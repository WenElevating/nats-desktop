package monitor

import (
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// 节点报表：varz+healthz 齐；未知服务器 → not_found。
func TestGetServerDetail(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)

	// 不预跑快照：resolveServerID 必须自己跑一次广播刷新（覆盖冷启动路径）。
	res := s.GetServerDetail("TEST_SYS")
	if !res.Ok() || res.Detail == nil {
		t.Fatalf("detail: %+v", res)
	}
	if res.Detail.HealthStatus == "" && res.Detail.HealthError == "" {
		t.Fatalf("healthz must be surfaced: %+v", res.Detail)
	}
	if res.Detail.Row.Connections < 1 {
		t.Fatalf("row merge missing: %+v", res.Detail.Row)
	}

	// 名称解析失败 → not_found（而非误导性的 server/权限错误）。
	if res := s.GetServerDetail("NO_SUCH"); res.ErrorCode != CodeNotFound {
		t.Fatalf("unknown server must be not_found: %+v", res)
	}
}

// 连接明细：分页 + 排序 + 总数（单节点开 3 条连接断言 ≥3）。
func TestListServerConnectionsPaging(t *testing.T) {
	f := testutil.StartSysServer(t)
	for range 3 {
		testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	}
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)

	res := s.ListServerConnections("TEST_SYS", "cid", 0, 2)
	if !res.Ok() {
		t.Fatalf("connz: %+v", res)
	}
	if len(res.Rows) != 2 || res.Limit != 2 || res.Total < 4 {
		t.Fatalf("page: rows=%d total=%d", len(res.Rows), res.Total)
	}
	if res.Rows[0].Cid == 0 || res.Rows[0].Ip == "" {
		t.Fatalf("row fields: %+v", res.Rows[0])
	}

	page2 := s.ListServerConnections("TEST_SYS", "cid", 2, 2)
	if !page2.Ok() || len(page2.Rows) < 1 {
		t.Fatalf("page2: %+v rows=%d", page2, len(page2.Rows))
	}

	if res := s.ListServerConnections("TEST_SYS", "DROP", 0, 50); res.ErrorCode != CodeValidation {
		t.Fatalf("bad sort: %+v", res)
	}
}

// kick：断开指定连接（AC 场景 = sys 权限用户）。
func TestKickConnection(t *testing.T) {
	f := testutil.StartSysServer(t)
	victim := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	victim.Flush()
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)

	cid, _ := victim.GetClientID()
	if res := s.KickConnection("TEST_SYS", uint64(cid)); !res.Ok() {
		t.Fatalf("kick: %+v", res)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if victim.IsClosed() || victim.Status() == nats.CLOSED || victim.Status() == nats.RECONNECTING {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("victim connection not closed after kick")
}
