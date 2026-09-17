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
