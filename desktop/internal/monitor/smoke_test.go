package monitor

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/nats-io/nats-server/v2/server"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
	"github.com/WenElevating/nats-desktop/desktop/internal/settings"
	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// 全绑定面冒烟：单服务器上依次调用全部公开方法不 panic、错误码受控。
func TestServiceBindingSurfaceSmoke(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)

	if res := s.StartMonitoring(); !res.Ok() {
		t.Fatal(res)
	}
	_ = s.GetMonitoringSnapshot()
	if res := s.GetServerDetail("TEST_SYS"); !res.Ok() {
		t.Fatal(res)
	}
	if res := s.ListServerConnections("TEST_SYS", "cid", 0, 10); !res.Ok() {
		t.Fatal(res)
	}
	_ = s.ListAccounts()
	if res := s.CreateSysWatch(SysWatchSpec{Types: []string{"account_connect"}}); !res.Ok() {
		t.Fatal(res)
	}
	if res := s.MetaStepDown(); res.ErrorCode != CodeValidation && res.ErrorCode != CodeServer {
		// 单节点无 Meta → natscli 原文错误（server）；域守卫不触发（无域）。
		t.Logf("meta stepdown on single node: %+v (expected server error)", res)
	}
	_ = s.StopMonitoring()
}

// ---------------------------------------------------------------------------
// 以下为绑定面的表格测试补齐（M5 门禁：monitor ≥80% 覆盖率）：只打纯函数、
// 错误分支与未连接路径，不新增集群夹具。

// writeIntervalSettings 写一份指定 poll_interval_seconds 的设置文件。
func writeIntervalSettings(t *testing.T, dir string, sec int) string {
	t.Helper()
	path := filepath.Join(dir, fmt.Sprintf("settings_%d.json", sec))
	st := settings.Default()
	st.Behavior.PollIntervalSeconds = sec
	if err := settings.Save(path, st); err != nil {
		t.Fatal(err)
	}
	return path
}

// 轮询间隔读取/夹取表：缺失/损坏回退 5s、<2 夹到 5s、>60 夹到 60s（§6.10）。
func TestIntervalClampTable(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name string
		path string
		want time.Duration
	}{
		{"default empty path", "", 5 * time.Second},
		{"missing file", filepath.Join(dir, "missing.json"), 5 * time.Second},
		{"zero clamps to default", writeIntervalSettings(t, dir, 0), 5 * time.Second},
		{"one clamps to default", writeIntervalSettings(t, dir, 1), 5 * time.Second},
		{"in-range kept", writeIntervalSettings(t, dir, 30), 30 * time.Second},
		{"over-range clamps to 60", writeIntervalSettings(t, dir, 61), 60 * time.Second},
	}
	s := NewMonitorService(connStub{nil}, nil, nil, "")
	for _, tc := range cases {
		s.settingsPath = tc.path
		if got := s.interval(); got != tc.want {
			t.Errorf("%s: interval = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// varzRow 的 JS 角色映射表（Global 12，与 jsRole 同语义）。
func TestVarzRowRoleMappingTable(t *testing.T) {
	si := &server.ServerInfo{Name: "S1", ID: "S1ID", JetStream: true}
	cases := []struct {
		name string
		vz   server.Varz
		want string
	}{
		{"js disabled (config nil)", server.Varz{}, "disabled"},
		{"meta leader", server.Varz{JetStream: server.JetStreamVarz{Config: &server.JetStreamConfig{}, Meta: &server.MetaClusterInfo{Leader: "S1"}}}, "meta_leader"},
		{"meta voter", server.Varz{JetStream: server.JetStreamVarz{Config: &server.JetStreamConfig{}, Meta: &server.MetaClusterInfo{Leader: "S2"}}}, "voter"},
		{"no meta (single node)", server.Varz{JetStream: server.JetStreamVarz{Config: &server.JetStreamConfig{}}}, ""},
	}
	for _, tc := range cases {
		row := varzRow(si, &tc.vz)
		if row.JsRole != tc.want {
			t.Errorf("%s: js_role = %q, want %q", tc.name, row.JsRole, tc.want)
		}
		if !row.Online || row.Name != "S1" || row.ID != "S1ID" || !row.JsEnabled {
			t.Errorf("%s: identity fields wrong: %+v", tc.name, row)
		}
	}
	// ServerInfo.JetStream=false → JsEnabled=false（行内开关跟随能力位）。
	off := varzRow(&server.ServerInfo{Name: "S2", ID: "S2ID"}, &server.Varz{})
	if off.JsEnabled || off.JsRole != "disabled" {
		t.Errorf("js-off server: %+v", off)
	}
}

// 未连接/带域路径表：五个集群操作在 nil 连接下统一 not_connected（单飞外壳
// 与 opConn 分支）；MetaPeerRemove 在带域上下文被域守卫拒绝（Global 8）。
func TestClusterOpsNotConnectedTable(t *testing.T) {
	s := NewMonitorService(connStub{nil}, nil, nil, "")
	cases := []struct {
		name string
		run  func() ClusterOpResult
	}{
		{"meta stepdown", s.MetaStepDown},
		{"meta peer remove", func() ClusterOpResult { return s.MetaPeerRemove("S2") }},
		{"stream stepdown", func() ClusterOpResult { return s.StreamStepDown("ST") }},
		{"stream peer remove", func() ClusterOpResult { return s.StreamPeerRemove("ST", "S2") }},
		{"stream balance", func() ClusterOpResult { return s.StreamBalance("ST") }},
	}
	for _, tc := range cases {
		if res := tc.run(); res.ErrorCode != CodeNotConnected {
			t.Errorf("%s: want not_connected, got %+v", tc.name, res)
		}
	}
	d := NewMonitorService(domainStub{nil, "A"}, nil, nil, "")
	if res := d.MetaPeerRemove("S2"); res.ErrorCode != CodeValidation {
		t.Errorf("meta peer remove domain guard: %+v", res)
	}
}

// 节点级绑定面未连接路径表：nil 连接下 resolveServerID 的冷启动采集先失败
// （CodeServer 原文 "not connected"），校验分支不触网即拒（CodeValidation）。
func TestServerOpsNotConnectedTable(t *testing.T) {
	s := NewMonitorService(connStub{nil}, nil, nil, "")
	if res := s.GetServerDetail("TEST_SYS"); res.ErrorCode != CodeServer {
		t.Errorf("detail: want server, got %+v", res)
	}
	if res := s.ListServerConnections("TEST_SYS", "cid", 0, 10); res.ErrorCode != CodeServer {
		t.Errorf("conns: want server, got %+v", res)
	}
	if res := s.KickConnection("TEST_SYS", 1); res.ErrorCode != CodeServer {
		t.Errorf("kick: want server, got %+v", res)
	}
	if res := s.ListServerConnections("TEST_SYS", "bogus", 0, 10); res.ErrorCode != CodeValidation {
		t.Errorf("conn query validation: %+v", res)
	}
}

// NotifyConnState 非 connected → sys watch 断连全停（watch id 失效 →
// not_found；Global 5 断连全停与 M4 buckets watcher 对齐的 sys 半边）。
func TestNotifyConnStateStopsSysWatches(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)

	res := s.CreateSysWatch(SysWatchSpec{Types: []string{"account_connect"}})
	if !res.Ok() {
		t.Fatal(res)
	}
	s.NotifyConnState(connections.StateEvent{State: connections.StateDisconnected})
	if res := s.StopSysWatch(res.WatchId); res.ErrorCode != CodeNotFound {
		t.Fatalf("watch must be stopped by disconnect: %+v", res)
	}
}
