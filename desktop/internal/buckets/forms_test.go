package buckets

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

func TestValidateKvBucketForm(t *testing.T) {
	// 合法组：History 0（=服务器默认 1）与显式值均可
	for _, ok := range []KvBucketForm{
		{Name: "CFG", History: 5, Replicas: 1},
		{Name: "cfg-2_x", History: 0, Replicas: 0}, // Replicas 0 → 默认 1
	} {
		if err := ValidateKvBucketForm(&ok); err != nil {
			t.Fatalf("%+v: %v", ok, err)
		}
	}
	bad := []KvBucketForm{
		{Name: "", Replicas: 1},                  // 空名
		{Name: "has space", Replicas: 1},         // 桶名字符集 ^[a-zA-Z0-9_-]+$
		{Name: "my.bucket", Replicas: 1},         // 点对桶名非法（stream 规则不适用）
		{Name: "S", Replicas: 9},                 // 副本 1–5
		{Name: "S", TtlSeconds: -1, Replicas: 1}, // TTL ≥0
		{Name: "S", MaxBytes: -2, Replicas: 1},   // ≥-1
	}
	for i := range bad {
		if err := ValidateKvBucketForm(&bad[i]); err == nil {
			t.Fatalf("case %d accepted: %+v", i, bad[i])
		}
	}
}

func TestValidateKeyName(t *testing.T) {
	// 字符集 = nats.go validKeyRe ^[-/_=.a-zA-Z0-9]+$ + 禁前后点/连续点（含 / —— natscli 互操作）
	for _, ok := range []string{"a", "ab", "app.name", "k-1_x=2", "A.B.C", "path/key"} {
		if err := ValidateKeyName(ok); err != nil {
			t.Fatalf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "a b", "a*", ">", ".a", "a.", "a..b"} {
		if err := ValidateKeyName(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	// watch 过滤串单独规则：键规则 + `*` + 尾部 `>`
	if err := ValidateWatchFilter("a.*"); err != nil {
		t.Fatalf("watch filter: %v", err)
	}
	if err := ValidateWatchFilter("a.>"); err != nil {
		t.Fatalf("watch filter tail: %v", err)
	}
}

func TestClassifyKvError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"key exists", jetstream.ErrKeyExists, CodeConflict},
		{"revision mismatch", jetstream.ErrKeyRevisionMismatch, CodeConflict},
		{"bucket exists", jetstream.ErrBucketExists, CodeConflict},
		{"key not found", jetstream.ErrKeyNotFound, CodeNotFound},
		{"bucket not found", jetstream.ErrBucketNotFound, CodeNotFound},
		{"stream not found (jetstream envelope)", jetstream.ErrStreamNotFound, CodeNotFound},
		{"other", jetstream.ErrJetStreamNotEnabled, CodeJSUnavailable},
	}
	for _, c := range cases {
		if got := ClassifyKvError(c.err).ErrorCode; got != c.want {
			t.Fatalf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}

// stubKvStatus implements jetstream.KeyValueStatus — all 10 methods
// (Bucket/Values/History/TTL/BackingStore/Bytes/IsCompressed/LimitMarkerTTL/
// Metadata/Config). MaxBytes/Replicas have no status getter; the summary must
// read them via Config().
type stubKvStatus struct {
	bucket     string
	values     uint64
	history    int64
	ttlSecs    int64
	bytes      uint64
	compressed bool
	maxBytes   int64
	replicas   int
}

func (s stubKvStatus) Bucket() string                { return s.bucket }
func (s stubKvStatus) Values() uint64                { return s.values }
func (s stubKvStatus) History() int64                { return s.history }
func (s stubKvStatus) TTL() time.Duration            { return time.Duration(s.ttlSecs) * time.Second }
func (s stubKvStatus) BackingStore() string          { return "JetStream" }
func (s stubKvStatus) Bytes() uint64                 { return s.bytes }
func (s stubKvStatus) IsCompressed() bool            { return s.compressed }
func (s stubKvStatus) LimitMarkerTTL() time.Duration { return 0 }
func (s stubKvStatus) Metadata() map[string]string   { return nil }
func (s stubKvStatus) Config() jetstream.KeyValueConfig {
	return jetstream.KeyValueConfig{Bucket: s.bucket, MaxBytes: s.maxBytes, Replicas: s.replicas}
}

func TestBuildKvBucketSummary(t *testing.T) {
	// 桩 status：jetstream.KeyValueStatus 接口共 10 方法（Bucket/Values/History/TTL/
	// BackingStore/Bytes/IsCompressed/LimitMarkerTTL/Metadata/Config）——
	// MaxBytes/Replicas 无 getter，必须经 Config() 取（kv.go:311-343）。
	stub := stubKvStatus{bucket: "CFG", values: 42, history: 5, ttlSecs: 60, bytes: 1024, compressed: true, maxBytes: 2048, replicas: 2}
	s := BuildKvBucketSummary(stub)
	if s.Name != "CFG" || s.Values != 42 || s.History != 5 || s.TtlSeconds != 60 || s.Bytes != 1024 || !s.IsCompressed {
		t.Fatalf("%+v", s)
	}
	if s.MaxBytes != 2048 || s.Replicas != 2 {
		t.Fatalf("config-derived fields: %+v", s) // 经 stub.Config() 取
	}
}

func TestEncodeValueRoundTrip(t *testing.T) {
	out := encodeValue("k", []byte("hello"), 3, time.Unix(1700000000, 0), "put")
	if out.Revision != 3 || out.PayloadSize != 5 || !out.IsUtf8 || out.Operation != "put" || out.CreatedMs != 1700000000000 {
		t.Fatalf("%+v", out)
	}
	raw, err := base64.StdEncoding.DecodeString(out.PayloadB64)
	if err != nil || string(raw) != "hello" {
		t.Fatalf("b64: %v", err)
	}
	if out := encodeValue("k", []byte{0xff}, 4, time.Time{}, "put"); out.IsUtf8 {
		t.Fatal("binary must be non-utf8")
	}
}

func TestWireTagsAreSnakeCase(t *testing.T) {
	b, _ := json.Marshal(KvWatchEvent{WatchId: "w1", Bucket: "B"})
	if !strings.Contains(string(b), `"watch_id":"w1"`) || !strings.Contains(string(b), `"bucket":"B"`) {
		t.Fatalf("kv watch wire: %s", b)
	}
	b2, _ := json.Marshal(ObjTransferEvent{TransferId: "t1", BytesTotal: 9})
	if !strings.Contains(string(b2), `"transfer_id":"t1"`) || !strings.Contains(string(b2), `"bytes_total":9`) {
		t.Fatalf("transfer wire: %s", b2)
	}
}
