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

// Event names for the subscription-session frontend contract (spec §7.1.3,
// frozen). EventSessionMsgs carries a []MsgOut payload (realtime mode:
// single-element arrays; batch mode: multi-element arrays).
// EventSessionState carries a SessionState payload.
const (
	EventSessionMsgs  = "session:msgs"
	EventSessionState = "session:state"
)

// SessionSpec is the creation request for one subscription session
// (spec §6.4). BufferSize <= 0 means "use the configured default" and is
// resolved before the messaging layer sees the value; JSPosition selects
// JetStream replay positioning (nil / mode "new" = plain core subscription).
// The JSON tags are a frozen frontend contract.
type SessionSpec struct {
	Subject    string      `json:"subject"`
	PushMode   PushMode    `json:"push_mode"`
	BufferSize int         `json:"buffer_size"`
	JSPosition *JSPosition `json:"js_position,omitempty"`
}

// JSPosition positions a session within a JetStream stream (spec §6.4).
// Mode is a closed set: all | new | start_sequence | start_time. StartSeq is
// the stream sequence for start_sequence; StartTime an RFC3339 timestamp for
// start_time.
type JSPosition struct {
	Mode      string `json:"mode"`
	StartSeq  uint64 `json:"start_seq,omitempty"`
	StartTime string `json:"start_time,omitempty"`
}

// SessionState is the status snapshot of one subscription session, as pushed
// via EventSessionState (throttled to 250ms) and returned by List(). The JSON
// tags are a frozen frontend contract. State is a closed set:
// running | paused | closed. Error carries the verbatim server error text for
// sessions the server refused (spec §6.4) and is otherwise empty.
type SessionState struct {
	ID         string   `json:"id"`
	Subject    string   `json:"subject"`
	State      string   `json:"state"`
	PushMode   PushMode `json:"push_mode"`
	RateMsgS   float64  `json:"rate_msg_s"`
	Total      int64    `json:"total"`
	Dropped    int64    `json:"dropped"`
	BufferUsed int      `json:"buffer_used"`
	Error      string   `json:"error,omitempty"`
}
