// Package connections provides CRUD over natscontext-backed connection
// profiles ("contexts") that are byte-compatible with the nats CLI's
// context files (spec §17.3 / AC-003).
package connections

// ContextSummary is the read model for a stored context, as shown in
// connection lists and switchers.
type ContextSummary struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	URL         string `json:"url"`
	AuthType    string `json:"auth_type"` // creds | nkey | token | userpass | none
	ColorScheme string `json:"color_scheme"`
}

// ContextForm is the write model used to create or edit a context.
// Empty string fields are skipped when saving, so an edit keeps the
// previously stored value for any field the form leaves empty.
type ContextForm struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	URL           string `json:"url"`
	User          string `json:"user"`
	Password      string `json:"password"`
	Token         string `json:"token"`
	Creds         string `json:"creds"`
	Nkey          string `json:"nkey"`
	Cert          string `json:"cert"`
	Key           string `json:"key"`
	CA            string `json:"ca"`
	JSDomain      string `json:"js_domain"`
	JSAPIPrefix   string `json:"js_api_prefix"`
	JSEventPrefix string `json:"js_event_prefix"`
	InboxPrefix   string `json:"inbox_prefix"`
	SocksProxy    string `json:"socks_proxy"`
	ColorScheme   string `json:"color_scheme"`
	TLSFirst      bool   `json:"tls_first"`
}

// State is a connection lifecycle state of the Manager (spec §7.3).
type State string

// The five connection states (spec §7.3); values are the wire/UI names.
const (
	StateDisconnected State = "disconnected"
	StateConnecting   State = "connecting"
	StateConnected    State = "connected"
	StateReconnecting State = "reconnecting"
	StateFailed       State = "failed"
)

// EventConnState is the event name emitted on every Manager state
// transition. Its payload is a StateEvent.
const EventConnState = "conn:state"

// StateEvent is the payload of EventConnState: the full state of the
// active connection at the moment of the transition. Since is the RFC3339
// timestamp of when the current state was entered, RttMs the last
// round-trip time measured while connected (0 otherwise), and Reason the
// error text for failed states.
type StateEvent struct {
	Context string `json:"context"`
	State   State  `json:"state"`
	Since   string `json:"since"`
	RttMs   int64  `json:"rtt_ms"`
	Reason  string `json:"reason,omitempty"`
}

// TestResult is the outcome of Manager.CheckConnection: whether the
// probe connection could be established, its averaged RTT, and whether a
// JetStream account was reachable on the other end.
type TestResult struct {
	OK        bool   `json:"ok"`
	RttMs     int64  `json:"rtt_ms"`
	JetStream bool   `json:"jetstream"`
	Error     string `json:"error,omitempty"`
}
