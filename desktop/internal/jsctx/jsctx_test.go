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

// TestNewWithDomain covers the domain branch (M3 §6-9)：domain 优先于
// prefix，走 WithDomain —— 请求落到 $JS.<domain>.API.*，测试服务器上没有
// 该 domain，账户信息因此失败（spec §6.6：domain 错误必须表现为不可用，
// 而非空资源列表）。
func TestNewWithDomain(t *testing.T) {
	nc, err := nats.Connect(testutil.StartJSServer(t))
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	mgr, err := NewManager(nc, "NOPE", "$ALSO.WRONG", time.Second) // domain 优先：prefix 被忽略
	if err != nil {
		t.Fatal(err)
	}
	if mgr.IsJetStreamEnabled() {
		t.Fatal("expected unavailable with wrong domain")
	}
	js, err := New(nc, "NOPE", "$ALSO.WRONG")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.AccountInfo(t.Context()); err == nil {
		t.Fatal("expected account info failure with wrong domain")
	}
}

// TestNewDefaultBranch covers the neither-domain-nor-prefix branch: with both
// empty the handle uses the default $JS.API prefix and account info succeeds
// on a JS-enabled server.
func TestNewDefaultBranch(t *testing.T) {
	nc, err := nats.Connect(testutil.StartJSServer(t))
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	js, err := New(nc, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.AccountInfo(t.Context()); err != nil {
		t.Fatalf("expected default-prefix account info to succeed: %v", err)
	}
}
