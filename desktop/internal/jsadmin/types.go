// Package jsadmin implements the JetStream management surface (spec
// §6.6/§6.7): streams, message browsing, consumers, backup/restore.
package jsadmin

// Error codes crossing the IPC boundary (spec §8.5.2 / §8.2.1 closed set).
const (
	CodeOK            = ""
	CodeNotConnected  = "not_connected"
	CodeJSUnavailable = "js_unavailable"
	CodeNotFound      = "not_found"
	CodeValidation    = "validation"
	CodeServer        = "server"
	CodeCancelled     = "cancelled"
)

// CallResult is embedded in every bound-call result; Ok is true iff
// ErrorCode is empty.
type CallResult struct {
	ErrorCode string `json:"error_code"`
	Error     string `json:"error"` // server原文 for server/validation errors
}

func (r CallResult) Ok() bool { return r.ErrorCode == CodeOK }

func fail(code, msg string) CallResult { return CallResult{ErrorCode: code, Error: msg} }

// UnavailableReason tokens for list endpoints (guidance panel, spec §6.6).
const (
	ReasonNoResponders = "no_responders"
	ReasonTimeout      = "timeout"
	ReasonServer       = "server"
)

type StreamSummary struct {
	Name              string   `json:"name"`
	Description       string   `json:"description"`
	InternalKind      string   `json:"internal_kind"` // "" | "kv" | "object" (KV_/O_ 前缀)
	Subjects          []string `json:"subjects"`
	Storage           string   `json:"storage"`   // file | memory
	Retention         string   `json:"retention"` // limits | interest | workqueue
	Messages          uint64   `json:"messages"`
	Bytes             uint64   `json:"bytes"`
	Consumers         int      `json:"consumers"`
	FirstSeq          uint64   `json:"first_seq"`
	LastSeq           uint64   `json:"last_seq"`
	LastTimeMs        int64    `json:"last_time_ms"`
	LostMsgs          int      `json:"lost_msgs"`
	LostBytes         uint64   `json:"lost_bytes"`
	NumDeleted        int      `json:"num_deleted"`
	IsMirror          bool     `json:"is_mirror"`
	IsSource          bool     `json:"is_source"`
	LeaderMissing     bool     `json:"leader_missing"`
	UnhealthyReplicas int      `json:"unhealthy_replicas"`
	ReplicaCount      int      `json:"replica_count"`
}

type StreamStateOut struct {
	FirstTimeMs int64  `json:"first_time_ms"`
	LastTimeMs  int64  `json:"last_time_ms"`
	NumSubjects uint64 `json:"num_subjects"`
}

type SourceInfo struct {
	Name          string `json:"name"`
	Lag           uint64 `json:"lag"`
	ActiveMs      int64  `json:"active_ms"` // -1 = 无活动（jsm 语义映射）
	FilterSubject string `json:"filter_subject"`
	OptStartSeq   uint64 `json:"opt_start_seq"`
	Error         string `json:"error,omitempty"`
}

type PeerOut struct {
	Name     string `json:"name"`
	Current  bool   `json:"current"`
	Offline  bool   `json:"offline"`
	ActiveMs int64  `json:"active_ms"`
	Lag      uint64 `json:"lag"`
}

type ClusterOut struct {
	Name          string    `json:"name"`
	RaftGroup     string    `json:"raft_group"`
	Leader        string    `json:"leader"`
	LeaderSinceMs int64     `json:"leader_since_ms"` // 0 = unknown
	Peers         []PeerOut `json:"peers"`
}

type StreamDetail struct {
	CallResult
	Summary   StreamSummary  `json:"summary"`
	Form      StreamForm     `json:"form"` // 编辑/复制的表单回显
	CreatedMs int64          `json:"created_ms"`
	State     StreamStateOut `json:"state"`
	Mirror    *SourceInfo    `json:"mirror"`
	Sources   []SourceInfo   `json:"sources"`
	Cluster   *ClusterOut    `json:"cluster"`
}

// StreamForm: 数值字段 0 = 不设置（服务器默认），-1 = 无限制（max_age_seconds 除外，仅 ≥0）。
type StreamForm struct {
	Name              string             `json:"name"`
	Description       string             `json:"description"`
	Subjects          []string           `json:"subjects"`
	Storage           string             `json:"storage"`   // file | memory
	Retention         string             `json:"retention"` // limits | interest | workqueue
	MaxMsgs           int64              `json:"max_msgs"`
	MaxBytes          int64              `json:"max_bytes"`
	MaxAgeSeconds     int64              `json:"max_age_seconds"`
	MaxMsgsPerSubject int64              `json:"max_msgs_per_subject"`
	Replicas          int                `json:"replicas"` // 1–5，0 视为 1
	PlacementCluster  string             `json:"placement_cluster"`
	PlacementTags     []string           `json:"placement_tags"`
	Mirror            *StreamSourceForm  `json:"mirror"`
	Sources           []StreamSourceForm `json:"sources"`
}

type StreamSourceForm struct {
	Name          string `json:"name"`
	FilterSubject string `json:"filter_subject"`
	OptStartSeq   uint64 `json:"opt_start_seq"`
}

type ListStreamsResult struct {
	CallResult
	Streams           []StreamSummary `json:"streams"`            // 失败时 nil
	UnavailableReason string          `json:"unavailable_reason"` // 非空 → 前端渲染指引面板
}

type PurgeResult struct {
	CallResult
	Purged uint64 `json:"purged"`
}

type BrowserPageRequest struct {
	Stream        string `json:"stream"`
	StartSeq      uint64 `json:"start_seq"`      // 页首序列（含）
	Count         int    `json:"count"`          // 20/50/100/200
	SubjectFilter string `json:"subject_filter"` // 可选；非空时前端禁用"上一页"
}

type BrowserMsg struct {
	Seq         uint64              `json:"seq"`
	Subject     string              `json:"subject"`
	Headers     map[string][]string `json:"headers"`
	PayloadB64  string              `json:"payload_b64"`
	PayloadSize int                 `json:"payload_size"`
	TimestampMs int64               `json:"timestamp_ms"`
	IsUtf8      bool                `json:"is_utf8"`
	// Truncated=true 时 PayloadB64 仅携带前 64KB（行级预览上限），
	// PayloadSize 仍为完整大小；完整内容经 GetStreamMessage / 下载获取。
	// 防止大消息页（如 50×2MB）把单页载荷推到百 MB 级（§6.6「仅展示
	// 元数据与十六进制预览」的 wire 半边）。
	Truncated bool `json:"truncated"`
}

type BrowserPageResult struct {
	CallResult
	Messages     []BrowserMsg `json:"messages"`
	NextStartSeq uint64       `json:"next_start_seq"` // 下一页请求起点（最后一条 seq+1；空页 = StartSeq）
	HasMore      bool         `json:"has_more"`
}

type GetMsgResult struct {
	CallResult
	Msg *BrowserMsg `json:"msg"`
}

type NextMsg struct {
	BrowserMsg
	NumDelivered uint64 `json:"num_delivered"`
	NumPending   uint64 `json:"num_pending"`
}

type PreviewNextResult struct {
	CallResult
	Messages []NextMsg `json:"messages"`
}

type PauseResult struct {
	CallResult
	Paused      bool  `json:"paused"`
	UntilMs     int64 `json:"until_ms"`
	RemainingMs int64 `json:"remaining_ms"`
}

type ConsumerSummary struct {
	Name                 string   `json:"name"`
	Stream               string   `json:"stream"`
	IsPull               bool     `json:"is_pull"`
	IsEphemeral          bool     `json:"is_ephemeral"`
	AckPolicy            string   `json:"ack_policy"`
	DeliverPolicy        string   `json:"deliver_policy"`
	FilterSubjects       []string `json:"filter_subjects"`
	NumPending           uint64   `json:"num_pending"`
	NumAckPending        int      `json:"num_ack_pending"`
	AckFloorConsumer     uint64   `json:"ack_floor_consumer"`
	NumRedelivered       int      `json:"num_redelivered"`
	NumWaiting           int      `json:"num_waiting"`
	DeliveredConsumerSeq uint64   `json:"delivered_consumer_seq"`
	Paused               bool     `json:"paused"`
	PauseRemainingMs     int64    `json:"pause_remaining_ms"`
	CreatedMs            int64    `json:"created_ms"`
	LeaderMissing        bool     `json:"leader_missing"`
	UnhealthyReplicas    int      `json:"unhealthy_replicas"`
	ReplicaCount         int      `json:"replica_count"`
}

type ConsumerDetail struct {
	CallResult
	Summary ConsumerSummary `json:"summary"`
	Form    ConsumerForm    `json:"form"`
	Cluster *ClusterOut     `json:"cluster"`
}

// ConsumerForm: 编辑时 deliver_policy/opt_start_* 由服务端原值回填、UI 禁改。
type ConsumerForm struct {
	Stream                   string   `json:"stream"`
	Durable                  string   `json:"durable"`
	Description              string   `json:"description"`
	DeliverMode              string   `json:"deliver_mode"` // pull | push
	DeliverSubject           string   `json:"deliver_subject"`
	DeliverGroup             string   `json:"deliver_group"`
	FilterSubjects           []string `json:"filter_subjects"`
	AckPolicy                string   `json:"ack_policy"` // explicit | none | all
	AckWaitSeconds           int64    `json:"ack_wait_seconds"`
	MaxDeliver               int      `json:"max_deliver"`
	MaxWaiting               int      `json:"max_waiting"`
	MaxAckPending            int      `json:"max_ack_pending"`
	MaxRequestBatch          int      `json:"max_request_batch"`
	MaxRequestExpiresSeconds int64    `json:"max_request_expires_seconds"`
	MaxRequestMaxBytes       int64    `json:"max_request_max_bytes"`
	BackoffSeconds           []int64  `json:"backoff_seconds"`
	ReplayPolicy             string   `json:"replay_policy"`  // instant | original
	DeliverPolicy            string   `json:"deliver_policy"` // all | last | new | start_sequence | start_time
	OptStartSeq              uint64   `json:"opt_start_seq"`
	OptStartTimeMs           int64    `json:"opt_start_time_ms"`
	PriorityGroups           []string `json:"priority_groups"`
	HeadersOnly              bool     `json:"headers_only"`
	Replicas                 int      `json:"replicas"`
	MemoryStorage            bool     `json:"memory_storage"`
	InactiveThresholdSeconds int64    `json:"inactive_threshold_seconds"`
}

type ListConsumersResult struct {
	CallResult
	Consumers         []ConsumerSummary `json:"consumers"`
	UnavailableReason string            `json:"unavailable_reason"`
}

type BackupProgress struct {
	Stream     string `json:"stream"`
	Direction  string `json:"direction"` // backup | restore
	Phase      string `json:"phase"`     // running | complete | incomplete
	BytesDone  uint64 `json:"bytes_done"`
	BytesTotal uint64 `json:"bytes_total"`
	ChunksDone uint32 `json:"chunks_done"`
}
