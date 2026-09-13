package monitor

import (
	"sort"

	"github.com/nats-io/nats-server/v2/server"
)

// accounts.go 实现账户信息与统计绑定面（Task 6）：广播 jsz（Accounts/Streams/
// Consumer 全开）聚合全服务器的账户级 JetStream 元数据，折叠成 AccountRow。
// 超时随设置（s.timeout()，与节点级报表同口径），不取快照的固定 2s。

// maxStreamNames 是单账户 StreamNames 上限（§ 巨型数组防护：几千条 stream 的
// 账户只上前 50 个名字，Streams 计数仍是全量 len）。
const maxStreamNames = 50

// ListAccounts 账户信息与统计：jsz 聚合 → AccountRow（按 Name 排序）。
// 失败降级面（§8.3.1）：无 JS/无 $SYS 权限等 CollectAccounts 失败 → Ok 结果
// + 空列表 + Error 原文（面板级降级，不 error_code 化）；连接缺失才走标准
// not_connected 路径。只记账户/stream 聚合计数（§13.3）。
func (s *MonitorService) ListAccounts() AccountListResult {
	nc := s.mgr.Conn()
	if nc == nil || !nc.IsConnected() {
		return AccountListResult{CallResult: fail(CodeNotConnected, "not connected")}
	}
	live, err := s.newLive(nc, s.timeout()) // waitFor=0 自适应
	if err != nil {
		return AccountListResult{CallResult: CallResult{Error: err.Error()}, Accounts: []AccountRow{}}
	}
	details, err := live.CollectAccounts()
	if err != nil {
		// 无权限/无 JS → 降级面板：空列表 + server 原文 reason，保持 Ok。
		return AccountListResult{CallResult: CallResult{Error: err.Error()}, Accounts: []AccountRow{}}
	}
	rows := accountRows(details)
	s.log.Info("accounts report", "accounts", len(rows), "streams", totalStreams(rows))
	return AccountListResult{Accounts: rows}
}

// accountRows 把 []*server.AccountDetail 折叠成按 Name 排序的 []AccountRow
// （纯函数，独立可测）。Consumers = 该账户全部 stream 的 Consumer 明细数之和；
// StreamNames 截前 maxStreamNames 个。CollectAccounts 已排序，此处重排是让
// 「按 Name」不变量由映射器自持，不依赖上游实现细节。
func accountRows(details []*server.AccountDetail) []AccountRow {
	rows := make([]AccountRow, 0, len(details))
	for _, d := range details {
		if d == nil {
			continue
		}
		row := AccountRow{
			Name:                d.Name,
			Id:                  d.Id,
			Streams:             len(d.Streams),
			MemoryBytes:         d.Memory,
			StoreBytes:          d.Store,
			ReservedMemoryBytes: d.ReservedMemory,
			ReservedStoreBytes:  d.ReservedStore,
			StreamNames:         make([]string, 0, min(len(d.Streams), maxStreamNames)),
		}
		for _, sd := range d.Streams {
			row.Consumers += len(sd.Consumer)
			if len(row.StreamNames) < maxStreamNames {
				row.StreamNames = append(row.StreamNames, sd.Name)
			}
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
	return rows
}

// totalStreams 汇总各行 stream 数，仅用于日志聚合计数。
func totalStreams(rows []AccountRow) int {
	n := 0
	for _, r := range rows {
		n += r.Streams
	}
	return n
}
