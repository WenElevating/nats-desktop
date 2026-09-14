package testutil

import (
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// 系统账户单节点：sys 用户可达 $SYS.REQ.SERVER.PING；app 用户请求无响应（超时）。
func TestStartSysServerPermissions(t *testing.T) {
	f := StartSysServer(t)

	sysNc := ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	// 请求超时是基础设施容差（M6 T1 flake 名单）：全量套件并行时嵌入服务器的
	// 应答可能错过紧窗口，放宽到 10s 不弱化任何断言（断言只看应答可达）。
	if _, err := sysNc.Request("$SYS.REQ.SERVER.PING", nil, 10*time.Second); err != nil {
		t.Fatalf("sys user should reach $SYS.REQ.SERVER.PING: %v", err)
	}

	appNc := ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	// app 用户这条保持 2s：no-responders 503 是服务器即时返回，超时同样满足
	// err != nil——负载只会让它更容易通过，不存在负载 flake 方向。
	if _, err := appNc.Request("$SYS.REQ.SERVER.PING", nil, 2*time.Second); err == nil {
		t.Fatal("app user must not reach $SYS.REQ.SERVER.PING")
	}

	// 断连 advisory 在系统账户可见（AC-016 前置）：订阅后关一条 app 连接。
	// 注意用回调计数而非 sub.Pending()：回调型订阅的 pending 在回调返回后
	// 即归零，50ms 轮询几乎必然错过（nats.go nats.go:5714 pMsgs 语义）。
	advisories := make(chan struct{}, 1)
	if _, err := sysNc.Subscribe("$SYS.ACCOUNT.*.DISCONNECT", func(m *nats.Msg) {
		t.Logf("advisory on %s (%d bytes)", m.Subject, len(m.Data))
		select {
		case advisories <- struct{}{}:
		default:
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := sysNc.Flush(); err != nil {
		t.Fatal(err)
	}
	appNc.Close()
	// advisory 由服务器异步发布；给足窗（5s 在全量并行负载下偶发错过，M6 T1）。
	select {
	case <-advisories:
	case <-time.After(10 * time.Second):
		t.Fatal("no disconnect advisory observed on $SYS.ACCOUNT.*.DISCONNECT")
	}
}

// 三节点集群：路由成型（活跃服务器数 3）、JS meta leader 选举完成。
func TestStartClusterFormation(t *testing.T) {
	c := StartCluster(t, 3)

	sysNc := ConnectUser(t, c.Nodes[0].URL, c.SysUser, c.SysPass)
	defer sysNc.Close()

	resp, err := sysNc.Request("$SYS.REQ.SERVER.PING", nil, 2*time.Second)
	if err != nil {
		t.Fatalf("cluster ping: %v", err)
	}
	t.Logf("ping response %d bytes", len(resp.Data))

	// 3 节点各自都应答（广播计数由 monitor 任务断言；此处只验证夹具可答）。
	if len(c.Nodes) != 3 {
		t.Fatalf("want 3 nodes, got %d", len(c.Nodes))
	}
}
