package messaging

// JetStream positioned replay sessions (spec §6.4 / Task 5). Every scenario
// runs twice: hermetic (embedded testutil.StartJSServer) and against the
// mandated real local nats-server (localServerURL, JS enabled). Each test
// creates a throwaway memory stream (unique name M2T5-<SCENARIO>-<suffix>,
// subject space m2t5.<scenario>.<suffix>.>) deleted via t.Cleanup, so runs
// never collide on the shared server. Payloads live only in the in-memory
// emit recorder — nothing is logged (spec §13.3).
//
// A core publish to a stream-covered subject lands in the stream, so fixtures
// publish via plain nc.Publish + Flush; the per-test exclusive subject space
// makes the stream sequence deterministic (first message = seq 1).

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// jsStreamFixture creates a per-test throwaway memory stream covering the
// "<space>.>" wildcard and returns one concrete publish subject under it.
func jsStreamFixture(t *testing.T, nc *nats.Conn, scenario, sfx string) string {
	t.Helper()
	name := "M2T5-" + strings.ToUpper(scenario) + "-" + sfx
	space := "m2t5." + scenario + "." + sfx
	createJSStream(t, nc, name, space+".>")
	return space + ".one"
}

// waitEmitted polls until session id has emitted at least want messages and
// returns the count seen.
func waitEmitted(t *testing.T, rec *emitRecorder, id string, want int, timeout time.Duration) int {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if got := rec.msgCount(id); got >= want {
			return got
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("session %s emitted %d messages, want >= %d within %v", id, rec.msgCount(id), want, timeout)
	return 0
}

// emittedStreamSeqs returns the StreamSeq of every emitted message of id, in
// emit order.
func emittedStreamSeqs(rec *emitRecorder, id string) []int64 {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	var out []int64
	for _, tb := range rec.batches {
		if len(tb.b) == 0 || tb.b[0].SessionID != id {
			continue
		}
		for _, m := range tb.b {
			out = append(out, m.StreamSeq)
		}
	}
	return out
}

// --- scenario functions (parameterized over server URL) ------------------------

// scenarioJSReplayAll (brief 1): 100 pre-published messages -> CreateSession
// with mode all -> exactly those 100 are replayed once, StreamSeq 1..100
// monotonic in emit order, and the session stays running afterwards (replay
// completion does not auto-close it).
func scenarioJSReplayAll(t *testing.T, url string) {
	t.Helper()
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)
	nc := connect(t, url)
	subj := jsStreamFixture(t, nc, "all", uniqueSuffix())

	const n = 100
	burstPublish(t, nc, subj, n, n, 0, []byte("js-all"))

	st, err := sm.CreateSession(context.Background(), SessionSpec{
		Subject: subj, JSPosition: &JSPosition{Mode: jsModeAll}})
	if err != nil {
		t.Fatal(err)
	}
	if st.State != SessionRunning {
		t.Fatalf("initial state = %q, want running", st.State)
	}
	waitEmitted(t, rec, st.ID, n, 15*time.Second)
	waitQuiescent(t, sm, st.ID, 10*time.Second)
	time.Sleep(200 * time.Millisecond) // any duplicate/delayed replay would land here
	if got := rec.msgCount(st.ID); got != n {
		t.Fatalf("emitted = %d, want exactly %d (no duplicates, no losses)", got, n)
	}

	seqs := emittedStreamSeqs(rec, st.ID)
	if len(seqs) != n {
		t.Fatalf("got %d stream seqs, want %d", len(seqs), n)
	}
	for i, sq := range seqs {
		if sq != int64(i+1) {
			t.Fatalf("StreamSeq[%d] = %d, want %d (must be 1..%d monotonic)", i, sq, i+1, n)
		}
	}

	final := findState2(t, sm, st.ID)
	if final.State != SessionRunning || final.Total != n {
		t.Fatalf("final state = %q Total = %d, want running/%d (replay must not auto-close)", final.State, final.Total, n)
	}
}

// scenarioJSReplayFromSequence (brief 2): start_sequence=50 over a 100-message
// stream replays exactly seqs 50..100 — 50 messages, first StreamSeq 50.
func scenarioJSReplayFromSequence(t *testing.T, url string) {
	t.Helper()
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)
	nc := connect(t, url)
	subj := jsStreamFixture(t, nc, "seq", uniqueSuffix())

	const n, from = 100, 50
	burstPublish(t, nc, subj, n, n, 0, []byte("js-seq"))

	st, err := sm.CreateSession(context.Background(), SessionSpec{
		Subject:    subj,
		JSPosition: &JSPosition{Mode: jsModeStartSequence, StartSeq: from}})
	if err != nil {
		t.Fatal(err)
	}
	waitEmitted(t, rec, st.ID, n-from+1, 15*time.Second)
	final := waitQuiescent(t, sm, st.ID, 10*time.Second)
	time.Sleep(200 * time.Millisecond)
	if got := rec.msgCount(st.ID); got != n-from+1 {
		t.Fatalf("emitted = %d, want exactly %d (stream seqs %d..%d)", got, n-from+1, from, n)
	}
	if final.Total != n-from+1 {
		t.Fatalf("Total = %d, want %d", final.Total, n-from+1)
	}
	seqs := emittedStreamSeqs(rec, st.ID)
	if len(seqs) != n-from+1 {
		t.Fatalf("got %d stream seqs, want %d", len(seqs), n-from+1)
	}
	if seqs[0] != from {
		t.Fatalf("first StreamSeq = %d, want %d", seqs[0], from)
	}
	for i, sq := range seqs {
		if sq != int64(from+i) {
			t.Fatalf("StreamSeq[%d] = %d, want %d", i, sq, from+i)
		}
	}
}

// scenarioJSReplayNew (brief 3): the session is created BEFORE publishing and
// receives only messages published afterwards. The 5 pre-existing stream
// messages (stream seqs 1..5) are never delivered; the 7 new ones carry their
// true stream seqs 6..12 (the stream sequence continues, it does not restart).
func scenarioJSReplayNew(t *testing.T, url string) {
	t.Helper()
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)
	nc := connect(t, url)
	subj := jsStreamFixture(t, nc, "new", uniqueSuffix())

	burstPublish(t, nc, subj, 5, 5, 0, []byte("pre"))

	st, err := sm.CreateSession(context.Background(), SessionSpec{
		Subject: subj, JSPosition: &JSPosition{Mode: jsModeNew}})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond) // a replay of the 5 pre-messages would land here
	if got := rec.msgCount(st.ID); got != 0 {
		t.Fatalf("mode new received %d pre-existing messages, want 0", got)
	}

	const n = 7
	burstPublish(t, nc, subj, n, n, 0, []byte("post"))
	waitEmitted(t, rec, st.ID, n, 15*time.Second)
	waitQuiescent(t, sm, st.ID, 10*time.Second)
	if got := rec.msgCount(st.ID); got != n {
		t.Fatalf("emitted = %d, want exactly %d", got, n)
	}
	seqs := emittedStreamSeqs(rec, st.ID)
	if len(seqs) != n {
		t.Fatalf("got %d stream seqs, want %d", len(seqs), n)
	}
	for i, sq := range seqs {
		if want := int64(5 + 1 + i); sq != want {
			t.Fatalf("StreamSeq[%d] = %d, want %d (continues the stream; no pre-messages)", i, sq, want)
		}
	}
}

// scenarioJSReplayStartTime (brief 4): messages stored strictly before the
// RFC3339 start_time never arrive (brief: relaxed assertion = "no old
// messages"); the 10 published after session creation do. 300ms of clock
// margin either side of start absorbs server timestamp resolution.
func scenarioJSReplayStartTime(t *testing.T, url string) {
	t.Helper()
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)
	nc := connect(t, url)
	subj := jsStreamFixture(t, nc, "time", uniqueSuffix())

	const oldN, newN = 30, 10
	burstPublish(t, nc, subj, oldN, oldN, 0, []byte("old-"))
	time.Sleep(300 * time.Millisecond)
	start := time.Now().UTC()
	time.Sleep(150 * time.Millisecond)

	st, err := sm.CreateSession(context.Background(), SessionSpec{
		Subject: subj,
		JSPosition: &JSPosition{Mode: jsModeStart,
			StartTime: start.Format(time.RFC3339Nano)}})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond) // any old-message replay would land here
	if got := rec.countPayloadPrefix(st.ID, "old-"); got != 0 {
		t.Fatalf("received %d messages stored before start_time, want 0", got)
	}

	burstPublish(t, nc, subj, newN, newN, 0, []byte("new-"))
	waitEmitted(t, rec, st.ID, newN, 15*time.Second)
	waitQuiescent(t, sm, st.ID, 10*time.Second)
	if got := rec.countPayloadPrefix(st.ID, "old-"); got != 0 {
		t.Fatalf("received %d old messages after the new burst, want 0", got)
	}
	if got := rec.msgCount(st.ID); got != newN {
		t.Fatalf("emitted = %d, want exactly %d", got, newN)
	}
}

// scenarioJSNoStreamError (brief 5): a subject no stream covers fails the
// create with the mapped "no stream" error (jetstream.ErrStreamNotFound
// remapped for §6.6-style troubleshooting); the session is registered in
// state closed carrying the verbatim error text (spec §6.4).
func scenarioJSNoStreamError(t *testing.T, url string) {
	t.Helper()
	_, sm, _ := newSessionStack(t, url, 10000, PushRealtime)
	subj := "m2t5.nostream." + uniqueSuffix() + ".one" // nothing covers this

	st, err := sm.CreateSession(context.Background(), SessionSpec{
		Subject: subj, JSPosition: &JSPosition{Mode: jsModeAll}})
	if err == nil {
		t.Fatal("CreateSession without a covering stream must fail")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "no stream") {
		t.Fatalf("Error = %q, want it to contain %q", err.Error(), "no stream")
	}
	if st.State != SessionClosed {
		t.Fatalf("returned state = %q, want closed", st.State)
	}
	if !strings.Contains(st.Error, "no stream") {
		t.Fatalf("state Error = %q, want it to contain %q", st.Error, "no stream")
	}
	listed, ok := findState(sm, st.ID)
	if !ok {
		t.Fatal("refused session must remain listable")
	}
	if listed.State != SessionClosed {
		t.Fatalf("listed state = %q, want closed", listed.State)
	}
}

// scenarioJSClosedStopsConsumer (brief 6): Close stops the ConsumeContext —
// nothing more is emitted for the closed session — and leaves no server-side
// residue that blocks a fresh session on the same subject (the acceptance
// proxy for "no consumer leak"). The consume goroutines are gone after Close.
func scenarioJSClosedStopsConsumer(t *testing.T, url string) {
	t.Helper()
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)
	nc := connect(t, url)
	subj := jsStreamFixture(t, nc, "close", uniqueSuffix())

	const n, late = 20, 10
	burstPublish(t, nc, subj, n, n, 0, []byte("pre"))
	st, err := sm.CreateSession(context.Background(), SessionSpec{
		Subject: subj, JSPosition: &JSPosition{Mode: jsModeAll}})
	if err != nil {
		t.Fatal(err)
	}
	waitEmitted(t, rec, st.ID, n, 15*time.Second)

	if err := sm.Close(st.ID); err != nil {
		t.Fatal(err)
	}
	if st1, _ := findState(sm, st.ID); st1.State != SessionClosed {
		t.Fatalf("state after Close = %q, want closed", st1.State)
	}
	burstPublish(t, nc, subj, late, late, 0, []byte("late"))
	time.Sleep(400 * time.Millisecond) // a not-stopped consumer would deliver here
	if got := rec.msgCount(st.ID); got != n {
		t.Fatalf("emits after Close: got %d, want frozen at %d (ConsumeContext not stopped)", got, n)
	}

	// Server side has no leak: a fresh session on the same subject works and
	// replays the whole stream (including the late messages) from `all`.
	st2, err := sm.CreateSession(context.Background(), SessionSpec{
		Subject: subj, JSPosition: &JSPosition{Mode: jsModeAll}})
	if err != nil {
		t.Fatalf("re-create on the same subject after Close: %v", err)
	}
	waitEmitted(t, rec, st2.ID, n+late, 15*time.Second)
	seqs := emittedStreamSeqs(rec, st2.ID)
	if len(seqs) != n+late || seqs[0] != 1 || seqs[len(seqs)-1] != n+late {
		t.Fatalf("replayed seqs len=%d first=%d last=%d, want %d msgs 1..%d",
			len(seqs), seqs[0], seqs[len(seqs)-1], n+late, n+late)
	}

	// Consume goroutines terminate: after Close no goroutine may still run
	// the nats.go jetstream consume loop. The check matches stack signatures
	// rather than a process-wide goroutine count — other tests in the same
	// process (embedded servers, manager conns) tear down asynchronously and
	// make any global baseline flaky. Measured teardown after
	// ConsumeContext.Stop is ~5.5s (bounded by the pull-fetch expiry), hence
	// the generous window.
	if err := sm.Close(st2.ID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) && consumeGoroutineRunning() {
		time.Sleep(100 * time.Millisecond)
	}
	if consumeGoroutineRunning() {
		t.Fatal("jetstream consume goroutines still running after Close (ConsumeContext.Stop not effective)")
	}
}

// consumeGoroutineRunning reports whether any goroutine is currently running
// the nats.go jetstream consume loop (Consume dispatcher or pull fetcher).
func consumeGoroutineRunning() bool {
	buf := make([]byte, 1<<22)
	n := runtime.Stack(buf, true)
	all := string(buf[:n])
	return strings.Contains(all, "nats.go/jetstream.(*pullConsumer).Consume") ||
		strings.Contains(all, "nats.go/jetstream.(*pullSubscription).pullMessages")
}

// scenarioJSReconnectRecreates: on a user-level Disconnect/Connect cycle the
// connected event must re-create the positioned consumer from the SAME
// JSPosition. The position is the replay source of truth: mode all replays
// the stream again (idempotent from the position; no dedup is invented) and
// later messages are delivered exactly once with continuing stream seqs.
func scenarioJSReconnectRecreates(t *testing.T, url string) {
	t.Helper()
	mgr, sm, rec := newSessionStack(t, url, 10000, PushRealtime)
	nc := connect(t, url)
	subj := jsStreamFixture(t, nc, "recon", uniqueSuffix())

	const n, post = 10, 5
	burstPublish(t, nc, subj, n, n, 0, []byte("pre"))
	st, err := sm.CreateSession(context.Background(), SessionSpec{
		Subject: subj, JSPosition: &JSPosition{Mode: jsModeAll}})
	if err != nil {
		t.Fatal(err)
	}
	waitEmitted(t, rec, st.ID, n, 15*time.Second)

	mgr.Disconnect()
	time.Sleep(200 * time.Millisecond)
	if err := mgr.Connect(context.Background(), "sess"); err != nil {
		t.Fatal(err)
	}
	waitManagerConnected(t, mgr, 10*time.Second)

	// The resubscribe worker re-created the consumer from the position: the
	// 10 stored messages replay again in stream order (fresh consumer).
	waitEmitted(t, rec, st.ID, 2*n, 20*time.Second)
	seqs := emittedStreamSeqs(rec, st.ID)
	if len(seqs) != 2*n {
		t.Fatalf("after reconnect: %d stream seqs, want %d (replay from position)", len(seqs), 2*n)
	}
	for i, sq := range seqs {
		if want := int64(i%n + 1); sq != want {
			t.Fatalf("seqs[%d] = %d, want %d (replay must repeat 1..%d in order)", i, sq, want, n)
		}
	}

	// Messages published after the reconnect are delivered exactly once.
	burstPublish(t, nc, subj, post, post, 0, []byte("post"))
	waitEmitted(t, rec, st.ID, 2*n+post, 15*time.Second)
	waitQuiescent(t, sm, st.ID, 10*time.Second)
	if s, _ := findState(sm, st.ID); s.State != SessionRunning {
		t.Fatalf("state after reconnect = %q, want running", s.State)
	}
	seqs = emittedStreamSeqs(rec, st.ID)
	if len(seqs) != 2*n+post {
		t.Fatalf("final: %d stream seqs, want %d", len(seqs), 2*n+post)
	}
	for i, sq := range seqs[2*n:] {
		if want := int64(n + 1 + i); sq != want {
			t.Fatalf("post-reconnect StreamSeq[%d] = %d, want %d (delivered exactly once)", i, sq, want)
		}
	}
}

// --- config mapping (pure logic) ------------------------------------------------

// TestConsumerConfigFor pins the JSPosition -> jetstream.ConsumerConfig
// mapping (aligned with natscli makeConsumerConfig: ephemeral, AckNone,
// filtered to the session subject) plus the local parameter validation.
func TestConsumerConfigFor(t *testing.T) {
	cfg, err := consumerConfigFor(&JSPosition{Mode: jsModeAll}, "s.x")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DeliverPolicy != jetstream.DeliverAllPolicy || cfg.AckPolicy != jetstream.AckNonePolicy || cfg.FilterSubject != "s.x" {
		t.Fatalf("all-mode config wrong: %+v", cfg)
	}

	if cfg, err = consumerConfigFor(&JSPosition{Mode: jsModeNew}, "s.x"); err != nil || cfg.DeliverPolicy != jetstream.DeliverNewPolicy {
		t.Fatalf("new-mode config wrong: %+v err=%v", cfg, err)
	}

	if cfg, err = consumerConfigFor(&JSPosition{Mode: jsModeStartSequence, StartSeq: 42}, "s.x"); err != nil ||
		cfg.DeliverPolicy != jetstream.DeliverByStartSequencePolicy || cfg.OptStartSeq != 42 {
		t.Fatalf("start_sequence config wrong: %+v err=%v", cfg, err)
	}

	ts := time.Date(2026, 9, 11, 12, 0, 0, 0, time.UTC)
	if cfg, err = consumerConfigFor(&JSPosition{Mode: jsModeStart, StartTime: ts.Format(time.RFC3339)}, "s.x"); err != nil ||
		cfg.DeliverPolicy != jetstream.DeliverByStartTimePolicy || cfg.OptStartTime == nil || !cfg.OptStartTime.Equal(ts) {
		t.Fatalf("start_time config wrong: %+v err=%v", cfg, err)
	}

	// Parameter validation.
	if _, err = consumerConfigFor(&JSPosition{Mode: jsModeStartSequence, StartSeq: 0}, "s.x"); err == nil {
		t.Fatal("start_sequence with StartSeq 0 must be rejected")
	}
	if _, err = consumerConfigFor(&JSPosition{Mode: jsModeStart, StartTime: "not-a-time"}, "s.x"); err == nil {
		t.Fatal("start_time with a non-RFC3339 value must be rejected")
	}
	if _, err = consumerConfigFor(&JSPosition{Mode: "bogus"}, "s.x"); err == nil {
		t.Fatal("bogus mode must be rejected")
	}
}

// --- embedded-fixture tests (CI-hermetic path) --------------------------------

func TestJSReplayAll(t *testing.T) {
	scenarioJSReplayAll(t, testutil.StartJSServer(t))
}

func TestJSReplayFromSequence(t *testing.T) {
	scenarioJSReplayFromSequence(t, testutil.StartJSServer(t))
}

func TestJSReplayNew(t *testing.T) {
	scenarioJSReplayNew(t, testutil.StartJSServer(t))
}

func TestJSReplayStartTime(t *testing.T) {
	scenarioJSReplayStartTime(t, testutil.StartJSServer(t))
}

func TestJSNoStreamError(t *testing.T) {
	scenarioJSNoStreamError(t, testutil.StartJSServer(t))
}

func TestJSClosedStopsConsumer(t *testing.T) {
	scenarioJSClosedStopsConsumer(t, testutil.StartJSServer(t))
}

func TestJSReconnectRecreates(t *testing.T) {
	scenarioJSReconnectRecreates(t, testutil.StartJSServer(t))
}

// --- real local nats-server variants (M2 mandate) -------------------------------

func TestJSReplayAllLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioJSReplayAll(t, localServerURL)
}

func TestJSReplayFromSequenceLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioJSReplayFromSequence(t, localServerURL)
}

func TestJSReplayNewLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioJSReplayNew(t, localServerURL)
}

func TestJSReplayStartTimeLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioJSReplayStartTime(t, localServerURL)
}

func TestJSNoStreamErrorLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioJSNoStreamError(t, localServerURL)
}

func TestJSClosedStopsConsumerLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioJSClosedStopsConsumer(t, localServerURL)
}

func TestJSReconnectRecreatesLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioJSReconnectRecreates(t, localServerURL)
}
