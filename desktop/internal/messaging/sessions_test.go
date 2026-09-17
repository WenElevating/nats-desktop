package messaging

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
	"github.com/nats-io/jsm.go/natscontext"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// Counting conventions for the session tests (spec §6.4 / AC-007):
//
//   - Total      = messages received by the session (running receipts; per the
//     spec counting continues while paused, but the displayed value freezes).
//   - Emitted    = messages handed to the pusher (recorder-visible session:msgs).
//   - Dropped    = ring evictions (oldest dropped when the buffer is full).
//   - BufferUsed = current ring occupancy.
//   - Filtered   = receipts dropped by the session's header filter before any
//     counting/ring/push (M3 Task 7): they never become MsgOut and never touch
//     rate/ring/pusher, so the extension of the invariant reads
//
//	received == delivered_total + filtered      (filter side: nothing vanishes)
//
//   - and the delivered side keeps M2's two-sided conservation unchanged
//     (Total == Emitted ∧ Total == Dropped + BufferUsed).
//
// In realtime mode every received message is BOTH handed to the pusher and
// written to the ring, so the brief's one-line invariant decomposes into the
// exact two-sided conservation asserted below:
//
//	Total == Emitted                  (push side: nothing vanishes before push)
//	Total == Dropped + BufferUsed     (buffer side: every message is resident or evicted)
//
// Both sides are additionally cross-checked against the real ring counters.

// --- recorder -----------------------------------------------------------------

// emitRecorder captures every emit call from the SessionManager. Emissions
// arrive on nats.go client goroutines (and the batch-pusher timer goroutine),
// so all access is mutex-guarded. timedBatch is reused from pipeline_test.go.
type emitRecorder struct {
	mu      sync.Mutex
	names   []string
	batches []timedBatch              // every session:msgs batch, in emit order
	lean    bool                      // lean mode: count msgs, do not retain batches
	leanN   int                       // lean mode: total msgs seen (all sessions)
	states  map[string][]SessionState // per session id, in emit order
	conn    []connections.StateEvent  // conn:state payloads seen
}

func newEmitRecorder() *emitRecorder {
	return &emitRecorder{states: map[string][]SessionState{}}
}

// newLeanEmitRecorder returns a recorder that does NOT retain session:msgs
// batches (only counts them): at flood volumes the retained MsgOut slice slows
// the session dispatcher into nats.go's slow-consumer protection, the same
// reason the M2 stress gate uses its O(1) stressEmit sink. session:state
// payloads are still retained, so lastState works.
func newLeanEmitRecorder() *emitRecorder {
	return &emitRecorder{lean: true, states: map[string][]SessionState{}}
}

func (r *emitRecorder) emit(name string, data any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.names = append(r.names, name)
	switch v := data.(type) {
	case []MsgOut:
		if r.lean {
			r.leanN += len(v)
			return
		}
		r.batches = append(r.batches, timedBatch{b: v, at: time.Now()})
	case SessionState:
		r.states[v.ID] = append(r.states[v.ID], v)
	case connections.StateEvent:
		r.conn = append(r.conn, v)
	}
}

// msgCount returns how many messages of session id have been emitted so far.
// (In lean mode batches are not retained; the count is then the cross-session
// total, which is exact for single-session lean stacks.)
func (r *emitRecorder) msgCount(id string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.lean {
		return r.leanN
	}
	n := 0
	for _, tb := range r.batches {
		if len(tb.b) > 0 && tb.b[0].SessionID == id {
			n += len(tb.b)
		}
	}
	return n
}

// emittedPayloads returns the base64 payloads of all messages emitted for id,
// in emit order.
func (r *emitRecorder) emittedPayloads(id string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, tb := range r.batches {
		if len(tb.b) == 0 || tb.b[0].SessionID != id {
			continue
		}
		for _, m := range tb.b {
			out = append(out, m.PayloadB64)
		}
	}
	return out
}

// countPayloadPrefix counts emitted payloads of id whose DECODED payload
// starts with the given prefix.
func (r *emitRecorder) countPayloadPrefix(id, prefix string) int {
	n := 0
	for _, b64 := range r.emittedPayloads(id) {
		if raw, err := base64.StdEncoding.DecodeString(b64); err == nil && strings.HasPrefix(string(raw), prefix) {
			n++
		}
	}
	return n
}

func (r *emitRecorder) sawConnState(s connections.State) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ev := range r.conn {
		if ev.State == s {
			return true
		}
	}
	return false
}

// sessionEventCount counts session:msgs + session:state emissions (conn:state
// events are legitimate on a live stack and excluded).
func (r *emitRecorder) sessionEventCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, name := range r.names {
		if name == EventSessionMsgs || name == EventSessionState {
			n++
		}
	}
	return n
}

// lastState returns the most recent session:state payload emitted for id.
func (r *emitRecorder) lastState(id string) (SessionState, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	evs := r.states[id]
	if len(evs) == 0 {
		return SessionState{}, false
	}
	return evs[len(evs)-1], true
}

// --- fixtures -----------------------------------------------------------------

// newSessionStack builds a connected connections.Manager plus a
// SessionManager wired the way main.go will wire it in Task 7: the manager's
// emit closure forwards conn:state events into sm.NotifyConnState (side-band),
// and session events are captured by the recorder.
func newSessionStack(t *testing.T, url string, defaultBuf int, defaultPush PushMode) (*connections.Manager, *SessionManager, *emitRecorder) {
	t.Helper()
	return newSessionStackRec(t, url, defaultBuf, defaultPush, newEmitRecorder())
}

// newSessionStackRec is newSessionStack with a caller-provided recorder — the
// flood gate passes a lean recorder (see newLeanEmitRecorder).
func newSessionStackRec(t *testing.T, url string, defaultBuf int, defaultPush PushMode, rec *emitRecorder) (*connections.Manager, *SessionManager, *emitRecorder) {
	t.Helper()
	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	var sm *SessionManager
	mgr := connections.NewManager(reg, log, func(name string, data any) {
		rec.emit(name, data)
		if ev, ok := data.(connections.StateEvent); ok && sm != nil {
			sm.NotifyConnState(ev) // Task 7 side-band wiring (non-blocking)
		}
	})
	sm = NewSessionManager(mgr, log, rec.emit, nil, defaultBuf, defaultPush)

	store := connections.NewStore(reg)
	if err := store.Save(context.Background(), connections.ContextForm{Name: "sess", URL: url}, 0); err != nil {
		t.Fatal(err)
	}
	if err := mgr.Connect(context.Background(), "sess"); err != nil {
		t.Fatal(err)
	}
	waitManagerConnected(t, mgr, 10*time.Second)
	t.Cleanup(mgr.Disconnect) // LIFO: CloseAll runs first, then Disconnect
	t.Cleanup(sm.CloseAll)
	return mgr, sm, rec
}

func waitManagerConnected(t *testing.T, mgr *connections.Manager, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if mgr.Snapshot().State == connections.StateConnected {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("manager not connected within %v (state=%s)", timeout, mgr.Snapshot().State)
}

func findState(sm *SessionManager, id string) (SessionState, bool) {
	for _, st := range sm.List() {
		if st.ID == id {
			return st, true
		}
	}
	return SessionState{}, false
}

// findState2 is findState with a hard failure.
func findState2(t *testing.T, sm *SessionManager, id string) SessionState {
	t.Helper()
	st, ok := findState(sm, id)
	if !ok {
		t.Fatalf("session %s missing from List", id)
	}
	return st
}

func waitSessionTotal(t *testing.T, sm *SessionManager, id string, want int64, timeout time.Duration) SessionState {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if st, ok := findState(sm, id); ok && st.Total >= want {
			return st
		}
		time.Sleep(20 * time.Millisecond)
	}
	st, _ := findState(sm, id)
	t.Fatalf("session %s total never reached %d within %v (last: %+v)", id, want, timeout, st)
	return SessionState{}
}

// waitQuiescent polls until the session's rate drains to 0 and its total has
// been stable for two consecutive samples (all in-flight messages delivered).
func waitQuiescent(t *testing.T, sm *SessionManager, id string, timeout time.Duration) SessionState {
	t.Helper()
	deadline := time.Now().Add(timeout)
	last := int64(-1)
	for time.Now().Before(deadline) {
		if st, ok := findState(sm, id); ok {
			if st.RateMsgS == 0 && st.Total == last {
				return st
			}
			last = st.Total
		}
		time.Sleep(100 * time.Millisecond)
	}
	st, _ := findState(sm, id)
	t.Fatalf("session %s never quiesced within %v (last: %+v)", id, timeout, st)
	return SessionState{}
}

// getSession returns the internal session for white-box assertions (tests live
// in the same package).
func getSession(t *testing.T, sm *SessionManager, id string) *session {
	t.Helper()
	sm.mu.Lock()
	defer sm.mu.Unlock()
	s, ok := sm.sessions[id]
	if !ok {
		t.Fatalf("white-box: session %s not in manager map", id)
	}
	return s
}

// burstPublish publishes count messages in bursts of perBurst every interval
// and flushes per burst; returns the number published.
func burstPublish(t *testing.T, nc *nats.Conn, subject string, count, perBurst int, interval time.Duration, payload []byte) int {
	t.Helper()
	n := 0
	for n < count {
		for i := 0; i < perBurst && n < count; i++ {
			n++
			if err := nc.Publish(subject, payload); err != nil {
				t.Errorf("publish: %v", err)
				return n
			}
		}
		if err := nc.Flush(); err != nil {
			t.Errorf("flush: %v", err)
			return n
		}
		if n < count {
			time.Sleep(interval)
		}
	}
	return n
}

// floodPublish publishes perBurst messages every interval for the given
// duration (full-rate flood); returns the number published. Safe to call from
// a goroutine (uses t.Errorf only).
func floodPublish(t *testing.T, nc *nats.Conn, subject string, perBurst int, interval, dur time.Duration) int {
	t.Helper()
	deadline := time.Now().Add(dur)
	n := 0
	payload := make([]byte, 64)
	for time.Now().Before(deadline) {
		for i := 0; i < perBurst; i++ {
			n++
			if err := nc.Publish(subject, payload); err != nil {
				t.Errorf("flood publish: %v", err)
				return n
			}
		}
		if err := nc.Flush(); err != nil {
			t.Errorf("flood flush: %v", err)
			return n
		}
		time.Sleep(interval)
	}
	return n
}

// --- scenario functions (parameterized over server URL) -----------------------

// scenarioSessionRealtime: AC-005 Go half. ~100 msg/s for 2s -> Total ~200,
// RateMsgS > 80, realtime emits 1..500-element aggregated batches (100ms), seq starts at 1
// and is monotonic.
func scenarioSessionRealtime(t *testing.T, url string) {
	t.Helper()
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)

	st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: "rt." + uniqueSuffix()})
	if err != nil {
		t.Fatal(err)
	}
	if st.State != SessionRunning {
		t.Fatalf("initial state = %q, want %q", st.State, SessionRunning)
	}
	if st.PushMode != PushRealtime {
		t.Fatalf("default push mode = %q, want realtime", st.PushMode)
	}
	if st.ID != "sub-1" {
		t.Fatalf("first session id = %q, want sub-1", st.ID)
	}
	if st.BufferUsed != 0 || st.Total != 0 || st.Dropped != 0 {
		t.Fatalf("initial counters not zero: %+v", st)
	}

	nc := connect(t, url)
	published := burstPublish(t, nc, st.Subject, 200, 10, 100*time.Millisecond, []byte("rt"))

	sample := waitSessionTotal(t, sm, st.ID, 180, 10*time.Second)
	if sample.RateMsgS <= 80 {
		t.Fatalf("RateMsgS = %v, want > 80 while streaming at ~100 msg/s", sample.RateMsgS)
	}
	if sample.Total < 180 || sample.Total > 220 {
		t.Fatalf("Total = %d, want ~%d", sample.Total, published)
	}

	final := waitQuiescent(t, sm, st.ID, 10*time.Second)
	if final.Total != int64(published) {
		t.Fatalf("final Total = %d, want %d (no loss on live loopback conns)", final.Total, published)
	}

	// Realtime mode: batches carry 1..500 elements (100ms/500 transport
	// aggregation); seq starts at 1 and is monotonic across the flattened
	// stream.
	rec.mu.Lock()
	var seqs []int64
	for _, tb := range rec.batches {
		if len(tb.b) == 0 || tb.b[0].SessionID != st.ID {
			continue
		}
		// M6 crash fix: realtime micro-batches may carry 1..200 elements
		// (transport aggregation); per-message delivery semantics are
		// preserved via conservation + order below.
		for _, m := range tb.b {
			seqs = append(seqs, m.Seq)
		}
	}
	rec.mu.Unlock()
	if len(seqs) != published {
		t.Fatalf("emitted %d messages, want %d", len(seqs), published)
	}
	for i, seq := range seqs {
		if seq != int64(i+1) {
			t.Fatalf("seqs[%d] = %d, want %d (must start at 1 and be monotonic)", i, seq, i+1)
		}
	}

	// Only session and conn events on the wire.
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for _, n := range rec.names {
		if n != EventSessionMsgs && n != EventSessionState && n != connections.EventConnState {
			t.Fatalf("unexpected event name %q", n)
		}
	}
}

// scenarioSessionPauseResume: AC-006 + Global Constraint #3. While paused the
// display counters freeze, no session:msgs are emitted, rate reads 0 — but the
// subscription keeps receiving, internal counting continues and the sequence
// counter keeps advancing (the ring scrolls to latest). Resume continues from
// newest with NO replay of paused-period messages.
func scenarioSessionPauseResume(t *testing.T, url string) {
	t.Helper()
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)

	st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: "pause." + uniqueSuffix()})
	if err != nil {
		t.Fatal(err)
	}
	nc := connect(t, url)

	published := burstPublish(t, nc, st.Subject, 30, 10, 30*time.Millisecond, []byte("pre"))
	waitSessionTotal(t, sm, st.ID, int64(published), 10*time.Second)
	waitQuiescent(t, sm, st.ID, 10*time.Second)

	if err := sm.Pause(st.ID); err != nil {
		t.Fatal(err)
	}
	if err := sm.Pause(st.ID); err != nil { // idempotent
		t.Fatalf("second Pause: %v", err)
	}
	frozen := findState2(t, sm, st.ID)
	if frozen.State != SessionPaused {
		t.Fatalf("state after Pause = %q, want paused", frozen.State)
	}
	if frozen.RateMsgS != 0 {
		t.Fatalf("paused RateMsgS = %v, want 0 (AC-006: 速率归 0)", frozen.RateMsgS)
	}
	if frozen.Total != int64(published) {
		t.Fatalf("paused Total = %d, want %d", frozen.Total, published)
	}
	emitsAtPause := rec.msgCount(st.ID)
	pausedSeqStart := getSession(t, sm, st.ID).seq.Load() // == published

	// Publish 50 messages while paused: display frozen, no emits, but the
	// subscription keeps receiving and seq keeps advancing.
	during := burstPublish(t, nc, st.Subject, 50, 10, 20*time.Millisecond, []byte("gap"))
	time.Sleep(300 * time.Millisecond) // let them arrive and the display "would" update

	after := findState2(t, sm, st.ID)
	if after != frozen {
		t.Fatalf("display counters moved during pause:\n before %+v\n after  %+v", frozen, after)
	}
	if got := rec.msgCount(st.ID); got != emitsAtPause {
		t.Fatalf("emits during pause: %d -> %d, want frozen", emitsAtPause, got)
	}
	s := getSession(t, sm, st.ID)
	if got := s.seq.Load(); got < pausedSeqStart+int64(during) {
		t.Fatalf("seq during pause = %d, want >= %d (subscription must keep receiving)", got, pausedSeqStart+int64(during))
	}
	if got := s.total; got != int64(published+during) {
		t.Fatalf("internal total during pause = %d, want %d (spec: 暂停时继续计数)", got, published+during)
	}
	pausedSeqEnd := s.seq.Load()

	// Resume: continue from newest, NO replay of paused-period messages.
	if err := sm.Resume(st.ID); err != nil {
		t.Fatal(err)
	}
	post := burstPublish(t, nc, st.Subject, 10, 5, 20*time.Millisecond, []byte("post"))
	final := waitQuiescent(t, sm, st.ID, 10*time.Second)
	if final.Total != int64(published+during+post) {
		t.Fatalf("final Total = %d, want %d (paused receipts still counted)", final.Total, published+during+post)
	}
	if final.State != SessionRunning {
		t.Fatalf("state after Resume = %q, want running", final.State)
	}

	// Emitted messages: exactly the pre-pause 30 plus the post-resume 10; the
	// 50 paused-period messages are never emitted (不回补), and post-resume
	// seqs are strictly greater than every paused-period seq.
	emittedSeqs := emittedSeqsOf(rec, st.ID)
	if len(emittedSeqs) != published+post {
		t.Fatalf("emitted %d messages, want %d (paused-period messages must not be replayed)", len(emittedSeqs), published+post)
	}
	for i, seq := range emittedSeqs {
		if i < published && seq > pausedSeqStart {
			t.Fatalf("pre-pause emitted seq %d > pause start %d", seq, pausedSeqStart)
		}
		if i >= published && seq <= pausedSeqEnd {
			t.Fatalf("post-resume emitted seq %d <= paused-period max %d (replay!)", seq, pausedSeqEnd)
		}
	}
	if got := s.emitted.Load(); got != int64(published+post) {
		t.Fatalf("internal emitted = %d, want %d", got, published+post)
	}

	// Closed sessions refuse control operations.
	if err := sm.Close(st.ID); err != nil {
		t.Fatal(err)
	}
	if err := sm.Pause(st.ID); err == nil {
		t.Fatal("Pause on closed session must fail")
	}
	if err := sm.Resume(st.ID); err == nil {
		t.Fatal("Resume on closed session must fail")
	}
	if err := sm.Clear(st.ID); err == nil {
		t.Fatal("Clear on closed session must fail")
	}
}

// emittedSeqsOf collects all emitted message seqs of a session in emit order.
func emittedSeqsOf(rec *emitRecorder, id string) []int64 {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	var seqs []int64
	for _, tb := range rec.batches {
		if len(tb.b) == 0 || tb.b[0].SessionID != id {
			continue
		}
		for _, m := range tb.b {
			seqs = append(seqs, m.Seq)
		}
	}
	return seqs
}

// scenarioSessionFlood: AC-007 Go half. Flood at ~5000 msg/s, buffer=1000.
// Asserts Dropped>0, the two-sided conservation invariant, real buffer
// occupancy, rate fallback to ~0 after the flood, and that pausing mid-flood
// stops emits immediately while the ring keeps scrolling. wave2 enables the
// pause-during-flood phase; with wave2=false only phase 1 runs.
func scenarioSessionFlood(t *testing.T, url string, floodDur time.Duration, wave2 bool) {
	t.Helper()
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)

	st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: "flood." + uniqueSuffix(), BufferSize: 1000})
	if err != nil {
		t.Fatal(err)
	}
	nc := connect(t, url)

	// --- phase 1: uninterrupted flood, exact accounting ---
	published1 := floodPublish(t, nc, st.Subject, 100, 20*time.Millisecond, floodDur) // ~5000/s
	final := waitQuiescent(t, sm, st.ID, 15*time.Second)
	g := getSession(t, sm, st.ID)

	achieved := float64(final.Total) / floodDur.Seconds()
	t.Logf("flood wave 1: published=%d received=%d dropped=%d buffer_used=%d achieved=%.0f msg/s (target 5000)",
		published1, final.Total, final.Dropped, final.BufferUsed, achieved)

	if final.Dropped <= 0 {
		t.Fatalf("Dropped = %d, want > 0 for a %d-message flood into a %d buffer", final.Dropped, published1, 1000)
	}
	if final.Total != int64(published1) {
		t.Fatalf("Total = %d, want %d (published)", final.Total, published1)
	}
	if final.Total != final.Dropped+int64(final.BufferUsed) {
		t.Fatalf("buffer conservation broken: Total %d != Dropped %d + BufferUsed %d", final.Total, final.Dropped, final.BufferUsed)
	}
	if final.BufferUsed != 1000 {
		t.Fatalf("BufferUsed = %d, want 1000 (buffer saturated)", final.BufferUsed)
	}
	if got := g.emitted.Load(); got != final.Total {
		t.Fatalf("Emitted = %d, want Total %d (every received message must reach the pusher)", got, final.Total)
	}
	if got := rec.msgCount(st.ID); int64(got) != final.Total {
		t.Fatalf("recorder saw %d messages, want %d", got, final.Total)
	}
	// Cross-check the display counters against the REAL ring state.
	if got := g.ring.Dropped(); got != final.Dropped {
		t.Fatalf("ring.Dropped() = %d, want %d (display counter must match the ring)", got, final.Dropped)
	}
	if got := len(g.ring.Snapshot(1 << 20)); got != 1000 {
		t.Fatalf("real ring occupancy = %d, want 1000", got)
	}
	if final.RateMsgS > 50 {
		t.Fatalf("RateMsgS = %v after flood drained, want ~0 (AC-007)", final.RateMsgS)
	}

	if !wave2 {
		return
	}

	// --- phase 2: pause during flood -> emits stop immediately, ring scrolls ---
	pubDone := make(chan int, 1)
	go func() { pubDone <- floodPublish(t, nc, st.Subject, 100, 20*time.Millisecond, floodDur) }()
	time.Sleep(floodDur / 3) // flood is flowing

	if err := sm.Pause(st.ID); err != nil {
		t.Fatal(err)
	}
	frozen := findState2(t, sm, st.ID)
	if frozen.State != SessionPaused || frozen.RateMsgS != 0 {
		t.Fatalf("paused snapshot wrong: %+v", frozen)
	}
	time.Sleep(floodDur / 6)
	emitsC1 := rec.msgCount(st.ID)
	seqC1 := g.seq.Load()
	time.Sleep(floodDur / 3) // still inside the flood window: arrivals continue
	emitsC2 := rec.msgCount(st.ID)
	seqC2 := g.seq.Load()

	if emitsC2 != emitsC1 {
		t.Fatalf("emits continued after pause: %d -> %d within 300ms", emitsC1, emitsC2)
	}
	if seqC2 <= seqC1 {
		t.Fatalf("ring not scrolling during pause: seq %d -> %d", seqC1, seqC2)
	}
	if after := findState2(t, sm, st.ID); after != frozen {
		t.Fatalf("display moved during pause+flood:\n frozen %+v\n after  %+v", frozen, after)
	}

	published2 := <-pubDone
	// The flood has fully drained by now (Flush + duration slack): no emit may
	// have happened between the last sample and Resume.
	if emitsC3 := rec.msgCount(st.ID); emitsC3 != emitsC2 {
		t.Fatalf("emits during pause after flood drained: %d -> %d", emitsC2, emitsC3)
	}
	if err := sm.Resume(st.ID); err != nil {
		t.Fatal(err)
	}
	resumeSeq := g.seq.Load()
	published3 := burstPublish(t, nc, st.Subject, 10, 10, 20*time.Millisecond, []byte("post"))

	drained := waitQuiescent(t, sm, st.ID, 15*time.Second)
	t.Logf("flood wave 2: published=%d (paused mid-flood) + %d post-resume; final total=%d dropped=%d",
		published2, published3, drained.Total, drained.Dropped)

	wantTotal := int64(published1 + published2 + published3)
	if drained.Total != wantTotal {
		t.Fatalf("final Total = %d, want %d (paused-period receipts still counted, spec 继续计数)", drained.Total, wantTotal)
	}
	if drained.Dropped != drained.Total-int64(1000) || drained.BufferUsed != 1000 {
		t.Fatalf("final accounting wrong: %+v (want Dropped=Total-1000, BufferUsed=1000)", drained)
	}

	// No replay across the pause: exactly published3 messages are emitted after
	// the pause, and every one of them carries a seq strictly greater than the
	// highest seq assigned up to the Resume instant (paused-period seqs never
	// appear in the emit stream).
	rec.mu.Lock()
	var postSeqs []int64
	seen := 0
	for _, tb := range rec.batches {
		if len(tb.b) == 0 || tb.b[0].SessionID != st.ID {
			continue
		}
		for _, m := range tb.b {
			if seen >= emitsC2 {
				if m.Seq <= resumeSeq {
					rec.mu.Unlock()
					t.Fatalf("post-resume emitted seq %d <= resume seq %d (paused-period replay!)", m.Seq, resumeSeq)
				}
				postSeqs = append(postSeqs, m.Seq)
			}
			seen++
		}
	}
	rec.mu.Unlock()
	if len(postSeqs) != published3 {
		t.Fatalf("post-resume emitted %d messages, want exactly %d (no pause-period replay)", len(postSeqs), published3)
	}
}

// scenarioSessionBatch: batch mode coalesces into multi-element batches with
// ~100ms timer spacing and never exceeds 500 per batch.
func scenarioSessionBatch(t *testing.T, url string) {
	t.Helper()
	_, sm, rec := newSessionStack(t, url, 10000, PushBatch)

	st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: "batch." + uniqueSuffix(), PushMode: PushBatch})
	if err != nil {
		t.Fatal(err)
	}
	if st.PushMode != PushBatch {
		t.Fatalf("PushMode = %q, want batch", st.PushMode)
	}

	nc := connect(t, url)
	published := burstPublish(t, nc, st.Subject, 50, 5, 100*time.Millisecond, []byte("bt")) // 5 msgs / 100ms
	time.Sleep(400 * time.Millisecond)                                                      // drain the final partial batch

	final := waitQuiescent(t, sm, st.ID, 10*time.Second)
	if final.Total != int64(published) {
		t.Fatalf("Total = %d, want %d", final.Total, published)
	}

	rec.mu.Lock()
	var mine []timedBatch
	for _, tb := range rec.batches {
		if len(tb.b) > 0 && tb.b[0].SessionID == st.ID {
			mine = append(mine, tb)
		}
	}
	rec.mu.Unlock()
	if len(mine) < 3 {
		t.Fatalf("got %d batches, want >= 3 for %d messages at 100ms cadence", len(mine), published)
	}
	maxLen, got := 0, 0
	for _, tb := range mine {
		if len(tb.b) > maxLen {
			maxLen = len(tb.b)
		}
		if len(tb.b) > batchMaxMsgs {
			t.Fatalf("batch len %d exceeds %d", len(tb.b), batchMaxMsgs)
		}
		got += len(tb.b)
	}
	if got != published {
		t.Fatalf("batched %d messages, want %d", got, published)
	}
	if maxLen < 2 {
		t.Fatalf("max batch len = %d, want >= 2 (batch mode must coalesce)", maxLen)
	}
	for i := 1; i < len(mine); i++ {
		gap := mine[i].at.Sub(mine[i-1].at)
		if gap < 50*time.Millisecond || gap > 400*time.Millisecond {
			t.Fatalf("batch gap[%d] = %v, want ~100ms (50..400ms tolerance)", i, gap)
		}
	}
}

// scenarioSessionClear: Clear resets the display counters and the list while
// the subscription keeps receiving (new messages counted fresh).
func scenarioSessionClear(t *testing.T, url string) {
	t.Helper()
	_, sm, _ := newSessionStack(t, url, 10000, PushRealtime)

	st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: "clear." + uniqueSuffix()})
	if err != nil {
		t.Fatal(err)
	}
	nc := connect(t, url)

	published := burstPublish(t, nc, st.Subject, 15, 5, 20*time.Millisecond, []byte("c1"))
	waitQuiescent(t, sm, st.ID, 10*time.Second)
	before := findState2(t, sm, st.ID)
	if before.Total != int64(published) {
		t.Fatalf("pre-clear Total = %d, want %d", before.Total, published)
	}

	if err := sm.Clear(st.ID); err != nil {
		t.Fatal(err)
	}
	cleared := findState2(t, sm, st.ID)
	if cleared.Total != 0 || cleared.Dropped != 0 || cleared.BufferUsed != 0 {
		t.Fatalf("after Clear: %+v, want Total/Dropped/BufferUsed all zero", cleared)
	}
	if cleared.State != SessionRunning {
		t.Fatalf("state after Clear = %q, want running (subscription must not stop)", cleared.State)
	}

	published2 := burstPublish(t, nc, st.Subject, 8, 4, 20*time.Millisecond, []byte("c2"))
	final := waitQuiescent(t, sm, st.ID, 10*time.Second)
	if final.Total != int64(published2) {
		t.Fatalf("post-clear Total = %d, want %d (subscription must keep receiving)", final.Total, published2)
	}
	if final.BufferUsed != published2 {
		t.Fatalf("post-clear BufferUsed = %d, want %d", final.BufferUsed, published2)
	}
	g := getSession(t, sm, st.ID)
	if got := len(g.ring.Snapshot(1 << 20)); got != published2 {
		t.Fatalf("real ring occupancy after Clear+receive = %d, want %d (ring must be reset)", got, published2)
	}
}

// --- embedded-fixture tests (CI-hermetic path) --------------------------------

func TestSessionRealtimeReceives(t *testing.T) {
	scenarioSessionRealtime(t, testutil.StartJSServer(t))
}

func TestSessionPauseResumeSemantics(t *testing.T) {
	scenarioSessionPauseResume(t, testutil.StartJSServer(t))
}

func TestSessionFloodSmoke(t *testing.T) {
	scenarioSessionFlood(t, testutil.StartJSServer(t), 600*time.Millisecond, false)
}

func TestSessionFloodPauseSmoke(t *testing.T) {
	scenarioSessionFlood(t, testutil.StartJSServer(t), 600*time.Millisecond, true)
}

func TestSessionBatchMode(t *testing.T) {
	scenarioSessionBatch(t, testutil.StartJSServer(t))
}

func TestSessionClear(t *testing.T) {
	scenarioSessionClear(t, testutil.StartJSServer(t))
}

// TestSessionInvalidSubject: whitespace subjects are rejected with an
// E-VALIDATION-style error BEFORE any network call — no session is created,
// nothing is emitted, and it works even with no connection at all.
func TestSessionInvalidSubject(t *testing.T) {
	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	rec := newEmitRecorder()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := connections.NewManager(reg, log, rec.emit) // never connected
	sm := NewSessionManager(mgr, log, rec.emit, nil, 10000, PushRealtime)

	for _, subj := range []string{"foo bar", " a", "a ", "", "a\tb", "a\nb"} {
		st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: subj})
		if err == nil {
			t.Fatalf("subject %q must be rejected", subj)
		}
		if st.ID != "" || st.State != "" {
			t.Fatalf("subject %q: rejected session must return zero state, got %+v", subj, st)
		}
	}
	if sessions := sm.List(); len(sessions) != 0 {
		t.Fatalf("List after rejects = %+v, want empty", sessions)
	}
	if n := rec.sessionEventCount(); n != 0 {
		t.Fatalf("rejected CreateSession emitted %d session events, want nothing", n)
	}

	// Also rejected on a live stack (validation precedes the network path).
	_, sm2, rec2 := newSessionStack(t, testutil.StartJSServer(t), 10000, PushRealtime)
	if _, err := sm2.CreateSession(context.Background(), SessionSpec{Subject: "has space"}); err == nil {
		t.Fatal("connected stack must reject whitespace subject too")
	}
	if sessions := sm2.List(); len(sessions) != 0 {
		t.Fatalf("rejected session must not be registered: %+v", sessions)
	}
	if n := rec2.sessionEventCount(); n != 0 {
		t.Fatalf("rejected CreateSession emitted %d session events, want nothing", n)
	}
}

// TestSessionJSPositionValidation pins the JSPosition closed set. Invalid
// modes are rejected locally (no session, no events); every valid mode routes
// to the Task 5 JetStream path, so a subject no stream covers fails there
// with the mapped "no stream" error (session closed, verbatim text).
func TestSessionJSPositionValidation(t *testing.T) {
	url := testutil.StartJSServer(t)
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)
	sfx := uniqueSuffix()

	// Closed-set violations (including an explicit empty mode: a provided
	// js_position must carry an explicit mode).
	for _, mode := range []string{"bogus", ""} {
		if _, err := sm.CreateSession(context.Background(), SessionSpec{
			Subject: "js.bad." + sfx, JSPosition: &JSPosition{Mode: mode}}); err == nil {
			t.Fatalf("js_position mode %q must be rejected", mode)
		}
	}
	if n := rec.sessionEventCount(); n != 0 {
		t.Fatalf("closed-set rejects emitted %d session events, want nothing", n)
	}

	// Valid modes route to the JS path; without a covering stream each fails
	// with the "no stream" error and the session is registered closed.
	for _, mode := range []string{"all", "new", "start_sequence", "start_time"} {
		st, err := sm.CreateSession(context.Background(), SessionSpec{
			Subject: "js.nostream." + sfx, JSPosition: &JSPosition{Mode: mode, StartSeq: 5}})
		if err == nil {
			t.Fatalf("js_position mode %q without a covering stream must fail", mode)
		}
		if !strings.Contains(strings.ToLower(err.Error()), "no stream") {
			t.Fatalf("mode %q: Error = %q, want it to contain %q", mode, err.Error(), "no stream")
		}
		if st.State != SessionClosed || !strings.Contains(st.Error, "no stream") {
			t.Fatalf("mode %q: state %+v, want closed with the verbatim no-stream error", mode, st)
		}
	}

	// mode "new" on a stream-covered subject: a running JS consumer session.
	nc := connect(t, url)
	createJSStream(t, nc, "M2T5-VAL-"+sfx, "js.new."+sfx+".>")
	st, err := sm.CreateSession(context.Background(), SessionSpec{
		Subject: "js.new." + sfx + ".one", JSPosition: &JSPosition{Mode: "new"}})
	if err != nil {
		t.Fatal(err)
	}
	if st.State != SessionRunning {
		t.Fatalf("mode new initial state = %q, want running", st.State)
	}
}

// TestSessionCloseAndCloseAll: Close unsubscribes (no further emits), marks
// the session closed, and leaks no goroutines (batch-mode timer goroutine and
// state-throttle timer must both terminate). CloseAll closes every session.
func TestSessionCloseAndCloseAll(t *testing.T) {
	url := testutil.StartJSServer(t)
	_, sm, rec := newSessionStack(t, url, 10000, PushBatch)

	st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: "close." + uniqueSuffix(), PushMode: PushBatch})
	if err != nil {
		t.Fatal(err)
	}
	nc := connect(t, url)
	burstPublish(t, nc, st.Subject, 7, 7, 20*time.Millisecond, []byte("x"))
	waitSessionTotal(t, sm, st.ID, 7, 10*time.Second)

	if err := sm.Close(st.ID); err != nil {
		t.Fatal(err)
	}
	if err := sm.Close(st.ID); err != nil { // idempotent
		t.Fatalf("second Close: %v", err)
	}
	closed := findState2(t, sm, st.ID)
	if closed.State != SessionClosed {
		t.Fatalf("state after Close = %q, want closed", closed.State)
	}

	emitsAtClose := rec.msgCount(st.ID)
	burstPublish(t, nc, st.Subject, 5, 5, 10*time.Millisecond, []byte("late"))
	time.Sleep(300 * time.Millisecond)
	if got := rec.msgCount(st.ID); got != emitsAtClose {
		t.Fatalf("emits after Close: %d -> %d (unsubscription failed)", emitsAtClose, got)
	}
	if st2, _ := findState(sm, st.ID); st2.Total != int64(emitsAtClose) {
		t.Fatalf("Total after Close = %d, want frozen %d", st2.Total, emitsAtClose)
	}

	// Goroutine-leak check for a fresh batch session (timer goroutine + state
	// throttle timer must both terminate). Side conns are closed first so the
	// baseline is stable.
	nc.Close()
	time.Sleep(200 * time.Millisecond)
	before := runtime.NumGoroutine()
	st2, err := sm.CreateSession(context.Background(), SessionSpec{Subject: "leak." + uniqueSuffix(), PushMode: PushBatch})
	if err != nil {
		t.Fatal(err)
	}
	if err := sm.Close(st2.ID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before {
		t.Fatalf("goroutine leak around Close: before=%d after=%d", before, after)
	}

	// CloseAll closes everything (states stay listable as closed).
	if _, err := sm.CreateSession(context.Background(), SessionSpec{Subject: "all1." + uniqueSuffix()}); err != nil {
		t.Fatal(err)
	}
	if _, err := sm.CreateSession(context.Background(), SessionSpec{Subject: "all2." + uniqueSuffix()}); err != nil {
		t.Fatal(err)
	}
	sm.CloseAll()
	sm.CloseAll() // idempotent
	list := sm.List()
	if len(list) != 4 { // close.* + leak.* + all1.* + all2.* (closed sessions remain listable)
		t.Fatalf("List after CloseAll has %d sessions, want 4", len(list))
	}
	for _, s := range list {
		if s.State != SessionClosed {
			t.Fatalf("session %s state after CloseAll = %q, want closed", s.ID, s.State)
		}
	}
}

// --- wire contract (SessionSpec/SessionState json tags are frozen) -------------

func TestSessionTypesJSONContract(t *testing.T) {
	st := SessionState{
		ID: "sub-1", Subject: "orders.received", State: "running", PushMode: PushRealtime,
		RateMsgS: 12.5, Total: 42, Dropped: 7, BufferUsed: 35,
	}
	got, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"sub-1","subject":"orders.received","state":"running","push_mode":"realtime","rate_msg_s":12.5,"total":42,"filtered":0,"dropped":7,"buffer_used":35}`
	if string(got) != want {
		t.Fatalf("SessionState JSON drifted from contract:\n got  %s\n want %s", got, want)
	}
	st.Error = "boom"
	got, err = json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	want = `{"id":"sub-1","subject":"orders.received","state":"running","push_mode":"realtime","rate_msg_s":12.5,"total":42,"filtered":0,"dropped":7,"buffer_used":35,"error":"boom"}`
	if string(got) != want {
		t.Fatalf("SessionState Error tag wrong:\n got  %s\n want %s", got, want)
	}

	spec := SessionSpec{Subject: "s", PushMode: PushBatch, BufferSize: 100,
		JSPosition: &JSPosition{Mode: "start_sequence", StartSeq: 9}}
	got, err = json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	wantSpec := `{"subject":"s","push_mode":"batch","buffer_size":100,"js_position":{"mode":"start_sequence","start_seq":9}}`
	if string(got) != wantSpec {
		t.Fatalf("SessionSpec JSON drifted:\n got  %s\n want %s", got, wantSpec)
	}
	got, err = json.Marshal(SessionSpec{Subject: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"subject":"x","push_mode":"","buffer_size":0}`; string(got) != want {
		t.Fatalf("zero SessionSpec JSON wrong:\n got  %s\n want %s", got, want)
	}

	if EventSessionMsgs != "session:msgs" || EventSessionState != "session:state" {
		t.Fatalf("event name contract drifted: %q / %q", EventSessionMsgs, EventSessionState)
	}
}

// TestSessionStateFilteredFieldPins pins the header-filter conservation field
// on the wire (M3 Task 7): `filtered` sits right after `total` so the JSON
// reads received == total + filtered, and it has no omitempty — every
// session:state payload carries it, letting the frontend render the
// "filtered" chip without version drift.
func TestSessionStateFilteredFieldPins(t *testing.T) {
	st := SessionState{ID: "sub-9", Total: 100, Filtered: 40}
	got, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"sub-9","subject":"","state":"","push_mode":"","rate_msg_s":0,"total":100,"filtered":40,"dropped":0,"buffer_used":0}`
	if string(got) != want {
		t.Fatalf("SessionState filtered field drifted:\n got  %s\n want %s", got, want)
	}

	// The request-side spec gains header_filters (omitempty): absent when the
	// session has no filters, snake_case key on the wire.
	spec, err := json.Marshal(SessionSpec{Subject: "s", HeaderFilters: map[string]string{"Env": "prod"}})
	if err != nil {
		t.Fatal(err)
	}
	wantSpec := `{"subject":"s","push_mode":"","buffer_size":0,"header_filters":{"Env":"prod"}}`
	if string(spec) != wantSpec {
		t.Fatalf("SessionSpec header_filters tag drifted:\n got  %s\n want %s", spec, wantSpec)
	}
	if plain, err := json.Marshal(SessionSpec{Subject: "x"}); err != nil {
		t.Fatal(err)
	} else if wantPlain := `{"subject":"x","push_mode":"","buffer_size":0}`; string(plain) != wantPlain {
		t.Fatalf("SessionSpec zero form drifted:\n got  %s\n want %s", plain, wantPlain)
	}
}

// --- state-event regressions (GUI-smoke Critical fix round 1) ------------------

// scenarioReceiptsEmitStateEvents: receipts must produce coalesced
// session:state events (spec §6.4: 每次状态/计数变化节流 250ms). Regression for
// the GUI smoke finding where the rate/total chip stayed at the create-time
// snapshot "0 msg/s 共 0 条" because deliver() never notified the throttle.
func scenarioReceiptsEmitStateEvents(t *testing.T, url string) {
	t.Helper()
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)

	st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: "stateevt." + uniqueSuffix()})
	if err != nil {
		t.Fatal(err)
	}
	if st.Total != 0 {
		t.Fatalf("create-time Total = %d, want 0", st.Total)
	}

	nc := connect(t, url)
	published := burstPublish(t, nc, st.Subject, 20, 5, 10*time.Millisecond, []byte("x"))

	// A session:state carrying the received total must arrive within ~1s of
	// the receipts (leading edge fires immediately; 250ms coalesce at worst).
	deadline := time.Now().Add(time.Second)
	for {
		if last, ok := rec.lastState(st.ID); ok && last.Total >= int64(published) {
			return
		}
		if time.Now().After(deadline) {
			last, _ := rec.lastState(st.ID)
			t.Fatalf("no session:state with Total >= %d within 1s (last: %+v) — receipts must notify the throttle", published, last)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// scenarioRateDecaysToZero: after receipts stop, the throttle's quiet-period
// refresh must deliver a final state event whose rate has decayed to ~0 while
// keeping the full total (AC-007: 注入结束后速率回落为 0).
func scenarioRateDecaysToZero(t *testing.T, url string) {
	t.Helper()
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)

	st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: "decay." + uniqueSuffix()})
	if err != nil {
		t.Fatal(err)
	}
	nc := connect(t, url)
	published := burstPublish(t, nc, st.Subject, 200, 50, 10*time.Millisecond, []byte("x"))

	// The rate must actually have risen (guards against passing because the
	// rate never moved): the sample right after the burst sits inside the 1s
	// rate window, well before any decay.
	sample := waitSessionTotal(t, sm, st.ID, int64(published), 10*time.Second)
	if sample.RateMsgS <= 1 {
		t.Fatalf("RateMsgS = %v right after a %d-message burst, want > 1 (rate must rise before it can decay)", sample.RateMsgS, published)
	}

	// Within ~1.5s of the last non-zero snapshot the decay refresh must emit a
	// state event with Total intact and the rate decayed below 1 msg/s.
	deadline := time.Now().Add(3 * time.Second)
	for {
		if last, ok := rec.lastState(st.ID); ok && last.Total == int64(published) && last.RateMsgS < 1 {
			// It must stay decayed: no later event may raise the rate again.
			time.Sleep(300 * time.Millisecond)
			if last, ok := rec.lastState(st.ID); !ok || last.RateMsgS >= 1 || last.Total != int64(published) {
				t.Fatalf("decayed state did not hold: %+v (ok=%v)", last, ok)
			}
			return
		}
		if time.Now().After(deadline) {
			last, _ := rec.lastState(st.ID)
			t.Fatalf("no decayed session:state (Total==%d, Rate<1) within 3s; last: %+v (quiet-period refresh missing?)", published, last)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestReceiptsEmitStateEvents / TestRateDecaysToZero plus their LocalServer
// variants cover the receipt->state-event contract on both fixtures.
func TestReceiptsEmitStateEvents(t *testing.T) {
	scenarioReceiptsEmitStateEvents(t, testutil.StartJSServer(t))
}

func TestRateDecaysToZeroInStateEvents(t *testing.T) {
	scenarioRateDecaysToZero(t, testutil.StartJSServer(t))
}

// --- real local nats-server variants (M2 mandate) -------------------------------

func TestSessionRealtimeReceivesLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioSessionRealtime(t, localServerURL)
}

func TestSessionPauseResumeSemanticsLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioSessionPauseResume(t, localServerURL)
}

// TestSessionFloodDropCountingLocalServer is the mandated real-server flood:
// 5000 msg/s x 3s into a 1000-message buffer, plus a pause mid-flood.
func TestSessionFloodDropCountingLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioSessionFlood(t, localServerURL, 3*time.Second, true)
}

func TestSessionBatchModeLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioSessionBatch(t, localServerURL)
}

func TestSessionClearLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioSessionClear(t, localServerURL)
}

func TestReceiptsEmitStateEventsLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioReceiptsEmitStateEvents(t, localServerURL)
}

func TestRateDecaysToZeroLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioRateDecaysToZero(t, localServerURL)
}

// --- header filtering (M3 Task 7) ------------------------------------------------

// smTestConn opens the publisher/injector-side client connection used by the
// session tests (the session's own subscription lives on the stack manager's
// connection). Cleanup closes it with the test.
func smTestConn(t *testing.T, url string) *nats.Conn {
	t.Helper()
	return connect(t, url) // nats.Connect + t.Cleanup(nc.Close)
}

// waitForCond polls cond every 20ms until it holds, failing the test after
// timeout (state events are throttled to 250ms, so polling — not waiting on
// channels — is the right shape for recorder assertions).
func waitForCond(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("condition not met within %v", timeout)
}

// flushSessionSub deterministically gates publishing on server-side SUB
// registration. nats.Subscribe only QUEUES the SUB protocol line on the
// manager connection's write buffer; a message published (on any connection)
// before the server processes that SUB is silently not delivered (at-most-once
// delivery), which breaks exact-count conservation assertions by a handful of
// early messages. Flush round-trips PING/PONG on that same connection, so when
// it returns the SUB is registered and everything published afterwards is
// observable by the session.
func flushSessionSub(t *testing.T, sm *SessionManager, id string) {
	t.Helper()
	s := getSession(t, sm, id)
	s.mu.Lock()
	nc := s.subNC
	s.mu.Unlock()
	if nc == nil {
		t.Fatal("session has no subscription connection (not subscribed)")
	}
	if err := nc.Flush(); err != nil {
		t.Fatalf("subscription flush failed: %v", err)
	}
}

// TestSessionHeaderFiltering: a session with HeaderFilters {"Env":"prod"} only
// receives the matching half of a 20-message alternate stream — Total==10,
// Filtered==10 (conservation: received 20 == delivered 10 + filtered 10), and
// the pusher emitted exactly the 10 hits.
func TestSessionHeaderFiltering(t *testing.T) {
	url := testutil.StartJSServer(t)
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime)
	nc := smTestConn(t, url)
	subj := "filter.e2e." + uniqueSuffix()
	st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: subj, HeaderFilters: map[string]string{"Env": "prod"}})
	if err != nil {
		t.Fatal(err)
	}
	sid := st.ID
	flushSessionSub(t, sm, sid) // SUB registered server-side before the burst
	for i := 0; i < 20; i++ {
		var msg *nats.Msg
		if i%2 == 0 {
			msg = &nats.Msg{Subject: subj, Data: []byte("hit"), Header: nats.Header{"Env": {"prod"}}}
		} else {
			msg = &nats.Msg{Subject: subj, Data: []byte("miss"), Header: nats.Header{"Env": {"dev"}}}
		}
		if err := nc.PublishMsg(msg); err != nil {
			t.Fatal(err)
		}
	}
	nc.Flush()
	waitForCond(t, 2*time.Second, func() bool {
		st, ok := rec.lastState(sid)
		return ok && st.Total == 10 && st.Filtered == 10
	})
	// Pushed messages contain only the hits (recorder's existing msgCount).
	if got := rec.msgCount(sid); got != 10 {
		t.Fatalf("emitted messages: %d", got)
	}
}

// TestSessionHeaderFilterFloodConservationLocalServer: Global Constraint 8 —
// 50k msg/s-level injection with filtering on must conserve (received ==
// Total + Filtered) without collapsing the rate or dropping anything. The
// session buffer is sized (200k) so the delivered half never overflows the
// ring — this keeps the brief's "no unexpected drops at this rate" assertion
// meaningful AND keeps M2's delivered-side invariant Total == Dropped +
// BufferUsed intact (with the 10k default the ring would necessarily evict
// 90k of the 100k delivered hits, which is drop-oldest behavior, not loss).
// M2 measured ~628k msg/s in-process injection on this machine, so the 200k
// flood clears the hard 50k msg/s gate with ~12x headroom.
func TestSessionHeaderFilterFloodConservationLocalServer(t *testing.T) {
	// Global Constraint 8: 50k msg/s-scale injection + conservation and live
	// rate with filtering enabled. Local-server only (CI skips cleanly).
	requireLocalServer(t)
	rec := newLeanEmitRecorder() // flood volume: never retain the 100k hit batches
	_, sm, _ := newSessionStackRec(t, localServerURL, 10000, PushRealtime, rec)
	inj := smTestConn(t, localServerURL)
	subj := "filter.flood." + uniqueSuffix()
	st, err := sm.CreateSession(context.Background(), SessionSpec{
		Subject: subj, BufferSize: 200_000, HeaderFilters: map[string]string{"Env": "prod"}})
	if err != nil {
		t.Fatal(err)
	}
	sid := st.ID
	flushSessionSub(t, sm, sid) // SUB registered server-side before the burst
	const total = 200_000
	// Global Constraint 8 mandates the 50k msg/s LEVEL, so the injection is
	// PACED 20% above the hard gate and self-corrects against the wall clock.
	// An unbounded loop bursts at ~400-600k msg/s here, parking >64MB of
	// queued *nats.Msg (small messages + per-message header maps) in the
	// session's subscription and tripping nats.go's deliberate slow-consumer
	// valve (500k msgs / 64MB pending bytes) — a burst artifact, not a
	// pipeline property: the dispatcher sustains the mandated level with a
	// wide margin, and paced injection makes the conservation assertion
	// deterministic instead of GC-lucky.
	const (
		paceRate  = 60_000 // msg/s — mandate level +20% headroom over the 50k gate
		paceBatch = 1_000  // messages per pacing slice (~16.7ms at paceRate)
	)
	start := time.Now()
	for i := 0; i < total; i++ {
		msg := &nats.Msg{Subject: subj, Data: []byte("x")}
		if i%2 == 0 {
			msg.Header = nats.Header{"Env": {"prod"}}
		} else {
			msg.Header = nats.Header{"Env": {"dev"}}
		}
		if err := inj.PublishMsg(msg); err != nil {
			t.Fatal(err)
		}
		if (i+1)%paceBatch == 0 {
			if d := time.Duration(float64(i+1)/paceRate*float64(time.Second)) - time.Since(start); d > 0 {
				time.Sleep(d)
			}
		}
	}
	inj.Flush()
	achieved := float64(total) / time.Since(start).Seconds()
	t.Logf("flood injection rate: %.0f msg/s (mandate gate: 50000)", achieved)
	if achieved < 50_000 {
		t.Fatalf("flood level not reached: %.0f msg/s (mandate: 50k)", achieved)
	}
	waitForCond(t, 10*time.Second, func() bool {
		st, ok := rec.lastState(sid)
		return ok && st.Total+st.Filtered == total
	})
	final, _ := rec.lastState(sid)
	if final.Total != total/2 || final.Filtered != total/2 {
		t.Fatalf("conservation: total=%d filtered=%d", final.Total, final.Filtered)
	}
	if final.Dropped != 0 {
		t.Fatalf("unexpected drops at this rate: %d", final.Dropped)
	}
	if final.Total != int64(final.Dropped)+int64(final.BufferUsed) {
		t.Fatalf("delivered-side conservation broken: Total %d != Dropped %d + BufferUsed %d",
			final.Total, final.Dropped, final.BufferUsed)
	}
	if final.RateMsgS <= 0 {
		t.Fatalf("rate must stay live under filtered flood (final state: %+v)", final)
	}
}

// TestValidateHeaderFilters bounds the filter form (spec §6.4): nil/empty
// allowed, at most 8 pairs, key/value at most 256 bytes each.
func TestValidateHeaderFilters(t *testing.T) {
	ok := []map[string]string{
		nil,
		{},
		{"Env": "prod"},
	}
	eight := map[string]string{}
	for i := 0; i < 8; i++ {
		eight[fmt.Sprintf("K%d", i)] = "v"
	}
	ok = append(ok, eight)
	for _, f := range ok {
		if err := validateHeaderFilters(f); err != nil {
			t.Fatalf("must accept %d pairs: %v", len(f), err)
		}
	}

	nine := map[string]string{}
	for i := 0; i < 9; i++ {
		nine[fmt.Sprintf("K%d", i)] = "v"
	}
	bad := []map[string]string{
		nine,
		{strings.Repeat("k", 257): "v"},
		{"k": strings.Repeat("v", 257)},
	}
	for _, f := range bad {
		if err := validateHeaderFilters(f); !errors.Is(err, ErrInvalidHeaderFilter) {
			t.Fatalf("must reject %d-pair/oversize filter, got %v", len(f), err)
		}
	}
	// Exactly at the byte bound is still fine.
	if err := validateHeaderFilters(map[string]string{strings.Repeat("k", 256): strings.Repeat("v", 256)}); err != nil {
		t.Fatalf("256-byte key/value must be accepted: %v", err)
	}
}

// --- reconnect (inline restartable server; can't restart the shared one) -------

// freePort asks the OS for a currently unused TCP port (manager_test.go
// fixture pattern, replicated here because that helper is package-private to
// connections).
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// startServerOnPort boots a plain embedded server on an explicit port and
// store dir. Cleanup is NOT registered so tests can shut it down and restart
// a twin on the same port (M1 Task 8 / TestReconnectOnServerRestart pattern).
func startServerOnPort(t *testing.T, port int, dir string) *server.Server {
	t.Helper()
	srv, err := server.NewServer(&server.Options{
		Port:       port,
		ServerName: "TEST_SESS",
		StoreDir:   dir,
	})
	if err != nil {
		t.Fatal(err)
	}
	go srv.Start()
	if !srv.ReadyForConnections(10 * time.Second) {
		t.Fatal("server not ready")
	}
	return srv
}

// TestSessionReconnectResubscribes: server restart on the SAME port/store dir.
// nats.go keeps the same conn and auto-resubscribes; NotifyConnState(connected)
// must therefore NOT duplicate subscriptions. Messages published during the
// disconnect window are never replayed; new messages resume; the session stays
// running throughout.
func TestSessionReconnectResubscribes(t *testing.T) {
	port := freePort(t)
	dir := t.TempDir()
	srv := startServerOnPort(t, port, dir)

	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	rec := newEmitRecorder()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	var sm *SessionManager
	mgr := connections.NewManager(reg, log, func(name string, data any) {
		rec.emit(name, data)
		if ev, ok := data.(connections.StateEvent); ok && sm != nil {
			sm.NotifyConnState(ev) // main.go-style side-band (Task 7 wiring)
		}
	})
	sm = NewSessionManager(mgr, log, rec.emit, nil, 10000, PushRealtime)
	t.Cleanup(srv.Shutdown)   // registered first: runs after client teardown
	t.Cleanup(mgr.Disconnect) // disconnect before the replacement server dies
	t.Cleanup(sm.CloseAll)    // registered last: runs first (live conn)

	store := connections.NewStore(reg)
	if err := store.Save(context.Background(), connections.ContextForm{Name: "re", URL: srv.ClientURL()}, 0); err != nil {
		t.Fatal(err)
	}
	if err := mgr.Connect(context.Background(), "re"); err != nil {
		t.Fatal(err)
	}
	waitManagerConnected(t, mgr, 10*time.Second)

	subj := "recon." + uniqueSuffix()
	st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: subj})
	if err != nil {
		t.Fatal(err)
	}

	nc := connect(t, srv.ClientURL()) // publisher (dies with the first server)
	pre := burstPublish(t, nc, subj, 5, 5, 10*time.Millisecond, []byte("pre-"))
	waitSessionTotal(t, sm, st.ID, int64(pre), 10*time.Second)

	// Server dies: manager moves to reconnecting; the session stays running
	// (no paused-marking per M2 user ruling).
	srv.Shutdown()
	deadline := time.Now().Add(10 * time.Second)
	for !rec.sawConnState(connections.StateReconnecting) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !rec.sawConnState(connections.StateReconnecting) {
		t.Fatal("manager never entered reconnecting")
	}
	if s, _ := findState(sm, st.ID); s.State != SessionRunning {
		t.Fatalf("session state during disconnect = %q, want running", s.State)
	}

	// Server returns on the same port; a helper client publishes GAP messages
	// immediately — inside the manager's ~1s reconnect backoff window — so
	// they land while the session is unsubscribed. Core NATS has no storage,
	// so they must never be replayed.
	srv2 := startServerOnPort(t, port, dir)
	gap := connect(t, srv2.ClientURL())
	gapPublished := burstPublish(t, gap, subj, 6, 2, 10*time.Millisecond, []byte("gap-"))
	time.Sleep(300 * time.Millisecond) // widen the window; manager still reconnecting

	waitManagerConnected(t, mgr, 15*time.Second) // nats.go reconnect (same conn)
	if !rec.sawConnState(connections.StateConnected) {
		t.Fatal("no connected event after restart")
	}

	ncPost := connect(t, srv2.ClientURL()) // fresh publisher for the new server
	post := burstPublish(t, ncPost, subj, 4, 4, 10*time.Millisecond, []byte("post-"))
	final := waitQuiescent(t, sm, st.ID, 15*time.Second)
	if s, _ := findState(sm, st.ID); s.State != SessionRunning {
		t.Fatalf("session state after reconnect = %q, want running", s.State)
	}
	if final.Total != int64(pre+post) {
		t.Fatalf("Total = %d, want %d (gap messages must NOT be replayed)", final.Total, pre+post)
	}

	// Payload audit (in-memory only; nothing is logged): every pre-* message
	// exactly once, no gap-* at all, every post-* present, and nothing else
	// (rules out both gap replay and reconnect duplicates).
	got := rec.countPayloadPrefix(st.ID, "pre-")
	gapN := rec.countPayloadPrefix(st.ID, "gap-")
	postN := rec.countPayloadPrefix(st.ID, "post-")
	if got != pre || postN != post || gapN != 0 {
		t.Fatalf("payload audit: pre=%d (want %d) gap=%d (want 0) post=%d (want %d); gap published=%d",
			got, pre, gapN, postN, post, gapPublished)
	}
}
