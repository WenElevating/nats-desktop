package buckets

import (
	"context"
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
