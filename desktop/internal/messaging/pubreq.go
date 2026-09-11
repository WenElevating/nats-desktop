// Pub/request adapters of the messaging package (spec §6.5). The call
// sequences mirror the natscli investigation verbatim: core publish = NewMsg +
// PublishMsg + Flush + LastError; JetStream publish = RequestMsg +
// ParsePubAck; request = explicit reply inbox + SubscribeSync + PublishMsg +
// NextMsg. No logging happens here, and payload content is never included in
// returned error strings (spec §13.3).

package messaging

import (
	"errors"
	"time"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/nats.go"
)

// MaxPayload is the largest payload this layer will put on the wire (8 MiB).
const MaxPayload = 8 << 20

// Sentinel errors surfaced via PubResult.Error / ReqResult.Error (as
// err.Error() strings). Payload > MaxPayload is rejected locally — no network
// side effect; a nil conn yields ErrNotConnected.
var (
	ErrPayloadTooLarge = errors.New("payload exceeds MaxPayload (8 MiB)")
	ErrNotConnected    = errors.New("not connected")
)

// PubForm is one publish request. JetStream selects the acked publish path;
// TimeoutMs (<=0 -> settings default / 5000) is the ack wait for that path
// only. The JSON tags are the frozen Wails-binding contract (lowercase snake,
// like every other messaging wire type).
type PubForm struct {
	Subject   string              `json:"subject"`
	Headers   map[string][]string `json:"headers"`
	Payload   []byte              `json:"payload"` // Go json encodes []byte as base64
	JetStream bool                `json:"jetstream"`
	TimeoutMs int                 `json:"timeout_ms"`
}

// PubResult reports one publish. JSON tags are lowercase snake per the frozen
// frontend contract. Stream/Sequence/Duplicate are only meaningful when
// JetStream is true.
type PubResult struct {
	OK        bool   `json:"ok"`
	JetStream bool   `json:"jetstream"`
	Stream    string `json:"stream,omitempty"`
	Sequence  int64  `json:"sequence,omitempty"`
	Duplicate bool   `json:"duplicate,omitempty"`
	ElapsedMs int64  `json:"elapsed_ms"`
	Error     string `json:"error,omitempty"`
}

// ReqForm is one request (reply expected on an auto-generated inbox). The
// JSON tags are the frozen Wails-binding contract (lowercase snake).
type ReqForm struct {
	Subject   string              `json:"subject"`
	Headers   map[string][]string `json:"headers"`
	Payload   []byte              `json:"payload"` // Go json encodes []byte as base64
	TimeoutMs int                 `json:"timeout_ms"`
}

// ReqResult reports one request. NoResponder mirrors nats.ErrNoResponders;
// Payload carries the response body (never logged anywhere).
type ReqResult struct {
	OK          bool                `json:"ok"`
	Payload     []byte              `json:"payload,omitempty"`
	Headers     map[string][]string `json:"headers,omitempty"`
	ElapsedMs   int64               `json:"elapsed_ms"`
	NoResponder bool                `json:"no_responder"`
	Error       string              `json:"error,omitempty"`
}

// reqTimeout clamps a TimeoutMs form value: <=0 falls back to the 5000ms
// default, otherwise milliseconds.
func reqTimeout(ms int) time.Duration {
	if ms <= 0 {
		return 5000 * time.Millisecond
	}
	return time.Duration(ms) * time.Millisecond
}

// buildMsg materializes a PubForm/ReqForm into a wire message. nats.NewMsg
// already allocates Header, so direct key assignment preserves the caller's
// key casing exactly.
func buildMsg(subject string, headers map[string][]string, payload []byte) *nats.Msg {
	msg := nats.NewMsg(subject)
	msg.Data = payload
	for k, vs := range headers {
		msg.Header[k] = vs
	}
	return msg
}

// Publish sends one message per f. Core NATS publish uses the
// PublishMsg/Flush/LastError triple; JetStream publish sends the message as a
// request and parses the PubAck. A nil conn or an oversize payload returns a
// failed result without touching the network.
func Publish(nc *nats.Conn, f PubForm) (res PubResult) {
	res.JetStream = f.JetStream
	start := time.Now()
	defer func() { res.ElapsedMs = time.Since(start).Milliseconds() }()

	if nc == nil {
		res.Error = ErrNotConnected.Error()
		return res
	}
	if len(f.Payload) > MaxPayload {
		res.Error = ErrPayloadTooLarge.Error()
		return res
	}

	msg := buildMsg(f.Subject, f.Headers, f.Payload)

	if !f.JetStream {
		if err := nc.PublishMsg(msg); err != nil {
			res.Error = err.Error()
			return res
		}
		nc.Flush()
		if err := nc.LastError(); err != nil {
			res.Error = err.Error()
			return res
		}
		res.OK = true
		return res
	}

	resp, err := nc.RequestMsg(msg, reqTimeout(f.TimeoutMs))
	if err != nil {
		res.Error = err.Error()
		return res
	}
	ack, err := jsm.ParsePubAck(resp)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	res.OK = true
	res.Stream = ack.Stream
	res.Sequence = int64(ack.Sequence)
	res.Duplicate = ack.Duplicate
	return res
}

// Request sends one request and waits up to the (clamped) timeout for a
// single reply on a private inbox. A nil conn or an oversize payload returns a
// failed result without touching the network.
func Request(nc *nats.Conn, f ReqForm) (res ReqResult) {
	start := time.Now()
	defer func() { res.ElapsedMs = time.Since(start).Milliseconds() }()

	if nc == nil {
		res.Error = ErrNotConnected.Error()
		return res
	}
	if len(f.Payload) > MaxPayload {
		res.Error = ErrPayloadTooLarge.Error()
		return res
	}
	timeout := reqTimeout(f.TimeoutMs)

	msg := buildMsg(f.Subject, f.Headers, f.Payload)
	msg.Reply = nc.NewRespInbox()
	sub, err := nc.SubscribeSync(msg.Reply)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	defer sub.Unsubscribe()
	if err := nc.Flush(); err != nil {
		res.Error = err.Error()
		return res
	}
	if err := nc.PublishMsg(msg); err != nil {
		res.Error = err.Error()
		return res
	}

	m, err := sub.NextMsg(timeout)
	if err != nil {
		if errors.Is(err, nats.ErrNoResponders) {
			res.NoResponder = true
		}
		res.Error = err.Error()
		return res
	}

	res.OK = true
	res.Payload = m.Data
	if m.Header != nil {
		res.Headers = map[string][]string(m.Header)
	}
	return res
}
