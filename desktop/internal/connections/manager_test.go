package connections

import (
	"context"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
	"github.com/nats-io/jsm.go/natscontext"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// eventRecorder captures every emit call. Connection handlers fire on
// nats.go client-internal goroutines, so all access is mutex-guarded.
type eventRecorder struct {
	mu     sync.Mutex
	names  []string
	events []StateEvent
}

func (r *eventRecorder) emit(name string, data any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.names = append(r.names, name)
	if ev, ok := data.(StateEvent); ok {
		r.events = append(r.events, ev)
	}
}

func (r *eventRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.events)
}

func (r *eventRecorder) last() (StateEvent, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.events) == 0 {
		return StateEvent{}, false
	}
	return r.events[len(r.events)-1], true
}

func (r *eventRecorder) dump() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var b strings.Builder
	for _, ev := range r.events {
		b.WriteString(string(ev.State))
		if ev.Reason != "" {
			b.WriteString("(" + ev.Reason + ")")
		}
		b.WriteString(" ")
	}
	return b.String()
}

// newRecordingManager wires a Manager over a temp-dir registry whose
// emissions are captured by the returned recorder.
func newRecordingManager(t *testing.T) (*Manager, *eventRecorder, *Store) {
	t.Helper()
	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	rec := &eventRecorder{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	m := NewManager(reg, log, rec.emit)
	return m, rec, NewStore(reg)
}

// formMod mutates a ContextForm within saveContext.
type formMod func(*ContextForm)

func withUser(user, pass string) formMod {
	return func(f *ContextForm) { f.User, f.Password = user, pass }
}

func saveContext(t *testing.T, store *Store, name, url string, mods ...formMod) {
	t.Helper()
	f := ContextForm{Name: name, URL: url}
	for _, mod := range mods {
		mod(&f)
	}
	if err := store.Save(context.Background(), f, 0); err != nil {
		t.Fatal(err)
	}
}

// waitForStateAfter polls until a StateEvent with State==want is emitted
// at index >= min, or fails after timeout. min lets a test distinguish a
// NEW transition from earlier ones with the same state.
func waitForStateAfter(t *testing.T, rec *eventRecorder, want State, min int, timeout time.Duration) StateEvent {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		rec.mu.Lock()
		for i := min; i < len(rec.events); i++ {
			if rec.events[i].State == want {
				ev := rec.events[i]
				rec.mu.Unlock()
				return ev
			}
		}
		rec.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("state %q (index >= %d) not observed within %v; emitted: %s", want, min, timeout, rec.dump())
	return StateEvent{}
}

func waitForState(t *testing.T, rec *eventRecorder, want State, timeout time.Duration) StateEvent {
	t.Helper()
	return waitForStateAfter(t, rec, want, 0, timeout)
}

func assertLastState(t *testing.T, rec *eventRecorder, want State) {
	t.Helper()
	ev, ok := rec.last()
	if !ok || ev.State != want {
		t.Fatalf("last state = %+v, want %q (all: %s)", ev, want, rec.dump())
	}
}

func assertAllEventNames(t *testing.T, rec *eventRecorder) {
	t.Helper()
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for _, n := range rec.names {
		if n != EventConnState {
			t.Fatalf("emitted event name %q, want %q", n, EventConnState)
		}
	}
}

// TestStateMachineHappyPath covers disconnected -> connecting ->
// connected -> disconnected (spec §10).
func TestStateMachineHappyPath(t *testing.T) {
	url := testutil.StartJSServer(t)
	m, events, store := newRecordingManager(t)
	t.Cleanup(m.Disconnect)

	if ev := m.Snapshot(); ev.State != StateDisconnected {
		t.Fatalf("initial snapshot: %+v", ev)
	}

	saveContext(t, store, "demo", url)
	if err := m.Connect(context.Background(), "demo"); err != nil {
		t.Fatal(err)
	}

	connected := waitForState(t, events, StateConnected, 10*time.Second)
	if connected.Context != "demo" {
		t.Fatalf("connected event context %q, want %q", connected.Context, "demo")
	}
	if _, err := time.Parse(time.RFC3339, connected.Since); err != nil {
		t.Fatalf("Since not RFC3339: %q", connected.Since)
	}
	if ev := m.Snapshot(); ev.State != StateConnected || ev.Context != "demo" {
		t.Fatalf("snapshot after connect: %+v", ev)
	}

	rtt, err := m.MeasureRTT()
	// RTT measures a PING write+flush, which is legitimately 0 on
	// loopback; only a negative value or an error is a failure.
	if err != nil || rtt < 0 {
		t.Fatalf("MeasureRTT = %v, %v; want >= 0, nil error", rtt, err)
	}

	m.Disconnect()
	waitForState(t, events, StateDisconnected, 5*time.Second)
	if _, err := m.MeasureRTT(); err == nil {
		t.Fatal("MeasureRTT must fail when disconnected")
	}
	assertAllEventNames(t, events)
}

// TestReconnectOnServerRestart covers connected -> reconnecting ->
// connected on server loss and restart (spec §10). The fixture is inline
// (not testutil) because the server must die and come back on the SAME
// port and store dir.
func TestReconnectOnServerRestart(t *testing.T) {
	port := freePort(t)
	dir := t.TempDir()
	srv := startServerOnPort(t, port, dir)

	m, events, store := newRecordingManager(t)
	saveContext(t, store, "re", srv.ClientURL())
	if err := m.Connect(context.Background(), "re"); err != nil {
		t.Fatal(err)
	}
	waitForState(t, events, StateConnected, 30*time.Second)

	// Server dies: the client must move to reconnecting (not failed).
	srv.Shutdown()
	first := events.count()
	waitForStateAfter(t, events, StateReconnecting, first, 30*time.Second)

	// Register the manager cleanup now so cleanup order is LIFO:
	// disconnect the client before the replacement server shuts down.
	t.Cleanup(m.Disconnect)

	// Server returns on the same port and store dir: reconnect, then
	// connected again.
	srv2 := startServerOnPort(t, port, dir)
	t.Cleanup(srv2.Shutdown)
	reconnecting := events.count()
	waitForStateAfter(t, events, StateConnected, reconnecting, 30*time.Second)
	if ev := m.Snapshot(); ev.State != StateConnected {
		t.Fatalf("snapshot after reconnect: %+v", ev)
	}
}

// TestAuthFailureGoesFailedNoRetryLoop covers connected/connecting ->
// failed on authorization errors and asserts the failure is terminal
// (spec §6.2: no retry loop).
func TestAuthFailureGoesFailedNoRetryLoop(t *testing.T) {
	url := testutil.StartAuthServer(t, "u", "right")
	m, events, store := newRecordingManager(t)
	t.Cleanup(m.Disconnect)

	saveContext(t, store, "bad", url, withUser("u", "wrong"))
	if err := m.Connect(context.Background(), "bad"); err == nil {
		t.Fatal("connect with wrong credentials must fail")
	}

	waitForState(t, events, StateFailed, 10*time.Second)
	snap := m.Snapshot()
	if !strings.Contains(strings.ToLower(snap.Reason), "authorization") {
		t.Fatalf("failure reason %q should mention authorization", snap.Reason)
	}

	// Auth failure must terminate: freeze the event count and verify no
	// further transitions arrive (no reconnect loop).
	before := events.count()
	time.Sleep(3 * time.Second)
	if after := events.count(); after != before {
		t.Fatalf("state kept changing after auth failure (retry loop?): before=%d after=%d events=%s",
			before, after, events.dump())
	}
	assertLastState(t, events, StateFailed)
}

func TestCheckConnection(t *testing.T) {
	url := testutil.StartJSServer(t)
	m, _, _ := newRecordingManager(t)

	res := m.CheckConnection(context.Background(), ContextForm{Name: "t", URL: url})
	if !res.OK || !res.JetStream || res.RttMs < 0 || res.Error != "" {
		t.Fatalf("unexpected: %+v", res)
	}
}

func TestCheckConnectionWithoutJetStream(t *testing.T) {
	srv := startServerOnPort(t, freePort(t), t.TempDir())
	t.Cleanup(srv.Shutdown)

	m, _, _ := newRecordingManager(t)
	res := m.CheckConnection(context.Background(), ContextForm{Name: "t", URL: srv.ClientURL()})
	if !res.OK || res.JetStream {
		t.Fatalf("plain server must be reachable without JetStream: %+v", res)
	}
}

func TestCheckConnectionFailure(t *testing.T) {
	m, _, _ := newRecordingManager(t)
	res := m.CheckConnection(context.Background(), ContextForm{Name: "t", URL: "nats://127.0.0.1:1"})
	if res.OK || res.Error == "" || res.JetStream {
		t.Fatalf("dead endpoint must fail with an error: %+v", res)
	}
}

func TestConnectUnknownContext(t *testing.T) {
	m, events, _ := newRecordingManager(t)
	if err := m.Connect(context.Background(), "nope"); err == nil {
		t.Fatal("expected error for unknown context")
	}
	assertLastState(t, events, StateFailed)
	if ev := m.Snapshot(); ev.State != StateFailed || ev.Context != "nope" {
		t.Fatalf("snapshot: %+v", ev)
	}
}

// TestConnectReplacesExistingConnection verifies that switching contexts
// closes the previous connection and that stale handlers of the replaced
// connection cannot leak state transitions afterwards.
func TestConnectReplacesExistingConnection(t *testing.T) {
	urlA := testutil.StartJSServer(t)
	urlB := testutil.StartJSServer(t)
	m, events, store := newRecordingManager(t)
	t.Cleanup(m.Disconnect)

	saveContext(t, store, "a", urlA)
	saveContext(t, store, "b", urlB)

	if err := m.Connect(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	waitForState(t, events, StateConnected, 10*time.Second)

	if err := m.Connect(context.Background(), "b"); err != nil {
		t.Fatal(err)
	}
	switched := events.count()
	waitForStateAfter(t, events, StateConnected, switched, 10*time.Second)

	// Give any stale handlers of connection A time to (wrongly) fire.
	time.Sleep(500 * time.Millisecond)
	assertLastState(t, events, StateConnected)
	if ev := m.Snapshot(); ev.Context != "b" || ev.State != StateConnected {
		t.Fatalf("snapshot after switch: %+v", ev)
	}
}

// blackholeURL returns a nats:// URL whose TCP port accepts connections
// but never speaks the NATS protocol, so nats.Connect blocks for its full
// Timeout (5s) before failing — a deterministic in-flight dial window.
func blackholeURL(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			// Hold the connection open; never send INFO.
			_ = c
		}
	}()
	return "nats://" + l.Addr().String()
}

// TestDisconnectDuringInFlightConnect: a Disconnect that lands while
// Connect is mid-dial is terminal (spec §10) — the late dial error must
// not overwrite disconnected with failed, and no stale connecting may
// remain.
func TestDisconnectDuringInFlightConnect(t *testing.T) {
	m, events, store := newRecordingManager(t)
	saveContext(t, store, "bh", blackholeURL(t))

	done := make(chan error, 1)
	go func() {
		done <- m.Connect(context.Background(), "bh")
	}()

	// The attempt is now inside the dial window (connecting emitted, dial
	// hanging for the full 5s timeout).
	waitForState(t, events, StateConnecting, 5*time.Second)
	m.Disconnect()
	waitForState(t, events, StateDisconnected, 5*time.Second)

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("in-flight connect against a blackhole must fail")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("connect goroutine did not finish")
	}

	// The contract (spec §10): the late dial error must not OVERWRITE the
	// terminal disconnected — i.e. no failed may appear AFTER disconnected,
	// and disconnected is final. On hosts whose stack resets silent sockets
	// quickly (observed on CI runners), the dial may legitimately fail
	// BEFORE the user's Disconnect lands ([connecting failed disconnected]);
	// that ordering is correct behavior, not an overwrite, so the assertion
	// is order-aware rather than "failed never emitted".
	events.mu.Lock()
	states := make([]State, 0, len(events.events))
	for _, ev := range events.events {
		states = append(states, ev.State)
	}
	events.mu.Unlock()
	lastDisc := -1
	for i, s := range states {
		if s == StateDisconnected {
			lastDisc = i
		}
	}
	for i := lastDisc + 1; i < len(states); i++ {
		if states[i] == StateFailed {
			t.Fatalf("late dial error overwrote terminal disconnected with failed: %v", states)
		}
	}
	assertLastState(t, events, StateDisconnected)
	if ev := m.Snapshot(); ev.State != StateDisconnected {
		t.Fatalf("snapshot after disconnect race: %+v", ev)
	}
}

// TestConnectDialErrorGoesFailed covers connecting -> failed on an
// immediate dial error (dead endpoint, no interruption).
func TestConnectDialErrorGoesFailed(t *testing.T) {
	m, events, store := newRecordingManager(t)
	saveContext(t, store, "dead", "nats://127.0.0.1:1")

	if err := m.Connect(context.Background(), "dead"); err == nil {
		t.Fatal("dial to dead endpoint must fail")
	}
	waitForState(t, events, StateFailed, 5*time.Second)
	assertLastState(t, events, StateFailed)
	if ev := m.Snapshot(); ev.State != StateFailed || ev.Context != "dead" {
		t.Fatalf("snapshot after dial error: %+v", ev)
	}
}

func TestReconnectBackoff(t *testing.T) {
	cases := []struct {
		attempts int
		want     time.Duration
	}{
		{-1, 1 * time.Second},
		{0, 1 * time.Second},
		{1, 2 * time.Second},
		{2, 4 * time.Second},
		{3, 8 * time.Second},
		{4, 10 * time.Second},
		{100, 10 * time.Second},
	}
	for _, c := range cases {
		if got := reconnectBackoff(c.attempts); got != c.want {
			t.Fatalf("reconnectBackoff(%d) = %v, want %v", c.attempts, got, c.want)
		}
	}
}

// TestConnAccessor covers the Conn accessor across the full lifecycle:
// nil before connect, live CONNECTED conn after, nil again after
// disconnect (hermetic embedded-fixture path).
func TestConnAccessor(t *testing.T) {
	url := testutil.StartJSServer(t)
	m, events, store := newRecordingManager(t)
	saveContext(t, store, "demo", url)
	if m.Conn() != nil {
		t.Fatal("no conn before connect")
	}
	if err := m.Connect(context.Background(), "demo"); err != nil {
		t.Fatal(err)
	}
	waitForState(t, events, StateConnected, 5*time.Second)
	if c := m.Conn(); c == nil || c.Status() != nats.CONNECTED {
		t.Fatalf("expected live conn, got %v", c)
	}
	m.Disconnect()
	waitForState(t, events, StateDisconnected, 5*time.Second)
	if m.Conn() != nil {
		t.Fatal("conn must be nil after disconnect")
	}
}

// TestConnAccessorLocalServer runs the same accessor assertions against the
// real long-lived local nats-server (M2 mandate: NATS-connectivity tests
// exercise a real server whenever one is available). Skips cleanly when the
// server is unreachable so CI without it still passes.
func TestConnAccessorLocalServer(t *testing.T) {
	const (
		url = "nats://127.0.0.1:4333"
		ctx = "m2-t1"
	)

	probe, err := nats.Connect(url, nats.Timeout(2*time.Second), nats.MaxReconnects(0))
	if err != nil {
		t.Skipf("local nats-server at %s unreachable: %v", url, err)
	}
	probe.Close()

	m, events, store := newRecordingManager(t)
	saveContext(t, store, ctx, url)
	t.Cleanup(func() {
		m.Disconnect()
		if err := store.Delete(context.Background(), ctx); err != nil {
			t.Errorf("delete context %q: %v", ctx, err)
		}
	})

	if m.Conn() != nil {
		t.Fatal("no conn before connect")
	}
	if err := m.Connect(context.Background(), ctx); err != nil {
		t.Fatal(err)
	}
	waitForState(t, events, StateConnected, 5*time.Second)
	if c := m.Conn(); c == nil || c.Status() != nats.CONNECTED {
		t.Fatalf("expected live conn, got %v", c)
	}
	m.Disconnect()
	waitForState(t, events, StateDisconnected, 5*time.Second)
	if m.Conn() != nil {
		t.Fatal("conn must be nil after disconnect")
	}
}

// TestJSParams covers the JetStream handle parameters accessor across the
// lifecycle: ok=false before connect, the saved context's JSDomain/JSAPIPrefix
// while connected, ok=false again after disconnect.
func TestJSParams(t *testing.T) {
	url := testutil.StartJSServer(t)
	m, rec, store := newRecordingManager(t) // connections 既有助手（manager_test.go:67）：(*Manager, *eventRecorder, *Store)
	if _, _, ok := m.JSParams(); ok {
		t.Fatal("no params before connect")
	}
	saveContext(t, store, "demo", url, func(f *ContextForm) { f.JSDomain = "HUB" })
	if err := m.Connect(context.Background(), "demo"); err != nil {
		t.Fatal(err)
	}
	waitForState(t, rec, StateConnected, 5*time.Second)
	domain, prefix, ok := m.JSParams()
	if !ok || domain != "HUB" || prefix != "" {
		t.Fatalf("got (%q,%q,%v)", domain, prefix, ok)
	}
	m.Disconnect()
	waitForState(t, rec, StateDisconnected, 5*time.Second)
	if _, _, ok := m.JSParams(); ok {
		t.Fatal("params must be unavailable after disconnect")
	}
}

// freePort asks the OS for a currently unused TCP port.
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
// store dir (no JetStream, no auth). Cleanup is NOT registered so tests
// can shut the server down and restart a twin on the same port.
func startServerOnPort(t *testing.T, port int, dir string) *server.Server {
	t.Helper()
	srv, err := server.NewServer(&server.Options{
		Port:       port,
		ServerName: "TEST_MGR",
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
