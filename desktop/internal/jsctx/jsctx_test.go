package jsctx

import (
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

func TestNewManagerDefaults(t *testing.T) {
	nc, err := nats.Connect(testutil.StartJSServer(t))
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	mgr, err := NewManager(nc, "", "", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !mgr.IsJetStreamEnabled() {
		t.Fatal("expected JetStream enabled on test server")
	}
}

func TestNewRespectsPrefix(t *testing.T) {
	nc, err := nats.Connect(testutil.StartJSServer(t))
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	// 错误前缀：JS API 不可达 → 账户信息报 no responders
	mgr, err := NewManager(nc, "", "$WRONG.API", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if mgr.IsJetStreamEnabled() {
		t.Fatal("expected unavailable with wrong prefix")
	}
	js, err := New(nc, "", "$WRONG.API")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.AccountInfo(t.Context()); err == nil {
		t.Fatal("expected account info failure with wrong prefix")
	}
}
