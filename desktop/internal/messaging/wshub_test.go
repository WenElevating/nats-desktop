package messaging

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
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
	if err != nil {
		t.Fatal(err)
	}
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
	if err != nil {
		t.Fatal(err)
	}
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
		if h.clientCount() == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if h.clientCount() != 2 {
		t.Fatalf("clients = %d, want 2", h.clientCount())
	}
	h.BroadcastData(map[string]any{"session_id": "sub-1", "seq": 1})
	for _, read := range [](func() ([]byte, error)){read1, read2} {
		b, err := read()
		if err != nil {
			t.Fatal(err)
		}
		var got map[string]any
		if err := json.Unmarshal(b, &got); err != nil {
			t.Fatal(err)
		}
		if got["session_id"] != "sub-1" {
			t.Fatalf("got %v", got)
		}
	}
}

func TestMsgHubOverflowDisconnectsSlowClient(t *testing.T) {
	h := NewMsgHub(testLog(t))
	url, token := mustStart(t, h)
	conn, _ := dialHub(t, url, token)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if h.clientCount() == 1 {
			break
		}
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
	if _, err := h.Start(); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

// TestMsgHubAcceptsBrowserOrigin pins the wails-webview handshake: the browser
// sends Origin http://wails.localhost and MUST be accepted (default cross-origin
// rejection starved the data plane silently — m6-perf §12.4). Auth is the token
// + loopback checks, not the client-controlled Origin header.
func TestMsgHubAcceptsBrowserOrigin(t *testing.T) {
	h := NewMsgHub(testLog(t))
	url, token := mustStart(t, h)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url+"?token="+token, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"http://wails.localhost"}},
	})
	if err != nil {
		t.Fatalf("dial with browser origin must succeed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
}
