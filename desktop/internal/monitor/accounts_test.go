package monitor

import (
	"testing"

	"github.com/nats-io/jsm.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

func TestListAccounts(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)

	// 在 APP 账户建一个 stream，账户统计应出现 APP + 1 stream。
	// StartSysServer 只在服务器级开 JS；APP 账户需运行时启用（夹具返回的
	// AppAcc 是活对象，nil limits = 默认动态配额；tq 在 v2.15 未使用）。
	appNc := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	if err := f.AppAcc.EnableJetStream(nil, nil); err != nil {
		t.Fatal(err)
	}
	mgr, err := jsm.New(appNc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mgr.NewStream("ACCT_TEST"); err != nil {
		t.Fatal(err)
	}

	s, _ := newService(t, nc)
	res := s.ListAccounts()
	if !res.Ok() {
		t.Fatalf("accounts: %+v", res)
	}
	var app *AccountRow
	for i := range res.Accounts {
		if res.Accounts[i].Name == "APP" {
			app = &res.Accounts[i]
		}
	}
	if app == nil || app.Streams < 1 || len(app.StreamNames) < 1 {
		t.Fatalf("APP account row: %+v", app)
	}
}

func TestListAccountsNoSysPermission(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	s, _ := newService(t, nc)
	res := s.ListAccounts()
	if res.Ok() && len(res.Accounts) == 0 && res.Error == "" {
		t.Fatal("degraded path must carry reason")
	}
}
