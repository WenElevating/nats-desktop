package sysreq

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// startPlain boots an embedded server with a system account + sys user (the
// plain $SYS.REQ.SERVER.* endpoints are not served to account-less clients —
// same reason testutil.StartSysServer exists; inlined here to avoid an
// import cycle with the fixtures that consume this package).
func startPlain(t *testing.T) string {
	t.Helper()
	accs := []*server.Account{server.NewAccount("SYS"), server.NewAccount("APP")}
	opts := &server.Options{
		Port:          -1,
		ServerName:    "TEST_SYSREQ",
		Accounts:      accs,
		SystemAccount: "SYS",
		Users: []*server.User{
			{Username: "sys", Password: "syspass", Account: accs[0]},
		},
	}
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

// connect opens the sys user connection. The nats.Timeout budget is pure
// infrastructure tolerance (loopback to an embedded server); full-suite
// parallel load can stretch the handshake past tight windows (M6 T1 flake
// list), so it is generous on purpose — no assertion depends on it.
func connect(t *testing.T, url string) *nats.Conn {
	t.Helper()
	nc, err := nats.Connect(url, nats.UserInfo("sys", "syspass"), nats.Timeout(10*time.Second), nats.MaxReconnects(0))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(nc.Close)
	return nc
}

// Broadcast ping with adaptive waitFor=0 must collect at least one response
// and parse as a ServerStatsMsg (same contract serverdata gives its callers).
func TestDoReqPlainPing(t *testing.T) {
	url := startPlain(t)
	nc := connect(t, url)

	// Request deadline is infrastructure tolerance only (the assertion is that
	// at least one parseable stats response arrives, however long the loaded
	// scheduler takes to deliver it): 10s headroom per the M6 T1 flake list.
	res, err := DoReq(context.Background(), nil, "$SYS.REQ.SERVER.PING", 0, nc, 10*time.Second, nil)
	if err != nil {
		t.Fatalf("DoReq: %v", err)
	}
	if len(res) == 0 {
		t.Fatal("no responses")
	}
	var m server.ServerStatsMsg
	if err := json.Unmarshal(res[0], &m); err != nil {
		t.Fatalf("unmarshal ServerStatsMsg: %v", err)
	}
	if m.Server.Name != "TEST_SYSREQ" || m.Stats.Connections < 1 {
		t.Fatalf("stats msg: %+v", m)
	}
}

// waitFor=1 against a nonexistent directed endpoint yields the wrapped
// no-responders error (natscli-parity message).
func TestDoReqNoResponders(t *testing.T) {
	url := startPlain(t)
	nc := connect(t, url)

	// Same load-tolerance rationale: the 503 arrives immediately in healthy
	// conditions; the wide budget only covers scheduler starvation (a timeout
	// here would surface as err==nil, i.e. a flake).
	_, err := DoReq(context.Background(), nil, "$SYS.REQ.SERVER.NOPE.VARZ", 1, nc, 10*time.Second, nil)
	if err == nil {
		t.Fatal("expected error")
	}
}

// The snappy opt-out subjects must not request compression: the request
// header carries Accept-Encoding only for non-PING/non-ACCOUNT subjects.
func TestDoReqSnappyOptOut(t *testing.T) {
	url := startPlain(t)
	nc := connect(t, url)

	var gotHeader string
	done := make(chan struct{})
	sub, err := nc.Subscribe("sysreq.probe", func(m *nats.Msg) {
		gotHeader = m.Header.Get("Accept-Encoding")
		m.Respond(nil)
		close(done)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Unsubscribe()
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}

	if _, err := DoReq(context.Background(), nil, "sysreq.probe", 1, nc, 10*time.Second, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	default:
		t.Fatal("probe not reached")
	}
	if gotHeader != "snappy" {
		t.Fatalf("custom subject must request snappy, got %q", gotHeader)
	}
}
