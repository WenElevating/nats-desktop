// Wails-bound messaging facade (M2 Task 7). MessagingService is the exact
// method set the frontend bindings consume (publish/request/trace from spec
// §6.5, subscription sessions from spec §6.4); it contains no logic of its
// own beyond default resolution and gating:
//
//   - Timeouts: a blank (<=0) TimeoutMs resolves from the settings
//     request_timeout_seconds (Publish/Request/Trace alike), read per call so
//     a settings change applies without an app restart. When the settings
//     value is absent the messaging layer's own 5000ms default applies.
//   - Sessions: a blank BufferSize resolves from settings session_buffer_size
//     and a blank PushMode from settings session_push_batching — both read
//     per call in CreateSession, so they affect sessions created afterwards,
//     never existing ones. The SessionManager defaults (built once at
//     startup) remain only as the last-resort fallback for a failed settings
//     read.
//   - Gating: publish/request/trace use the live connections.Manager
//     connection and degrade to the ErrNotConnected result/error when
//     disconnected. CreateSession is fail-closed while disconnected (M1
//     Task 4 finding: a session created without a connection cannot
//     subscribe and would be born closed), returning an ErrNotConnected
//     error so the frontend can refuse clearly.
//
// Payload content is never logged (spec §13.3) — the service logs nothing.

package messaging

import (
	"context"
	"fmt"
	"io"
	"log/slog"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
	"github.com/WenElevating/nats-desktop/desktop/internal/settings"
)

// MessagingService fronts the messaging package for the Wails service
// registry. Construct with NewMessagingService; all methods are safe for
// concurrent use (the underlying Publish/Request/Trace functions and the
// SessionManager are).
type MessagingService struct {
	mgr          *connections.Manager
	log          *slog.Logger
	emit         func(name string, data any)
	settingsPath string

	// Sessions is the subscription-session manager the service fronts. It
	// is exported so main.go can forward connections.Manager conn:state
	// events into its reconnect side-band (emit closure ->
	// Sessions.NotifyConnState); Wails binds methods only, so the field
	// never appears in the generated frontend bindings.
	Sessions *SessionManager
}

// NewMessagingService builds the bound facade over mgr. A nil log discards
// output, a nil emit turns events into no-ops, and an unreadable settings
// file leaves the spec defaults in place. The SessionManager is constructed
// eagerly (Sessions is never nil); its buffer/push defaults are read from
// settings once and serve purely as fallback (see the package comment).
func NewMessagingService(mgr *connections.Manager, log *slog.Logger, emit func(string, any), settingsPath string) *MessagingService {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if emit == nil {
		emit = func(string, any) {}
	}
	s := &MessagingService{mgr: mgr, log: log, emit: emit, settingsPath: settingsPath}

	defBuf, defPush := 0, PushRealtime
	if st, err := settings.Load(settingsPath); err == nil {
		if st.Behavior.SessionBufferSize > 0 {
			defBuf = st.Behavior.SessionBufferSize
		}
		if st.Behavior.SessionPushBatching {
			defPush = PushBatch
		}
	}
	s.Sessions = NewSessionManager(mgr, log, emit, defBuf, defPush)
	return s
}

// Publish sends one message (core NATS or, with JetStream, an acked publish).
// A blank TimeoutMs resolves from the settings request_timeout_seconds. A
// disconnected manager yields the failed ErrNotConnected result, not an
// error.
func (s *MessagingService) Publish(form PubForm) PubResult {
	form.TimeoutMs = s.resolveTimeoutMs(form.TimeoutMs)
	return Publish(s.conn(), form)
}

// Request sends one request and waits for a single reply, with the same
// blank-timeout and disconnect semantics as Publish.
func (s *MessagingService) Request(form ReqForm) ReqResult {
	form.TimeoutMs = s.resolveTimeoutMs(form.TimeoutMs)
	return Request(s.conn(), form)
}

// Trace sends one probe through the server message-tracing API (NATS Server
// 2.11+) and returns the unfolded hop tree. It shares the Publish/Request
// timeout and disconnect semantics; ErrTraceOldServer reports a too-old
// server.
func (s *MessagingService) Trace(form TraceForm) (TraceHop, error) {
	form.TimeoutMs = s.resolveTimeoutMs(form.TimeoutMs)
	return Trace(s.conn(), form)
}

// CreateSession subscribes spec.Subject and starts the session. Blank fields
// resolve per call from settings: BufferSize <= 0 from session_buffer_size,
// a non-realtime/batch PushMode from session_push_batching (batch when true,
// realtime otherwise). Refused with an ErrNotConnected error while the
// manager is disconnected (fail-closed: see the package comment).
func (s *MessagingService) CreateSession(spec SessionSpec) (SessionState, error) {
	if s.conn() == nil {
		return SessionState{}, fmt.Errorf("%w: create session requires a connected context", ErrNotConnected)
	}

	if spec.BufferSize <= 0 || (spec.PushMode != PushRealtime && spec.PushMode != PushBatch) {
		if st, err := settings.Load(s.settingsPath); err == nil {
			if spec.BufferSize <= 0 && st.Behavior.SessionBufferSize > 0 {
				spec.BufferSize = st.Behavior.SessionBufferSize
			}
			if spec.PushMode != PushRealtime && spec.PushMode != PushBatch {
				if st.Behavior.SessionPushBatching {
					spec.PushMode = PushBatch
				} else {
					spec.PushMode = PushRealtime
				}
			}
		}
	}

	return s.Sessions.CreateSession(context.Background(), spec)
}

// PauseSession freezes the session display; the subscription keeps receiving.
// Idempotent; fails on unknown or closed sessions.
func (s *MessagingService) PauseSession(id string) error { return s.Sessions.Pause(id) }

// ResumeSession unfreezes the session; paused-period messages are never
// replayed. Idempotent; fails on unknown or closed sessions.
func (s *MessagingService) ResumeSession(id string) error { return s.Sessions.Resume(id) }

// ClearSession resets the ring buffer and display counters; the subscription
// keeps receiving. Fails on unknown or closed sessions.
func (s *MessagingService) ClearSession(id string) error { return s.Sessions.Clear(id) }

// CloseSession unsubscribes and marks the session closed. Idempotent.
func (s *MessagingService) CloseSession(id string) error { return s.Sessions.Close(id) }

// ListSessions returns a snapshot of every session (including closed ones),
// sorted by ID. Never nil so the frontend can map over it.
func (s *MessagingService) ListSessions() []SessionState { return s.Sessions.List() }

// conn returns the live connection, or nil while disconnected (mirrors
// SessionManager.conn).
func (s *MessagingService) conn() *nats.Conn {
	if s.mgr == nil {
		return nil
	}
	return s.mgr.Conn()
}

// resolveTimeoutMs applies the settings request_timeout_seconds default to a
// blank (<=0) timeout; an explicit value always wins. A failed settings read
// or an unset/invalid value keeps the blank form, which the messaging layer
// clamps to its 5000ms default.
func (s *MessagingService) resolveTimeoutMs(explicit int) int {
	if explicit > 0 {
		return explicit
	}
	st, err := settings.Load(s.settingsPath)
	if err != nil {
		return explicit
	}
	if sec := st.Behavior.RequestTimeoutSeconds; sec > 0 {
		return sec * 1000
	}
	return explicit
}
