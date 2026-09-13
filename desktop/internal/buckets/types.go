// Package buckets implements the KeyValue (§6.8) and Object Store (§6.9)
// management surface over the jetstream API.
package buckets

import "errors"

// Error codes crossing the IPC boundary (spec §8.5.2 / §8.2.1 closed set) —
// same set as jsadmin plus the KV-specific conflict code.
const (
	CodeOK            = ""
	CodeNotConnected  = "not_connected"
	CodeJSUnavailable = "js_unavailable"
	CodeNotFound      = "not_found"
	CodeValidation    = "validation"
	CodeServer        = "server"
	CodeCancelled     = "cancelled"
	CodeConflict      = "conflict" // KV create 已存在 / update 修订不符 / 桶已存在（§6.8 异常 1/2）
)

// CallResult is embedded in every bound-call result; Ok is true iff
// ErrorCode is empty (same shape as jsadmin, re-declared in this package).
type CallResult struct {
	ErrorCode string `json:"error_code"`
	Error     string `json:"error"` // server原文 for server/validation errors
}

func (r CallResult) Ok() bool { return r.ErrorCode == CodeOK }

func fail(code, msg string) CallResult { return CallResult{ErrorCode: code, Error: msg} }

// Package-level sentinels for conditions the service layer must detect via
// errors.Is (revert without history, full disk on download, oversized value).
var (
	ErrNoHistory       = errors.New("key has no previous revision to revert to")
	ErrDiskSpace       = errors.New("insufficient disk space at download target")
	ErrPayloadTooLarge = errors.New("value exceeds 8MB limit")
)

// Event names (spec §8.5 additive extensions).
const (
	EventKvWatch     = "kv:watch"
	EventObjWatch    = "obj:watch"
	EventObjTransfer = "obj:transfer"
)

// KvBucketForm: 数值字段 0 = 不设置（服务器默认），-1 = 无限制（ttl_seconds 仅 ≥0）。
type KvBucketForm struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	History      uint8  `json:"history"`        // 0 = 服务器默认(1)，1–64
	TtlSeconds   int64  `json:"ttl_seconds"`    // ≥0，0 = 不过期
	MaxBytes     int64  `json:"max_bytes"`      // ≥-1
	Replicas     int    `json:"replicas"`       // 1–5，0 视为 1
	MaxValueSize int32  `json:"max_value_size"` // ≥-1
}

type KvBucketSummary struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	Values       uint64 `json:"values"`
	History      int64  `json:"history"`
	TtlSeconds   int64  `json:"ttl_seconds"`
	Bytes        uint64 `json:"bytes"`
	MaxBytes     int64  `json:"max_bytes"`
	Replicas     int    `json:"replicas"`
	IsCompressed bool   `json:"is_compressed"`
}

type ObjBucketForm struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	MaxBytes    int64  `json:"max_bytes"` // ≥-1
	Replicas    int    `json:"replicas"`  // 1–5
}

type ObjBucketSummary struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Size        uint64 `json:"size"`
	Sealed      bool   `json:"sealed"`
	Replicas    int    `json:"replicas"`
	TtlSeconds  int64  `json:"ttl_seconds"`
}

type ListBucketsResult struct {
	CallResult
	KvBuckets         []KvBucketSummary  `json:"kv_buckets"`
	ObjBuckets        []ObjBucketSummary `json:"obj_buckets"`
	UnavailableReason string             `json:"unavailable_reason"`
}

type BucketDetailResult struct {
	CallResult
	Form      KvBucketForm `json:"form"` // KV 详情（GetKvBucketDetail）
	CreatedMs int64        `json:"created_ms"`
}

// KeyMeta: 键名+元数据（列表用，值另行批量补齐）。
type KeyMeta struct {
	Key       string `json:"key"`
	Revision  uint64 `json:"revision"`
	CreatedMs int64  `json:"created_ms"`
	Operation string `json:"operation"` // put | delete | purge
}

type ListKeysResult struct {
	CallResult
	Keys []KeyMeta `json:"keys"`
}

// KeyValueOut: 批量值补齐的单键结果；缺失键 NotFound=true（键在列表后被删）。
type KeyValueOut struct {
	Key         string `json:"key"`
	Revision    uint64 `json:"revision"`
	PayloadB64  string `json:"payload_b64"`
	PayloadSize int    `json:"payload_size"`
	IsUtf8      bool   `json:"is_utf8"`
	CreatedMs   int64  `json:"created_ms"`
	Operation   string `json:"operation"`
	NotFound    bool   `json:"not_found"`
}

type GetKeyValuesResult struct {
	CallResult
	Values []KeyValueOut `json:"values"`
}

type KeyHistoryEntry struct {
	Revision    uint64 `json:"revision"`
	PayloadB64  string `json:"payload_b64"`
	PayloadSize int    `json:"payload_size"`
	IsUtf8      bool   `json:"is_utf8"`
	CreatedMs   int64  `json:"created_ms"`
	Operation   string `json:"operation"`
}

type GetKeyHistoryResult struct {
	CallResult
	Entries []KeyHistoryEntry `json:"entries"`
}

// PutKeyResult: revision 为新修订号；冲突时 CurrentRevision 填当前修订（§6.8 异常 2）。
type PutKeyResult struct {
	CallResult
	Revision        uint64 `json:"revision"`
	CurrentRevision uint64 `json:"current_revision"`
}

type ObjectOut struct {
	Name      string `json:"name"`
	Size      uint64 `json:"size"`
	Chunks    uint32 `json:"chunks"`
	Digest    string `json:"digest"`
	ModTimeMs int64  `json:"mod_time_ms"`
	Deleted   bool   `json:"deleted"`
}

type ListObjectsResult struct {
	CallResult
	Objects []ObjectOut `json:"objects"`
}

// KvWatchEvent / ObjWatchEvent / ObjTransferEvent（Global 4 载荷）。
type KvWatchEvent struct {
	WatchId      string `json:"watch_id"`
	Bucket       string `json:"bucket"`
	Key          string `json:"key,omitempty"` // "" = 初始完成 sentinel
	Revision     uint64 `json:"revision"`
	Operation    string `json:"operation"`
	PayloadB64   string `json:"payload_b64,omitempty"`
	PayloadSize  int    `json:"payload_size"`
	IsUtf8       bool   `json:"is_utf8"`
	TimestampMs  int64  `json:"timestamp_ms"`
	DroppedTotal uint64 `json:"dropped_total"` // 发射时累计丢弃数（§6.4 丢弃计数显示的 wire 来源）
}

type ObjWatchEvent struct {
	WatchId      string `json:"watch_id"`
	Bucket       string `json:"bucket"`
	Name         string `json:"name,omitempty"` // "" = sentinel
	Size         uint64 `json:"size"`
	Chunks       uint32 `json:"chunks"`
	Digest       string `json:"digest"`
	ModTimeMs    int64  `json:"mod_time_ms"`
	Deleted      bool   `json:"deleted"`
	DroppedTotal uint64 `json:"dropped_total"`
}

type ObjTransferEvent struct {
	TransferId  string `json:"transfer_id"`
	Bucket      string `json:"bucket"`
	Name        string `json:"name"`
	Direction   string `json:"direction"` // upload | download
	Phase       string `json:"phase"`     // running | complete | incomplete
	BytesDone   uint64 `json:"bytes_done"`
	BytesTotal  uint64 `json:"bytes_total"`
	DigestMatch *bool  `json:"digest_match,omitempty"` // 下载完成时
	Error       string `json:"error,omitempty"`
}
