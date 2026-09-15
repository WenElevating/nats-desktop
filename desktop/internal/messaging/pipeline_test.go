package messaging

import (
	"encoding/json"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// --- ring -----------------------------------------------------------------

func TestRingDropsOldestAndCounts(t *testing.T) {
	r := newRing(3)
	for i := int64(1); i <= 5; i++ {
		r.Add(MsgOut{Seq: i})
	}
	if r.Dropped() != 2 {
		t.Fatalf("dropped = %d want 2", r.Dropped())
	}
	got := r.Snapshot(10)
	if len(got) != 3 || got[0].Seq != 3 || got[2].Seq != 5 {
		t.Fatalf("ring contents: %+v", got)
	}
}

func TestRingSnapshotOrderEdge(t *testing.T) {
	r := newRing(1)
	r.Add(MsgOut{Seq: 1})
	r.Add(MsgOut{Seq: 2})
	r.Add(MsgOut{Seq: 3})
	if r.Dropped() != 2 {
		t.Fatalf("capacity-1 ring: dropped = %d want 2", r.Dropped())
	}
	got := r.Snapshot(5)
	if len(got) != 1 || got[0].Seq != 3 {
		t.Fatalf("capacity-1 ring snapshot = %+v, want only newest Seq=3", got)
	}
	// Partial snapshot: newest n, old→new order.
	r2 := newRing(5)
	for i := int64(1); i <= 5; i++ {
		r2.Add(MsgOut{Seq: i})
	}
	got2 := r2.Snapshot(2)
	if len(got2) != 2 || got2[0].Seq != 4 || got2[1].Seq != 5 {
		t.Fatalf("snapshot(2) = %+v, want [4 5] in old→new order", got2)
	}
	// Degenerate requests.
	if s := r2.Snapshot(0); len(s) != 0 {
		t.Fatalf("snapshot(0) = %+v, want empty", s)
	}
	if s := r2.Snapshot(-1); len(s) != 0 {
		t.Fatalf("snapshot(-1) = %+v, want empty", s)
	}
	// Snapshot must not mutate ring state.
	if r2.Dropped() != 0 {
		t.Fatalf("snapshot changed dropped counter: %d", r2.Dropped())
	}
	if got3 := r2.Snapshot(10); len(got3) != 5 || got3[0].Seq != 1 {
		t.Fatalf("snapshot(10) after partial = %+v, want full ring 1..5", got3)
	}
}

// --- pusher: realtime (16ms/200 micro-batches, M6 crash fix) ---------------

// Low rate: a lone message goes out as a single-element array within the
// 16ms window (plus scheduler ε) — the pre-fix wire shape is preserved.
func TestPusherRealtimeLowRateSingleElement(t *testing.T) {
	var mu sync.Mutex
	var batches [][]MsgOut
	p := newPusher(PushRealtime, func(b []MsgOut) {
		mu.Lock()
		batches = append(batches, b)
		mu.Unlock()
	})
	defer p.Stop()
	p.Add(MsgOut{Seq: 1})

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(batches)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(batches) != 1 || len(batches[0]) != 1 || batches[0][0].Seq != 1 {
		t.Fatalf("low-rate realtime must emit one single-element batch: %+v", batches)
	}
}

// Burst: conservation (all messages delivered exactly once, in order), each
// micro-batch ≤200, and the timer flushes the tail — the contract that keeps
// the wails event mailbox from retaining the backlog (M6 crash fix).
func TestPusherRealtimeBurstConservation(t *testing.T) {
	var mu sync.Mutex
	var got []int64
	var batchMax int
	p := newPusher(PushRealtime, func(b []MsgOut) {
		mu.Lock()
		if len(b) > batchMax {
			batchMax = len(b)
		}
		for _, m := range b {
			got = append(got, m.Seq)
		}
		mu.Unlock()
	})
	const n = 1000
	for i := 1; i <= n; i++ {
		p.Add(MsgOut{Seq: int64(i)})
	}
	// 1000 msgs at a 200 threshold → ≥5 threshold flushes synchronously; the
	// tail flushes within one 16ms tick + ε.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := len(got) >= n
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != n {
		t.Fatalf("conservation: got %d msgs, want %d", len(got), n)
	}
	for i, seq := range got {
		if seq != int64(i+1) {
			t.Fatalf("order broken at %d: got seq %d", i, seq)
		}
	}
	if batchMax > realtimeMaxMsgs {
		t.Fatalf("batch size %d exceeds cap %d", batchMax, realtimeMaxMsgs)
	}
	if n > 100 && batchMax <= 1 {
		t.Fatalf("burst produced only single-element batches — coalescing inactive")
	}
}

// --- pusher: batch (500 threshold / 100ms timer) ---------------------------

type timedBatch struct {
	b  []MsgOut
	at time.Time
}

func TestPusherBatchFlushesAt500OrTimer(t *testing.T) {
	t.Run("500_adds_flush_immediately_before_timer", func(t *testing.T) {
		ch := make(chan timedBatch, 4)
		p := newPusher(PushBatch, func(b []MsgOut) { ch <- timedBatch{b: b, at: time.Now()} })
		defer p.Stop()

		start := time.Now()
		for i := 0; i < 500; i++ {
			p.Add(MsgOut{Seq: int64(i + 1)})
		}
		select {
		case res := <-ch:
			// The 500th Add must flush synchronously; the timer period is
			// 100ms, so any flush stamped at/after 100ms came from the timer
			// and the threshold flush is broken.
			if el := res.at.Sub(start); el >= 100*time.Millisecond {
				t.Fatalf("500-add flush took %v (>= timer period): flush came from timer, not threshold", el)
			}
			if len(res.b) != 500 {
				t.Fatalf("batch len = %d want 500", len(res.b))
			}
			for i, m := range res.b {
				if m.Seq != int64(i+1) {
					t.Fatalf("batch[%d].Seq = %d want %d (order must be old→new)", i, m.Seq, i+1)
				}
			}
		case <-time.After(2 * time.Second):
			t.Fatal("no flush after 500 adds")
		}
	})

	t.Run("fewer_adds_flush_via_timer", func(t *testing.T) {
		ch := make(chan timedBatch, 4)
		p := newPusher(PushBatch, func(b []MsgOut) { ch <- timedBatch{b: b, at: time.Now()} })
		defer p.Stop()

		start := time.Now()
		p.Add(MsgOut{Seq: 1})
		p.Add(MsgOut{Seq: 2})
		p.Add(MsgOut{Seq: 3})
		select {
		case res := <-ch:
			el := res.at.Sub(start)
			// Timer fires at 100ms; allow 3x margin for CI scheduling jitter.
			if el > 300*time.Millisecond {
				t.Fatalf("timer flush took %v, want ~100ms", el)
			}
			if el < 50*time.Millisecond {
				t.Fatalf("flush after %v is too early to be the 100ms timer", el)
			}
			if len(res.b) != 3 || res.b[0].Seq != 1 || res.b[2].Seq != 3 {
				t.Fatalf("timer batch = %+v want seqs 1..3 old→new", res.b)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("no timer flush within 2s for 3 buffered messages")
		}
	})
}

func TestPusherStopTerminates(t *testing.T) {
	before := runtime.NumGoroutine()
	var emits atomic.Int64
	p := newPusher(PushBatch, func(b []MsgOut) { emits.Add(int64(len(b))) })
	p.Add(MsgOut{Seq: 1})
	p.Add(MsgOut{Seq: 2})
	p.Add(MsgOut{Seq: 3})

	p.Stop()
	p.Stop() // Stop must be idempotent.

	// After Stop returns, the internal goroutine is gone: wait past one full
	// timer period and prove no further emits occur, then Add must be a no-op.
	time.Sleep(250 * time.Millisecond)
	if got := emits.Load(); got != 0 {
		t.Fatalf("emits after Stop = %d want 0", got)
	}
	p.Add(MsgOut{Seq: 4})
	p.Flush()
	time.Sleep(150 * time.Millisecond)
	if got := emits.Load(); got != 0 {
		t.Fatalf("emits after Stop+Add = %d want 0 (Add/Flush must be no-ops after Stop)", got)
	}

	// Goroutine leak check: poll up to 2s for NumGoroutine to return to baseline.
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before {
		t.Fatalf("goroutine leak: before=%d after=%d", before, after)
	}
}

func TestPusherFlushDrainsPartialBatch(t *testing.T) {
	var mu sync.Mutex
	var total int
	p := newPusher(PushBatch, func(b []MsgOut) {
		mu.Lock()
		total += len(b)
		mu.Unlock()
	})
	p.Add(MsgOut{Seq: 1})
	p.Add(MsgOut{Seq: 2})
	p.Flush()
	mu.Lock()
	if total != 2 {
		t.Fatalf("flushed total = %d want 2", total)
	}
	mu.Unlock()
	// Flush on empty buffer must not emit.
	p.Flush()
	mu.Lock()
	if total != 2 {
		t.Fatalf("second flush emitted; total = %d want 2", total)
	}
	mu.Unlock()
}

func TestPusherConcurrentAddHammer(t *testing.T) {
	var emits atomic.Int64
	p := newPusher(PushBatch, func(b []MsgOut) {
		if len(b) > 500 {
			t.Errorf("batch len %d exceeds 500", len(b))
		}
		emits.Add(int64(len(b)))
	})
	const goroutines, perG = 8, 1000
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				p.Add(MsgOut{Seq: 1})
			}
		}()
	}
	wg.Wait()
	p.Flush()
	if got := emits.Load(); got != goroutines*perG {
		t.Fatalf("emitted = %d want %d (messages must not be lost or duplicated)", got, goroutines*perG)
	}
	p.Stop()
}

// --- rateMeter --------------------------------------------------------------

func TestRateMeterWindow(t *testing.T) {
	r := newRateMeter(time.Second)
	for i := 0; i < 50; i++ {
		r.Inc()
	}
	if got := int(r.Rate()); got < 40 || got > 60 {
		t.Fatalf("rate = %v", got)
	}
}

// --- isUTF8 -----------------------------------------------------------------

func TestIsUTF8(t *testing.T) {
	if !isUTF8([]byte("hello 世界")) {
		t.Fatal("valid UTF-8 text reported invalid")
	}
	if !isUTF8([]byte{}) {
		t.Fatal("empty payload must be treated as valid UTF-8")
	}
	if !isUTF8(nil) {
		t.Fatal("nil payload must be treated as valid UTF-8")
	}
	if isUTF8([]byte{'h', 0xff, 'i'}) {
		t.Fatal("invalid bytes reported as UTF-8")
	}
	if isUTF8([]byte{0xed, 0xa0, 0x80}) {
		t.Fatal("surrogate encoding (CESU) must be rejected")
	}
}

// --- wire contract (MsgOut json tags are frozen, spec §7.1.3) ---------------

func TestMsgOutJSONContract(t *testing.T) {
	m := MsgOut{
		SessionID:   "sub-1",
		Seq:         1204331,
		Subject:     "orders.received",
		Headers:     map[string][]string{"Nats-Msg-Id": {"9f8c"}},
		PayloadB64:  "eyJvcmRlciI6MTIzfQ==",
		PayloadSize: 15,
		Timestamp:   "2026-09-11T10:42:07.123Z",
		StreamSeq:   88231,
		IsUTF8:      true,
	}
	got, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"session_id":"sub-1","seq":1204331,"subject":"orders.received","headers":{"Nats-Msg-Id":["9f8c"]},"payload_b64":"eyJvcmRlciI6MTIzfQ==","payload_size":15,"timestamp":"2026-09-11T10:42:07.123Z","stream_seq":88231,"is_utf8":true}`
	if string(got) != want {
		t.Fatalf("MsgOut JSON drifted from §7.1.3 contract:\n got  %s\n want %s", got, want)
	}
	// omitempty: headers absent when nil, stream_seq absent when 0.
	zero, err := json.Marshal(MsgOut{})
	if err != nil {
		t.Fatal(err)
	}
	wantZero := `{"session_id":"","seq":0,"subject":"","payload_b64":"","payload_size":0,"timestamp":"","is_utf8":false}`
	if string(zero) != wantZero {
		t.Fatalf("zero MsgOut JSON wrong:\n got  %s\n want %s", zero, wantZero)
	}
}

// --- throughput floor (sanity; real bench lands in Task 11) -----------------

func TestPipelineThroughputSanity(t *testing.T) {
	const n = 100000
	r := newRing(10000)
	p := newPusher(PushRealtime, func([]MsgOut) {}) // noop emit: pure pipeline cost
	defer p.Stop()

	start := time.Now()
	for i := 0; i < n; i++ {
		m := MsgOut{
			Seq:         int64(i + 1),
			Subject:     "flood.subject",
			PayloadB64:  "eyJvcmRlciI6MTIzfQ==",
			PayloadSize: 15,
		}
		r.Add(m)
		p.Add(m)
	}
	elapsed := time.Since(start)
	t.Logf("throughput: %d msgs through ring+realtime-pusher in %v (%.0f msg/s)", n, elapsed, float64(n)/elapsed.Seconds())
	if elapsed >= 2*time.Second {
		t.Fatalf("throughput floor breached: %v for %d msgs (want < 2s)", elapsed, n)
	}
	// Bulk run doubles as a drop-accounting check: cap 10000 must drop exactly n-10000.
	if d := r.Dropped(); d != n-10000 {
		t.Fatalf("ring dropped = %d want %d", d, n-10000)
	}
}

// --- header filters (spec §6.4 optional header filter, Go-side match) -------

func TestHeadersMatchFilters(t *testing.T) {
	h := nats.Header{"Env": {"prod"}, "X-B": {"2"}}
	if !HeadersMatchFilters(h, nil) || !HeadersMatchFilters(h, map[string]string{}) {
		t.Fatal("empty filters must match everything")
	}
	if !HeadersMatchFilters(h, map[string]string{"Env": "prod"}) {
		t.Fatal("single exact match")
	}
	if !HeadersMatchFilters(h, map[string]string{"Env": "prod", "X-B": "2"}) {
		t.Fatal("AND match")
	}
	for _, f := range []map[string]string{
		{"Env": "dev"}, {"env": "prod"}, {"Missing": "x"}, {"Env": "prod", "Missing": "x"},
	} {
		if HeadersMatchFilters(h, f) {
			t.Fatalf("must not match %v", f)
		}
	}
}

func TestHeaderMatchPerformance(t *testing.T) {
	if raceEnabled {
		t.Skip("perf budget not meaningful under -race instrumentation")
	}
	h := nats.Header{"Env": {"prod"}, "Svc": {"orders"}, "Ver": {"3"}}
	filters := map[string]string{"Env": "prod", "Svc": "orders"}
	start := time.Now()
	const n = 1_000_000
	for i := 0; i < n; i++ {
		HeadersMatchFilters(h, filters)
	}
	per := time.Since(start) / n
	if per > 500*time.Nanosecond { // 洪峰 50k/s 时占预算 <2.5%（预算 20µs/msg）
		t.Fatalf("filter too slow: %v/match", per)
	}
}
