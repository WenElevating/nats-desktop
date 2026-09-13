package messaging

import (
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// 集群 route hop：在 S1 发布、S3 订阅，trace 树应出现 egress(S1) ->
// ingress(S2) -> ... 的跨服务器链（M2 遗留第 3 条 route-hop 半边）。
func TestTraceClusterRouteHop(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc1 := testutil.ConnectUser(t, c.Nodes[0].URL, c.AppUser, c.AppPass)
	nc3 := testutil.ConnectUser(t, c.Nodes[2].URL, c.AppUser, c.AppPass)

	sub, err := nc3.Subscribe("cluster.trace.subject", func(m *nats.Msg) {})
	if err != nil {
		t.Fatal(err)
	}
	if err := nc3.Flush(); err != nil {
		t.Fatal(err)
	}
	// 等订阅兴趣经路由传播到发布节点（S1）：向 S1 请求对端是否已见该 subject
	// 没有廉价探针，用固定窗（内嵌集群路由订阅广播在毫秒级，500ms 富余）。
	time.Sleep(500 * time.Millisecond)

	hop, err := Trace(nc1, TraceForm{Subject: "cluster.trace.subject", Payload: []byte("x"), Deliver: true, TimeoutMs: 5000})
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	if !strings.Contains(hop.Detail, `server:"S1"`) {
		t.Fatalf("root should be S1 ingress, got %q", hop.Detail)
	}
	// 树中必须出现另一台服务器的 hop（egress -> 远端 ingress 链）。
	if !containsServer(hop, "S2") && !containsServer(hop, "S3") {
		t.Fatalf("expected a remote-server hop in tree: %+v", hop)
	}
	_ = sub
}

func containsServer(h TraceHop, name string) bool {
	if strings.Contains(h.Detail, `server:"`+name+`"`) {
		return true
	}
	for _, c := range h.Children {
		if containsServer(c, name) {
			return true
		}
	}
	return false
}

// 账户 subject mapping hop：APP 账户加映射 src->dst，trace 树应含
// Kind=="mapping" 的子节点（M2 遗留 mapping 半边；service_import/
// stream_export 见验收裁定记录）。
func TestTraceClusterMappingHop(t *testing.T) {
	f := testutil.StartSysServer(t)
	if err := f.AppAcc.AddMapping("trace.map.src", "trace.map.dst"); err != nil {
		t.Fatalf("add mapping: %v", err)
	}
	nc := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)

	sub, err := nc.Subscribe("trace.map.dst", func(m *nats.Msg) {})
	if err != nil {
		t.Fatal(err)
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)

	hop, err := Trace(nc, TraceForm{Subject: "trace.map.src", Payload: []byte("x"), Deliver: true, TimeoutMs: 5000})
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	if !hasKind(hop, "mapping") {
		t.Fatalf("expected mapping hop, tree: %+v", hop)
	}
	_ = sub
}

func hasKind(h TraceHop, kind string) bool {
	if h.Kind == kind {
		return true
	}
	for _, c := range h.Children {
		if hasKind(c, kind) {
			return true
		}
	}
	return false
}

// 无兴趣主题：ingress 服务器仍立即回 trace 事件（0 hop 也回），返回部分树
// 且不报错——验证「无订阅者 → 树可返回」半边。真正的 ErrTimeout-部分-结果
// 路径需要多跳兴趣 + 远端停摆，无法确定性构造，转 M6 手测矩阵项（验收记录
// 登记；本测试改名以免声称测了超时）。
func TestTraceClusterNoInterestReturnsTree(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.AppUser, c.AppPass)

	hop, err := Trace(nc, TraceForm{Subject: "no.interest.anywhere", Payload: []byte("x"), Deliver: true, TimeoutMs: 300})
	if err != nil {
		t.Fatalf("no-interest trace must return the ingress tree: %v", err)
	}
	if hop.Kind != "ingress" {
		t.Fatalf("expected ingress root, got %+v", hop)
	}
}
