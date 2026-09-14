package monitor

import (
	"errors"
	"fmt"
	"time"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/jsm.go/balancer"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/jsctx"
)

// clusterops.go 实现集群危险操作（Task 8）：meta step-down / meta peer-remove
// / stream step-down / stream peer-remove / stream balance。natscli 语义对齐：
//   - meta 操作（step-down/peer-remove）在上下文带 JS domain/apiPrefix 时拒绝
//     （Global 8），实际请求一律显式无域发送（jsctx.NewManager(nc, "", "", t)）；
//   - stream 操作域感知：jsm 句柄由 JSParams 的 domain/prefix 构建（同 jsadmin
//     handles()）；
//   - 单飞 key=op+"\x00"+target（Global 6），重复触发 → CodeConflict
//     "operation in progress"；
//   - 全部操作经 runClusterOp：defer endOp + recover（Global 20）+ 耗时统计。

// leaderPollInterval / leaderPollCount 是新 leader 观测窗口（≤5s）：natscli
// 同款 500ms 轮询；观测不到不算失败——选举可能慢于窗口（Note 半边），快照侧
// 最终会看到换人。
const (
	leaderPollInterval = 500 * time.Millisecond
	leaderPollCount    = 10
)

// beginOp 把 op+target 登记进在途集合；已在途返回 false（调用方译为
// CodeConflict）。opsInFlight 懒初始化，零值 MonitorService 亦安全。
func (s *MonitorService) beginOp(op, target string) bool {
	s.opsMu.Lock()
	defer s.opsMu.Unlock()
	key := op + "\x00" + target
	if s.opsInFlight[key] {
		return false
	}
	if s.opsInFlight == nil {
		s.opsInFlight = map[string]bool{}
	}
	s.opsInFlight[key] = true
	return true
}

func (s *MonitorService) endOp(op, target string) {
	s.opsMu.Lock()
	defer s.opsMu.Unlock()
	delete(s.opsInFlight, op+"\x00"+target)
}

// runClusterOp 是全部危险操作的统一外壳：单飞登记（Global 6）→ panic 兜底
// （Global 20，绝不带飞进程）→ 耗时统计。日志只记 op/target/code/耗时与
// leader 名（服务器名，允许），不含凭据与载荷（§13.3）。单飞冲突路径也补
// Warn（⑫：否则该拒绝在日志里完全不可见）——同样只记 op/target。
func (s *MonitorService) runClusterOp(op, target string, fn func() ClusterOpResult) (res ClusterOpResult) {
	start := time.Now()
	if !s.beginOp(op, target) {
		s.log.Warn("cluster op rejected: in progress", "op", op, "target", target)
		return ClusterOpResult{CallResult: fail(CodeConflict, "operation in progress")}
	}
	defer s.endOp(op, target)
	defer func() {
		if r := recover(); r != nil {
			s.log.Error("cluster op panic recovered", "op", op, "target", target, "panic", r)
			res = ClusterOpResult{CallResult: fail(CodeServer, fmt.Sprintf("internal error: %v", r))}
		}
		res.ElapsedMs = time.Since(start).Milliseconds()
		s.log.Info("cluster op completed", "op", op, "target", target, "code", res.ErrorCode, "elapsed_ms", res.ElapsedMs)
	}()
	return fn()
}

// metaDomainGuard（Global 8，natscli 同款文案）：meta step-down/peer-remove
// 在上下文带 JS domain 或 apiPrefix 时拒绝——meta/系统账户操作与域无关。
func (s *MonitorService) metaDomainGuard(op string) CallResult {
	domain, prefix, ok := s.mgr.JSParams()
	if !ok {
		return fail(CodeNotConnected, "not connected")
	}
	if domain != "" || prefix != "" {
		return fail(CodeValidation, fmt.Sprintf("the --js-domain option cannot be used with %s: JetStream domains do not apply to the system account, connect without a domain configured", op))
	}
	return CallResult{}
}

// opConn 校验活动连接（jsadmin resolveConn 的 monitor 侧同款）。
func (s *MonitorService) opConn() (*nats.Conn, CallResult) {
	nc := s.mgr.Conn()
	if nc == nil || !nc.IsConnected() {
		return nil, fail(CodeNotConnected, "not connected")
	}
	return nc, CallResult{}
}

// streamManager 构建域感知 jsm 句柄（同 jsadmin handles()，jsctx.NewManager
// 带上 JSParams 的 domain/prefix）。
func (s *MonitorService) streamManager(nc *nats.Conn) (*jsm.Manager, CallResult) {
	domain, prefix, ok := s.mgr.JSParams()
	if !ok {
		return nil, fail(CodeNotConnected, "not connected")
	}
	mgr, err := jsctx.NewManager(nc, domain, prefix, s.timeout())
	if err != nil {
		return nil, fail(CodeServer, err.Error())
	}
	return mgr, CallResult{}
}

// classifyOpError 把 jsm API 失败映射到封闭错误码集：服务器 404（流不存在、
// peer 不在组内）→ not_found，其余沿用 ClassifyMonitorError（原文透传，
// Global 4）。
func classifyOpError(err error) CallResult {
	var ae api.ApiError
	if errors.As(err, &ae) && ae.NotFoundError() {
		return fail(CodeNotFound, ae.Error())
	}
	return ClassifyMonitorError(err)
}

// resolveMetaLeader 广播 jsz 找唯一 meta leader（natscli metaLeaderStandDownAction
// 同款）：只认「应答者自身就是 meta leader」的应答（Server.Name == Meta.Leader），
// 0 个 → 文案含 system privileges 提示，>1 个 → 无法确定目标集群。
func (s *MonitorService) resolveMetaLeader(nc *nats.Conn) (leader string, jsi *server.JSInfo, err error) {
	live, err := s.newLive(nc, s.timeout())
	if err != nil {
		return "", nil, err
	}
	resps, err := live.Jsz(server.JszEventOptions{})
	if err != nil {
		return "", nil, err
	}
	var leaders []*server.ServerAPIJszResponse
	for _, jr := range resps {
		if jr.Data == nil || jr.Data.Meta == nil || jr.Server == nil || jr.Server.Name != jr.Data.Meta.Leader {
			continue
		}
		leaders = append(leaders, jr)
	}
	switch len(leaders) {
	case 0:
		return "", nil, fmt.Errorf("did not receive a response from the meta leader, ensure the account used has system privileges and appropriate permissions")
	case 1:
		return leaders[0].Data.Meta.Leader, leaders[0].Data, nil
	default:
		return "", nil, fmt.Errorf("found %d JetStream meta cluster leaders, unable to determine which cluster to act on", len(leaders))
	}
}

// awaitNewMetaLeader 轮询 ≤leaderPollCount×leaderPollInterval 观察新 meta
// leader；窗口内没观察到不改判失败（Ok + Note）——选举最终由快照证实。
func (s *MonitorService) awaitNewMetaLeader(nc *nats.Conn, old string) (newLeader, note string) {
	for i := 0; i < leaderPollCount; i++ {
		time.Sleep(leaderPollInterval)
		leader, _, err := s.resolveMetaLeader(nc)
		if err != nil || leader == "" {
			continue
		}
		if leader != old {
			return leader, ""
		}
	}
	return "", "new leader not observed within 5s"
}

// awaitNewStreamLeader 同 awaitNewMetaLeader，改走流信息（Information 每次
// 重取，Leader 即时）。
func (s *MonitorService) awaitNewStreamLeader(st *jsm.Stream, old string) (newLeader, note string) {
	for i := 0; i < leaderPollCount; i++ {
		time.Sleep(leaderPollInterval)
		info, err := st.Information()
		if err != nil || info.Cluster == nil {
			continue
		}
		if leader := info.Cluster.Leader; leader != "" && leader != old {
			return leader, ""
		}
	}
	return "", "new leader not observed within 5s"
}

// MetaStepDown 元集群 leader step-down：域守卫 → resolveMetaLeader → 显式
// 无域 manager（natscli parity）→ MetaLeaderStandDown(nil) → 轮询新 leader。
func (s *MonitorService) MetaStepDown() ClusterOpResult {
	if res := s.metaDomainGuard("step-down"); !res.Ok() {
		return ClusterOpResult{CallResult: res}
	}
	return s.runClusterOp("meta_stepdown", "", func() ClusterOpResult {
		nc, res := s.opConn()
		if !res.Ok() {
			return ClusterOpResult{CallResult: res}
		}
		old, _, err := s.resolveMetaLeader(nc)
		if err != nil {
			return ClusterOpResult{CallResult: ClassifyMonitorError(err)}
		}
		mgr, err := jsctx.NewManager(nc, "", "", s.timeout())
		if err != nil {
			return ClusterOpResult{OldLeader: old, CallResult: fail(CodeServer, err.Error())}
		}
		if err := mgr.MetaLeaderStandDown(nil); err != nil {
			return ClusterOpResult{OldLeader: old, CallResult: ClassifyMonitorError(err)}
		}
		newLeader, note := s.awaitNewMetaLeader(nc, old)
		return ClusterOpResult{OldLeader: old, NewLeader: newLeader, Note: note}
	})
}

// MetaPeerRemove 从元集群移除 peer：resolveMetaLeader 的 jsz 里解析副本——
// r.Name == peer || r.Peer == peer（natscli 同款）；id 已知时按 id 移除
// （服务端 id 寻址最精确），否则按名。找不到 → not_found。
func (s *MonitorService) MetaPeerRemove(peer string) ClusterOpResult {
	if res := s.metaDomainGuard("peer-remove"); !res.Ok() {
		return ClusterOpResult{CallResult: res}
	}
	return s.runClusterOp("meta_peer_remove", peer, func() ClusterOpResult {
		nc, res := s.opConn()
		if !res.Ok() {
			return ClusterOpResult{CallResult: res}
		}
		old, jsi, err := s.resolveMetaLeader(nc)
		if err != nil {
			return ClusterOpResult{CallResult: ClassifyMonitorError(err)}
		}
		var name, id string
		for _, r := range jsi.Meta.Replicas {
			if r != nil && (r.Name == peer || r.Peer == peer) {
				name, id = r.Name, r.Peer
				break
			}
		}
		if name == "" && id == "" {
			return ClusterOpResult{OldLeader: old, CallResult: fail(CodeNotFound, fmt.Sprintf("did not find a replica named %s to remove", peer))}
		}
		mgr, err := jsctx.NewManager(nc, "", "", s.timeout())
		if err != nil {
			return ClusterOpResult{CallResult: fail(CodeServer, err.Error())}
		}
		if id != "" {
			err = mgr.MetaPeerRemove("", id)
		} else {
			err = mgr.MetaPeerRemove(name, id)
		}
		if err != nil {
			return ClusterOpResult{OldLeader: old, CallResult: ClassifyMonitorError(err)}
		}
		return ClusterOpResult{OldLeader: old, Note: fmt.Sprintf("removed %s", peer)}
	})
}

// StreamStepDown 流 leader step-down：域感知句柄 → LoadStream → 未集群拒绝
// → LeaderStepDown() → 轮询新 leader。
func (s *MonitorService) StreamStepDown(stream string) ClusterOpResult {
	return s.runClusterOp("stream_stepdown", stream, func() ClusterOpResult {
		nc, res := s.opConn()
		if !res.Ok() {
			return ClusterOpResult{CallResult: res}
		}
		mgr, res := s.streamManager(nc)
		if !res.Ok() {
			return ClusterOpResult{CallResult: res}
		}
		st, err := mgr.LoadStream(stream)
		if err != nil {
			return ClusterOpResult{CallResult: classifyOpError(err)}
		}
		info, err := st.Information()
		if err != nil {
			return ClusterOpResult{CallResult: ClassifyMonitorError(err)}
		}
		if info.Cluster == nil || len(info.Cluster.Replicas) == 0 {
			return ClusterOpResult{CallResult: fail(CodeValidation, fmt.Sprintf("stream %q is not clustered", stream))}
		}
		old := info.Cluster.Leader
		if err := st.LeaderStepDown(); err != nil {
			return ClusterOpResult{OldLeader: old, CallResult: ClassifyMonitorError(err)}
		}
		newLeader, note := s.awaitNewStreamLeader(st, old)
		return ClusterOpResult{OldLeader: old, NewLeader: newLeader, Note: note}
	})
}

// StreamPeerRemove 从流 RAFT 组移除副本（LoadStream → RemoveRAFTPeer）。
// 单飞 target 取流名：同一流的副本移除串行（RAFT 组收敛期间叠加移除有风险）。
func (s *MonitorService) StreamPeerRemove(stream, peer string) ClusterOpResult {
	return s.runClusterOp("stream_peer_remove", stream, func() ClusterOpResult {
		nc, res := s.opConn()
		if !res.Ok() {
			return ClusterOpResult{CallResult: res}
		}
		mgr, res := s.streamManager(nc)
		if !res.Ok() {
			return ClusterOpResult{CallResult: res}
		}
		st, err := mgr.LoadStream(stream)
		if err != nil {
			return ClusterOpResult{CallResult: classifyOpError(err)}
		}
		if err := st.RemoveRAFTPeer(peer); err != nil {
			return ClusterOpResult{CallResult: ClassifyMonitorError(err)}
		}
		return ClusterOpResult{Note: fmt.Sprintf("removed %s from %s", peer, stream)}
	})
}

// StreamBalance 用 jsm.go/balancer 平衡流 leader 分布。logger 用官方
// api.NewDiscardLogger()——api.Logger 是五方法接口（Tracef/Debugf/Infof/
// Warnf/Errorf），不手写适配器；balancer 内部细节不外泄，结果只记数量。
func (s *MonitorService) StreamBalance(stream string) ClusterOpResult {
	return s.runClusterOp("stream_balance", stream, func() ClusterOpResult {
		nc, res := s.opConn()
		if !res.Ok() {
			return ClusterOpResult{CallResult: res}
		}
		mgr, res := s.streamManager(nc)
		if !res.Ok() {
			return ClusterOpResult{CallResult: res}
		}
		st, err := mgr.LoadStream(stream)
		if err != nil {
			return ClusterOpResult{CallResult: classifyOpError(err)}
		}
		b, err := balancer.New(nc, api.NewDiscardLogger())
		if err != nil {
			return ClusterOpResult{CallResult: fail(CodeServer, err.Error())}
		}
		n, err := b.BalanceStreams([]*jsm.Stream{st})
		if err != nil {
			return ClusterOpResult{CallResult: ClassifyMonitorError(err)}
		}
		return ClusterOpResult{StreamsBalanced: n}
	})
}
