// Core subscription session manager (spec §6.4). Each session wraps one core
// NATS subscription with a ring buffer (scrollback + drop accounting), a
// realtime/batch pusher toward the frontend, a sliding-window rate meter, and
// pause/resume/clear/close semantics:
//
//   - Pause freezes the DISPLAY (List/state events stop moving, rate reads 0,
//     no session:msgs are emitted) while the subscription keeps receiving and
//     the ring keeps scrolling to the latest messages (spec AC-006; counting
//     continues internally). Resume continues from newest — paused-period
//     messages are never replayed.
//   - Clear resets the ring and the display counters; the subscription keeps
//     receiving and new messages are counted fresh.
//   - Reconnect: NotifyConnState is the main.go side-band for conn:state
//     events (Task 7 wiring). On connected, every non-closed session is
//     resubscribed — skipped when nats.go already re-armed the same
//     connection (its core subscriptions survive a reconnect of the same
//     *nats.Conn). Messages seen during a disconnect are never replayed
//     (core NATS is at-most-once, fire-and-forget).
//
// Per-message flow (handler runs on nats.go client goroutines, one dispatcher
// per subscription, so emissions of a session are ordered by Seq): assemble
// MsgOut (seq from an atomic counter starting at 1) -> rate.Inc -> under the
// session mutex: total++ and ring.Add (ring scrolls whether paused or not) ->
// outside the session mutex, only when not paused: emitted++ and
// pusher.Add -> session:msgs. Payload content is never logged (spec §13.3);
// only subject/size/seq/counters reach the logger.

package messaging

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
)

// Session lifecycle states (spec §6.4 closed set).
const (
	SessionRunning = "running"
	SessionPaused  = "paused"
	SessionClosed  = "closed"
)

// jsPositionMode* are the JSPosition.Mode closed-set values (spec §6.4).
const (
	jsModeAll           = "all"
	jsModeNew           = "new"
	jsModeStartSequence = "start_sequence"
	jsModeStart         = "start_time"
)

// stateThrottleInterval bounds session:state emissions to one per interval
// per session (spec §6.4: 250ms), with a trailing-edge emission so the final
// state always lands.
const stateThrottleInterval = 250 * time.Millisecond

// defaultSessionBuffer is the spec default ring capacity (最近 10,000 条) used
// when NewSessionManager is given a non-positive defaultBuf.
const defaultSessionBuffer = 10000

// Errors surfaced by SessionManager methods. ErrInvalidSubject is the
// E-VALIDATION-style rejection: it fires before any network call.
var (
	ErrInvalidSubject  = errors.New("invalid subject: must be non-empty and contain no whitespace")
	ErrSessionNotFound = errors.New("session not found")
	ErrSessionClosed   = errors.New("session closed")
	ErrManagerClosed   = errors.New("session manager closed")
)

// SessionManager owns all subscription sessions and forwards their events to
// the frontend via emit (event names: EventSessionMsgs / EventSessionState).
// It must be constructed over a connected connections.Manager; CreateSession
// returns ErrNotConnected otherwise. All methods are safe for concurrent use.
type SessionManager struct {
	mgr  *connections.Manager
	log  *slog.Logger
	emit func(name string, data any)

	defBuf  int
	defPush PushMode

	mu       sync.Mutex
	sessions map[string]*session
	closed   bool
	counter  atomic.Int64

	reconnCh chan struct{} // NotifyConnState -> resubscribe worker (coalescing)
	quit     chan struct{} // CloseAll stops the worker
	quitOnce sync.Once
}

// NewSessionManager returns a manager over mgr. A nil log discards output, a
// nil emit turns events into no-ops, defaultBuf <= 0 falls back to the spec
// default (10000), and a defaultPush other than PushBatch falls back to
// PushRealtime (spec: realtime is the global default).
func NewSessionManager(mgr *connections.Manager, log *slog.Logger, emit func(name string, data any), defaultBuf int, defaultPush PushMode) *SessionManager {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if emit == nil {
		emit = func(string, any) {}
	}
	if defaultBuf <= 0 {
		defaultBuf = defaultSessionBuffer
	}
	if defaultPush != PushBatch {
		defaultPush = PushRealtime
	}
	m := &SessionManager{
		mgr:      mgr,
		log:      log,
		emit:     emit,
		defBuf:   defaultBuf,
		defPush:  defaultPush,
		sessions: make(map[string]*session),
		reconnCh: make(chan struct{}, 1),
		quit:     make(chan struct{}),
	}
	go m.resubscribeWorker()
	return m
}

// CreateSession subscribes to spec.Subject and starts the session. The
// subject is validated BEFORE any network call (ErrInvalidSubject for empty or
// whitespace-containing subjects); JetStream replay positioning other than
// new/none is rejected until the Task 5 JS-replay path lands. A subscription
// the server refuses leaves the session registered in state closed with the
// verbatim error text (spec §6.4) and returns that error as well.
func (m *SessionManager) CreateSession(_ context.Context, spec SessionSpec) (SessionState, error) {
	if err := validateSubject(spec.Subject); err != nil {
		return SessionState{}, err
	}
	if spec.JSPosition != nil {
		mode := spec.JSPosition.Mode
		switch mode {
		case "", jsModeNew:
			// Core path: a plain subscription only sees new messages, which is
			// exactly mode "new" (and the nil-omitted default).
		case jsModeAll, jsModeStartSequence, jsModeStart:
			return SessionState{}, fmt.Errorf("messaging: js_position mode %q requires JetStream replay (Task 5), not supported by core sessions", mode)
		default:
			return SessionState{}, fmt.Errorf("messaging: invalid js_position mode %q (closed set: all|new|start_sequence|start_time)", mode)
		}
	}

	push := spec.PushMode
	if push != PushRealtime && push != PushBatch {
		push = m.defPush
	}
	buf := spec.BufferSize
	if buf <= 0 {
		buf = m.defBuf
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return SessionState{}, ErrManagerClosed
	}
	id := fmt.Sprintf("sub-%d", m.counter.Add(1))
	s := newSession(id, spec.Subject, push, buf, m.log, m.emit)
	m.sessions[id] = s
	m.mu.Unlock()

	if err := s.subscribe(m.conn()); err != nil {
		return s.snapshot(), err // registered as closed with the verbatim error
	}
	s.throttle.notify() // initial running state event (leading edge)
	return s.snapshot(), nil
}

// conn returns the live connection, or nil when the manager is disconnected.
// Callers must not hold SessionManager.mu (it would invert against the
// connections.Manager lock via the emit side-band).
func (m *SessionManager) conn() *nats.Conn {
	if m.mgr == nil {
		return nil
	}
	return m.mgr.Conn()
}

// validateSubject applies the local subset of NATS subject rules that must
// never reach the network: the subject must be non-empty and free of
// whitespace (a space would split into protocol tokens server-side).
func validateSubject(subject string) error {
	if subject == "" || strings.ContainsAny(subject, " \t\r\n") {
		return fmt.Errorf("%w: got %q", ErrInvalidSubject, subject)
	}
	return nil
}

// Pause freezes the display of the session (List/state events, rate shown as
// 0) while the subscription keeps receiving. Idempotent; fails on unknown or
// closed sessions.
func (m *SessionManager) Pause(id string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	if err := s.pause(); err != nil {
		return err
	}
	s.throttle.notify()
	return nil
}

// Resume unfreezes the session; new messages continue from the newest, with
// no replay of paused-period messages. Idempotent; fails on unknown or closed
// sessions.
func (m *SessionManager) Resume(id string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	if err := s.resume(); err != nil {
		return err
	}
	s.throttle.notify()
	return nil
}

// Clear resets the ring buffer and the display counters (Total/Dropped/
// BufferUsed back to zero); the subscription keeps receiving and counting
// fresh. The pusher is not touched. Fails on unknown or closed sessions.
func (m *SessionManager) Clear(id string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	if err := s.clear(); err != nil {
		return err
	}
	s.throttle.notify()
	return nil
}

// Close unsubscribes the session, delivers any pending batch tail
// (Flush-before-Stop), and marks it closed. Closed sessions remain listable
// (state closed) but refuse further control operations. Idempotent.
func (m *SessionManager) Close(id string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.close()
	return nil
}

// CloseAll closes every session and stops the reconnect worker. Idempotent;
// the manager refuses new sessions afterwards.
func (m *SessionManager) CloseAll() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	ss := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		ss = append(ss, s)
	}
	m.mu.Unlock()

	m.quitOnce.Do(func() { close(m.quit) })
	for _, s := range ss {
		s.close()
	}
}

// List returns a snapshot of every session (including closed ones), sorted by
// ID. It shares the snapshot source with the EventSessionState payloads.
func (m *SessionManager) List() []SessionState {
	m.mu.Lock()
	ss := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		ss = append(ss, s)
	}
	m.mu.Unlock()

	out := make([]SessionState, 0, len(ss))
	for _, s := range ss {
		out = append(out, s.snapshot())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// NotifyConnState is the side-band through which main.go forwards
// connections.Manager conn:state events (Task 7 wires it alongside emit; the
// connections package is not expanded for this). On connected, all non-closed
// sessions are resubscribed — asynchronously, so it is safe to call from the
// Manager's emit path (which runs under the Manager lock) and can never
// deadlock against Manager.Conn(). Sends are coalescing and non-blocking.
func (m *SessionManager) NotifyConnState(ev connections.StateEvent) {
	if ev.State != connections.StateConnected {
		return
	}
	m.mu.Lock()
	closed := m.closed
	m.mu.Unlock()
	if closed {
		return
	}
	select {
	case m.reconnCh <- struct{}{}:
	default:
	}
}

// resubscribeWorker drains coalesced connected-notifications. m.quit stops it
// (CloseAll); nothing leaks after that.
func (m *SessionManager) resubscribeWorker() {
	for {
		select {
		case <-m.quit:
			return
		case <-m.reconnCh:
			m.resubscribeAll()
		}
	}
}

// resubscribeAll re-arms every non-closed session on the current connection.
// Sessions whose subscription already belongs to this *nats.Conn are skipped:
// nats.go re-sends core subscriptions itself when the same connection
// reconnects, and a blind re-subscribe would deliver duplicates. A new
// connection (user Connect/switch) gets a fresh subscription per session;
// a session the server refuses is closed with the verbatim error (spec §6.4).
func (m *SessionManager) resubscribeAll() {
	nc := m.conn()
	if nc == nil {
		return // transient; the next connected event retries
	}
	m.mu.Lock()
	ss := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		ss = append(ss, s)
	}
	m.mu.Unlock()

	for _, s := range ss {
		s.resubscribe(nc)
	}
}

func (m *SessionManager) get(id string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrSessionNotFound, id)
	}
	return s, nil
}

// --- session ------------------------------------------------------------------

// session is one subscription session. See the package-level flow comment for
// the per-message path and the locking discipline:
//
//   - s.mu guards lifecycle state, the display counters, and the ring/pusher/
//     sub pointers. It is never held while emitting (neither session:msgs nor
//     session:state), so a slow frontend cannot stall control operations.
//   - seq and emitted are atomics; seq is bumped before s.mu so a receipt's
//     seq is assigned even while the mutex is contended (monotonic per
//     session, starting at 1).
//   - Lock ordering is strictly session.mu -> ring.mu / rate.mu; the throttle
//     releases its own mutex before taking session.mu to build a snapshot.
type session struct {
	id      string
	subject string
	mode    PushMode
	cap     int

	mu     sync.Mutex
	state  string             // running | paused | closed
	subErr string             // verbatim subscription error, if any
	frozen *SessionState      // display snapshot captured at Pause
	ring   *ring              // swapped on Clear
	pusher *pusher            // created once; Clear does not touch it
	sub    *nats.Subscription // nil when not subscribed
	subNC  *nats.Conn         // connection the subscription belongs to

	seq     atomic.Int64 // per-session message seq, monotonic from 1
	emitted atomic.Int64 // messages handed to the pusher (excludes paused receipts)
	total   int64        // receipts since last Clear, paused receipts included (spec: 继续计数)
	rate    *rateMeter

	throttle *stateThrottle
	log      *slog.Logger
}

func newSession(id, subject string, mode PushMode, buf int, log *slog.Logger, emit func(name string, data any)) *session {
	s := &session{
		id:      id,
		subject: subject,
		mode:    mode,
		cap:     buf,
		state:   SessionRunning,
		ring:    newRing(buf),
		rate:    newRateMeter(time.Second),
		log:     log,
	}
	s.pusher = newPusher(mode, func(batch []MsgOut) {
		emit(EventSessionMsgs, batch) // payload: []MsgOut — the §7.1.3 wire shape
	})
	s.throttle = newStateThrottle(stateThrottleInterval, s.snapshot, emit)
	return s
}

// handle is the NATS subscription callback; nats.go runs it on one dispatcher
// goroutine per subscription, so emissions keep Seq order.
func (s *session) handle(m *nats.Msg) {
	seq := s.seq.Add(1)
	out := buildMsgOut(s.id, seq, s.subject, m)
	s.rate.Inc()

	s.mu.Lock()
	if s.state == SessionClosed {
		s.mu.Unlock()
		return
	}
	s.total++
	s.ring.Add(out) // always: the ring scrolls to latest even while paused
	paused := s.state == SessionPaused
	s.mu.Unlock()

	if !paused {
		s.emitted.Add(1)
		s.pusher.Add(out) // emits (realtime: synchronously) WITHOUT s.mu held
	}
}

// buildMsgOut assembles the wire message. Headers are deep-copied (nats.Header
// reuses storage), the payload is base64-encoded, and the timestamp is UTC
// RFC3339Nano. Payload content must never be logged (spec §13.3).
func buildMsgOut(id string, seq int64, subject string, m *nats.Msg) MsgOut {
	out := MsgOut{
		SessionID:   id,
		Seq:         seq,
		Subject:     subject,
		PayloadB64:  base64.StdEncoding.EncodeToString(m.Data),
		PayloadSize: len(m.Data),
		Timestamp:   time.Now().UTC().Format(time.RFC3339Nano),
		IsUTF8:      isUTF8(m.Data),
	}
	if len(m.Header) > 0 {
		hdrs := make(map[string][]string, len(m.Header))
		for k, vs := range m.Header {
			hdrs[k] = append([]string(nil), vs...)
		}
		out.Headers = hdrs
	}
	return out
}

// subscribe creates the core subscription on nc. An error closes the session
// with the verbatim error text (spec §6.4: 服务器拒绝 → state=closed + 原文).
func (s *session) subscribe(nc *nats.Conn) error {
	s.mu.Lock()
	if s.state == SessionClosed {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	if nc == nil {
		s.fail(ErrNotConnected.Error())
		return ErrNotConnected
	}
	sub, err := nc.Subscribe(s.subject, s.handle)
	if err != nil {
		s.fail(err.Error())
		return err
	}
	s.mu.Lock()
	if s.state == SessionClosed {
		// A Close raced the network call: drop the fresh subscription so a
		// closed session never keeps one registered.
		s.mu.Unlock()
		_ = sub.Unsubscribe()
		return nil
	}
	s.sub, s.subNC = sub, nc
	s.mu.Unlock()
	return nil
}

// resubscribe re-arms the session on nc unless its subscription already
// belongs to that connection (nats.go auto-resubscribes a same-conn
// reconnect; subscribing again would duplicate deliveries).
func (s *session) resubscribe(nc *nats.Conn) {
	s.mu.Lock()
	if s.state == SessionClosed || s.sub != nil && s.subNC == nc {
		s.mu.Unlock()
		return
	}
	old := s.sub
	s.sub, s.subNC = nil, nil
	s.mu.Unlock()

	if old != nil {
		_ = old.Unsubscribe() // best-effort; the old conn may already be closed
	}
	_ = s.subscribe(nc)
	if st := s.snapshot(); st.State == SessionClosed {
		s.throttle.fireNow() // terminal: server refused the resubscription
	} else {
		s.throttle.notify()
	}
}

// fail marks the session closed with the verbatim error text.
func (s *session) fail(errText string) {
	s.mu.Lock()
	s.state = SessionClosed
	s.subErr = errText
	s.sub, s.subNC = nil, nil
	s.mu.Unlock()
	s.log.Error("session subscription failed", "id", s.id, "subject", s.subject, "err", errText)
	s.throttle.fireNow()
}

// pause freezes the display. An already-paused session is a no-op (nil); a
// closed session is an error.
func (s *session) pause() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch s.state {
	case SessionClosed:
		return ErrSessionClosed
	case SessionPaused:
		return nil
	}
	s.state = SessionPaused
	frozen := s.computeSnapshotLocked() // State: paused
	frozen.RateMsgS = 0                 // AC-006: 速率归 0 while paused
	s.frozen = &frozen
	return nil
}

// resume unfreezes the session; new messages continue from newest (no replay:
// the ring is not re-pushed). An already-running session is a no-op (nil); a
// closed session is an error.
func (s *session) resume() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch s.state {
	case SessionClosed:
		return ErrSessionClosed
	case SessionRunning:
		return nil
	}
	s.state = SessionRunning
	s.frozen = nil
	return nil
}

// clear swaps in a fresh ring and resets the counters; the pusher keeps
// running (spec: 清列表+计数重置显示，订阅不动). A closed session is an error.
func (s *session) clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state == SessionClosed {
		return ErrSessionClosed
	}
	s.ring = newRing(s.cap)
	s.total = 0
	s.emitted.Store(0)
	if s.frozen != nil { // paused: keep the display frozen at the reset values
		frozen := s.computeSnapshotLocked()
		frozen.RateMsgS = 0
		s.frozen = &frozen
	}
	return nil
}

// close unsubscribes, flushes any pending batch tail, and stops the pusher
// and the throttle timer. Idempotent.
func (s *session) close() {
	s.mu.Lock()
	alreadyClosed := s.state == SessionClosed
	sub := s.sub
	s.sub, s.subNC = nil, nil
	s.state = SessionClosed
	s.mu.Unlock()
	if alreadyClosed {
		return
	}

	if sub != nil {
		_ = sub.Unsubscribe() // best-effort: a dead conn reports an error we ignore
	}
	s.pusher.Flush() // deliver the partial batch before Stop discards it
	s.pusher.Stop()  // terminates the batch timer goroutine; no emit afterwards
	s.throttle.fireNow()
}

// snapshot returns the current display state. While paused it returns the
// snapshot captured at Pause (frozen counters, rate 0); List() shares this
// source with the EventSessionState payloads.
func (s *session) snapshot() SessionState {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.frozen != nil {
		return *s.frozen
	}
	return s.computeSnapshotLocked()
}

// computeSnapshotLocked derives the live display state. Callers hold s.mu.
// Buffer accounting is exact: every receipt ring.Adds exactly once and Clear
// swaps ring+counters together, so with N receipts since the last reset the
// ring holds min(N, cap) messages and has evicted max(0, N-cap).
func (s *session) computeSnapshotLocked() SessionState {
	st := SessionState{
		ID:       s.id,
		Subject:  s.subject,
		State:    s.state,
		PushMode: s.mode,
		RateMsgS: s.rate.Rate(),
		Total:    s.total,
		Error:    s.subErr,
	}
	if s.total > int64(s.cap) {
		st.Dropped = s.total - int64(s.cap)
		st.BufferUsed = s.cap
	} else {
		st.BufferUsed = int(s.total)
	}
	return st
}

// --- state throttle -------------------------------------------------------------

// stateThrottle coalesces session:state emissions to at most one per interval:
// a leading emission fires immediately, further notifications within the
// interval schedule exactly one trailing emission, so the final state always
// lands (e.g. closed). fire releases the throttle mutex before snapshotting,
// so snapshot may take the session mutex without lock inversion.
type stateThrottle struct {
	interval time.Duration
	snapshot func() SessionState
	emit     func(name string, data any)

	mu    sync.Mutex
	last  time.Time
	timer *time.Timer
}

func newStateThrottle(interval time.Duration, snapshot func() SessionState, emit func(name string, data any)) *stateThrottle {
	return &stateThrottle{interval: interval, snapshot: snapshot, emit: emit}
}

// notify requests a state emission (leading + trailing edge, <=1 per interval).
func (t *stateThrottle) notify() {
	t.mu.Lock()
	if t.timer != nil {
		t.mu.Unlock()
		return // a trailing emission is already scheduled
	}
	delay := t.interval - time.Since(t.last)
	if delay <= 0 {
		t.mu.Unlock()
		t.fire()
		return
	}
	t.timer = time.AfterFunc(delay, func() {
		t.mu.Lock()
		t.timer = nil
		t.last = time.Now()
		t.mu.Unlock()
		t.fire()
	})
	t.mu.Unlock()
}

// fireNow cancels any pending trailing emission and emits the current state
// immediately (used for terminal transitions such as closed).
func (t *stateThrottle) fireNow() {
	t.mu.Lock()
	if t.timer != nil {
		t.timer.Stop()
		t.timer = nil
	}
	t.last = time.Now()
	t.mu.Unlock()
	t.fire()
}

func (t *stateThrottle) fire() {
	st := t.snapshot() // takes the session mutex; t.mu must NOT be held here
	t.emit(EventSessionState, st)
}
