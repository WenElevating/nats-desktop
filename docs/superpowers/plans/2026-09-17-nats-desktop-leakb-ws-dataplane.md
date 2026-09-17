# Leak B Residual Fix — Session Data-Plane WebSocket Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move subscription-session message batches (`session:msgs`, spec §7.1.3 wire shape) off the wails event pipeline onto an app-owned loopback WebSocket, eliminating the WebView2 browser-process memory ratchet (~231MB/h under 1k msg/s, m6-perf §12.3 leg D1) that blocks release.

**Architecture:** A `MsgHub` (Go, `coder/websocket` — already in the dependency tree) serves one loopback endpoint with a per-boot token. The pusher's data emit fans out to connected WS clients; control events (`session:state`, errors) stay on wails events. The frontend connects once at mount and feeds the same handler the wails `Events.On("session:msgs")` path used. Overflow policy is drop-client (bounded buffers everywhere — the leak-A lesson), never buffer-without-bound.

**Tech Stack:** Go 1.26 + `github.com/coder/websocket v1.8.14`; wails v3.0.0-beta.20 bindings regen; React 18 + vitest 5 (jsdom).

**Scope decision:** Nav/page-mount churn (m6-perf §12.2 leg E2, result pending at plan time) is OUT OF SCOPE here. If E2 shows an independent nav-driven ratchet, that becomes a separate frontend unmount-hygiene plan. This plan is single-subsystem (session data transport).

## Global Constraints

- 测试必须全面：每个任务单元测试先行（TDD），收尾做同载性能验证跑并保留证据（用户绑定指令）。
- §13.3 安全：日志不得记录任何凭证内容——数据面 token 是每次启动的凭据，**禁止写日志**（`MsgHub.Start` 只记录不含 token 的 URL）；消息 payload 内容永不落日志（subject/size/seq 仅限）。
- §6.4 线缆语义不变：`session:msgs` 载荷仍是 `[]MsgOut`（§7.1.3）；推送模式 100ms/500 聚合不变；单连接单写协程保序（每客户端一个 writer goroutine，单一 BroadcastData 发布点）。
- 背压契约（泄漏 A 教训，结构性）：每客户端有界发送缓冲 64 批；溢出即断开该客户端（前端重连，§6.4 恢复不回补语义兜底），任何路径不得出现无界队列。
- 降级契约：hub 未启动/不可用时，数据面自动回退到 wails 事件（现有行为），控制面（session:state）永不受影响。
- CI 契约：go 测试带 `-race -cover`；vitest 本地需 `--maxWorkers=2`（默认 OOM）；`frontend/bindings/` 提交且必须用 `wails3 generate bindings -ts -clean=true` 再生成（CONTRIBUTING.md:21）。
- i18n：本计划无新增用户可见文案，无需新增 locale 键。
- lucide 图标：本计划无 UI 变更，不涉及。

**Evidence baseline (why):** m6-perf §12/§12.1/§12.3 — leg D1 (delivery-only, no nav) browser process +231.3MB/h; idle leg D0 flat (0.1MB/h); 24h gold re-soak +~108MB/h (m6-soak §11). Success criterion for this plan: leg-D1-style 1h validation run on the new build shows browser-process slope ≈ 0 (within noise, ≤10MB/h).

---

## File Structure

- Create: `desktop/internal/messaging/wshub.go` — loopback WS hub: auth, fanout, bounded per-client buffers, lifecycle. One responsibility: data-plane transport.
- Create: `desktop/internal/messaging/wshub_test.go` — hub unit tests (auth/fanout/overflow/close/loopback).
- Modify: `desktop/internal/messaging/service.go:62,80` — constructor gains `hub *MsgHub`; builds `dataEmit` closure; `NewSessionManager` call gains the extra param; adds `DataChannel()` binding method + `DataChannelInfo` type.
- Modify: `desktop/internal/messaging/sessions.go:477-479` — pusher emit closure uses `dataEmit` instead of `emit`; `SessionManager`/factory thread the new param (nil `dataEmit` falls back to `emit`, so `newSession` test call sites stay simple).
- Modify: `desktop/internal/messaging/service_test.go:79` (`newConnectedServiceStack` passes `nil` hub) + new hub-routed tests.
- Modify: `desktop/internal/messaging/sessions_test.go:204,820,1447`, `desktop/internal/messaging/sessions_stress_test.go:66`, `desktop/internal/messaging/pipeline_bench_test.go:69` — `newSession`/`NewSessionManager` call sites gain the `dataEmit` arg (`nil`, or a recording sink where the test asserts emissions).
- Modify: `desktop/main.go:109` — construct + start hub, `defer hub.Close()`, pass into constructor.
- Create: `desktop/frontend/src/lib/msgChannel.ts` — WS connect/reconnect/close wrapper (data plane).
- Create: `desktop/frontend/tests/msg-channel.test.ts` — channel unit tests (fake WebSocket).
- Modify: `desktop/frontend/src/features/messages/useSessions.ts:150` — replace `Events.On("session:msgs")` with `connectMsgChannel`.
- Modify: `desktop/frontend/tests/messages-sessions.test.tsx`, `messages-sessions-filter.test.tsx`, `messages-sessions-coalesce.test.tsx` (its `fireMsgs` helper + bindings mock), `messages-perf.test.ts` (bindings mock gains `DataChannel`) — switch from `runtime.handlers.get("session:msgs")` firing to msgChannel mock firing. `tests/bench/sessions.bench.ts` needs NO change (drives `applyMsgsBatch` directly).
- Modify: `desktop/frontend/src/lib/bindings.ts:33-43` — hand-maintained re-export surface gains `DataChannel` (regen does NOT touch this file).
- Regen: `desktop/frontend/bindings/` — after `DataChannel()` is added.

---

### Task 1: MsgHub core (Go)

**Files:**
- Create: `desktop/internal/messaging/wshub.go`
- Create: `desktop/internal/messaging/wshub_test.go`

**Interfaces:**
- Produces (Task 2/3 consume):
  - `func NewMsgHub(log *slog.Logger) *MsgHub`
  - `func (h *MsgHub) Start() (url string, err error)` — idempotent-ish: binds `127.0.0.1:0`, serves `/messaging/data`
  - `func (h *MsgHub) BroadcastData(v any)` — JSON-marshals and fans out; slow client (send buffer full) is disconnected
  - `func (h *MsgHub) DataChannel() (url string, token string)`
  - `func (h *MsgHub) Close() error` — idempotent

- [ ] **Step 1: Write the failing tests**

Create `desktop/internal/messaging/wshub_test.go`:

```go
package messaging

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func testLog(t *testing.T) *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func mustStart(t *testing.T, h *MsgHub) (string, string) {
	t.Helper()
	url, err := h.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	_, token := h.DataChannel()
	return url, token
}

// dialHub connects a raw WS client to a started hub; returns the conn and a
// single-frame reader with a 2s timeout.
func dialHub(t *testing.T, url, token string) (*websocket.Conn, func() ([]byte, error)) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url+"?token="+token, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	read := func() ([]byte, error) {
		rctx, rcancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer rcancel()
		_, b, err := conn.Read(rctx)
		return b, err
	}
	return conn, read
}

func TestMsgHubRejectsWrongToken(t *testing.T) {
	h := NewMsgHub(testLog(t))
	url, err := h.Start()
	if err != nil { t.Fatal(err) }
	defer h.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := websocket.Dial(ctx, url+"?token=wrong", nil); err == nil {
		t.Fatal("dial with wrong token must fail")
	}
}

func TestMsgHubLoopbackOnly(t *testing.T) {
	h := NewMsgHub(testLog(t))
	url, err := h.Start()
	if err != nil { t.Fatal(err) }
	defer h.Close()
	if want := "ws://127.0.0.1:"; len(url) < len(want) || url[:len(want)] != want {
		t.Fatalf("hub url %q must bind loopback", url)
	}
}

func TestMsgHubBroadcastFanout(t *testing.T) {
	h := NewMsgHub(testLog(t))
	url, token := mustStart(t, h)
	c1, read1 := dialHub(t, url, token)
	_ = c1
	c2, read2 := dialHub(t, url, token)
	_ = c2
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if h.clientCount() == 2 { break }
		time.Sleep(10 * time.Millisecond)
	}
	if h.clientCount() != 2 { t.Fatalf("clients = %d, want 2", h.clientCount()) }
	h.BroadcastData(map[string]any{"session_id": "sub-1", "seq": 1})
	for _, read := range [](func() ([]byte, error)){read1, read2} {
		b, err := read()
		if err != nil { t.Fatal(err) }
		var got map[string]any
		if err := json.Unmarshal(b, &got); err != nil { t.Fatal(err) }
		if got["session_id"] != "sub-1" { t.Fatalf("got %v", got) }
	}
}

func TestMsgHubOverflowDisconnectsSlowClient(t *testing.T) {
	h := NewMsgHub(testLog(t))
	url, token := mustStart(t, h)
	conn, _ := dialHub(t, url, token)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if h.clientCount() == 1 { break }
		time.Sleep(10 * time.Millisecond)
	}
	// Never read: 64 buffered batches overflow → hub must drop the client,
	// not block and not buffer without bound (leak-A contract).
	for i := 0; i < 200; i++ {
		h.BroadcastData(map[string]int{"i": i})
	}
	// Disconnect is asynchronous (`go h.remove(c)`); poll instead of asserting
	// synchronously.
	deadline = time.Now().Add(2 * time.Second)
	for h.clientCount() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if h.clientCount() != 0 {
		t.Fatalf("slow client must be disconnected, clients=%d", h.clientCount())
	}
	_ = conn
}

func TestMsgHubCloseIdempotent(t *testing.T) {
	h := NewMsgHub(testLog(t))
	if _, err := h.Start(); err != nil { t.Fatal(err) }
	if err := h.Close(); err != nil { t.Fatal(err) }
	if err := h.Close(); err != nil { t.Fatalf("second Close: %v", err) }
}
```

(imports: `context, encoding/json, io, log/slog, testing, time, github.com/coder/websocket`; add `clientCount()` as a test-only helper on MsgHub: `func (h *MsgHub) clientCount() int { h.mu.Lock(); defer h.mu.Unlock(); return len(h.clients) }` — used by tests in the same package.)

- [ ] **Step 2: Run tests to verify they fail (package does not compile: MsgHub undefined)**

Run: `cd desktop && go test ./internal/messaging/ -run TestMsgHub -v`
Expected: FAIL — `undefined: NewMsgHub`

- [ ] **Step 3: Write the implementation**

Create `desktop/internal/messaging/wshub.go`:

```go
package messaging

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// MsgHub is the data-plane bypass for subscription-session message batches
// (spec §7.1.3). Delivering batches through the wails event pipeline grows
// the WebView2 browser process ~231MB/h under 1k msg/s (m6-perf §12.3, leg
// D1); the hub serves the same []MsgOut envelope over a loopback WebSocket
// that the browser's own network stack pumps, removing the wails event path
// from the data plane. Control events (session:state, errors) stay on wails
// events.
//
// Backpressure contract (leak-A lesson — no unbounded queues): each client
// has a bounded send buffer; a client that falls behind is DISCONNECTED, and
// the frontend reconnects and resumes from live counters (§6.4: 恢复不回补).
const (
	msgHubPath       = "/messaging/data"
	msgHubSendBuffer = 64
	msgHubTokenLen   = 16
	msgHubWriteWait  = 5 * time.Second
)

type MsgHub struct {
	log     *slog.Logger
	token   string
	url     string
	srv     *http.Server
	mu      sync.Mutex
	clients map[*hubClient]struct{}
	closed  bool
}

type hubClient struct {
	conn *websocket.Conn
	send chan []byte
	done chan struct{}
	once sync.Once
}

func NewMsgHub(log *slog.Logger) *MsgHub {
	if log == nil {
		log = slog.Default()
	}
	b := make([]byte, msgHubTokenLen)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("msg hub: token entropy: %v", err)) // unrecoverable at boot
	}
	return &MsgHub{
		log:     log,
		token:   hex.EncodeToString(b),
		clients: make(map[*hubClient]struct{}),
	}
}

// Start binds a loopback listener and serves the data endpoint. The logged
// URL intentionally excludes the token (§13.3: no credentials in logs); the
// token reaches the frontend only via the DataChannel binding.
func (h *MsgHub) Start() (string, error) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return "", errors.New("msg hub: closed")
	}
	h.mu.Unlock()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("msg hub listen: %w", err)
	}
	h.url = "ws://" + ln.Addr().String() + msgHubPath
	mux := http.NewServeMux()
	mux.HandleFunc(msgHubPath, h.handleData)
	h.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := h.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			h.log.Error("msg hub serve", "err", err)
		}
	}()
	h.log.Info("msg hub listening", "addr", ln.Addr().String())
	return h.url, nil
}

func (h *MsgHub) handleData(w http.ResponseWriter, r *http.Request) {
	got := r.URL.Query().Get("token")
	if subtle.ConstantTimeCompare([]byte(got), []byte(h.token)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || (host != "127.0.0.1" && host != "::1") {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c := &hubClient{conn: conn, send: make(chan []byte, msgHubSendBuffer), done: make(chan struct{})}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		_ = conn.Close(websocket.StatusGoingAway, "hub closed")
		return
	}
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	go h.writeLoop(c)
	h.readLoop(c) // blocks until the client goes away
}

func (h *MsgHub) readLoop(c *hubClient) {
	defer h.remove(c)
	for {
		if _, _, err := c.conn.Read(context.Background()); err != nil {
			return
		}
		// Data plane is one-way; client frames are drained and ignored.
	}
}

func (h *MsgHub) writeLoop(c *hubClient) {
	for {
		select {
		case <-c.done:
			return
		case b := <-c.send:
			ctx, cancel := context.WithTimeout(context.Background(), msgHubWriteWait)
			err := c.conn.Write(ctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				h.remove(c)
				return
			}
		}
	}
}

func (h *MsgHub) remove(c *hubClient) {
	c.once.Do(func() {
		close(c.done)
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
		_ = c.conn.Close(websocket.StatusGoingAway, "removed")
	})
}

func (h *MsgHub) clientCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// BroadcastData fans one payload out to every connected client. A slow
// client is dropped, never buffered without bound.
func (h *MsgHub) BroadcastData(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		h.log.Error("msg hub marshal", "err", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	for c := range h.clients {
		select {
		case c.send <- b:
		default:
			go h.remove(c)
		}
	}
}

// DataChannel reports the loopback endpoint and per-boot token.
func (h *MsgHub) DataChannel() (url string, token string) { return h.url, h.token }

func (h *MsgHub) Close() error {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil
	}
	h.closed = true
	clients := make([]*hubClient, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.clients = make(map[*hubClient]struct{})
	h.mu.Unlock()
	for _, c := range clients {
		h.remove(c)
	}
	if h.srv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return h.srv.Shutdown(ctx)
}
```

Also move `go.mod` dependency to direct (it is already in the tree via wails):

Run: `cd desktop && go mod tidy`
Expected: `github.com/coder/websocket` moves from `// indirect` to a direct require; go.sum unchanged or appended.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && go test ./internal/messaging/ -run TestMsgHub -v -race`
Expected: all 5 PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/internal/messaging/wshub.go desktop/internal/messaging/wshub_test.go desktop/go.mod desktop/go.sum
git commit -m "feat(messaging): MsgHub loopback WS data plane (leak B bypass, part 1)"
```

---

### Task 2: Service data-plane routing

**Files:**
- Modify: `desktop/internal/messaging/service.go:62,80`
- Modify: `desktop/internal/messaging/sessions.go:477-479` (+ SessionManager struct/constructor)
- Modify: `desktop/internal/messaging/service_test.go` (helper `newConnectedServiceStack` + new tests)

**Interfaces:**
- Consumes: `NewMsgHub`, `(*MsgHub).BroadcastData(v any)` (Task 1)
- Produces (Task 3 consumes):
  - `func NewMessagingService(mgr *connections.Manager, log *slog.Logger, emit func(string, any), settingsPath string, hub *MsgHub) *MessagingService` (5th param added)
  - `type DataChannelInfo struct { URL string \`json:"url"\`; Token string \`json:"token"\` }`
  - `func (s *MessagingService) DataChannel() DataChannelInfo`
  - Behavior: hub non-nil → `session:msgs` batches go ONLY to the hub; hub nil → legacy `emit(EventSessionMsgs, batch)`. `session:state` always via `emit`.

- [ ] **Step 1: Write the failing tests**

Append to `desktop/internal/messaging/service_test.go`:

```go
// TestServiceDataPlaneRoutesViaHub: hub active → session:msgs batches arrive
// over the loopback WS and NEVER through the wails emit recorder. The stack
// construction mirrors newConnectedServiceStack (service_test.go:58) with the
// hub added. Add imports if absent: "encoding/json",
// "github.com/coder/websocket".
func TestServiceDataPlaneRoutesViaHub(t *testing.T) {
	requireLocalServer(t)
	settingsPath := filepath.Join(t.TempDir(), "missing-settings.json")
	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	rec := newEmitRecorder()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	hub := NewMsgHub(log)
	if _, err := hub.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = hub.Close() })
	url, token := hub.DataChannel()

	got := make(chan []MsgOut, 4)
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 10*time.Second)
	conn, _, err := websocket.Dial(dialCtx, url+"?token="+token, nil)
	dialCancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	// The hub registers the client after Accept returns server-side; wait so
	// the session's first batch cannot be broadcast to zero clients.
	regDeadline := time.Now().Add(2 * time.Second)
	for hub.clientCount() == 0 {
		if time.Now().After(regDeadline) {
			t.Fatal("hub client never registered")
		}
		time.Sleep(10 * time.Millisecond)
	}
	go func() {
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			_, b, err := conn.Read(ctx)
			cancel()
			if err != nil {
				return
			}
			var batch []MsgOut
			if json.Unmarshal(b, &batch) == nil {
				got <- batch
			}
		}
	}()

	var svc *MessagingService
	mgr := connections.NewManager(reg, log, func(name string, data any) {
		rec.emit(name, data)
		if name == connections.EventConnState && svc != nil {
			if ev, ok := data.(connections.StateEvent); ok {
				svc.Sessions.NotifyConnState(ev)
			}
		}
	})
	svc = NewMessagingService(mgr, log, rec.emit, settingsPath, hub)

	store := connections.NewStore(reg)
	if err := store.Save(context.Background(), connections.ContextForm{Name: "svc", URL: localServerURL}, 0); err != nil {
		t.Fatal(err)
	}
	if err := mgr.Connect(context.Background(), "svc"); err != nil {
		t.Fatal(err)
	}
	waitManagerConnected(t, mgr, 10*time.Second)
	t.Cleanup(func() { _ = store.Delete(context.Background(), "svc") })
	t.Cleanup(mgr.Disconnect)
	t.Cleanup(svc.Sessions.CloseAll)

	subject := "dp.route." + uniqueSuffix()
	st, err := svc.CreateSession(SessionSpec{Subject: subject})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if res := svc.Publish(PubForm{Subject: subject, Payload: []byte("hello dp")}); !res.OK {
		t.Fatalf("Publish: %+v", res)
	}
	select {
	case batch := <-got:
		if len(batch) == 0 || batch[0].Subject != subject {
			t.Fatalf("bad batch via hub: %+v", batch)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no batch via hub")
	}
	if n := rec.msgCount(st.ID); n != 0 {
		t.Fatalf("session:msgs leaked to wails emit: %d batches", n)
	}
}

// TestServiceDataPlaneFallsBackWithoutHub: nil hub (legacy path) →
// session:msgs still arrives via emit, exactly as before this plan.
func TestServiceDataPlaneFallsBackWithoutHub(t *testing.T) {
	_, svc, rec := newConnectedServiceStack(t, "")
	subject := "dp.fallback." + uniqueSuffix()
	st, err := svc.CreateSession(SessionSpec{Subject: subject})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if res := svc.Publish(PubForm{Subject: subject, Payload: []byte("x")}); !res.OK {
		t.Fatalf("Publish: %+v", res)
	}
	waitEmitted(t, rec, st.ID, 1, 10*time.Second)
}
```

Existing-helper changes required by the new 5th constructor param: in `newConnectedServiceStack` (service_test.go:79) pass `nil`:

```go
	svc = NewMessagingService(mgr, log, rec.emit, settingsPath, nil)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && go test ./internal/messaging/ -run 'TestDataPlane' -v`
Expected: COMPILE ERROR — `too many arguments in call to NewMessagingService` (the new tests pass 5 args; the current signature at service.go:62 takes 4)

- [ ] **Step 3: Implement**

service.go:62 (constructor) — add the 5th param and build the data emitter:

```go
func NewMessagingService(mgr *connections.Manager, log *slog.Logger, emit func(string, any), settingsPath string, hub *MsgHub) *MessagingService {
```

and around line 80:

```go
	dataEmit := func(v any) {
		if hub != nil {
			hub.BroadcastData(v)
			return
		}
		emit(EventSessionMsgs, v)
	}
	s.Sessions = NewSessionManager(mgr, log, emit, dataEmit, defBuf, defPush)
```

Add the binding method + type (service.go, near ListSessions:154):

```go
// DataChannelInfo is the loopback WS endpoint the frontend uses for the
// session data plane (§7.1.3 batches). Token is a per-boot capability
// credential: it must never be logged (§13.3).
type DataChannelInfo struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

// DataChannel reports the hub endpoint; zero value when the hub is absent
// (frontend then falls back to wails events — which also carry no data in
// that mode because the emit path is active, so the pairing stays coherent).
func (s *MessagingService) DataChannel() DataChannelInfo {
	if s.hub == nil {
		return DataChannelInfo{}
	}
	u, tok := s.hub.DataChannel()
	return DataChannelInfo{URL: u, Token: tok}
}
```

Add field `hub *MsgHub` to the MessagingService struct (set in the constructor: `s.hub = hub`).

sessions.go — `NewSessionManager(mgr, log, emit, dataEmit, defBuf, defPush)` (new param after emit; store as field `dataEmit func(any)` on SessionManager). `newSession` (free function at sessions.go:464, called from `CreateSession` at :189) gains the same param; its pusher closure (lines 477-479) becomes:

```go
	s.pusher = newPusher(mode, func(batch []MsgOut) {
		if dataEmit != nil {
			dataEmit(batch) // payload: []MsgOut — the §7.1.3 wire shape (data plane: hub or legacy emit; m6-perf §12.3)
			return
		}
		emit(EventSessionMsgs, batch)
	})
```

(nil `dataEmit` → legacy emit, so existing `newSession` call sites can pass `nil`; `stateThrottle` at line 480 keeps `emit`: state is control-plane and stays on wails events.)

Update every `newSession`/`NewSessionManager` call site the new param touches — pass `nil` unless the test asserts emissions:
- `sessions_test.go:204` (`newSessionStackRec`), `:820` (`TestSessionInvalidSubject`), `:1447` (`TestSessionReconnectResubscribes`)
- `sessions_stress_test.go:66`
- `pipeline_bench_test.go:69` (direct `newSession` call — if the bench asserts emissions, pass a recording sink; otherwise `nil`)
- `service_test.go:79` — `newConnectedServiceStack` passes hub `nil` AND `NewSessionManager` gains `dataEmit` from Task 2's constructor change (the service builds `dataEmit` itself, so the helper only adds the 5th service arg `nil`).

Run `go build ./... && go vet ./...` to prove no call site was missed before running tests.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && go test ./internal/messaging/ -race -count=1`
Expected: PASS (including new DataPlane tests and all existing sessions/pipeline tests)

- [ ] **Step 5: Commit**

```bash
git add desktop/internal/messaging/
git commit -m "feat(messaging): route session:msgs data plane through MsgHub when active (leak B bypass, part 2)"
```

---

### Task 3: DataChannel binding + main wiring

**Files:**
- Modify: `desktop/main.go:109` (+ hub lifecycle)
- Regen: `desktop/frontend/bindings/`

**Interfaces:**
- Consumes: `NewMsgHub/Start/Close` (Task 1), `DataChannel()` binding (Task 2)
- Produces: frontend binding `MessagingService.DataChannel()` returning `{ url: string | null; token: string | null }` (interface-mode nilable fields)

- [ ] **Step 1: Wire main.go**

Replace main.go:109:

```go
	msgSvc = messaging.NewMessagingService(manager, logger, emit, settingsPath)
```

with:

```go
	// Data-plane hub (leak B bypass, m6-perf §12.3): loopback WS for session
	// message batches. Failure to start degrades to the legacy wails-event
	// path (nil hub) — control plane unaffected.
	hub := messaging.NewMsgHub(logger)
	if _, err := hub.Start(); err != nil {
		logger.Error("msg hub start failed; session data falls back to wails events", "err", err)
		hub = nil
	} else {
		defer hub.Close()
	}
	msgSvc = messaging.NewMessagingService(manager, logger, emit, settingsPath, hub)
```

(Note: `logger.Error` with the error only — never the token, §13.3.)

- [ ] **Step 2: Regenerate bindings**

Run: `cd desktop && wails3 generate bindings -ts -clean=true`
Expected: `frontend/bindings/...` gains `DataChannel` on the messaging service; the diff shows ONLY this addition. If the diff shows wholesale reformatting, STOP and check the generator flags against CONTRIBUTING.md:21 — the committed tree must not churn. (`DataChannelInfo{URL, Token string}` fields are non-pointer without omitempty, so the generated model should read `"url": string; "token": string` — plain types, not `| null`.)

- [ ] **Step 2b: Re-export the binding**

`src/lib/bindings.ts:33-43` is hand-maintained (regen does NOT touch it) — add `DataChannel` to the messaging re-export block and `type DataChannelInfo` to the models re-exports (lines 47-57):

```ts
// messaging block gains:
  DataChannel,
// models block gains:
  type DataChannelInfo,
```

- [ ] **Step 3: Build + smoke**

Run: `cd desktop && go build -o bin/nats-desktop.exe . && go vet ./...`
Expected: clean build, clean vet.

- [ ] **Step 4: Commit**

```bash
git add desktop/main.go desktop/frontend/bindings/ desktop/frontend/src/lib/bindings.ts
git commit -m "feat(app): wire MsgHub lifecycle + DataChannel binding (leak B bypass, part 3)"
```

---

### Task 4: Frontend msgChannel

**Files:**
- Create: `desktop/frontend/src/lib/msgChannel.ts`
- Create: `desktop/frontend/tests/msg-channel.test.ts`

**Interfaces:**
- Produces (Task 5 consumes):
  - `export interface MsgChannel { close(): void }`
  - `export function connectMsgChannel(url: string, token: string, onData: (data: unknown) => void, log?: (...a: unknown[]) => void): MsgChannel`
  - Reconnect backoff: 1s, 2s, 4s, 8s (cap 8s), reset on open; `close()` cancels timers and the socket.

- [ ] **Step 1: Write the failing tests**

Create `desktop/frontend/tests/msg-channel.test.ts`:

```ts
import { it, expect, vi, beforeEach, afterEach } from "vitest";

type FakeWS = {
  url: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  close: () => void;
  sentClose: boolean;
};

let sockets: FakeWS[];
let WS: typeof WebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  WS = class {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    url: string;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    sentClose = false;
    constructor(url: string) {
      this.url = url;
      sockets.push(this as unknown as FakeWS);
    }
    close() {
      this.sentClose = true;
      this.onclose?.();
    }
  } as unknown as typeof WebSocket;
  vi.stubGlobal("WebSocket", WS);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

import { connectMsgChannel } from "../src/lib/msgChannel";

it("connects with the token in the query string and routes parsed frames", () => {
  const seen: unknown[] = [];
  connectMsgChannel("ws://127.0.0.1:1/messaging/data", "tok", (d) => seen.push(d));
  expect(sockets[0].url).toBe("ws://127.0.0.1:1/messaging/data?token=tok");
  sockets[0].onopen?.();
  sockets[0].onmessage?.({ data: JSON.stringify([{ seq: 1 }]) });
  expect(seen).toEqual([[{ seq: 1 }]]);
});

it("reconnects with capped backoff and resets on open", () => {
  connectMsgChannel("ws://x", "t", () => {});
  sockets[0].onclose?.(); // attempt 0 → +1s
  vi.advanceTimersByTime(999);
  expect(sockets.length).toBe(1);
  vi.advanceTimersByTime(1);
  expect(sockets.length).toBe(2);
  sockets[1].onclose?.(); // attempt 1 → +2s
  vi.advanceTimersByTime(2000);
  expect(sockets.length).toBe(3);
  sockets[2].onopen?.(); // reset
  sockets[2].onclose?.(); // attempt reset → +1s
  vi.advanceTimersByTime(1000);
  expect(sockets.length).toBe(4);
});

it("close() stops reconnects and closes the socket", () => {
  const ch = connectMsgChannel("ws://x", "t", () => {});
  ch.close();
  vi.advanceTimersByTime(60000);
  expect(sockets.length).toBe(1);
  expect(sockets[0].sentClose).toBe(true);
});

it("bad frames are logged, not thrown", () => {
  const log = vi.fn();
  const seen: unknown[] = [];
  connectMsgChannel("ws://x", "t", (d) => seen.push(d), log);
  sockets[0].onopen?.();
  sockets[0].onmessage?.({ data: "not-json" });
  expect(seen).toEqual([]);
  expect(log).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop/frontend && npx vitest run tests/msg-channel.test.ts --maxWorkers=2`
Expected: FAIL — module `../src/lib/msgChannel` not found

- [ ] **Step 3: Implement**

Create `desktop/frontend/src/lib/msgChannel.ts`:

```ts
// Data-plane channel for session message batches (m6-perf §12.3): delivering
// §7.1.3 batches through the wails event pipeline grows the WebView2 browser
// process ~231MB/h under sustained delivery, so batches ride a loopback
// WebSocket instead. Control events (session:state, errors) stay on wails
// events. Reconnect backoff 1s→8s capped; a close is final (no reconnect).

export interface MsgChannel {
  close(): void;
}

export function connectMsgChannel(
  url: string,
  token: string,
  onData: (data: unknown) => void,
  log: (...a: unknown[]) => void = console.error,
): MsgChannel {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    const sock = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
    };
    sock.onmessage = (ev) => {
      try {
        onData(JSON.parse(ev.data as string));
      } catch (err) {
        log("msg channel: undecodable frame", err);
      }
    };
    sock.onclose = () => {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      attempt += 1;
      timer = setTimeout(open, delay);
    };
    sock.onerror = () => sock.close();
  };
  open();

  return {
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      ws?.close();
      ws = null;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop/frontend && npx vitest run tests/msg-channel.test.ts --maxWorkers=2`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/frontend/src/lib/msgChannel.ts desktop/frontend/tests/msg-channel.test.ts
git commit -m "feat(frontend): loopback WS msg channel for session data plane (leak B bypass, part 4)"
```

---

### Task 5: Switch useSessions to the data-plane channel

**Files:**
- Modify: `desktop/frontend/src/features/messages/useSessions.ts:150-156`
- Modify: `desktop/frontend/tests/messages-sessions.test.tsx`, `messages-sessions-filter.test.tsx`, `messages-perf.test.ts`, `tests/bench/sessions.bench.ts`

**Interfaces:**
- Consumes: `connectMsgChannel` (Task 4), binding `DataChannel()` (Task 3, via `src/lib/bindings.ts` re-exports)
- Produces: identical downstream behavior — `applyPendingMsgs` receives the same `[]MsgOut` batches; `session:state` remains on wails `Events.On`.

- [ ] **Step 1: Update the component**

In `useSessions.ts`, replace the subscription (lines 149-153):

```ts
    const offMsgs = Events.On("session:msgs", (e: { data?: unknown }) => {
      bufferMsgs(e?.data);
      scheduleFlush();
    });
```

with:

```ts
    // Data plane (m6-perf §12.3): §7.1.3 batches ride the loopback WS
    // channel; the wails event path no longer carries message batches.
    // session:state below remains a wails event (control plane).
    // DataChannel() is a $CancellablePromise like every binding — resolve
    // it; do NOT treat it as synchronous.
    let channel: MsgChannel | null = null;
    DataChannel()
      .then((dc) => {
        if (!alive || !dc?.url || !dc?.token) return;
        channel = connectMsgChannel(dc.url, dc.token, (data) => {
          bufferMsgs(data);
          scheduleFlush();
        });
      })
      .catch(() => {
        /* endpoint unavailable: live frames pause; counters keep flowing
           via session:state and §6.4's no-replay-on-resume covers the UI */
      });
```

and the effect cleanup (line ~187): replace `offMsgs();` with `channel?.close();` (the `alive = false` already present guards the async resolve against post-unmount construction).

Imports at the top of the file: add `DataChannel` to the existing bindings import (the same import statement that already brings in `ListSessions`), and add:

```ts
import { connectMsgChannel, type MsgChannel } from "@/lib/msgChannel";
```

(`!dc?.url || !dc?.token` guards the hub-absent zero value; in that case no channel is opened — sessions still work, only live message frames pause, and §6.4's no-replay-on-resume semantics make that loss invisible to counters via `session:state`.)

`sessionsLogic.ts` wire-shape comments (§7.1.3) stay valid — the WS frame payload IS the old `e.data`.

- [ ] **Step 2: Update the test mocks**

In `tests/messages-sessions.test.tsx`, `messages-sessions-filter.test.tsx`, AND `messages-sessions-coalesce.test.tsx` (its `fireMsgs` helper at lines 61-64 fires `handlers.get("session:msgs")`), AND `messages-perf.test.ts` (its bindings mock at lines 33-42 must gain `DataChannel` or the suite crashes on the undefined call):
- Add to the existing bindings mock (async — the binding is a promise): `DataChannel: async () => ({ url: "ws://127.0.0.1:1/messaging/data", token: "test-token" })`.
- Add a hoisted channel mock and a fire helper replacing `runtime.handlers.get("session:msgs")({ data })`:

```ts
const channel = vi.hoisted(() => ({
  onData: null as null | ((data: unknown) => void),
}));
vi.mock("../src/lib/msgChannel", () => ({
  connectMsgChannel: (_url: string, _token: string, onData: (data: unknown) => void) => {
    channel.onData = onData;
    return { close: () => { channel.onData = null; } };
  },
}));
// fire: channel.onData?.(batch)   // batch === old e.data
```

- Replace every `runtime.handlers.get("session:msgs")(…)` call with `channel.onData?.(…)` in all four files.
- `tests/messages-sessions.test.tsx:379-389` (unmount test) asserts wails subscription lifecycle — rewrite to channel lifecycle:

```ts
    // before: expect(runtime.handlers.has("session:msgs")).toBe(true);
    expect(channel.onData).not.toBeNull();
    // before: expect(runtime.offs).toContain("session:msgs");
    unmount();
    expect(channel.onData).toBeNull();           // mock close() ran
    expect(runtime.offs).toEqual(["session:state"]); // only the control plane remains
```

- `tests/bench/sessions.bench.ts`: NO change (drives `applyMsgsBatch` directly; excluded from vitest run).

- [ ] **Step 3: Run the frontend suite**

Run: `cd desktop/frontend && npx vitest run --maxWorkers=2`
Expected: all suites PASS (incl. coalescing, filter, perf, bench)

- [ ] **Step 4: Commit**

```bash
git add desktop/frontend/
git commit -m "feat(frontend): session data plane rides the loopback WS channel (leak B bypass, part 5)"
```

---

### Task 6: Full validation + evidence

**Files:**
- Modify: `docs/superpowers/plans/2026-09-14-nats-desktop-m6-perf.md` (§12.4 validation backfill)
- Modify: `docs/superpowers/specs/2026-09-11-nats-desktop-v1-spec.md` (§6.4 transport note, version table v1.4)

- [ ] **Step 1: Full local gates**

Run: `cd desktop && go test ./... -race -count=1 && go vet ./...`
Run: `cd desktop/frontend && npx vitest run --maxWorkers=2 && npx tsc --noEmit && npx eslint src tests`
Expected: all green (local `-race` may hit the TSAN alloc-87 environment failure — in that case CI is the arbiter; push and require the 4-job CI green).

- [ ] **Step 2: Same-load validation run (the evidence that matters)**

Repeat leg D1 exactly (delivery-only, no nav) on the NEW build:

```bash
cd desktop && go build -o bin/nats-desktop.exe .
bash bin/legD1.sh   # rename OutDir to bin/legD1-wsfix via editing legD1.sh paths first
```

(Adapt `bin/legD1.sh` copy → `bin/legD1-wsfix.sh`: same body, `-OutCsv`/logs under `bin/legD1-wsfix/`.) Expected: flood ~99%, session receives ~1k msg/s, `ppsample.csv` over the last 40 minutes: browser-process slope ≤ 10MB/h (vs 231.3 before). Backfill the numbers into m6-perf §12.4 with the CSV path — PASS/FAIL verdict unsoftened.

- [ ] **Step 3: Docs**

- m6-perf §12.4: validation table (before 231.3 → after measured), leg-D1-wsfix artifact paths.
- spec v1.4 row in §1 version table: `session:msgs` 数据面改走应用自建回环 WebSocket（token 鉴权、有界缓冲、溢出断连重同步）；§6.4 处理逻辑补一行传输说明；§7.1.3 wire shape unchanged note.
- Recovery ledger `.superpowers/sdd/progress.md` update.

- [ ] **Step 4: Commit + push**

```bash
git add desktop/ docs/
git commit -m "docs(perf/spec): leak B WS data-plane validation evidence + spec v1.4 transport note"
git push origin <branch>
```

- [ ] **Step 5: Post-merge soak #3 (24h, separate from this plan's merge gate)**

Relaunch `scripts/soak.ps1 -Hours 24` on the fixed build. Prediction under the cascade hypothesis (m6-soak §11): flat tree memory AND nav 0-miss throughout AND app log never freezes — closing all three defects with one root-cause fix. Adjudicate ≤10% AC-025 gate from verdict.txt.
