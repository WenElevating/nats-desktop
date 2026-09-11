package connections

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/jsm.go/natscontext"
	"github.com/nats-io/nats.go"
)

// Manager owns the single live NATS connection and drives its five-state
// lifecycle — disconnected / connecting / connected / reconnecting /
// failed (spec §10). Every transition updates the fields under mu and
// emits EventConnState.
//
// Concurrency model: nats.go invokes connection callbacks (connect,
// disconnect, reconnect, error, closed) on client-internal goroutines.
// All Manager state lives behind mu, and emit is called with mu held so
// event ordering matches transition ordering — emit implementations must
// not call back into the Manager (they would deadlock on the
// non-reentrant mutex). The production emit is the Wails event forwarder,
// which only serializes and publishes.
//
// Each connect attempt has a generation number. Callbacks capture the
// generation at registration and ignore themselves when the Manager has
// moved on (a newer Connect attempt or a Disconnect), so stale handlers
// of a replaced or closed connection can never leak transitions.
type Manager struct {
	mu   sync.Mutex
	reg  *natscontext.Registry
	log  *slog.Logger
	emit func(name string, data any)

	nc     *nats.Conn
	gen    uint64 // connect-attempt generation; stale callbacks are ignored
	active string // name of the context the state refers to

	// cur is the Snapshot payload; fields are only mutated under mu.
	state  State
	since  string
	rttMs  int64
	reason string

	// userClosed marks that the current connection was closed by
	// Disconnect/Connect-replacement, not by the network.
	userClosed bool
}

// NewManager returns a Manager over reg. A nil reg defaults to the
// CLI-interop registry, a nil log discards output, and a nil emit turns
// events into no-ops (tests may inject a recorder).
func NewManager(reg *natscontext.Registry, log *slog.Logger, emit func(name string, data any)) *Manager {
	if reg == nil {
		reg = NewRegistry()
	}
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if emit == nil {
		emit = func(string, any) {}
	}
	return &Manager{
		reg:   reg,
		log:   log,
		emit:  emit,
		state: StateDisconnected,
		since: time.Now().Format(time.RFC3339),
	}
}

// Connect establishes the connection for the stored context name,
// replacing any active connection first. It returns an error (with the
// state machine moved to failed) when the context cannot be loaded or
// the initial connect fails; later transitions are driven by the nats.go
// handlers.
func (m *Manager) Connect(ctx context.Context, name string) error {
	m.mu.Lock()
	old := m.nc
	m.nc = nil
	m.gen++
	m.userClosed = false
	m.active = name
	gen := m.gen
	m.mu.Unlock()

	// Stale handlers of the replaced connection are invalidated by the
	// generation bump above; Close never blocks on callback dispatch.
	// Every transition after the first critical section is gen-guarded:
	// a Disconnect (or newer Connect) that lands mid-attempt owns the
	// state machine from then on, and this attempt must not overwrite
	// its terminal states (spec §10).
	if old != nil {
		old.Close()
		m.setStateIfCurrent(gen, StateDisconnected, "")
	}

	m.setStateIfCurrent(gen, StateConnecting, "")

	cfg, err := m.reg.Load(ctx, name)
	if err != nil {
		m.setStateIfCurrent(gen, StateFailed, fmt.Sprintf("load context: %v", err))
		return err
	}
	opts, err := cfg.NATSOptions()
	if err != nil {
		m.setStateIfCurrent(gen, StateFailed, fmt.Sprintf("context options: %v", err))
		return err
	}

	opts = append(opts,
		nats.Name("nats-desktop"),
		nats.Timeout(5*time.Second),
		nats.MaxReconnects(-1),
		nats.CustomReconnectDelay(reconnectBackoff),
		nats.ConnectHandler(func(nc *nats.Conn) { m.onConnected(gen, nc) }),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) { m.onDisconnect(gen, err) }),
		nats.ReconnectHandler(func(nc *nats.Conn) { m.onConnected(gen, nc) }),
		nats.ErrorHandler(func(nc *nats.Conn, _ *nats.Subscription, err error) { m.onError(gen, nc, err) }),
		nats.ClosedHandler(func(_ *nats.Conn) { m.onClosed(gen) }),
	)

	nc, err := nats.Connect(cfg.ServerURL(), opts...)
	if err != nil {
		// The dial may have taken up to Timeout (5s); if a Disconnect
		// landed in that window it already emitted its terminal
		// disconnected and the failure must not overwrite it.
		m.setStateIfCurrent(gen, StateFailed, err.Error())
		return err
	}

	m.mu.Lock()
	if m.gen != gen {
		// A newer attempt or a Disconnect superseded this one while we
		// were dialing; discard the connection instead of adopting it.
		m.mu.Unlock()
		nc.Close()
		return nil
	}
	m.nc = nc
	m.mu.Unlock()
	return nil
}

// Disconnect user-closes the active connection and moves the state
// machine to disconnected. Closing is user-initiated: no reconnecting or
// failed transition follows.
func (m *Manager) Disconnect() {
	m.mu.Lock()
	nc := m.nc
	m.nc = nil
	m.userClosed = true
	m.gen++
	m.setStateLocked(StateDisconnected, "")
	m.mu.Unlock()

	if nc != nil {
		nc.Close()
	}
}

// Snapshot returns the current state as a StateEvent.
func (m *Manager) Snapshot() StateEvent {
	m.mu.Lock()
	defer m.mu.Unlock()
	return StateEvent{
		Context: m.active,
		State:   m.state,
		Since:   m.since,
		RttMs:   m.rttMs,
		Reason:  m.reason,
	}
}

// MeasureRTT returns a fresh round-trip measurement over the active
// connection, or an error when there is none.
func (m *Manager) MeasureRTT() (time.Duration, error) {
	m.mu.Lock()
	nc := m.nc
	m.mu.Unlock()
	if nc == nil || !nc.IsConnected() {
		return 0, errors.New("measure rtt: not connected")
	}
	return nc.RTT()
}

// CheckConnection dials a throwaway connection from form (nothing is
// persisted and the Manager state machine is not involved), measures the
// average of five RTT samples, probes JetStream via
// jsm.JetStreamAccountInfo, and closes the connection again. The ctx
// parameter is accepted for API symmetry; nats.Connect dials without one.
func (m *Manager) CheckConnection(_ context.Context, form ContextForm) TestResult {
	fail := func(err error) TestResult { return TestResult{OK: false, Error: err.Error()} }

	cfg, err := natscontext.New("check", false, formOptions(form)...)
	if err != nil {
		return fail(err)
	}
	opts, err := cfg.NATSOptions()
	if err != nil {
		return fail(err)
	}
	opts = append(opts,
		nats.Name("nats-desktop-check"),
		nats.Timeout(5*time.Second),
		nats.MaxReconnects(1),
	)

	nc, err := nats.Connect(cfg.ServerURL(), opts...)
	if err != nil {
		return fail(err)
	}
	defer nc.Close()

	// Let the connection settle before sampling (mirrors `nats rtt`).
	time.Sleep(25 * time.Millisecond)

	var total time.Duration
	samples := 0
	for i := 0; i < 5; i++ {
		if d, err := nc.RTT(); err == nil {
			total += d
			samples++
		}
	}

	var jsOK bool
	if jm, err := jsm.New(nc); err == nil {
		if _, err := jm.JetStreamAccountInfo(); err == nil {
			jsOK = true
		}
	}

	res := TestResult{OK: true, JetStream: jsOK}
	if samples > 0 {
		res.RttMs = (total / time.Duration(samples)).Milliseconds()
	}
	return res
}

// reconnectBackoff is the desktop reconnect backoff: exponential 2^n
// seconds capped at 10s (desktop-side equivalent of natscli's
// iu.DefaultBackoff).
func reconnectBackoff(attempts int) time.Duration {
	if attempts < 0 {
		attempts = 0
	}
	const maxBackoff = 10 * time.Second
	d := time.Duration(1) << min(attempts, 30) * time.Second
	if d > maxBackoff {
		d = maxBackoff
	}
	return d
}

// onConnected handles both initial connect and reconnect: measure the
// RTT first (network round trip; must not run under mu) and then move to
// connected.
func (m *Manager) onConnected(gen uint64, nc *nats.Conn) {
	rtt, rttErr := nc.RTT()

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gen != gen || m.userClosed {
		return
	}
	m.state = StateConnected
	m.since = time.Now().Format(time.RFC3339)
	m.reason = ""
	m.rttMs = 0
	if rttErr == nil {
		m.rttMs = rtt.Milliseconds()
	}
	m.emitLocked()
}

// onDisconnect moves to reconnecting on network loss. A user-initiated
// close must not transition, and once an authorization error has moved
// the machine to failed a queued disconnect callback must not resurrect
// reconnecting (spec §6.2: auth failure terminates).
func (m *Manager) onDisconnect(gen uint64, _ error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gen != gen || m.userClosed || m.state == StateFailed {
		return
	}
	m.setStateLocked(StateReconnecting, "")
}

// onError terminates the connection on authorization errors: failed +
// close, and deliberately WITHOUT nats.IgnoreAuthErrorAbort so the
// client does not keep retrying bad credentials (spec §6.2).
func (m *Manager) onError(gen uint64, nc *nats.Conn, err error) {
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "authorization") {
		return
	}

	m.mu.Lock()
	if m.gen != gen || m.userClosed || m.state == StateFailed {
		m.mu.Unlock()
		return
	}
	m.setStateLocked(StateFailed, err.Error())
	m.mu.Unlock()

	// Close outside the lock: nc.Close only enqueues the disconnect and
	// closed callbacks (dispatched asynchronously); it never waits for
	// them, so this cannot deadlock with handlers blocked on mu.
	nc.Close()
}

// onClosed marks unexpected closes as failed. User closes (gen/userClosed
// guards) and closes that already followed an authorization failure
// (state failed) are ignored.
func (m *Manager) onClosed(gen uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gen != gen || m.userClosed || m.state == StateFailed {
		return
	}
	m.setStateLocked(StateFailed, "connection closed")
}

// setStateIfCurrent transitions to state only when gen is still the
// Manager's current generation — i.e. neither a Disconnect nor a newer
// Connect attempt has superseded the caller's attempt. It is a no-op
// otherwise, so a mid-dial Disconnect keeps its terminal disconnected
// state instead of being overwritten with failed/connecting (spec §10).
func (m *Manager) setStateIfCurrent(gen uint64, state State, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gen != gen {
		return
	}
	m.setStateLocked(state, reason)
}

// setStateLocked transitions to state; callers must hold mu.
func (m *Manager) setStateLocked(state State, reason string) {
	m.state = state
	m.since = time.Now().Format(time.RFC3339)
	m.reason = reason
	if state != StateConnected {
		m.rttMs = 0
	}
	m.emitLocked()
}

// emitLocked publishes the current state; callers must hold mu (emitting
// under the lock preserves event ordering).
func (m *Manager) emitLocked() {
	m.log.Debug("connection state changed",
		"context", m.active, "state", m.state, "rtt_ms", m.rttMs, "reason", m.reason)
	m.emit(EventConnState, StateEvent{
		Context: m.active,
		State:   m.state,
		Since:   m.since,
		RttMs:   m.rttMs,
		Reason:  m.reason,
	})
}
