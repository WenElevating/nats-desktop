package monitor

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// newJsm 直接 jsm.New(nc)（默认域/前缀——测试连的就是本进程内集群）。
func newJsm(t *testing.T, nc *nats.Conn) *jsm.Manager {
	t.Helper()
	mgr, err := jsm.New(nc)
	if err != nil {
		t.Fatal(err)
	}
	return mgr
}

// domainStub 实现三方法 connSource；JSParams() 返回 ("A","",true) 模拟
// 带 JS 域的上下文（meta 危险操作必须被域守卫拒绝，Global 8）。
type domainStub struct {
	nc     *nats.Conn
	domain string
}

func (c domainStub) Conn() *nats.Conn                 { return c.nc }
func (c domainStub) JSParams() (string, string, bool) { return c.domain, "", true }
func (c domainStub) JSEventPrefix() string            { return "" }

func TestMetaStepDownElectsNewLeader(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.SysUser, c.SysPass)
	s, _ := newService(t, nc)

	res := s.MetaStepDown()
	if !res.Ok() {
		t.Fatalf("step-down: %+v", res)
	}
	if res.OldLeader == "" {
		t.Fatalf("old leader required: %+v", res)
	}
	// 新 leader 未必 5s 内观测到（Note 半边），但快照最终必须换人。
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		snap := s.collectSnapshot()
		var leader string
		for _, r := range snap.Servers {
			if r.JsRole == "meta_leader" {
				leader = r.Name
			}
		}
		if leader != "" && leader != res.OldLeader {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatal("no new meta leader elected within 15s")
}

func TestMetaStepDownSingleFlightConflict(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.SysUser, c.SysPass)
	s, _ := newService(t, nc)

	var wg sync.WaitGroup
	codes := make([]string, 2)
	for i := range 2 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = s.MetaStepDown().ErrorCode
		}(i)
	}
	wg.Wait()
	// 一个成功（或 note 超时仍 Ok）、另一个 conflict——不允许双执行。
	sawConflict, sawOther := false, false
	for _, c := range codes {
		if c == CodeConflict {
			sawConflict = true
		} else if c == CodeOK {
			sawOther = true
		}
	}
	if !sawConflict || !sawOther {
		t.Fatalf("want one ok + one conflict, got %v", codes)
	}
}

func TestStreamStepDownAndBalance(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.AppUser, c.AppPass)
	s, _ := newService(t, nc)

	mgr := newJsm(t, nc)
	if _, err := mgr.NewStream("OPS_R3", jsm.Replicas(3)); err != nil {
		t.Fatalf("R3 stream: %v", err)
	}

	res := s.StreamStepDown("OPS_R3")
	if !res.Ok() {
		t.Fatalf("stream step-down: %+v", res)
	}
	// 单流 R3 在 3 节点上本就均衡（balancer 数学：1 流/3 节点 → offset=0
	// → 不动任何 leader），BalanceStreams 返回 0——只断言 Ok 并记录数值；
	// 「不均衡才迁移」的数值断言留给真实集群 UIA 冒烟（Task 14）。
	res = s.StreamBalance("OPS_R3")
	if !res.Ok() {
		t.Fatalf("balance: %+v", res)
	}
	t.Logf("balanced %d streams (single balanced stream is a no-op by design)", res.StreamsBalanced)
	if res := s.StreamStepDown("NOPE"); res.ErrorCode != CodeNotFound {
		t.Fatalf("missing stream: %+v", res)
	}
}

// peer-remove 破坏夹具：放在独立子测试最后执行（顺序内 last）。
func TestStreamPeerRemove(t *testing.T) {
	// 4 节点（其余用例 3）：nats-server v2.15 的 peer-remove 带 requireReplicas
	// 语义——移除 R3 副本时要求立刻补位，3 节点全在组内、被移除者又从候选剔除，
	// 无位可补 → 10075 peer remap failed。第 4 节点提供补位候选，删除才能成功。
	c := testutil.StartCluster(t, 4)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.AppUser, c.AppPass)
	s, _ := newService(t, nc)

	mgr := newJsm(t, nc)
	st, err := mgr.NewStream("OPS_PR", jsm.Replicas(3))
	if err != nil {
		t.Fatal(err)
	}
	info, err := st.Information()
	if err != nil {
		t.Fatal(err)
	}
	if info.Cluster == nil || len(info.Cluster.Replicas) == 0 {
		t.Fatal("stream not clustered")
	}
	peer := info.Cluster.Replicas[0].Name

	res := s.StreamPeerRemove("OPS_PR", peer)
	if !res.Ok() {
		t.Fatalf("peer remove: %+v", res)
	}
	// 移除后流仍可用（信息可查）。
	if _, err := st.Information(); err != nil {
		t.Fatalf("stream info after remove: %v", err)
	}
}

func TestMetaOpsDomainGuard(t *testing.T) {
	c := testutil.StartCluster(t, 3)
	nc := testutil.ConnectUser(t, c.Nodes[0].URL, c.SysUser, c.SysPass)
	s := NewMonitorService(domainStub{nc, "A"}, nil, func(string, any) {}, "")
	res := s.MetaStepDown()
	if res.ErrorCode != CodeValidation || !strings.Contains(res.Error, "system account") {
		t.Fatalf("guard: %+v", res)
	}
}
