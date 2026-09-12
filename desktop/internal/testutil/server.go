// Package testutil provides embedded nats-server test fixtures: single-node
// servers with random ports, started and cleaned up automatically via t.Cleanup.
// Unlike the natscli 3-node cluster fixture, these single-node fixtures do not
// skip on Windows.
package testutil

import (
	"testing"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// start boots an embedded nats-server with the given options, waits for it to
// accept client connections, and registers srv.Shutdown with t.Cleanup.
func start(t *testing.T, opts *server.Options) string {
	t.Helper()
	srv, err := server.NewServer(opts)
	if err != nil {
		t.Fatal(err)
	}
	go srv.Start()
	if !srv.ReadyForConnections(10 * time.Second) {
		t.Fatal("server not ready")
	}
	t.Cleanup(srv.Shutdown)
	return srv.ClientURL()
}

// StartJSServer starts a single-node server with JetStream enabled, a random
// port, and its store directory in t.TempDir(). It returns the client URL.
func StartJSServer(t *testing.T) string {
	return start(t, &server.Options{
		Port:       -1,
		ServerName: "TEST_JS",
		StoreDir:   t.TempDir(),
		JetStream:  true,
	})
}

// StartAuthServer starts a single-node server on a random port that requires
// basic username/password authentication. It returns the client URL.
func StartAuthServer(t *testing.T, user, pass string) string {
	return start(t, &server.Options{
		Port:       -1,
		ServerName: "TEST_AUTH",
		Users:      []*server.User{{Username: user, Password: pass}},
	})
}

// StartEcho connects to the server at url and subscribes to "echo", responding
// to each request with the request payload echoed back. The connection is
// closed via t.Cleanup. Header passthrough (what the requester sent vs. what
// the responder returns) is asserted by the calling test case.
func StartEcho(t *testing.T, url string) {
	t.Helper()
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := nc.Subscribe("echo", func(m *nats.Msg) {
		m.Respond(m.Data)
	}); err != nil {
		nc.Close()
		t.Fatal(err)
	}
	nc.Flush()
	t.Cleanup(nc.Close)
}

// LocalServerURL is the long-lived local test server (user-mandated real
// server for unit/perf/stress tests; monitor endpoint :8333/jsz).
const LocalServerURL = "nats://127.0.0.1:4333"

// ConnectLocalServer connects to the local server or skips the test when
// it is not running (2s probe), mirroring messaging's requireLocalServer.
func ConnectLocalServer(t *testing.T) *nats.Conn {
	t.Helper()
	nc, err := nats.Connect(LocalServerURL, nats.Timeout(2*time.Second), nats.MaxReconnects(0))
	if err != nil {
		t.Skipf("local server %s not running: %v", LocalServerURL, err)
	}
	t.Cleanup(func() { nc.Close() })
	return nc
}
