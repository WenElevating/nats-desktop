package monitor

import (
	"context"
	"time"

	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/jsm.go/serverdata"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// newLive 构造一个自适应等待的 Live 数据源（waitFor=0：首响应最多等
// timeout、其后 300ms 静默即止）。Task 8 的 leader 解析复用此助手
// （超时取调用方给定值而非快照的固定 2s）。logger 用 api.NewDiscardLogger()
// ——DoReq 全程调 log.Debugf，nil 会 panic（勿传 nil；也不 import testutil）。
func (s *MonitorService) newLive(nc *nats.Conn, timeout time.Duration) (*serverdata.Live, error) {
	reqFn := func(req any, subj string, waitFor int, nc *nats.Conn) ([][]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		return serverdata.DoReq(ctx, req, subj, waitFor, nc, timeout, api.NewDiscardLogger())
	}
	return serverdata.NewLive(nc, reqFn, 0)
}

// collectSnapshot 执行一轮全量采集：statsz 出服务器表、jsz 补 JS 角色/配额。
// 失败降级为 SysAvailable=false + 原文 reason（§8.3.1），绝不 panic。
func (s *MonitorService) collectSnapshot() MonitorSnapshot {
	start := time.Now()
	// Servers 初始化为非 nil 空 slice：降级早退路径的 JSON 恒为 "servers":[]
	// 而非 null（终审 I-1——前端 schema 容忍 null，但事件线发送规范形状）。
	snap := MonitorSnapshot{
		SysAvailable:        true,
		Servers:             []MonitorServerRow{},
		PolledAtMs:          start.UnixMilli(),
		PollIntervalSeconds: int(s.interval().Seconds()),
	}

	nc := s.mgr.Conn()
	if nc == nil || !nc.IsConnected() {
		snap.SysAvailable = false
		snap.SysReason = "not connected"
		return snap
	}
	if rtt, err := nc.RTT(); err == nil {
		snap.RttMs = rtt.Milliseconds()
	}

	live, err := s.newLive(nc, snapshotTimeout) // waitFor=0 自适应（2s+300ms 静默）
	if err != nil {
		snap.SysAvailable = false
		snap.SysReason = err.Error()
		return snap
	}
	statsz, err := live.Statz(server.StatszEventOptions{})
	if err != nil {
		// 无响应者/无权限 → §8.3.1 降级（DoReq 原文含 system privileges 提示）。
		snap.SysAvailable = false
		snap.SysReason = err.Error()
		return snap
	}
	jsz, jszErr := live.Jsz(server.JszEventOptions{}) // 失败容忍：JS 角色列退化
	_ = jszErr

	now := time.Now()
	rows := mergeStatszJsz(statsz, jsz, now)

	// 已知集合 diff：本周期未应答的已知服务器保留原行并标红（Global 2）。
	s.runMu.Lock()
	for name, prev := range s.known {
		if _, ok := rowByName(rows, name); !ok {
			prev.Online = false
			if prev.OfflineSinceMs == 0 {
				prev.OfflineSinceMs = now.UnixMilli()
			}
			if prev.Error == "" {
				prev.Error = "no response within 2s"
			}
			rows = append(rows, prev)
		}
	}
	newKnown := map[string]MonitorServerRow{}
	for _, r := range rows {
		newKnown[r.Name] = r
	}
	s.known = newKnown
	s.runMu.Unlock()

	snap.Servers = rows
	snap.CycleMs = time.Since(start).Milliseconds()
	// 只记聚合计数，不记载荷与凭据（§13.3）。
	s.log.Info("monitor snapshot", "servers", len(rows), "cycle_ms", snap.CycleMs)
	return snap
}

// mergeStatszJsz 把 statsz 应答折叠成 MonitorServerRow，再按服务器名对齐合并
// jsz 的 JetStream 元数据（纯函数，独立可测；Global 12 角色映射）。
func mergeStatszJsz(statsz []*server.ServerStatsMsg, jsz []*server.ServerAPIJszResponse, now time.Time) []MonitorServerRow {
	jsInfo := make(map[string]*server.JSInfo, len(jsz))
	for _, resp := range jsz {
		if resp == nil || resp.Server == nil || resp.Data == nil || resp.Server.Name == "" {
			continue
		}
		jsInfo[resp.Server.Name] = resp.Data
	}

	rows := make([]MonitorServerRow, 0, len(statsz))
	for _, st := range statsz {
		if st == nil {
			continue
		}
		row := MonitorServerRow{
			Name:             st.Server.Name,
			ID:               st.Server.ID,
			Host:             st.Server.Host,
			Cluster:          st.Server.Cluster,
			Domain:           st.Server.Domain,
			Version:          st.Server.Version,
			Online:           true,
			UptimeSeconds:    int64(now.Sub(st.Stats.Start).Seconds()),
			Cpu:              st.Stats.CPU,
			MemBytes:         st.Stats.Mem,
			Cores:            st.Stats.Cores,
			Connections:      st.Stats.Connections,
			TotalConnections: st.Stats.TotalConnections,
			Routes:           len(st.Stats.Routes),
			Gateways:         len(st.Stats.Gateways),
			ActiveAccounts:   st.Stats.ActiveAccounts,
			SlowConsumers:    st.Stats.SlowConsumers,
			JsEnabled:        st.Server.JetStreamEnabled(),
		}
		if info, ok := jsInfo[row.Name]; ok {
			row.JsRole = jsRole(info, row.Name)
			row.JsStreams = info.Streams
			row.JsStreamsLeader = info.StreamsLeader
			row.JsConsumers = info.Consumers
			row.JsMemoryBytes = info.JetStreamStats.Memory
			row.JsStoreBytes = info.JetStreamStats.Store
			row.JsMaxMemoryBytes = info.Config.MaxMemory
			row.JsMaxStoreBytes = info.Config.MaxStore
		}
		rows = append(rows, row)
	}
	return rows
}

// jsRole 映射 jsz 元集群信息到展示角色（Global 12）：
// disabled → "disabled"；元 leader → "meta_leader"；其余投票成员 → "voter"；
// 无元集群信息（单点）→ ""。
func jsRole(info *server.JSInfo, serverName string) string {
	if info.Disabled {
		return "disabled"
	}
	if info.Meta == nil {
		return ""
	}
	if info.Meta.Leader == serverName {
		return "meta_leader"
	}
	return "voter"
}

// rowByName 在服务器表里线性查名（表 ≤ 百级，无需索引）。
func rowByName(rows []MonitorServerRow, name string) (MonitorServerRow, bool) {
	for _, r := range rows {
		if r.Name == name {
			return r, true
		}
	}
	return MonitorServerRow{}, false
}
