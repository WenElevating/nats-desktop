// Real-server end-to-end stress gate (Task 11; binding user mandate:
// performance/stress tests hit the REAL local nats-server nats://127.0.0.1:4333,
// JS on, monitor :8333/jsz). A SessionManager session is created over the
// production connection stack, a publisher goroutine floods it with 1KB
// messages, and the session must sustain >= stressFloorMsgS RECEIVED over a
// 10s window with the conservation invariant intact (push side: receipts ==
// emitted; buffer side: Total == Dropped + BufferUsed; plus ring cross-check
// and seq continuity). CI-invisible: skips cleanly when the server is
// unreachable — Task 13 documents this as the locally-scripted stress gate.

package messaging

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/jsm.go/natscontext"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
)

// stressFloorMsgS is the user-mandated sustained end-to-end floor: >= 5,000
// msg/s RECEIVED by a real session over the measurement window.
const stressFloorMsgS = 5000

// stressWindow is the sustained-rate measurement window (mandate: 10s).
const stressWindow = 10 * time.Second

// stressEmit is an O(1)-memory emit sink for flood volumes: the shared
// emitRecorder retains every MsgOut (GBs at flood rates), so the stress gate
// only counts emissions and tracks the newest seq.
type stressEmit struct {
	msgs    atomic.Int64 // messages emitted toward the frontend (session:msgs)
	lastSeq atomic.Int64 // seq of the newest emitted message
}

func (e *stressEmit) emit(name string, data any) {
	if b, ok := data.([]MsgOut); ok && len(b) > 0 {
		e.msgs.Add(int64(len(b)))
		e.lastSeq.Store(b[len(b)-1].Seq)
	}
}

// newStressStack builds a connected connections.Manager + SessionManager wired
// the way main.go wires Task 7 (conn:state side-band into the SessionManager),
// but with the lean counting emit instead of the full recorder. Skips when the
// local server is unreachable.
func newStressStack(t *testing.T) (*SessionManager, *stressEmit) {
	t.Helper()
	requireLocalServer(t)

	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	e := &stressEmit{}

	var sm *SessionManager
	mgr := connections.NewManager(reg, log, func(name string, data any) {
		if ev, ok := data.(connections.StateEvent); ok && sm != nil {
			sm.NotifyConnState(ev) // main.go Task 7 side-band wiring
		}
	})
	sm = NewSessionManager(mgr, log, e.emit, 0, PushRealtime)

	store := connections.NewStore(reg)
	if err := store.Save(context.Background(), connections.ContextForm{Name: "stress", URL: localServerURL}, 0); err != nil {
		t.Fatal(err)
	}
	if err := mgr.Connect(context.Background(), "stress"); err != nil {
		t.Fatal(err)
	}
	waitManagerConnected(t, mgr, 10*time.Second)
	t.Cleanup(mgr.Disconnect) // LIFO: CloseAll runs first, then Disconnect
	t.Cleanup(sm.CloseAll)
	return sm, e
}

// TestSessionRealServerStress floods one realtime session through the real
// local nats-server and asserts the mandated sustained end-to-end floor plus
// the full conservation invariant under flood.
func TestSessionRealServerStress(t *testing.T) {
	sm, emit := newStressStack(t)
	subject := "m2t11.stress." + uniqueSuffix()

	st, err := sm.CreateSession(context.Background(), SessionSpec{Subject: subject, PushMode: PushRealtime})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if st.State != SessionRunning {
		t.Fatalf("session state = %q, want running", st.State)
	}

	// Flood: one unbounded publisher goroutine, 1KB payloads (the spec flood
	// profile). Flooding (rather than pacing) measures the true sustained
	// ceiling; the assertion is the 5k msg/s floor, far below it.
	payload := make([]byte, 1024)
	nc := connect(t, localServerURL)
	stop := make(chan struct{})
	pubDone := make(chan struct{})
	var published atomic.Int64
	go func() {
		defer close(pubDone)
		for {
			select {
			case <-stop:
				return
			default:
			}
			if err := nc.Publish(subject, payload); err != nil {
				return
			}
			published.Add(1)
		}
	}()

	// Warm-up: open the measurement window only once messages are flowing, so
	// subscription ramp-up cannot dilute the sustained rate.
	waitSessionTotal(t, sm, st.ID, 1, 10*time.Second)

	c0 := emit.msgs.Load()
	t0 := time.Now()
	time.Sleep(stressWindow)
	t1 := time.Now()
	c1 := emit.msgs.Load()
	close(stop)
	<-pubDone

	received := c1 - c0
	rate := float64(received) / t1.Sub(t0).Seconds()
	t.Logf("real-server sustained throughput: %d msgs received over %v => %.0f msg/s (floor %d msg/s); published total %d",
		received, t1.Sub(t0), rate, stressFloorMsgS, published.Load())
	if rate < stressFloorMsgS {
		t.Fatalf("sustained throughput %.0f msg/s below the %d msg/s floor (%d msgs in %v)",
			rate, stressFloorMsgS, received, t1.Sub(t0))
	}

	// Drain trailing deliveries, then assert conservation under flood.
	snap := waitQuiescent(t, sm, st.ID, 15*time.Second)
	s := getSession(t, sm, st.ID)
	emitted := emit.msgs.Load()

	// Push side: every receipt was handed to the pusher (running realtime
	// session) and reached the emit sink.
	if snap.Total != emitted {
		t.Fatalf("conservation (push side): session Total = %d, emitted = %d", snap.Total, emitted)
	}
	// Seq continuity: one seq per receipt, all emitted => lastSeq == count.
	if seq := s.seq.Load(); seq != emitted {
		t.Fatalf("seq continuity broken: last seq = %d, emitted = %d", seq, emitted)
	}
	if last := emit.lastSeq.Load(); last != emitted {
		t.Fatalf("seq continuity broken: newest emitted seq = %d, emitted = %d", last, emitted)
	}
	// Buffer side: every receipt is resident in the ring or evicted.
	if snap.Total != snap.Dropped+int64(snap.BufferUsed) {
		t.Fatalf("conservation (buffer side): Total %d != Dropped %d + BufferUsed %d",
			snap.Total, snap.Dropped, snap.BufferUsed)
	}
	// Ring cross-check: the snapshot numbers must match the real ring state.
	if d := s.ring.Dropped(); d != snap.Dropped {
		t.Fatalf("ring dropped = %d, snapshot says %d", d, snap.Dropped)
	}
	if got := len(s.ring.Snapshot(s.cap)); got != snap.BufferUsed {
		t.Fatalf("ring holds %d messages, snapshot says BufferUsed %d", got, snap.BufferUsed)
	}
}
