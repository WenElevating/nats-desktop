package buckets

import (
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// UnavailableReason tokens for ListBucketsResult — jsadmin's vocabulary
// re-declared in this package (前端指引面板按 token 显示文案).
const (
	ReasonNoResponders = "no_responders"
	ReasonTimeout      = "timeout"
	ReasonServer       = "server"
)

// ListKvBuckets lists the KV half of the bucket surface via the
// KeyValueStores lister; ObjBuckets stays nil (Task 5 fills the object
// half — the frontend pages each call their own method against the shared
// result shape). UnavailableReason 仅描述 JS 层不可用成因（no_responders/
// timeout/server）；not_connected 不属于指引面板语义（前端按连接状态整体
// gate），置空——对齐 jsadmin.ListStreams。
func (s *BucketService) ListKvBuckets() ListBucketsResult {
	js, res := s.js()
	if !res.Ok() {
		return ListBucketsResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	lister := js.KeyValueStores(ctx)
	out := make([]KvBucketSummary, 0)
	for st := range lister.Status() {
		out = append(out, BuildKvBucketSummary(st))
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
	return ListBucketsResult{KvBuckets: out}
}

// GetKvBucketDetail loads one KV bucket and echoes the editable form.
// KeyValueStatus has no Created field (verified against nats.go v1.53.1 —
// the interface exposes exactly 10 methods), so CreatedMs stays 0; the
// frontend does not display bucket creation time.
func (s *BucketService) GetKvBucketDetail(name string) BucketDetailResult {
	js, res := s.js()
	if !res.Ok() {
		return BucketDetailResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	kv, err := js.KeyValue(ctx, name)
	if err != nil {
		return BucketDetailResult{CallResult: ClassifyKvError(err)} // ErrBucketNotFound → not_found
	}
	st, err := kv.Status(ctx)
	if err != nil {
		return BucketDetailResult{CallResult: ClassifyKvError(err)}
	}
	cfg := st.Config()
	return BucketDetailResult{
		Form: KvBucketForm{
			Name:         st.Bucket(),
			Description:  cfg.Description,
			History:      cfg.History,
			TtlSeconds:   int64(cfg.TTL.Seconds()),
			MaxBytes:     cfg.MaxBytes,
			Replicas:     cfg.Replicas,
			MaxValueSize: cfg.MaxValueSize,
		},
	}
}

// CreateKvBucket validates the form and creates the bucket. nats-server
// treats a duplicate CREATE carrying an identical config as idempotent
// success — ErrBucketExists (→ conflict) only surfaces for a differing
// config, which is what the UI's duplicate banner is for.
func (s *BucketService) CreateKvBucket(form KvBucketForm) CallResult {
	if err := ValidateKvBucketForm(&form); err != nil {
		return fail(CodeValidation, err.Error())
	}
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	if _, err := js.CreateKeyValue(ctx, kvConfigFromForm(&form)); err != nil {
		return ClassifyKvError(err) // ErrBucketExists → conflict（§6.8 异常 1）
	}
	s.log.Info("kv bucket created", "bucket", form.Name)
	return CallResult{}
}

// UpdateKvBucket validates the form and patches the bucket. History can only
// grow on the server (shrink is rejected as a 400 → validation, 表单内联).
func (s *BucketService) UpdateKvBucket(form KvBucketForm) CallResult {
	if err := ValidateKvBucketForm(&form); err != nil {
		return fail(CodeValidation, err.Error())
	}
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	if _, err := js.UpdateKeyValue(ctx, kvConfigFromForm(&form)); err != nil {
		return ClassifyKvError(err) // ErrBucketNotFound → not_found
	}
	s.log.Info("kv bucket updated", "bucket", form.Name)
	return CallResult{}
}

// DeleteKvBucket removes the bucket and its data (二级确认在 UI 层).
func (s *BucketService) DeleteKvBucket(name string) CallResult {
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	if err := js.DeleteKeyValue(ctx, name); err != nil {
		return ClassifyKvError(err) // ErrBucketNotFound → not_found（前端刷新列表）
	}
	s.log.Info("kv bucket deleted", "bucket", name)
	return CallResult{}
}

// CompactKvBucket purges delete markers together with the history they
// gate. DeleteMarkersOlderThan(-1) is the unconditional variant: a zero
// value would mean nats.go's 30-minute default threshold
// (kv.go kvDefaultPurgeDeletesMarkerThreshold), NOT delete-all — only the
// negative duration skips the age filter and purges every marker.
func (s *BucketService) CompactKvBucket(name string) CallResult {
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	kv, err := js.KeyValue(ctx, name)
	if err != nil {
		return ClassifyKvError(err) // ErrBucketNotFound → not_found
	}
	if err := kv.PurgeDeletes(ctx, jetstream.DeleteMarkersOlderThan(-1)); err != nil {
		return ClassifyKvError(err)
	}
	s.log.Info("kv bucket compacted", "bucket", name)
	return CallResult{}
}

// kvConfigFromForm maps the wire form onto jetstream.KeyValueConfig. Numeric
// 0 keeps the server defaults (history 1, unlimited value size) exactly as
// prepareKeyValueConfig interprets them; TTL 0 = no expiry.
func kvConfigFromForm(f *KvBucketForm) jetstream.KeyValueConfig {
	return jetstream.KeyValueConfig{
		Bucket:       f.Name,
		Description:  f.Description,
		History:      f.History,
		TTL:          time.Duration(f.TtlSeconds) * time.Second,
		MaxBytes:     f.MaxBytes,
		Replicas:     f.Replicas,
		MaxValueSize: f.MaxValueSize,
	}
}

// ---------------------------------------------------------------------------
// 键操作半边（spec §6.8）：列表 / 批量值 / 历史 / put 三语义 / del 两模式 /
// revert。修订号 = 桶底层流序列（全局递增，跨键共享），结果原样透传服务端
// 序号；值只编码传输，绝不入日志（键名/修订号可记）。
// ---------------------------------------------------------------------------

// PutKey mode 闭集（§6.8）。
const (
	PutModePut    = "put"
	PutModeCreate = "create"
	PutModeUpdate = "update"
)

// DeleteKey mode 闭集。
const (
	DeleteModeDelete = "delete"
	DeleteModePurge  = "purge"
)

// ListKeys 收集桶内全部键的最新元数据。MetaOnly 只取 meta 不取值（值由
// GetKeyValues 批量补齐）；不用 UpdatesOnly——初始快照正是列表要的数据；
// 不用 IgnoreDeletes——删除/清除标记键仍出现在列表（Operation=delete/purge，
// §6.8「历史可查」浏览语义）。nil 哨兵表示初始快照结束，随即 Stop 释放
// 服务端有序消费者。
func (s *BucketService) ListKeys(bucket string) ListKeysResult {
	js, res := s.js()
	if !res.Ok() {
		return ListKeysResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	kv, err := js.KeyValue(ctx, bucket)
	if err != nil {
		return ListKeysResult{CallResult: ClassifyKvError(err)} // ErrBucketNotFound → not_found
	}
	watcher, err := kv.Watch(ctx, ">", jetstream.MetaOnly())
	if err != nil {
		return ListKeysResult{CallResult: ClassifyKvError(err)}
	}
	defer watcher.Stop()
	keys := make([]KeyMeta, 0)
	for e := range watcher.Updates() {
		if e == nil { // 初始快照完成哨兵
			break
		}
		keys = append(keys, BuildKeyMeta(e))
	}
	// ctx 到期会让订阅关闭、通道提前结束——此刻返回部分列表会伪装成成功，
	// 必须转成超时错误（哨兵正常到达时 deadline 必然未到，不受影响）。
	if err := ctx.Err(); err != nil {
		return ListKeysResult{CallResult: ClassifyKvError(err)}
	}
	return ListKeysResult{Keys: keys}
}

// GetKeyValues 批量补齐键值：sync.WaitGroup + 预分配索引写入（out[i] 只被
// 唯一 goroutine 写，无锁无竞争），并发上限 8（不用 errgroup：golang.org/x/sync
// 不进依赖树，Global 12）。ErrKeyNotFound（含已删除键——kv.Get 把 ErrKeyDeleted
// 归一为 ErrKeyNotFound）→ 该键 NotFound=true，不拖垮整批；其余错误取首错
// 分类后整批失败。
func (s *BucketService) GetKeyValues(bucket string, keys []string) GetKeyValuesResult {
	js, res := s.js()
	if !res.Ok() {
		return GetKeyValuesResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	kv, err := js.KeyValue(ctx, bucket)
	if err != nil {
		return GetKeyValuesResult{CallResult: ClassifyKvError(err)}
	}
	out := make([]KeyValueOut, len(keys))
	const maxWorkers = 8
	workers := maxWorkers
	if len(keys) < workers {
		workers = len(keys)
	}
	sem := make(chan struct{}, workers)
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		firstEr error
	)
	for i, key := range keys {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			e, err := kv.Get(ctx, key)
			if err != nil {
				if errors.Is(err, jetstream.ErrKeyNotFound) {
					out[i] = KeyValueOut{Key: key, NotFound: true}
					return
				}
				mu.Lock()
				if firstEr == nil {
					firstEr = err
				}
				mu.Unlock()
				return
			}
			out[i] = encodeValue(e.Key(), e.Value(), e.Revision(), e.Created(), kvOpToWire(e.Operation()))
		}()
	}
	wg.Wait()
	if firstEr != nil {
		return GetKeyValuesResult{CallResult: ClassifyKvError(firstEr)}
	}
	return GetKeyValuesResult{Values: out}
}

// GetKeyHistory 返回键的全量修订历史（含值，升序——流序列即历史顺序，删除
// 标记也在其中，§6.8「历史可查」）。键不存在 → not_found。
func (s *BucketService) GetKeyHistory(bucket, key string) GetKeyHistoryResult {
	js, res := s.js()
	if !res.Ok() {
		return GetKeyHistoryResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	kv, err := js.KeyValue(ctx, bucket)
	if err != nil {
		return GetKeyHistoryResult{CallResult: ClassifyKvError(err)}
	}
	entries, err := kv.History(ctx, key)
	if err != nil {
		return GetKeyHistoryResult{CallResult: ClassifyKvError(err)} // ErrKeyNotFound → not_found
	}
	out := make([]KeyHistoryEntry, 0, len(entries))
	for _, e := range entries {
		v := encodeValue(e.Key(), e.Value(), e.Revision(), e.Created(), kvOpToWire(e.Operation()))
		out = append(out, KeyHistoryEntry{
			Revision:    v.Revision,
			PayloadB64:  v.PayloadB64,
			PayloadSize: v.PayloadSize,
			IsUtf8:      v.IsUtf8,
			CreatedMs:   v.CreatedMs,
			Operation:   v.Operation,
		})
	}
	return GetKeyHistoryResult{Entries: out}
}

// PutKey 三语义写入：put（无条件）/ create（键不存在才写，ErrKeyExists →
// conflict，服务器原文前置 + 「可改用 put 或查看现有值」指引）/ update（CAS：
// expectedRevision 不符 → conflict，并回读当前修订填 CurrentRevision——kv.Get
// 失败置 0）。值经 base64 解码后过 8MB 上限校验；键名走 ValidateKeyName
// （'/' 合法，natscli 互操作）。
func (s *BucketService) PutKey(bucket, key, payloadB64, mode string, expectedRevision uint64) PutKeyResult {
	if err := ValidateKeyName(key); err != nil {
		return PutKeyResult{CallResult: fail(CodeValidation, err.Error())}
	}
	payload, err := base64.StdEncoding.DecodeString(payloadB64)
	if err != nil {
		return PutKeyResult{CallResult: fail(CodeValidation, "payload_b64 must be valid base64: "+err.Error())}
	}
	if err := ValidatePayloadSize(len(payload)); err != nil {
		return PutKeyResult{CallResult: fail(CodeValidation, err.Error())}
	}
	switch mode {
	case PutModePut, PutModeCreate, PutModeUpdate:
	default:
		return PutKeyResult{CallResult: fail(CodeValidation, "mode must be one of put|create|update")}
	}
	js, res := s.js()
	if !res.Ok() {
		return PutKeyResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	kv, err := js.KeyValue(ctx, bucket)
	if err != nil {
		return PutKeyResult{CallResult: ClassifyKvError(err)} // ErrBucketNotFound → not_found
	}
	switch mode {
	case PutModeCreate:
		rev, err := kv.Create(ctx, key, payload)
		if err != nil {
			if errors.Is(err, jetstream.ErrKeyExists) {
				// §6.8 异常 1：服务器原文前置，拼入指引文案。
				return PutKeyResult{CallResult: fail(CodeConflict, err.Error()+"；已存在，可改用 put 或查看现有值")}
			}
			return PutKeyResult{CallResult: ClassifyKvError(err)}
		}
		s.log.Info("kv key created", "bucket", bucket, "key", key, "revision", rev)
		return PutKeyResult{Revision: rev}
	case PutModeUpdate:
		rev, err := kv.Update(ctx, key, payload, expectedRevision)
		if err != nil {
			if errors.Is(err, jetstream.ErrKeyRevisionMismatch) {
				// §6.8 异常 2：CAS 冲突，回读当前修订供前端刷新（读不到置 0）。
				current := uint64(0)
				if e, gerr := kv.Get(ctx, key); gerr == nil {
					current = e.Revision()
				}
				return PutKeyResult{CallResult: fail(CodeConflict, err.Error()), CurrentRevision: current}
			}
			return PutKeyResult{CallResult: ClassifyKvError(err)}
		}
		s.log.Info("kv key updated", "bucket", bucket, "key", key, "revision", rev)
		return PutKeyResult{Revision: rev}
	default: // PutModePut
		rev, err := kv.Put(ctx, key, payload)
		if err != nil {
			return PutKeyResult{CallResult: ClassifyKvError(err)}
		}
		s.log.Info("kv key put", "bucket", bucket, "key", key, "revision", rev)
		return PutKeyResult{Revision: rev}
	}
}

// DeleteKey 两模式删除：delete（打删除标记，历史保留，可 revert）/ purge
// （打标记并移除此前的全部修订，§6.8 彻底清除；UI 层负责二级确认）。
func (s *BucketService) DeleteKey(bucket, key, mode string) CallResult {
	if err := ValidateKeyName(key); err != nil {
		return fail(CodeValidation, err.Error())
	}
	switch mode {
	case DeleteModeDelete, DeleteModePurge:
	default:
		return fail(CodeValidation, "mode must be one of delete|purge")
	}
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	kv, err := js.KeyValue(ctx, bucket)
	if err != nil {
		return ClassifyKvError(err) // ErrBucketNotFound → not_found
	}
	if mode == DeleteModePurge {
		err = kv.Purge(ctx, key)
	} else {
		err = kv.Delete(ctx, key)
	}
	if err != nil {
		return ClassifyKvError(err)
	}
	s.log.Info("kv key deleted", "bucket", bucket, "key", key, "mode", mode)
	return CallResult{}
}

// RevertKey 删除态感知回退（F-09）：历史升序；最新条目为 delete/purge 标记 →
// 目标 = 最后一个有效修订本身（恢复最后有效值）；最新条目有效 → 目标 = 倒数
// 第二个有效修订（活键回退一步，跳过历史中的标记）。有效修订不足（活键仅
// 1 修订，或删除态下无更早有效修订——如 purge 后）→ validation + ErrNoHistory。
// 回退 = 以目标值 kv.Put 产生新修订（流序列不回滚）。
func (s *BucketService) RevertKey(bucket, key string) PutKeyResult {
	if err := ValidateKeyName(key); err != nil {
		return PutKeyResult{CallResult: fail(CodeValidation, err.Error())}
	}
	js, res := s.js()
	if !res.Ok() {
		return PutKeyResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	kv, err := js.KeyValue(ctx, bucket)
	if err != nil {
		return PutKeyResult{CallResult: ClassifyKvError(err)}
	}
	entries, err := kv.History(ctx, key)
	if err != nil {
		return PutKeyResult{CallResult: ClassifyKvError(err)} // ErrKeyNotFound → not_found
	}
	isMarker := func(e jetstream.KeyValueEntry) bool {
		op := e.Operation()
		return op == jetstream.KeyValueDelete || op == jetstream.KeyValuePurge
	}
	var target jetstream.KeyValueEntry
	if isMarker(entries[len(entries)-1]) {
		for i := len(entries) - 1; i >= 0; i-- { // 删除态：最后一个有效修订
			if !isMarker(entries[i]) {
				target = entries[i]
				break
			}
		}
	} else {
		valid := 0
		for i := len(entries) - 1; i >= 0; i-- { // 活键：倒数第二个有效修订
			if !isMarker(entries[i]) {
				valid++
				if valid == 2 {
					target = entries[i]
					break
				}
			}
		}
	}
	if target == nil {
		return PutKeyResult{CallResult: fail(CodeValidation, ErrNoHistory.Error())}
	}
	rev, err := kv.Put(ctx, key, target.Value())
	if err != nil {
		return PutKeyResult{CallResult: ClassifyKvError(err)}
	}
	s.log.Info("kv key reverted", "bucket", bucket, "key", key, "from_revision", target.Revision(), "revision", rev)
	return PutKeyResult{Revision: rev}
}
