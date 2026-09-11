// Package messaging implements the pure-logic heart of subscription
// sessions (spec §6.4): the MsgOut wire type, a drop-oldest ring buffer,
// a realtime/batch pusher, and a sliding-window rate meter. It has zero
// NATS dependencies; NATS adapters live in later files of this package
// (sessions.go, jsposition.go, trace.go).
package messaging

// MsgOut is the wire payload for one subscription-session message pushed
// across the frontend boundary (spec §7.1.3). The JSON tags are a frozen
// contract: realtime mode emits a single-element array of MsgOut, batch
// mode a multi-element array. Do not rename fields or tags.
type MsgOut struct {
	SessionID   string              `json:"session_id"`
	Seq         int64               `json:"seq"`
	Subject     string              `json:"subject"`
	Headers     map[string][]string `json:"headers,omitempty"`
	PayloadB64  string              `json:"payload_b64"`
	PayloadSize int                 `json:"payload_size"`
	Timestamp   string              `json:"timestamp"`
	StreamSeq   int64               `json:"stream_seq,omitempty"`
	IsUTF8      bool                `json:"is_utf8"`
}

// PushMode selects how messages in a subscription session are pushed to
// the frontend (spec §6.4): realtime pushes one single-element batch per
// arriving message, batch coalesces up to 500 messages or 100ms
// (whichever comes first) into one batch.
type PushMode string

// The two push modes (spec §6.4); realtime is the default.
const (
	PushRealtime PushMode = "realtime"
	PushBatch    PushMode = "batch"
)
