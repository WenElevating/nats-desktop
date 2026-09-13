package jsadmin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

func TestValidateStreamForm(t *testing.T) {
	valid := StreamForm{Name: "ORDERS", Subjects: []string{"orders.>"}, Storage: "file", Retention: "limits", Replicas: 1}
	if err := ValidateStreamForm(&valid); err != nil {
		t.Fatalf("valid form rejected: %v", err)
	}
	bad := []StreamForm{
		{Name: "", Subjects: []string{"a"}, Storage: "file", Retention: "limits"},               // 空名
		{Name: "has space", Subjects: []string{"a"}, Storage: "file", Retention: "limits"},      // 名称含空格
		{Name: "S", Subjects: nil, Storage: "file", Retention: "limits"},                        // 非 mirror 无 subjects
		{Name: "S", Subjects: []string{"a"}, Storage: "redis", Retention: "limits"},             // storage 闭集
		{Name: "S", Subjects: []string{"a"}, Storage: "file", Retention: "forever"},             // retention 闭集
		{Name: "S", Subjects: []string{"a"}, Storage: "file", Retention: "limits", Replicas: 9}, // 副本 1–5
		{Name: "S", Subjects: []string{"a"}, Storage: "file", Retention: "limits", MaxMsgs: -2}, // 数值 < -1
		{Name: "S", Subjects: []string{"a"}, Storage: "file", Retention: "limits", MaxAgeSeconds: -1},
	}
	for i := range bad {
		if err := ValidateStreamForm(&bad[i]); err == nil {
			t.Fatalf("case %d accepted invalid form", i)
		}
	}
	mirror := StreamForm{Name: "M", Storage: "file", Retention: "limits", Replicas: 1,
		Mirror: &StreamSourceForm{Name: "upstream"}}
	if err := ValidateStreamForm(&mirror); err != nil {
		t.Fatalf("mirror without subjects must be allowed: %v", err)
	}
}

func TestStreamFormToConfigRoundTrip(t *testing.T) {
	f := StreamForm{Name: "ORDERS", Description: "d", Subjects: []string{"orders.>"},
		Storage: "file", Retention: "workqueue", MaxMsgs: -1, MaxBytes: 1024,
		MaxAgeSeconds: 3600, MaxMsgsPerSubject: 10, Replicas: 2,
		PlacementCluster: "cl-a", PlacementTags: []string{"tier"}} // 0 值字段留在服务端默认
	cfg := StreamFormToConfig(&f)
	if cfg.Name != "ORDERS" || cfg.Storage != api.FileStorage || cfg.Retention != api.WorkQueuePolicy {
		t.Fatalf("mapping wrong: %+v", cfg)
	}
	if cfg.MaxMsgs != -1 || cfg.MaxBytes != 1024 || cfg.MaxAge != time.Hour || cfg.MaxMsgsPer != 10 {
		t.Fatalf("limits mapping wrong: %+v", cfg)
	}
	if cfg.Placement == nil || cfg.Placement.Cluster != "cl-a" || len(cfg.Placement.Tags) != 1 {
		t.Fatalf("placement mapping wrong")
	}
	if cfg.MaxConsumers != 0 || cfg.Duplicates != 0 {
		t.Fatalf("unmanaged fields must stay zero on create")
	}
}

func TestMergeStreamUpdatePreservesServerSide(t *testing.T) {
	existing := api.StreamConfig{Name: "ORDERS", Subjects: []string{"orders.>"},
		Storage: api.FileStorage, Retention: api.LimitsPolicy, Replicas: 1,
		MaxConsumers: 7, Duplicates: 2 * time.Minute, Sealed: false}
	form := StreamForm{Name: "ORDERS", Description: "edited", Subjects: []string{"orders.>", "orders2.>"},
		Storage: "file", Retention: "limits", MaxMsgs: 5, Replicas: 1}
	merged := MergeStreamUpdate(existing, &form)
	if merged.Description != "edited" || merged.MaxMsgs != 5 {
		t.Fatalf("form fields must apply: %+v", merged)
	}
	if merged.MaxConsumers != 7 || merged.Duplicates != 2*time.Minute {
		t.Fatalf("server-managed fields must survive: %+v", merged)
	}
	if merged.Sealed {
		t.Fatal("form path must never seal")
	}
}

func TestBuildStreamSummary(t *testing.T) {
	st := api.StreamState{Msgs: 10, Bytes: 100, FirstSeq: 1, LastSeq: 12, NumDeleted: 2,
		LastTime: time.Unix(1700000000, 0), Lost: &api.LostStreamData{Msgs: []uint64{3}, Bytes: 30}}
	cfg := api.StreamConfig{Name: "KV_bucket", Subjects: []string{"$KV.bucket.>"}, Storage: api.FileStorage, Retention: api.LimitsPolicy}
	cluster := &api.ClusterInfo{Leader: "n1", Replicas: []*api.PeerInfo{
		{Name: "n2", Current: true}, {Name: "n3", Current: false, Offline: true}}}
	s := BuildStreamSummary("KV_bucket", cfg, st, cluster)
	if s.InternalKind != "kv" || s.Messages != 10 || s.NumDeleted != 2 || s.LostMsgs != 1 || s.LostBytes != 30 {
		t.Fatalf("summary wrong: %+v", s)
	}
	if s.UnhealthyReplicas != 1 || s.LeaderMissing || s.ReplicaCount != 3 {
		t.Fatalf("cluster wrong: %+v", s)
	}
	if s.LastTimeMs != 1700000000000 {
		t.Fatalf("ms epoch wrong: %d", s.LastTimeMs)
	}
}

func TestWireTagsAreSnakeCase(t *testing.T) {
	b, _ := json.Marshal(StreamSummary{Name: "x"})
	if string(b) != `{"name":"x","description":"","internal_kind":"","subjects":null,"storage":"","retention":"","messages":0,"bytes":0,"consumers":0,"first_seq":0,"last_seq":0,"last_time_ms":0,"lost_msgs":0,"lost_bytes":0,"num_deleted":0,"is_mirror":false,"is_source":false,"leader_missing":false,"unhealthy_replicas":0,"replica_count":0}` {
		t.Fatalf("wire contract drifted: %s", b)
	}
}

func TestClassifyError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"no responders", nats.ErrNoResponders, CodeJSUnavailable},
		{"deadline", context.DeadlineExceeded, CodeServer},
		{"api 404", api.ApiError{Code: 404, Description: "not found"}, CodeNotFound},
		{"api 400", api.ApiError{Code: 400, Description: "bad config"}, CodeValidation},
		{"api 500", api.ApiError{Code: 500, Description: "boom"}, CodeServer},
		{"jetstream 404 consumer", jetstream.ErrConsumerNotFound, CodeNotFound},
		{"jetstream 404 stream", jetstream.ErrStreamNotFound, CodeNotFound},
		{"jetstream not pull", jetstream.ErrNotPullConsumer, CodeValidation},
		{"other", errors.New("whatever"), CodeServer},
	}
	for _, c := range cases {
		if got := ClassifyError(c.err).ErrorCode; got != c.want {
			t.Fatalf("%s: got %s want %s", c.name, got, c.want)
		}
	}
	if r := ClassifyError(nil); !r.Ok() {
		t.Fatalf("nil error must be Ok, got %+v", r)
	}
}

// consumerFormBase returns a form that passes validation for creation.
func consumerFormBase() ConsumerForm {
	return ConsumerForm{
		Stream:        "ORDERS",
		Durable:       "worker",
		DeliverMode:   "pull",
		AckPolicy:     "explicit",
		ReplayPolicy:  "instant",
		DeliverPolicy: "all",
	}
}

func TestValidateConsumerForm(t *testing.T) {
	base := consumerFormBase()
	if err := ValidateConsumerForm(&base, false); err != nil {
		t.Fatalf("valid create form rejected: %v", err)
	}
	editing := consumerFormBase()
	editing.Durable = "" // editing: empty durable = keep existing name
	if err := ValidateConsumerForm(&editing, true); err != nil {
		t.Fatalf("editing with empty durable must be allowed: %v", err)
	}

	cases := []struct {
		name   string
		mutate func(f *ConsumerForm)
		want   error // nil → must be rejected (any error); ErrNeedsServer211 → errors.Is
	}{
		{"empty stream", func(f *ConsumerForm) { f.Stream = "" }, nil},
		{"blank durable on create", func(f *ConsumerForm) { f.Durable = "  " }, nil},
		{"durable with dot", func(f *ConsumerForm) { f.Durable = "a.b" }, nil},
		{"durable with star", func(f *ConsumerForm) { f.Durable = "a*b" }, nil},
		{"durable with gt", func(f *ConsumerForm) { f.Durable = "a>b" }, nil},
		{"bad deliver mode", func(f *ConsumerForm) { f.DeliverMode = "queue" }, nil},
		{"push without deliver subject", func(f *ConsumerForm) {
			f.DeliverMode = "push"
			f.DeliverSubject = ""
		}, nil},
		{"bad ack policy", func(f *ConsumerForm) { f.AckPolicy = "sometimes" }, nil},
		{"bad replay policy", func(f *ConsumerForm) { f.ReplayPolicy = "slow" }, nil},
		{"bad deliver policy", func(f *ConsumerForm) { f.DeliverPolicy = "yesterday" }, nil},
		{"start_sequence needs opt_start_seq", func(f *ConsumerForm) {
			f.DeliverPolicy = "start_sequence"
			f.OptStartSeq = 0
		}, nil},
		{"start_time needs opt_start_time_ms", func(f *ConsumerForm) {
			f.DeliverPolicy = "start_time"
			f.OptStartTimeMs = 0
		}, nil},
		{"negative ack wait", func(f *ConsumerForm) { f.AckWaitSeconds = -1 }, nil},
		{"negative max request expires", func(f *ConsumerForm) { f.MaxRequestExpiresSeconds = -1 }, nil},
		{"negative max deliver", func(f *ConsumerForm) { f.MaxDeliver = -1 }, nil},
		{"negative max waiting", func(f *ConsumerForm) { f.MaxWaiting = -1 }, nil},
		{"negative max ack pending", func(f *ConsumerForm) { f.MaxAckPending = -1 }, nil},
		{"negative max request batch", func(f *ConsumerForm) { f.MaxRequestBatch = -1 }, nil},
		{"backoff step below 1", func(f *ConsumerForm) { f.BackoffSeconds = []int64{0} }, nil},
		{"negative backoff step", func(f *ConsumerForm) { f.BackoffSeconds = []int64{-3} }, nil},
		{"too many backoff steps", func(f *ConsumerForm) {
			f.BackoffSeconds = make([]int64, 101)
			for i := range f.BackoffSeconds {
				f.BackoffSeconds[i] = 1
			}
		}, nil},
		{"empty filter subject", func(f *ConsumerForm) { f.FilterSubjects = []string{"orders.>", " "} }, nil},
		{"too many filter subjects", func(f *ConsumerForm) {
			f.FilterSubjects = []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"}
		}, nil},
		{"priority groups need server 2.11", func(f *ConsumerForm) { f.PriorityGroups = []string{"p1"} }, ErrNeedsServer211},
	}
	for _, c := range cases {
		f := consumerFormBase()
		c.mutate(&f)
		err := ValidateConsumerForm(&f, false)
		switch {
		case c.want == nil && err == nil:
			t.Fatalf("%s: accepted invalid form", c.name)
		case c.want != nil && !errors.Is(err, c.want):
			t.Fatalf("%s: got %v want %v", c.name, err, c.want)
		}
	}

	// Boundary values that must pass.
	good := func(mutate func(f *ConsumerForm)) {
		t.Helper()
		f := consumerFormBase()
		mutate(&f)
		if err := ValidateConsumerForm(&f, false); err != nil {
			t.Fatalf("boundary form rejected: %v", err)
		}
	}
	good(func(f *ConsumerForm) { f.DeliverPolicy = "start_sequence"; f.OptStartSeq = 1 }) // ≥ 1
	good(func(f *ConsumerForm) { f.DeliverPolicy = "start_time"; f.OptStartTimeMs = 1 })  // > 0
	good(func(f *ConsumerForm) { f.AckWaitSeconds = 0; f.MaxRequestExpiresSeconds = 0 })  // 0 = unset
	good(func(f *ConsumerForm) { f.MaxDeliver = 0; f.MaxWaiting = 0; f.MaxAckPending = 0; f.MaxRequestBatch = 0 })
	good(func(f *ConsumerForm) { f.BackoffSeconds = []int64{1} }) // smallest step
	good(func(f *ConsumerForm) {                                  // exactly 100 steps, 10 filters
		f.BackoffSeconds = make([]int64, 100)
		for i := range f.BackoffSeconds {
			f.BackoffSeconds[i] = 1
		}
		f.FilterSubjects = []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"}
	})
}

func TestConsumerFormRoundTrip(t *testing.T) {
	f := ConsumerForm{
		Stream: "ORDERS", Durable: "worker", Description: "d",
		DeliverMode: "push", DeliverSubject: "out.worker", DeliverGroup: "grp",
		FilterSubjects:           []string{"orders.>"},
		AckPolicy:                "explicit",
		AckWaitSeconds:           30,
		MaxDeliver:               5,
		MaxWaiting:               8,
		MaxAckPending:            100,
		MaxRequestBatch:          25,
		MaxRequestExpiresSeconds: 120,
		MaxRequestMaxBytes:       2048,
		BackoffSeconds:           []int64{1, 5},
		ReplayPolicy:             "original",
		DeliverPolicy:            "start_sequence",
		OptStartSeq:              42,
		HeadersOnly:              true,
		Replicas:                 3,
		MemoryStorage:            true,
		InactiveThresholdSeconds: 60,
	}
	cfg := ConsumerFormToConfig(&f)
	if cfg.Durable != "worker" || cfg.Name != "worker" || cfg.Description != "d" {
		t.Fatalf("identity mapping wrong: %+v", cfg)
	}
	if cfg.DeliverSubject != "out.worker" || cfg.DeliverGroup != "grp" {
		t.Fatalf("push deliver subject/group wrong: %+v", cfg)
	}
	if len(cfg.FilterSubjects) != 1 || cfg.FilterSubjects[0] != "orders.>" {
		t.Fatalf("filter subjects wrong: %+v", cfg.FilterSubjects)
	}
	if cfg.AckPolicy != api.AckExplicit {
		t.Fatalf("ack policy wrong: %v", cfg.AckPolicy)
	}
	if cfg.AckWait != 30*time.Second || cfg.MaxRequestExpires != 120*time.Second || cfg.InactiveThreshold != 60*time.Second {
		t.Fatalf("duration mapping wrong: %+v", cfg)
	}
	if cfg.MaxDeliver != 5 || cfg.MaxWaiting != 8 || cfg.MaxAckPending != 100 {
		t.Fatalf("limits mapping wrong: %+v", cfg)
	}
	if cfg.MaxRequestBatch != 25 || cfg.MaxRequestMaxBytes != 2048 {
		t.Fatalf("pull request limits wrong: %+v", cfg)
	}
	if len(cfg.BackOff) != 2 || cfg.BackOff[0] != time.Second || cfg.BackOff[1] != 5*time.Second {
		t.Fatalf("backoff mapping wrong: %+v", cfg.BackOff)
	}
	if cfg.ReplayPolicy != api.ReplayOriginal {
		t.Fatalf("replay policy wrong: %v", cfg.ReplayPolicy)
	}
	if cfg.DeliverPolicy != api.DeliverByStartSequence || cfg.OptStartSeq != 42 {
		t.Fatalf("deliver policy mapping wrong: %v %d", cfg.DeliverPolicy, cfg.OptStartSeq)
	}
	if !cfg.HeadersOnly || cfg.Replicas != 3 || !cfg.MemoryStorage {
		t.Fatalf("flags mapping wrong: %+v", cfg)
	}

	// Pull mode must not leak a deliver subject even if the form carries one.
	pull := consumerFormBase()
	pull.DeliverMode = "pull"
	pull.DeliverSubject = "out.worker"
	cfgPull := ConsumerFormToConfig(&pull)
	if cfgPull.DeliverSubject != "" || cfgPull.DeliverGroup != "" {
		t.Fatalf("pull mode must clear deliver subject/group: %+v", cfgPull)
	}

	// Deliver policy closed set.
	dp := []struct {
		form string
		want api.DeliverPolicy
	}{
		{"all", api.DeliverAll},
		{"last", api.DeliverLast},
		{"new", api.DeliverNew},
	}
	for _, c := range dp {
		f := consumerFormBase()
		f.DeliverPolicy = c.form
		if got := ConsumerFormToConfig(&f).DeliverPolicy; got != c.want {
			t.Fatalf("deliver policy %s: got %v want %v", c.form, got, c.want)
		}
	}
	st := consumerFormBase()
	st.DeliverPolicy = "start_time"
	st.OptStartTimeMs = 1700000000000
	cfgSt := ConsumerFormToConfig(&st)
	if cfgSt.DeliverPolicy != api.DeliverByStartTime || cfgSt.OptStartTime == nil || cfgSt.OptStartTime.UnixMilli() != 1700000000000 {
		t.Fatalf("start_time mapping wrong: %+v", cfgSt)
	}

	// ack none → MaxDeliver -1 (natscli-style server rejection workaround).
	none := consumerFormBase()
	none.AckPolicy = "none"
	none.MaxDeliver = 5
	cfgNone := ConsumerFormToConfig(&none)
	if cfgNone.AckPolicy != api.AckNone || cfgNone.MaxDeliver != -1 {
		t.Fatalf("ack none mapping wrong: %+v", cfgNone)
	}
	all := consumerFormBase()
	all.AckPolicy = "all"
	if got := ConsumerFormToConfig(&all).AckPolicy; got != api.AckAll {
		t.Fatalf("ack all mapping wrong: %v", got)
	}
}

func TestBuildConsumerSummary(t *testing.T) {
	created := time.Unix(1700000000, 0)
	info := api.ConsumerInfo{
		Stream: "ORDERS",
		Name:   "worker",
		Config: api.ConsumerConfig{
			Durable:       "worker",
			DeliverPolicy: api.DeliverAll,
			AckPolicy:     api.AckExplicit,
			ReplayPolicy:  api.ReplayInstant,
			FilterSubject: "orders.>",
		},
		Created:        created,
		Delivered:      api.SequenceInfo{Consumer: 9, Stream: 100},
		AckFloor:       api.SequenceInfo{Consumer: 7, Stream: 98},
		NumAckPending:  3,
		NumRedelivered: 2,
		NumWaiting:     4,
		NumPending:     55,
		Cluster: &api.ClusterInfo{Leader: "n1", Replicas: []*api.PeerInfo{
			{Name: "n2", Current: false},
		}},
		Paused:         true,
		PauseRemaining: 1500 * time.Millisecond,
	}
	s := BuildConsumerSummary(info)
	if s.Name != "worker" || s.Stream != "ORDERS" {
		t.Fatalf("identity wrong: %+v", s)
	}
	if !s.IsPull || s.IsEphemeral {
		t.Fatalf("pull/ephemeral flags wrong: %+v", s)
	}
	if s.AckPolicy != "explicit" || s.DeliverPolicy != "all" {
		t.Fatalf("policies wrong: %+v", s)
	}
	if len(s.FilterSubjects) != 1 || s.FilterSubjects[0] != "orders.>" {
		t.Fatalf("filter subjects wrong: %+v", s.FilterSubjects)
	}
	if s.NumPending != 55 || s.NumAckPending != 3 || s.AckFloorConsumer != 7 {
		t.Fatalf("pending/ack state wrong: %+v", s)
	}
	if s.NumRedelivered != 2 || s.NumWaiting != 4 || s.DeliveredConsumerSeq != 9 {
		t.Fatalf("delivery state wrong: %+v", s)
	}
	if !s.Paused || s.PauseRemainingMs != 1500 || s.CreatedMs != 1700000000000 {
		t.Fatalf("pause/created wrong: %+v", s)
	}
	if s.LeaderMissing || s.UnhealthyReplicas != 1 || s.ReplicaCount != 2 {
		t.Fatalf("cluster columns wrong: %+v", s)
	}

	// Push ephemeral consumer: no durable, deliver subject set → push.
	push := api.ConsumerInfo{
		Stream: "ORDERS",
		Name:   "eph",
		Config: api.ConsumerConfig{
			DeliverSubject: "out.eph",
			AckPolicy:      api.AckNone,
			DeliverPolicy:  api.DeliverNew,
			ReplayPolicy:   api.ReplayOriginal,
		},
		Created: created,
	}
	ps := BuildConsumerSummary(push)
	if ps.IsPull || !ps.IsEphemeral {
		t.Fatalf("push/ephemeral flags wrong: %+v", ps)
	}
	if ps.AckPolicy != "none" || ps.DeliverPolicy != "new" {
		t.Fatalf("push policies wrong: %+v", ps)
	}
	if ps.FilterSubjects != nil {
		t.Fatalf("no filters expected: %+v", ps.FilterSubjects)
	}
	if ps.PauseRemainingMs != 0 {
		t.Fatalf("pause remaining must be 0 when unset: %d", ps.PauseRemainingMs)
	}

	// Leader-less cluster and multi-filter consumer.
	multi := api.ConsumerInfo{
		Stream: "ORDERS",
		Name:   "mf",
		Config: api.ConsumerConfig{
			Durable:        "mf",
			DeliverSubject: "out",
			FilterSubjects: []string{"a", "b"},
		},
		Cluster: &api.ClusterInfo{Leader: "", Replicas: []*api.PeerInfo{
			{Name: "n2", Current: true}, {Name: "n3", Offline: true},
		}},
	}
	ms := BuildConsumerSummary(multi)
	if !ms.LeaderMissing || ms.UnhealthyReplicas != 1 || ms.ReplicaCount != 2 {
		t.Fatalf("leader-missing cluster columns wrong: %+v", ms)
	}
	if len(ms.FilterSubjects) != 2 || ms.FilterSubjects[0] != "a" || ms.FilterSubjects[1] != "b" {
		t.Fatalf("multi filter subjects wrong: %+v", ms.FilterSubjects)
	}
}

func TestEncodeBrowserMsg(t *testing.T) {
	// api.StoredMsg.Header blocks include the NATS/1.0 preamble.
	raw := []byte("NATS/1.0\r\nHdr: v\r\n\r\n")
	data := []byte("hello 世界")
	m := EncodeBrowserMsg("orders.new", raw, data, 7, time.Unix(1700000000, 0))
	if m.Seq != 7 || m.Subject != "orders.new" || m.TimestampMs != 1700000000000 {
		t.Fatalf("metadata wrong: %+v", m)
	}
	if !m.IsUtf8 {
		t.Fatal("utf8 payload must be detected")
	}
	if len(m.Headers) != 1 {
		t.Fatalf("expected 1 header key, got %+v", m.Headers)
	}
	if got := m.Headers["Hdr"]; len(got) != 1 || got[0] != "v" {
		t.Fatalf("header value wrong: %+v", m.Headers)
	}
	dec, err := base64.StdEncoding.DecodeString(m.PayloadB64)
	if err != nil || string(dec) != string(data) {
		t.Fatalf("b64 roundtrip failed: %q %v", m.PayloadB64, err)
	}
	if m.PayloadSize != len(data) {
		t.Fatalf("payload size wrong: %d", m.PayloadSize)
	}
	if m.Truncated {
		t.Fatal("must not be truncated by default")
	}

	// Binary payload → not UTF-8; malformed header block → Headers nil, no panic.
	bin := EncodeBrowserMsg("s", []byte("Hdr: v\r\n"), []byte{0xff, 0xfe}, 1, time.Unix(0, 0))
	if bin.IsUtf8 {
		t.Fatal("binary payload must not be utf8")
	}
	if bin.Headers != nil {
		t.Fatalf("malformed header block must yield nil headers, got %+v", bin.Headers)
	}

	// Empty header block → Headers nil.
	none := EncodeBrowserMsg("s", nil, []byte("x"), 1, time.Unix(0, 0))
	if none.Headers != nil {
		t.Fatalf("empty header block must yield nil headers, got %+v", none.Headers)
	}
}

func TestDecodeHeaders(t *testing.T) {
	// Status line with an error code: valid preamble, no headers.
	hdr, err := decodeHeaders([]byte("NATS/1.0 503\r\n\r\n"))
	if err != nil {
		t.Fatalf("status-line block must decode: %v", err)
	}
	if len(hdr) != 0 {
		t.Fatalf("expected empty headers, got %+v", hdr)
	}

	// Multi-value header.
	hdr, err = decodeHeaders([]byte("NATS/1.0\r\nK: a\r\nK: b\r\n\r\n"))
	if err != nil {
		t.Fatalf("multi-value block must decode: %v", err)
	}
	if got := hdr["K"]; len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("multi-value header wrong: %+v", hdr)
	}

	// Missing preamble → error.
	if _, err := decodeHeaders([]byte("Hdr: v\r\n")); err == nil {
		t.Fatal("missing preamble must error")
	}
	// Empty input → error.
	if _, err := decodeHeaders(nil); err == nil {
		t.Fatal("empty block must error")
	}
}

// TestStreamConfigToFormEchoesWorkqueueAndSources covers the config→form
// direction (the edit/copy form echo): non-limits retention policies must
// round-trip (a workqueue stream's edit form must not silently become
// "limits"), and mirror/sources must echo back with nil entries skipped.
func TestStreamConfigToFormEchoesWorkqueueAndSources(t *testing.T) {
	cfg := api.StreamConfig{
		Name:      "WQ",
		Storage:   api.MemoryStorage,
		Retention: api.WorkQueuePolicy,
		Mirror:    &api.StreamSource{Name: "up", FilterSubject: "up.>", OptStartSeq: 7},
		Sources:   []*api.StreamSource{{Name: "s1", FilterSubject: "s1.>", OptStartSeq: 3}, nil},
	}
	f := configToForm(cfg)
	if f.Retention != "workqueue" || f.Storage != "memory" {
		t.Fatalf("retention/storage echo wrong: %+v", f)
	}
	if f.Mirror == nil || f.Mirror.Name != "up" || f.Mirror.FilterSubject != "up.>" || f.Mirror.OptStartSeq != 7 {
		t.Fatalf("mirror echo wrong: %+v", f.Mirror)
	}
	if len(f.Sources) != 1 || f.Sources[0].Name != "s1" { // nil source skipped
		t.Fatalf("sources echo wrong: %+v", f.Sources)
	}
	if got := retentionFromAPI(api.InterestPolicy); got != "interest" {
		t.Fatalf("interest echo wrong: %q", got)
	}
	// form → config keeps the echoed mirror/sources (copy-stream fidelity).
	out := StreamFormToConfig(&f)
	if out.Mirror == nil || out.Mirror.Name != "up" || len(out.Sources) != 1 || out.Sources[0].Name != "s1" {
		t.Fatalf("mirror/sources round trip wrong: %+v", out)
	}
}
