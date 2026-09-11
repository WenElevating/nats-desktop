// Service-level tests for the Wails-bound MessagingService facade (M2 Task 7).
// Coverage follows the task contract: settings-default resolution (temp
// settings files, hermetic), disconnected gating (hermetic), and the full
// chain against the real local nats-server (M2 mandate: tests involving a
// live connection hit nats://127.0.0.1:4333 and skip cleanly when it is
// down). The connected fixture mirrors the main.go Task 7 wiring exactly:
// the manager's emit closure forwards conn:state events into
// svc.Sessions.NotifyConnState.

package messaging

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/jsm.go/natscontext"
	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
)

// writeSettingsFile writes a settings file whose behavior object is the given
// JSON, returning its path (settings-default tests are hermetic: temp file,
// no appdir).
func writeSettingsFile(t *testing.T, behaviorJSON string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(fmt.Sprintf(`{"behavior":%s}`, behaviorJSON)), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// newDisconnectedService builds a MessagingService over a Manager that has
// never connected (hermetic gating path).
func newDisconnectedService(t *testing.T, settingsPath string) (*MessagingService, *emitRecorder) {
	t.Helper()
	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	rec := newEmitRecorder()
	mgr := connections.NewManager(reg, slog.New(slog.NewTextHandler(io.Discard, nil)), rec.emit)
	return NewMessagingService(mgr, slog.New(slog.NewTextHandler(io.Discard, nil)), rec.emit, settingsPath), rec
}

// newConnectedServiceStack builds a connected MessagingService the way main.go
// wires it (Task 7): the Manager's emit closure forwards conn:state events
// into the service's SessionManager side-band, and session events land in the
// recorder. A settings file is written at behaviorJSON ("" -> no file, Load
// falls back to defaults). Skips via requireLocalServer.
func newConnectedServiceStack(t *testing.T, behaviorJSON string) (*connections.Manager, *MessagingService, *emitRecorder) {
	t.Helper()
	requireLocalServer(t)

	var settingsPath string
	if behaviorJSON == "" {
		settingsPath = filepath.Join(t.TempDir(), "missing-settings.json")
	} else {
		settingsPath = writeSettingsFile(t, behaviorJSON)
	}

	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	rec := newEmitRecorder()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	var svc *MessagingService
	mgr := connections.NewManager(reg, log, func(name string, data any) {
		rec.emit(name, data)
		// main.go Task 7 wiring: conn:state side-band into the SessionManager.
		if name == connections.EventConnState && svc != nil {
			if ev, ok := data.(connections.StateEvent); ok {
				svc.Sessions.NotifyConnState(ev)
			}
		}
	})
	svc = NewMessagingService(mgr, log, rec.emit, settingsPath)

	store := connections.NewStore(reg)
	if err := store.Save(context.Background(), connections.ContextForm{Name: "svc", URL: localServerURL}); err != nil {
		t.Fatal(err)
	}
	if err := mgr.Connect(context.Background(), "svc"); err != nil {
		t.Fatal(err)
	}
	waitManagerConnected(t, mgr, 10*time.Second)
	// LIFO: CloseAll runs first, then Disconnect, then the context delete.
	t.Cleanup(func() {
		if err := store.Delete(context.Background(), "svc"); err != nil {
			t.Errorf("delete context: %v", err)
		}
	})
	t.Cleanup(mgr.Disconnect)
	t.Cleanup(svc.Sessions.CloseAll)
	return mgr, svc, rec
}

// --- disconnected gating (hermetic) ---------------------------------------------

func TestServiceDisconnectedGating(t *testing.T) {
	svc, _ := newDisconnectedService(t, filepath.Join(t.TempDir(), "missing.json"))

	if svc.Sessions == nil {
		t.Fatal("Sessions manager must be constructed eagerly")
	}

	res := svc.Publish(PubForm{Subject: "m2t7.gate"})
	if res.OK || res.Error != ErrNotConnected.Error() {
		t.Fatalf("Publish while disconnected = %+v, want error %q", res, ErrNotConnected.Error())
	}

	jsRes := svc.Publish(PubForm{Subject: "m2t7.gate", JetStream: true})
	if jsRes.OK || jsRes.Error != ErrNotConnected.Error() {
		t.Fatalf("JetStream Publish while disconnected = %+v, want error %q", jsRes, ErrNotConnected.Error())
	}

	reqRes := svc.Request(ReqForm{Subject: "m2t7.gate"})
	if reqRes.OK || reqRes.Error != ErrNotConnected.Error() {
		t.Fatalf("Request while disconnected = %+v, want error %q", reqRes, ErrNotConnected.Error())
	}

	if _, err := svc.Trace(TraceForm{Subject: "m2t7.gate"}); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("Trace while disconnected err = %v, want %v", err, ErrNotConnected)
	}

	st, err := svc.CreateSession(SessionSpec{Subject: "m2t7.gate"})
	if !errors.Is(err, ErrNotConnected) {
		t.Fatalf("CreateSession while disconnected err = %v, want %v", err, ErrNotConnected)
	}
	if st.ID != "" || st.State != "" {
		t.Fatalf("CreateSession while disconnected returned state %+v, want zero", st)
	}

	if list := svc.ListSessions(); list == nil || len(list) != 0 {
		t.Fatalf("ListSessions = %+v, want empty non-nil", list)
	}

	for _, op := range []struct {
		name string
		fn   func() error
	}{
		{"PauseSession", func() error { return svc.PauseSession("sub-1") }},
		{"ResumeSession", func() error { return svc.ResumeSession("sub-1") }},
		{"ClearSession", func() error { return svc.ClearSession("sub-1") }},
		{"CloseSession", func() error { return svc.CloseSession("sub-1") }},
	} {
		if err := op.fn(); !errors.Is(err, ErrSessionNotFound) {
			t.Fatalf("%s on empty manager err = %v, want %v", op.name, err, ErrSessionNotFound)
		}
	}

	// NotifyConnState through the wiring handle with no live conn must be a
	// safe no-op (main.go forwards every conn:state unconditionally).
	svc.Sessions.NotifyConnState(connections.StateEvent{Context: "svc", State: connections.StateConnected})
}

// --- settings-default resolution (hermetic file, connected session) -------------

// TestServiceSessionDefaultsLocalServer creates sessions with blank spec
// fields and verifies the settings file decides buffer/push: a file with
// batch/7777 yields a 7777-cap batch session, a defaults file (and a missing
// file) yields the spec defaults 10000/realtime. Explicit spec values win.
func TestServiceSessionDefaultsLocalServer(t *testing.T) {
	_, svc, _ := newConnectedServiceStack(t, `{"request_timeout_seconds":5,"session_push_batching":true,"session_buffer_size":7777}`)
	subject := "m2t7.defaults." + uniqueSuffix()

	// Blank spec: settings decide -> 7777 + batch.
	st, err := svc.CreateSession(SessionSpec{Subject: subject})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if st.PushMode != PushBatch {
		t.Fatalf("PushMode = %q, want %q from session_push_batching", st.PushMode, PushBatch)
	}
	if s := getSession(t, svc.Sessions, st.ID); s.cap != 7777 {
		t.Fatalf("buffer cap = %d, want 7777 from session_buffer_size", s.cap)
	}

	// Explicit spec values win over settings.
	st2, err := svc.CreateSession(SessionSpec{Subject: subject + ".x", PushMode: PushRealtime, BufferSize: 55})
	if err != nil {
		t.Fatalf("CreateSession explicit: %v", err)
	}
	if st2.PushMode != PushRealtime {
		t.Fatalf("explicit PushMode = %q, want realtime", st2.PushMode)
	}
	if s := getSession(t, svc.Sessions, st2.ID); s.cap != 55 {
		t.Fatalf("explicit cap = %d, want 55", s.cap)
	}
	_ = svc.CloseSession(st.ID)
	_ = svc.CloseSession(st2.ID)
}

// TestServiceSessionSpecDefaultsNoSettingsLocalServer covers the spec-default
// branch: a settings file with no behavior fields (and a missing file) resolve
// BufferSize 0 -> 10000 and PushMode "" -> realtime.
func TestServiceSessionSpecDefaultsNoSettingsLocalServer(t *testing.T) {
	for _, tc := range []struct {
		name         string
		behaviorJSON string // "" -> no settings file at all
	}{
		{"empty behavior", "{}"},
		{"missing file", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, svc, _ := newConnectedServiceStack(t, tc.behaviorJSON)
			st, err := svc.CreateSession(SessionSpec{Subject: "m2t7.defspec." + uniqueSuffix()})
			if err != nil {
				t.Fatalf("CreateSession: %v", err)
			}
			t.Cleanup(func() { _ = svc.CloseSession(st.ID) })
			if st.PushMode != PushRealtime {
				t.Fatalf("PushMode = %q, want realtime default", st.PushMode)
			}
			if s := getSession(t, svc.Sessions, st.ID); s.cap != 10000 {
				t.Fatalf("buffer cap = %d, want spec default 10000", s.cap)
			}
		})
	}
}

// --- timeout resolution (settings file; silent responder needs a live server) ---

func TestServiceRequestTimeoutFromSettingsLocalServer(t *testing.T) {
	_, svc, _ := newConnectedServiceStack(t, `{"request_timeout_seconds":1,"session_push_batching":false,"session_buffer_size":0}`)
	subject := "m2t7.silent." + uniqueSuffix()

	silent := connect(t, localServerURL)
	sub, err := silent.SubscribeSync(subject)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sub.Unsubscribe() })
	if err := silent.Flush(); err != nil {
		t.Fatal(err)
	}

	// TimeoutMs 0 -> settings request_timeout_seconds x 1000 = 1000ms.
	start := time.Now()
	res := svc.Request(ReqForm{Subject: subject, Payload: []byte("x")})
	elapsed := time.Since(start)
	if res.OK || res.NoResponder {
		t.Fatalf("request with silent responder must fail: %+v", res)
	}
	if !strings.Contains(strings.ToLower(res.Error), "timeout") {
		t.Fatalf("Error = %q, want it to contain %q", res.Error, "timeout")
	}
	if elapsed < 900*time.Millisecond {
		t.Fatalf("elapsed %v < 900ms: settings timeout not applied (want ~1s)", elapsed)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("elapsed %v > 3s: settings timeout must be 1s, not the 5s default", elapsed)
	}

	// Explicit TimeoutMs wins over the settings value (100ms, not 1s).
	start = time.Now()
	res = svc.Request(ReqForm{Subject: subject, Payload: []byte("x"), TimeoutMs: 100})
	elapsed = time.Since(start)
	if elapsed >= 900*time.Millisecond {
		t.Fatalf("elapsed %v: explicit TimeoutMs must override the settings value", elapsed)
	}
	if res.OK {
		t.Fatal("silent responder request must not succeed")
	}
}

// --- full chain on the real local server ---------------------------------------

func TestServiceFullChainLocalServer(t *testing.T) {
	mgr, svc, rec := newConnectedServiceStack(t, "") // no settings file: spec defaults
	subject := "m2t7.chain." + uniqueSuffix()

	// CreateSession -> running, service-managed id space.
	st, err := svc.CreateSession(SessionSpec{Subject: subject})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if st.State != SessionRunning || !strings.HasPrefix(st.ID, "sub-") {
		t.Fatalf("new session = %+v, want running sub-*", st)
	}

	// Publish (core) lands in the session and reaches the frontend emit.
	res := svc.Publish(PubForm{Subject: subject, Payload: []byte("hello chain")})
	if !res.OK {
		t.Fatalf("Publish: %+v", res)
	}
	st = waitSessionTotal(t, svc.Sessions, st.ID, 1, 5*time.Second)
	if st.BufferUsed != 1 {
		t.Fatalf("BufferUsed = %d, want 1", st.BufferUsed)
	}
	if n := rec.msgCount(st.ID); n < 1 {
		t.Fatalf("session:msgs emitted %d times, want >= 1", n)
	}

	// Publish (JetStream) returns the PubAck.
	nc := connect(t, localServerURL)
	createJSStream(t, nc, "M2T7", "m2t7.js.>")
	jsRes := svc.Publish(PubForm{Subject: "m2t7.js.one", Payload: []byte("acked"), JetStream: true})
	if !jsRes.OK || jsRes.Stream != "M2T7" || jsRes.Sequence < 1 {
		t.Fatalf("JetStream Publish = %+v, want ack on M2T7", jsRes)
	}

	// Request round-trips a reply.
	echoSubject := "m2t7.echo." + uniqueSuffix()
	rsub, err := nc.Subscribe(echoSubject, func(m *nats.Msg) {
		_ = nc.Publish(m.Reply, []byte("pong"))
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rsub.Unsubscribe() })
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}
	reqRes := svc.Request(ReqForm{Subject: echoSubject, Payload: []byte("ping")})
	if !reqRes.OK || string(reqRes.Payload) != "pong" {
		t.Fatalf("Request = %+v, want payload pong", reqRes)
	}

	// Trace over the server tracing API (4333 is 2.11+).
	hop, err := svc.Trace(TraceForm{Subject: subject})
	if err != nil {
		t.Fatalf("Trace: %v", err)
	}
	if hop.Kind != "ingress" {
		t.Fatalf("Trace root kind = %q, want ingress", hop.Kind)
	}

	// Pause/Resume/Clear through the service.
	if err := svc.PauseSession(st.ID); err != nil {
		t.Fatalf("PauseSession: %v", err)
	}
	if s := findState2(t, svc.Sessions, st.ID); s.State != SessionPaused {
		t.Fatalf("state after pause = %q, want paused", s.State)
	}
	if err := svc.ResumeSession(st.ID); err != nil {
		t.Fatalf("ResumeSession: %v", err)
	}
	if err := svc.ClearSession(st.ID); err != nil {
		t.Fatalf("ClearSession: %v", err)
	}
	if s := findState2(t, svc.Sessions, st.ID); s.Total != 0 || s.BufferUsed != 0 {
		t.Fatalf("state after clear = %+v, want zeroed counters", s)
	}

	// ListSessions is non-nil and carries the session.
	if list := svc.ListSessions(); list == nil || len(list) != 1 || list[0].ID != st.ID {
		t.Fatalf("ListSessions = %+v, want exactly session %s", list, st.ID)
	}

	// Close marks the session closed; repeat close is idempotent.
	if err := svc.CloseSession(st.ID); err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
	if s := findState2(t, svc.Sessions, st.ID); s.State != SessionClosed {
		t.Fatalf("state after close = %q, want closed", s.State)
	}
	if err := svc.CloseSession(st.ID); err != nil {
		t.Fatalf("second CloseSession (idempotent): %v", err)
	}

	_ = mgr // connected stack teardown via t.Cleanup
}
