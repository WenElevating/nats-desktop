// Package monitor implements the server/cluster monitoring surface: live
// snapshot polling, connection/account listings, system event watches, and
// cluster operations (M5).
package monitor

// CallResult 与 jsadmin 同构（M4 裁定：包内私有重声明，零 churn）。
type CallResult struct {
	ErrorCode string `json:"error_code"`
	Error     string `json:"error"`
}

func (r CallResult) Ok() bool { return r.ErrorCode == CodeOK }

const (
	CodeOK           = ""
	CodeNotConnected = "not_connected"
	CodeNotFound     = "not_found"
	CodeValidation   = "validation"
	CodeServer       = "server"
	CodeCancelled    = "cancelled"
	CodeConflict     = "conflict"
)

func fail(code, msg string) CallResult { return CallResult{ErrorCode: code, Error: msg} }

// MonitorServerRow 是服务器表一行（statsz + jsz 合并；Global 12 角色映射）。
type MonitorServerRow struct {
	Name             string  `json:"name"`
	ID               string  `json:"id"`
	Host             string  `json:"host"`
	Cluster          string  `json:"cluster"`
	Domain           string  `json:"domain"`
	Version          string  `json:"version"`
	Online           bool    `json:"online"`
	OfflineSinceMs   int64   `json:"offline_since_ms"`
	UptimeSeconds    int64   `json:"uptime_seconds"`
	Cpu              float64 `json:"cpu"`
	MemBytes         int64   `json:"mem_bytes"`
	Cores            int     `json:"cores"`
	Connections      int     `json:"connections"`
	TotalConnections uint64  `json:"total_connections"`
	Routes           int     `json:"routes"`
	Gateways         int     `json:"gateways"`
	ActiveAccounts   int     `json:"active_accounts"`
	SlowConsumers    int64   `json:"slow_consumers"`
	JsEnabled        bool    `json:"js_enabled"`
	JsRole           string  `json:"js_role"` // ""|disabled|meta_leader|voter
	JsStreams        int     `json:"js_streams"`
	JsStreamsLeader  int     `json:"js_streams_leader"`
	JsConsumers      int     `json:"js_consumers"`
	JsMemoryBytes    uint64  `json:"js_memory_bytes"`
	JsStoreBytes     uint64  `json:"js_store_bytes"`
	JsMaxMemoryBytes int64   `json:"js_max_memory_bytes"`
	JsMaxStoreBytes  int64   `json:"js_max_store_bytes"`
	Error            string  `json:"error"` // 离线行显示的最近失败原因
}

// MonitorSnapshot 是 monitor:snapshot 事件与 GetMonitoringSnapshot 的载荷。
type MonitorSnapshot struct {
	Servers             []MonitorServerRow `json:"servers"`
	SysAvailable        bool               `json:"sys_available"`
	SysReason           string             `json:"sys_reason"`
	PolledAtMs          int64              `json:"polled_at_ms"`
	CycleMs             int64              `json:"cycle_ms"`
	RttMs               int64              `json:"rtt_ms"`
	PollIntervalSeconds int                `json:"poll_interval_seconds"`
}

// ServerDetailResult / GetServerDetail：varz + healthz 定向报表。
type ServerDetail struct {
	Row          MonitorServerRow `json:"row"`
	StartMs      int64            `json:"start_ms"`
	LeafNodes    int              `json:"leaf_nodes"`
	NumSubs      uint32           `json:"num_subs"`
	SentMsgs     uint64           `json:"sent_msgs"`
	SentBytes    uint64           `json:"sent_bytes"`
	RecvMsgs     uint64           `json:"recv_msgs"`
	RecvBytes    uint64           `json:"recv_bytes"`
	HealthStatus string           `json:"health_status"` // ""=未知/无权限
	HealthError  string           `json:"health_error"`
	HealthDetail string           `json:"health_detail"`
}

type ServerDetailResult struct {
	CallResult
	Detail *ServerDetail `json:"detail"`
}

// ConnRow / ConnPageResult：top 式连接明细（ConnInfo 裁剪——JWT/证书字段
// 不上 wire，Global 9 的 wire 半边）。
type ConnRow struct {
	Cid      uint64 `json:"cid"`
	Kind     string `json:"kind"`
	Ip       string `json:"ip"`
	Port     int    `json:"port"`
	Account  string `json:"account"`
	User     string `json:"user"`
	Name     string `json:"name"`
	Lang     string `json:"lang"`
	Version  string `json:"version"`
	StartMs  int64  `json:"start_ms"`
	Uptime   string `json:"uptime"`
	Idle     string `json:"idle"`
	Rtt      string `json:"rtt"`
	InMsgs   int64  `json:"in_msgs"`
	OutMsgs  int64  `json:"out_msgs"`
	InBytes  int64  `json:"in_bytes"`
	OutBytes int64  `json:"out_bytes"`
	NumSubs  uint32 `json:"num_subs"`
	Pending  int    `json:"pending"`
}

type ConnPageResult struct {
	CallResult
	Rows   []ConnRow `json:"rows"`
	Offset int       `json:"offset"`
	Limit  int       `json:"limit"`
	Total  int       `json:"total"`
}

// AccountRow：账户信息与统计（serverdata.CollectAccounts 聚合结果）。
type AccountRow struct {
	Name                string   `json:"name"`
	Id                  string   `json:"id"`
	Streams             int      `json:"streams"`
	Consumers           int      `json:"consumers"`
	MemoryBytes         uint64   `json:"memory_bytes"`
	StoreBytes          uint64   `json:"store_bytes"`
	ReservedMemoryBytes uint64   `json:"reserved_memory_bytes"`
	ReservedStoreBytes  uint64   `json:"reserved_store_bytes"`
	StreamNames         []string `json:"stream_names"`
}

type AccountListResult struct {
	CallResult
	Accounts []AccountRow `json:"accounts"`
}

// SysEvent：事件流行（载荷摘要化——原文不入 wire 不入日志，Global 9）。
type SysEvent struct {
	Seq           uint64 `json:"seq"`
	Subject       string `json:"subject"`
	Type          string `json:"type"` // io.nats.* schema type 或 ""
	OccurredMs    int64  `json:"occurred_ms"`
	ServerName    string `json:"server_name"`
	ServerCluster string `json:"server_cluster"`
	Account       string `json:"account"`
	Summary       string `json:"summary"`
	SizeBytes     int    `json:"size_bytes"`
}

// CreateSysWatchResult：单结构体返回（Global 19）。
type CreateSysWatchResult struct {
	CallResult
	WatchId string `json:"watch_id"`
}

// SysWatchEvent：sys:event 事件载荷；dropped/filtered 分开计数（Global 5/10）。
type SysWatchEvent struct {
	WatchId       string   `json:"watch_id"`
	Event         SysEvent `json:"event"`
	DroppedTotal  uint64   `json:"dropped_total"`
	FilteredTotal uint64   `json:"filtered_total"`
}

// ClusterOpResult：危险操作统一结果。
type ClusterOpResult struct {
	CallResult
	OldLeader       string `json:"old_leader"`
	NewLeader       string `json:"new_leader"`
	StreamsBalanced int    `json:"streams_balanced"`
	Note            string `json:"note"` // 如 "new leader not observed within 5s"
	ElapsedMs       int64  `json:"elapsed_ms"`
}
