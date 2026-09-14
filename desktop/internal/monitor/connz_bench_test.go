package monitor

import (
	"testing"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// BenchmarkListServerConnectionsPage: 1,024 行分页的服务端往返墙钟（G13 该
// 子门的 bench 证据，M5 ㉟）。跑法:
//
//	go test ./internal/monitor/ -bench BenchmarkListServerConnectionsPage -benchtime 5x -run '^$'
//
// 夹具：单节点系统账户 + 1,024 条 app 用户连接 + 1 条 sys 用户连接（monitor
// 自身）。计时段只含一次定向 CONNZ（offset=0 limit=1024，服务端分页）的
// 请求-应答-行映射；服务器名→ID 解析在计时前预热（known 缓存）。
func BenchmarkListServerConnectionsPage(b *testing.B) {
	f := testutil.StartSysServer(b) // testutil 助手已放宽为 testing.TB（M6 T4）
	for i := 0; i < 1024; i++ {
		testutil.ConnectUser(b, f.URL, f.AppUser, f.AppPass)
	}
	s := NewMonitorService(
		connStub{testutil.ConnectUser(b, f.URL, f.SysUser, f.SysPass)},
		nil, nil, "",
	)

	// 预热：冷启动路径含一轮 statsz 广播（known 空 → collectSnapshot），
	// 不属于分页往返，先跑一次把 ID 解析进缓存并验证面是通的。
	if res := s.ListServerConnections(f.Srv.Name(), "cid", 0, 1); !res.Ok() {
		b.Fatalf("warmup page: %+v", res)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		res := s.ListServerConnections(f.Srv.Name(), "cid", 0, 1024)
		if !res.Ok() {
			b.Fatalf("page: %+v", res)
		}
		if len(res.Rows) != 1024 {
			b.Fatalf("rows = %d, want 1024 (server-side paging)", len(res.Rows))
		}
		if res.Total < 1024 {
			b.Fatalf("total = %d, want >= 1024", res.Total)
		}
	}
}
