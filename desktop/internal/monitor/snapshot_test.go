package monitor

import (
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
	"github.com/WenElevating/nats-desktop/desktop/internal/settings"
	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

type connStub struct{ nc *nats.Conn }

func (c connStub) Conn() *nats.Conn                 { return c.nc }
func (c connStub) JSParams() (string, string, bool) { return "", "", true }
func (c connStub) JSEventPrefix() string            { return "" }

// snapLog 是 mutex 保护的快照收集器（emit 来自 ticker goroutine）。
type snapLog struct {
	mu    sync.Mutex
	snaps []MonitorSnapshot
}

func (l *snapLog) emit(name string, data any) {
	if name == EventMonitorSnapshot {
		l.mu.Lock()
		l.snaps = append(l.snaps, data.(MonitorSnapshot))
		l.mu.Unlock()
	}
}

func (l *snapLog) len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.snaps)
}

func newService(t *testing.T, nc *nats.Conn) (*MonitorService, *snapLog) {
	return newServiceAt(t, nc, "")
}

// newServiceAt 允许指定 settings 路径（停止类测试用 interval=2s 的设置文件，
// 使「停止后无新事件」断言在删掉停止逻辑时会失败）。
func newServiceAt(t *testing.T, nc *nats.Conn, settingsPath string) (*MonitorService, *snapLog) {
	t.Helper()
	l := &snapLog{}
	s := NewMonitorService(connStub{nc}, slog.New(slog.NewTextHandler(os.Stderr, nil)), l.emit, settingsPath)
	return s, l
}

// writeFastPollSettings 写一份 poll_interval_seconds=2 的设置文件并返回路径。
func writeFastPollSettings(t *testing.T) string {
	t.Helper()
	path := t.TempDir() + "/settings.json"
	st := settings.Default()
	st.Behavior.PollIntervalSeconds = 2
	if err := settings.Save(path, st); err != nil {
		t.Fatal(err)
	}
	return path
}

// 单节点（系统账户）：collectSnapshot 得 1 行在线、角色/版本/连接数齐备。
func TestSnapshotSingleSysServer(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)

	snap := s.collectSnapshot()
	if !snap.SysAvailable {
		t.Fatalf("sys must be available: %+v", snap.SysReason)
	}
	if len(snap.Servers) != 1 || !snap.Servers[0].Online {
		t.Fatalf("want 1 online row: %+v", snap.Servers)
	}
	row := snap.Servers[0]
	if row.Name != "TEST_SYS" || row.Version == "" || row.Connections < 1 || !row.JsEnabled {
		t.Fatalf("row fields incomplete: %+v", row)
	}
	if row.UptimeSeconds <= 0 || row.Cores < 1 || row.MemBytes <= 0 {
		t.Fatalf("stats fields incomplete: %+v", row)
	}
	if snap.RttMs < 0 || snap.CycleMs <= 0 {
		t.Fatalf("rtt/cycle: %+v", snap)
	}
}

// 无系统权限（app 用户）：SysAvailable=false + 原文 reason（§8.3.1）。
func TestSnapshotNoSysPermission(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	s, _ := newService(t, nc)

	snap := s.collectSnapshot()
	if snap.SysAvailable || snap.SysReason == "" {
		t.Fatalf("want degraded snapshot: %+v", snap)
	}
}

// 三节点 + 断一节点：该节点标红离线、其余正常（AC-015 预期 2 的 Go 半边）。
func TestSnapshotClusterNodeOfflineMarking(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.SysUser, c.SysPass)
	s, _ := newService(t, nc)

	snap := s.collectSnapshot()
	if len(snap.Servers) != 3 {
		t.Fatalf("want 3 rows, got %d", len(snap.Servers))
	}

	// 关闭 S3；下一周期它不应答 → 已知集合 diff 标红。
	c.Nodes[2].Srv.Shutdown()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		snap = s.collectSnapshot()
		var off *MonitorServerRow
		for i := range snap.Servers {
			if snap.Servers[i].Name == c.Nodes[2].Name {
				off = &snap.Servers[i]
			}
		}
		if off != nil && !off.Online {
			if len(snap.Servers) != 3 {
				t.Fatalf("offline row must be retained: %d rows", len(snap.Servers))
			}
			var online int
			for _, r := range snap.Servers {
				if r.Online {
					online++
				}
			}
			if online != 2 {
				t.Fatalf("want 2 online, got %d", online)
			}
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatal("S3 not marked offline within 10s")
}

// StartMonitoring 立即出首帧事件且按间隔续推；Stop 后停（§8.5.1）。
func TestStartStopMonitoringEvents(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	// interval=2s 的设置文件：停止后观察窗必须跨过一个完整 tick，删除停止
	// 逻辑时本测试会失败（空假设成立）。
	s, snaps := newServiceAt(t, nc, writeFastPollSettings(t))

	if res := s.StartMonitoring(); !res.Ok() {
		t.Fatalf("start: %+v", res)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && snaps.len() == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	if snaps.len() == 0 {
		t.Fatal("no snapshot event after start")
	}
	if res := s.StopMonitoring(); !res.Ok() {
		t.Fatalf("stop: %+v", res)
	}
	n := snaps.len()
	// > 2× interval（覆盖一个完整 tick 的静默断言）。
	time.Sleep(2500 * time.Millisecond)
	if snaps.len() != n {
		t.Fatalf("events must stop after StopMonitoring: %d -> %d", n, snaps.len())
	}
	// 重复 Stop 幂等；未启动时 Stop 也幂等。
	_ = s.StopMonitoring()
}

// NotifyConnState 非 connected → ticker 停（断连全停的快照半边）。
func TestNotifyConnStateStopsTicker(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, snaps := newServiceAt(t, nc, writeFastPollSettings(t))
	if res := s.StartMonitoring(); !res.Ok() {
		t.Fatal(res)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && snaps.len() == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	s.NotifyConnState(connections.StateEvent{State: connections.StateReconnecting})
	n := snaps.len()
	time.Sleep(2500 * time.Millisecond)
	if snaps.len() != n {
		t.Fatalf("ticker must stop on non-connected state: %d -> %d", n, snaps.len())
	}
}
