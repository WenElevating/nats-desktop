package buckets

import (
	"context"
	"errors"

	"github.com/nats-io/nats.go/jetstream"
)

// ---------------------------------------------------------------------------
// 对象桶与对象半边（spec §6.9）：桶 CRUD/封存 + 对象列表/删除/改名。一次性操作
// 全部带 s.timeout() ctx（watch 半边在 watch.go，用长生命周期 cancel ctx）。
// 对象名/尺寸/摘要可入日志，对象内容绝不入日志（§13.3 延续）。
// ---------------------------------------------------------------------------

// ListObjBuckets lists the object half via the ObjectStores lister, filling the
// ObjBuckets half of the shared ListBucketsResult (the frontend pages each call
// their own method against the same result shape as ListKvBuckets).
// UnavailableReason 仅描述 JS 层不可用成因（no_responders/timeout/server），
// not_connected 不属于指引面板语义——对齐 ListKvBuckets/jsadmin.ListStreams。
func (s *BucketService) ListObjBuckets() ListBucketsResult {
	js, res := s.js()
	if !res.Ok() {
		return ListBucketsResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	lister := js.ObjectStores(ctx)
	out := make([]ObjBucketSummary, 0)
	for st := range lister.Status() {
		out = append(out, BuildObjBucketSummary(st))
	}
	if err := lister.Error(); err != nil {
		reason := ReasonServer
		if isNoResponders(err) {
			reason = ReasonNoResponders
		} else if isTimeout(err) {
			reason = ReasonTimeout
		}
		return ListBucketsResult{CallResult: ClassifyKvError(err), UnavailableReason: reason}
	}
	return ListBucketsResult{ObjBuckets: out}
}

// GetObjBucketDetail loads one object bucket: editable-form echo + Sealed.
// ObjectStoreStatus 的接口没有 MaxBytes 取值器，而 prepareObjectStoreConfig 会
// 把 MaxBytes 0 归一为 -1（无限制）——若详情回显落 0，用户仅改描述提交就会把
// 已配置的配额静默重置为无限制。ObjectBucketStatus（nats.go v1.53.1 中 Status
// 的唯一具体实现）额外导出 StreamInfo()，用它补齐 MaxBytes；断言失败（未来
// 版本变更）时保持 0 并由前端表单按「不设置」处理。
func (s *BucketService) GetObjBucketDetail(name string) ObjBucketDetailResult {
	js, res := s.js()
	if !res.Ok() {
		return ObjBucketDetailResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	osb, err := js.ObjectStore(ctx, name)
	if err != nil {
		return ObjBucketDetailResult{CallResult: ClassifyKvError(err)} // ErrBucketNotFound → not_found
	}
	st, err := osb.Status(ctx)
	if err != nil {
		return ObjBucketDetailResult{CallResult: ClassifyKvError(err)}
	}
	form := ObjBucketForm{
		Name:        st.Bucket(),
		Description: st.Description(),
		Replicas:    st.Replicas(),
	}
	if sip, ok := st.(interface{ StreamInfo() *jetstream.StreamInfo }); ok {
		form.MaxBytes = sip.StreamInfo().Config.MaxBytes
	}
	return ObjBucketDetailResult{Form: form, Sealed: st.Sealed()}
}

// CreateObjBucket validates the form and creates the bucket. nats-server
// treats a duplicate CREATE carrying an identical config as idempotent
// success — ErrBucketExists (→ conflict) only surfaces for a differing
// config, same as the KV half.
func (s *BucketService) CreateObjBucket(form ObjBucketForm) CallResult {
	if err := ValidateObjBucketForm(&form); err != nil {
		return fail(CodeValidation, err.Error())
	}
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	if _, err := js.CreateObjectStore(ctx, objConfigFromForm(&form)); err != nil {
		return ClassifyKvError(err) // ErrBucketExists → conflict
	}
	s.log.Info("object bucket created", "bucket", form.Name)
	return CallResult{}
}

// UpdateObjBucket validates the form and patches the bucket (description /
// max_bytes / replicas). Sealed 桶的更新被服务器以 400 拒绝 → validation 原文
// 透传；缺失桶 ErrBucketNotFound → not_found。
func (s *BucketService) UpdateObjBucket(form ObjBucketForm) CallResult {
	if err := ValidateObjBucketForm(&form); err != nil {
		return fail(CodeValidation, err.Error())
	}
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	if _, err := js.UpdateObjectStore(ctx, objConfigFromForm(&form)); err != nil {
		return ClassifyKvError(err)
	}
	s.log.Info("object bucket updated", "bucket", form.Name)
	return CallResult{}
}

// DeleteObjBucket removes the bucket and its data (二级确认在 UI 层).
func (s *BucketService) DeleteObjBucket(name string) CallResult {
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	if err := js.DeleteObjectStore(ctx, name); err != nil {
		return ClassifyKvError(err) // ErrBucketNotFound → not_found（前端刷新列表）
	}
	s.log.Info("object bucket deleted", "bucket", name)
	return CallResult{}
}

// SealObjBucket seals the bucket: no further writes (UI 按 sealed 状态禁用
// 上传/编辑，服务器错误仍原文透传，§6.9 异常 3)。Seal 幂等。
func (s *BucketService) SealObjBucket(name string) CallResult {
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	osb, err := js.ObjectStore(ctx, name)
	if err != nil {
		return ClassifyKvError(err) // ErrBucketNotFound → not_found
	}
	if err := osb.Seal(ctx); err != nil {
		return ClassifyKvError(err)
	}
	s.log.Info("object bucket sealed", "bucket", name)
	return CallResult{}
}

// ListObjects 收集桶内全部对象（含已删除）。**必须带 ListObjectsShowDeleted**：
// 默认 List 过滤已删除对象（nats.go object.go List→IgnoreDeletes），「已删除」
// 徽标（§6.9 浏览语义）将永不出现。空桶/无对象 → ErrNoObjectsFound 吞掉返回
// 空数组（非 nil，前端 .length 语义）。
func (s *BucketService) ListObjects(bucket string) ListObjectsResult {
	js, res := s.js()
	if !res.Ok() {
		return ListObjectsResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	osb, err := js.ObjectStore(ctx, bucket)
	if err != nil {
		return ListObjectsResult{CallResult: ClassifyKvError(err)} // ErrBucketNotFound → not_found
	}
	infos, err := osb.List(ctx, jetstream.ListObjectsShowDeleted())
	if err != nil {
		if errors.Is(err, jetstream.ErrNoObjectsFound) {
			return ListObjectsResult{Objects: make([]ObjectOut, 0)}
		}
		return ListObjectsResult{CallResult: ClassifyKvError(err)}
	}
	out := make([]ObjectOut, 0, len(infos))
	for _, info := range infos {
		out = append(out, ObjectOut{
			Name:      info.Name,
			Size:      info.Size,
			Chunks:    info.Chunks,
			Digest:    info.Digest,
			ModTimeMs: info.ModTime.UnixMilli(),
			Deleted:   info.Deleted,
		})
	}
	return ListObjectsResult{Objects: out}
}

// DeleteObject 删除（打删除标记 + 清分片，一级确认在 UI 层）：对象**不存在** →
// not_found；对象**已删除** → Ok（nats.go Delete 文档语义 "If the object is
// already deleted, no error will be returned"——重删幂等，测试钉住）。
func (s *BucketService) DeleteObject(bucket, name string) CallResult {
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	osb, err := js.ObjectStore(ctx, bucket)
	if err != nil {
		return ClassifyKvError(err) // ErrBucketNotFound → not_found
	}
	if err := osb.Delete(ctx, name); err != nil {
		return classifyObjError(err)
	}
	s.log.Info("object deleted", "bucket", bucket, "object", name)
	return CallResult{}
}

// RenameObject 改名。注意 nats.go 的 UpdateMeta 以传入 meta **整体覆盖**元数据
// （Description/Headers/Metadata 直接取传入值，零值即清空）——先 GetInfo 回填
// 旧值再改名，避免外部创建的带描述/元数据对象在改名时被静默清空（Task 5 审查
// 裁定）。源对象不存在/已删除 → not_found（nats.go 把不存在的 GetInfo 归一为
// ErrUpdateMetaDeleted，服务层还原 not_found）；新名已被占用 → conflict。
func (s *BucketService) RenameObject(bucket, name, newName string) CallResult {
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	osb, err := js.ObjectStore(ctx, bucket)
	if err != nil {
		return ClassifyKvError(err) // ErrBucketNotFound → not_found
	}
	info, err := osb.GetInfo(ctx, name)
	if err != nil {
		return classifyObjError(err)
	}
	meta := jetstream.ObjectMeta{
		Name:        newName,
		Description: info.Description,
		Headers:     info.Headers,
		Metadata:    info.Metadata,
	}
	if err := osb.UpdateMeta(ctx, name, meta); err != nil {
		return classifyObjError(err)
	}
	s.log.Info("object renamed", "bucket", bucket, "from", name, "to", newName)
	return CallResult{}
}

// classifyObjError 在共享的 ClassifyKvError 之前补上对象 store 专属的客户端
// sentinel——它们无 APIError（未发起服务器往返），泛化 JetStreamError 分支会把
// 它们误归 server。
func classifyObjError(err error) CallResult {
	switch {
	case errors.Is(err, jetstream.ErrObjectNotFound),
		errors.Is(err, jetstream.ErrUpdateMetaDeleted):
		return fail(CodeNotFound, err.Error())
	case errors.Is(err, jetstream.ErrObjectAlreadyExists):
		return fail(CodeConflict, err.Error())
	case errors.Is(err, jetstream.ErrNameRequired), errors.Is(err, jetstream.ErrBadObjectMeta):
		return fail(CodeValidation, err.Error())
	}
	return ClassifyKvError(err)
}

// objConfigFromForm maps the wire form onto jetstream.ObjectStoreConfig.
// MaxBytes 0 = 不设置（nats.go 归一为 -1 无限制），-1 = 无限制。
func objConfigFromForm(f *ObjBucketForm) jetstream.ObjectStoreConfig {
	return jetstream.ObjectStoreConfig{
		Bucket:      f.Name,
		Description: f.Description,
		MaxBytes:    f.MaxBytes,
		Replicas:    f.Replicas,
	}
}
