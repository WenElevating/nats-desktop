package buckets

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// MaxValueBytes is the per-value cap enforced before publish (spec §6.8).
const MaxValueBytes = 8 * 1024 * 1024

// ClassifyKvError maps KV/object-store failures onto the closed error_code
// set. KV sentinels are matched FIRST: ErrKeyExists carries an APIError code
// 400 and the not-found sentinels carry no APIError at all, so the generic
// jetstream branch alone would misfile them as validation/server instead of
// the KV semantics conflict/not_found. After the sentinels the classification
// mirrors jsadmin.ClassifyError: the jetstream.JetStreamError branch plus the
// jsm api.ApiError branch (KV paths rarely produce the latter, kept for
// structural parity).
func ClassifyKvError(err error) CallResult {
	switch {
	case err == nil:
		return CallResult{}
	case errors.Is(err, jetstream.ErrKeyExists),
		errors.Is(err, jetstream.ErrKeyRevisionMismatch),
		errors.Is(err, jetstream.ErrBucketExists):
		return fail(CodeConflict, err.Error())
	case errors.Is(err, jetstream.ErrKeyNotFound),
		errors.Is(err, jetstream.ErrBucketNotFound):
		return fail(CodeNotFound, err.Error())
	case errors.Is(err, nats.ErrNoResponders):
		return fail(CodeJSUnavailable, "JetStream API unreachable: "+err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		return fail(CodeServer, "request timed out")
	case errors.Is(err, jetstream.ErrNotPullConsumer):
		// Client-side jetstream sentinel: APIError() is nil (no server round
		// trip), but semantically this is a request/validation failure.
		return fail(CodeValidation, err.Error())
	}
	var jse jetstream.JetStreamError
	if errors.As(err, &jse) {
		if ae := jse.APIError(); ae != nil {
			switch {
			case ae.Code == 404:
				return fail(CodeNotFound, err.Error())
			case ae.Code >= 400 && ae.Code < 500:
				return fail(CodeValidation, err.Error())
			case ae.Code == 503:
				return fail(CodeJSUnavailable, err.Error())
			}
		}
		return fail(CodeServer, err.Error())
	}
	var ae api.ApiError
	if errors.As(err, &ae) {
		switch {
		case ae.NotFoundError():
			return fail(CodeNotFound, ae.Error())
		case ae.Code == 400, ae.UserError():
			return fail(CodeValidation, ae.Error())
		case ae.ErrCode == 10012:
			// JSConsumerCreateErrF：服务器把配置类拒绝包进这个 HTTP 500 信封。
			// KV 路径不会产生它，保留分支以与 jsadmin 同构。
			return fail(CodeValidation, ae.Error())
		default:
			return fail(CodeServer, ae.Error())
		}
	}
	return fail(CodeServer, err.Error())
}

// Name charsets copied from nats.go jetstream/kv.go — the bucket rule is NOT
// the stream rule (dots are invalid for buckets), keys additionally allow '/'
// (natscli interop) and watch filters the search-key rule (allow '*' plus a
// single trailing '>').
var (
	validBucketRe    = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
	validKeyRe       = regexp.MustCompile(`^[-/_=\.a-zA-Z0-9]+$`)
	validSearchKeyRe = regexp.MustCompile(`^[-/_=\.a-zA-Z0-9*]*[>]?$`)
)

// ValidateKvBucketForm checks a KV bucket create/edit form. Numeric fields:
// 0 = server default, -1 = unlimited (ttl_seconds only ≥0). On success the
// form is normalized (Replicas 0 → 1) like jsadmin's validators.
func ValidateKvBucketForm(f *KvBucketForm) error {
	if !validBucketRe.MatchString(f.Name) {
		return errors.New("bucket name must be non-empty and match ^[a-zA-Z0-9_-]+$")
	}
	if f.History > 64 {
		return errors.New("history must be between 1 and 64 (0 = server default)")
	}
	if f.TtlSeconds < 0 {
		return errors.New("ttl seconds must be >= 0")
	}
	if f.MaxBytes < -1 || f.MaxValueSize < -1 {
		return errors.New("limits must be >= -1 (-1 means unlimited)")
	}
	if f.Replicas == 0 {
		f.Replicas = 1
	}
	if f.Replicas < 1 || f.Replicas > 5 {
		return errors.New("replicas must be between 1 and 5")
	}
	return nil
}

// ValidateObjBucketForm checks an object bucket create form (same name,
// replicas and max_bytes rules as the KV form).
func ValidateObjBucketForm(f *ObjBucketForm) error {
	if !validBucketRe.MatchString(f.Name) {
		return errors.New("bucket name must be non-empty and match ^[a-zA-Z0-9_-]+$")
	}
	if f.MaxBytes < -1 {
		return errors.New("limits must be >= -1 (-1 means unlimited)")
	}
	if f.Replicas == 0 {
		f.Replicas = 1
	}
	if f.Replicas < 1 || f.Replicas > 5 {
		return errors.New("replicas must be between 1 and 5")
	}
	return nil
}

// ValidateKeyName mirrors nats.go keyValid: charset validKeyRe plus no empty
// string, no leading/trailing dot and no ".." — '/' allowed (natscli keys
// like "a/b" must be readable/writable from this UI).
func ValidateKeyName(key string) error {
	if len(key) == 0 || key[0] == '.' || key[len(key)-1] == '.' || strings.Contains(key, "..") {
		return errors.New("key must not be empty, start/end with '.', or contain '..'")
	}
	if !validKeyRe.MatchString(key) {
		return errors.New(`key must match ^[-/_=.a-zA-Z0-9]+$`)
	}
	return nil
}

// ValidateWatchFilter applies the relaxed search-key rule (nats.go
// searchKeyValid): key charset plus '*' anywhere and a single trailing '>'.
// An empty filter ("watch whole bucket") is handled by the caller before
// validation, same as nats.go.
func ValidateWatchFilter(s string) error {
	if len(s) == 0 || s[0] == '.' || s[len(s)-1] == '.' || strings.Contains(s, "..") {
		return errors.New("watch filter must not be empty, start/end with '.', or contain '..'")
	}
	if !validSearchKeyRe.MatchString(s) {
		return errors.New(`watch filter must match ^[-/_=.a-zA-Z0-9*]+ with an optional trailing '>'`)
	}
	return nil
}

// ValidatePayloadSize rejects values above the 8MB cap; the error preserves
// ErrPayloadTooLarge for errors.Is checks.
func ValidatePayloadSize(n int) error {
	if n > MaxValueBytes {
		return fmt.Errorf("%w: %d bytes", ErrPayloadTooLarge, n)
	}
	return nil
}

// BuildKvBucketSummary flattens a KeyValueStatus into the wire shape.
// MaxBytes/Replicas have no status getters (the interface exposes exactly 10
// methods) — they come from Config().
func BuildKvBucketSummary(st jetstream.KeyValueStatus) KvBucketSummary {
	cfg := st.Config()
	return KvBucketSummary{
		Name:         st.Bucket(),
		Description:  cfg.Description,
		Values:       st.Values(),
		History:      st.History(),
		TtlSeconds:   int64(st.TTL().Seconds()),
		Bytes:        st.Bytes(),
		MaxBytes:     cfg.MaxBytes,
		Replicas:     cfg.Replicas,
		IsCompressed: st.IsCompressed(),
	}
}

// BuildObjBucketSummary flattens an ObjectStoreStatus into the wire shape
// (the status interface has no object-count field).
func BuildObjBucketSummary(st jetstream.ObjectStoreStatus) ObjBucketSummary {
	return ObjBucketSummary{
		Name:        st.Bucket(),
		Description: st.Description(),
		Size:        st.Size(),
		Sealed:      st.Sealed(),
		Replicas:    st.Replicas(),
		TtlSeconds:  int64(st.TTL().Seconds()),
	}
}

// kvOpToWire maps nats.go KeyValueOp onto the wire operation tokens
// (put | delete | purge) — KeyValueOp.String() returns "KeyValuePutOp"-style
// identifiers, not the wire vocabulary.
func kvOpToWire(op jetstream.KeyValueOp) string {
	switch op {
	case jetstream.KeyValueDelete:
		return "delete"
	case jetstream.KeyValuePurge:
		return "purge"
	default:
		return "put"
	}
}

// BuildKeyMeta extracts the list-view metadata from a KV entry (values are
// fetched separately in batch).
func BuildKeyMeta(e jetstream.KeyValueEntry) KeyMeta {
	return KeyMeta{
		Key:       e.Key(),
		Revision:  e.Revision(),
		CreatedMs: e.Created().UnixMilli(),
		Operation: kvOpToWire(e.Operation()),
	}
}

// encodeValue fills the single-key value shape shared by batch value fetch
// and watch events — same encoding口径 as jsadmin's browser messages
// (base64 payload + utf8 flag + ms epoch), kept local to avoid cross-package
// export churn (plan裁定).
func encodeValue(key string, val []byte, rev uint64, created time.Time, op string) KeyValueOut {
	return KeyValueOut{
		Key:         key,
		Revision:    rev,
		PayloadB64:  base64.StdEncoding.EncodeToString(val),
		PayloadSize: len(val),
		IsUtf8:      utf8.Valid(val),
		CreatedMs:   created.UnixMilli(),
		Operation:   op,
	}
}
