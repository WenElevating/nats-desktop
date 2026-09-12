// Hermetic pipeline performance gate (Task 11, spec §12 capacity line + 低配档
// mandate). The unit under test is the Task 2 hot path: ring.Add + realtime
// pusher.Add with a noop emit sink. The 50,000 msg/s floor is the spec's flood
// injection line (规格洪峰注入 5 万/s 的管线容量底线) and sits ~200x below Task
// 2's measured ~12M msg/s, so it must pass deterministically even on 2-core CI
// containers — the desktop-ci `bench` job runs TestPipelineThroughputFloor
// under `docker --cpus 2` as the low-spec gate.

package messaging

import (
	"encoding/base64"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// benchMsg is the 1KB-payload message reused across iterations. Base64/JSON
// assembly happens upstream in buildMsgOut and is deliberately excluded: the
// gate measures the ring+pusher pipeline itself. The payload bytes are baked
// once so per-iteration cost is ring accounting + pusher emit only.
var benchMsg = func() MsgOut {
	payload := make([]byte, 1024)
	for i := range payload {
		payload[i] = byte('a' + i%26)
	}
	return MsgOut{
		Subject:     "bench.pipeline",
		PayloadB64:  base64.StdEncoding.EncodeToString(payload),
		PayloadSize: len(payload),
	}
}()

// BenchmarkPipelineThroughput measures sustained ring+realtime-pusher
// throughput against a noop sink. Reported as ns/op plus an explicit msg/s
// metric:
//
//	go test ./internal/messaging/ -bench BenchmarkPipelineThroughput -benchmem
func BenchmarkPipelineThroughput(b *testing.B) {
	b.ReportAllocs()
	r := newRing(10000)
	p := newPusher(PushRealtime, func([]MsgOut) {}) // noop emit: pure pipeline cost
	defer p.Stop()

	start := time.Now()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r.Add(benchMsg)
		p.Add(benchMsg)
	}
	elapsed := time.Since(start)
	b.ReportMetric(float64(b.N)/elapsed.Seconds(), "msg/s")
}

// BenchmarkHeaderFilterPipeline (Task 14) measures the Task 6 receive path
// with an ACTIVE header filter: session.handle = HeadersMatchFilters +
// buildMsgOut (base64 + header deep-copy + utf8) + deliver (rate meter, ring,
// realtime pusher, throttled state notify) — 100,000 receipts per op, pure
// logic (no server; the NATS callback is invoked directly with a crafted
// nats.Msg). This is the flood-time per-message cost a filtered session pays,
// complementing TestHeaderMatchPerformance (filter alone) and
// BenchmarkPipelineThroughput (pipeline alone, no filter):
//
//	go test ./internal/messaging/ -bench BenchmarkHeaderFilterPipeline -benchmem
func BenchmarkHeaderFilterPipeline(b *testing.B) {
	s := newSession("bench", "bench.filter.>", nil, PushRealtime, 10000,
		map[string]string{"Env": "prod", "Svc": "orders"},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		func(string, any) {}, // noop emit: pure deliver cost
	)
	m := &nats.Msg{
		Subject: "bench.filter.a",
		Header:  nats.Header{"Env": {"prod"}, "Svc": {"orders"}, "Ver": {"3"}},
		Data:    make([]byte, 1024),
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s.handle(m)
	}
	b.StopTimer()
	// Every receipt must have cleared the filter and been delivered exactly
	// once (conservation: received == total + filtered, filtered == 0).
	if got := s.filtered.Load(); got != 0 {
		b.Fatalf("filtered = %d, want 0", got)
	}
	if got := s.seq.Load(); got != int64(b.N) {
		b.Fatalf("seq = %d, want %d", got, b.N)
	}
}

// TestPipelineThroughputFloor is the CI gate: the pipeline must sustain at
// least pipelineFloorMsgS over a sampling window (at least minSampleMsgs and
// minSampleTime, so a single scheduling hiccup on a busy 2-core runner cannot
// decide the result). Also asserts the ring's drop accounting stays exact
// while flooding — throughput must not come from corrupted accounting.
func TestPipelineThroughputFloor(t *testing.T) {
	const (
		floorMsgS     = 50000              // spec §12: 洪峰注入 5 万/s 管线容量底线
		minSampleMsgs = 50000              // the spec's flood burst, as a sample minimum
		minSampleTime = 250 * time.Millisecond // noise-smoothing window
		batch         = 10000
		ringCap       = 10000
	)

	r := newRing(ringCap)
	p := newPusher(PushRealtime, func([]MsgOut) {}) // noop emit: pure pipeline cost
	defer p.Stop()

	var n int
	start := time.Now()
	for {
		for i := 0; i < batch; i++ {
			r.Add(benchMsg)
			p.Add(benchMsg)
		}
		n += batch
		if n >= minSampleMsgs && time.Since(start) >= minSampleTime {
			break
		}
	}
	elapsed := time.Since(start)
	rate := float64(n) / elapsed.Seconds()
	t.Logf("pipeline throughput: %d msgs (1KB payload) in %v => %.0f msg/s (floor %d msg/s)", n, elapsed, rate, floorMsgS)
	if rate < floorMsgS {
		t.Fatalf("pipeline throughput %.0f msg/s below the %d msg/s floor (%d msgs in %v)", rate, floorMsgS, n, elapsed)
	}

	// Drop accounting must stay exact at flood rate: cap 10000 ring fed n
	// messages must report exactly n-10000 evictions.
	if want := int64(n - ringCap); r.Dropped() != want {
		t.Fatalf("ring dropped = %d want %d (accounting drifted during flood)", r.Dropped(), want)
	}
	if got := r.Snapshot(ringCap); len(got) != ringCap || got[ringCap-1].Subject != benchMsg.Subject {
		t.Fatalf("ring end state wrong: len=%d newest=%+v", len(got), got[ringCap-1])
	}
}
