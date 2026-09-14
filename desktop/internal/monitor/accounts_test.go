package monitor

import (
	"fmt"
	"testing"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/nats-server/v2/server"

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

// TestAccountRowsStreamNamesCap（M5 ⑦）：>maxStreamNames 流的账户折叠不变量——
// Streams 计数保持全量（60），StreamNames 只留前 50 个名字，Consumers 为全部
// stream 的 consumer 数之和。纯函数直调，不依赖 $SYS 面板。
func TestAccountRowsStreamNamesCap(t *testing.T) {
	detail := &server.AccountDetail{Name: "BIG", Id: "acct_big"}
	for i := 0; i < 60; i++ {
		detail.Streams = append(detail.Streams, server.StreamDetail{
			Name:     fmt.Sprintf("S%02d", i),
			Consumer: []*server.ConsumerInfo{{Name: "c"}},
		})
	}
	// nil 明细行必须被跳过；多账户按 Name 排序（映射器自持不变量）。
	rows := accountRows([]*server.AccountDetail{
		nil,
		detail,
		{Name: "AAA", Id: "acct_aaa"},
	})
	if len(rows) != 2 {
		t.Fatalf("nil detail must be skipped, got %d rows", len(rows))
	}
	if rows[0].Name != "AAA" || rows[1].Name != "BIG" {
		t.Fatalf("rows must sort by Name: %q, %q", rows[0].Name, rows[1].Name)
	}

	row := rows[1]
	if row.Id != "acct_big" {
		t.Fatalf("Id = %q", row.Id)
	}
	if row.Streams != 60 {
		t.Fatalf("Streams = %d, want 60 (full count, uncapped)", row.Streams)
	}
	if len(row.StreamNames) != 50 {
		t.Fatalf("len(StreamNames) = %d, want %d", len(row.StreamNames), 50)
	}
	for i, n := range row.StreamNames {
		if want := fmt.Sprintf("S%02d", i); n != want {
			t.Fatalf("StreamNames[%d] = %q, want %q (first-50 prefix kept)", i, n, want)
		}
	}
	if row.Consumers != 60 {
		t.Fatalf("Consumers = %d, want 60 (sum over all streams)", row.Consumers)
	}
}
