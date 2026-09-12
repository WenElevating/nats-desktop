// Message path tracing over the NATS Server >= 2.11 tracing API (spec §6.5,
// M2 Task 6). Trace publishes a probe message through
// jsm.go/api/server/tracing.TraceMsg (adding Nats-Trace-Dest, plus
// Nats-Trace-Only when Deliver is false so the message is never actually
// delivered), collects the server MsgTraceEvent responses and recursively
// unfolds Ingress/SubjectMapping/ServiceImports/StreamExports/JetStream/
// Egresses into a frontend-friendly TraceHop tree that mirrors the structure
// natscli's `nats trace` renders (cli/trace_command.go renderTrace). The
// server version gate (natsver.ServerAtLeast, mirroring natscli's
// util.ServerMinVersion) reads the INFO-protocol ConnectedServerVersion
// available to every client — no $SYS or monitor endpoint needed. Payload
// content is never included in returned error strings (spec §13.3).

package messaging

import (
	"errors"
	"fmt"
	"strings"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/jsm.go/api/server/tracing"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/natsver"
)

// ErrTraceOldServer is returned when the connected server predates the 2.11
// message tracing API.
var ErrTraceOldServer = errors.New("tracing requires NATS Server 2.11 or newer")

// traceMinVersion is the NATS Server release that introduced message tracing.
var traceMinVersion = [3]int{2, 11, 0}

// TraceForm is one trace request. Deliver=false (the default) traces the route
// only: the message carries Nats-Trace-Only and never reaches the final
// subject. TimeoutMs (<=0 -> settings default / 5000) bounds each
// trace-response wait. The JSON tags are the frozen Wails-binding contract
// (lowercase snake).
type TraceForm struct {
	Subject   string              `json:"subject"`
	Headers   map[string][]string `json:"headers"`
	Payload   []byte              `json:"payload"` // Go json encodes []byte as base64
	Deliver   bool                `json:"deliver"`
	TimeoutMs int                 `json:"timeout_ms"`
}

// TraceHop is one node of the trace tree. Kind is a closed set: "ingress",
// "egress", "mapping", "service_import", "stream_export", "jetstream",
// "no_interest". Detail carries the natscli-style human description; Children
// nests remote-server hops (egress -> next server's ingress).
type TraceHop struct {
	Kind     string     `json:"kind"`
	Detail   string     `json:"detail"`
	Children []TraceHop `json:"children,omitempty"`
}

// Trace sends one probe message per f and returns the unfolded trace tree. A
// nil conn yields ErrNotConnected and an oversize payload ErrPayloadTooLarge —
// both before any network side effect. As in natscli, an ErrTimeout with a
// partial trace event still returns the tree gathered so far.
func Trace(nc *nats.Conn, f TraceForm) (TraceHop, error) {
	if nc == nil {
		return TraceHop{}, ErrNotConnected
	}
	if len(f.Payload) > MaxPayload {
		return TraceHop{}, ErrPayloadTooLarge
	}
	if ok, err := natsver.ServerAtLeast(nc.ConnectedServerVersion(), traceMinVersion[0], traceMinVersion[1], traceMinVersion[2]); err != nil || !ok {
		return TraceHop{}, ErrTraceOldServer
	}

	event, err := tracing.TraceMsg(nc, buildMsg(f.Subject, f.Headers, f.Payload), f.Deliver, reqTimeout(f.TimeoutMs), nil)
	if err != nil && (event == nil || !errors.Is(err, nats.ErrTimeout)) {
		return TraceHop{}, err
	}
	if event == nil {
		return TraceHop{}, errors.New("no trace event received")
	}

	return traceTree(event), nil
}

// traceTree unfolds one MsgTraceEvent into its TraceHop subtree, following
// natscli renderTrace's order: ingress, subject mapping, service imports,
// stream exports, JetStream, then egresses (each recursing into its Link).
func traceTree(event *server.MsgTraceEvent) TraceHop {
	ingress := event.Ingress()
	if ingress == nil {
		// GetMsgTrace normally rejects ingress-less events; keep a safe root.
		return TraceHop{
			Kind:   "ingress",
			Detail: fmt.Sprintf("server:%q version:%q", event.Server.Name, event.Server.Version),
		}
	}

	root := TraceHop{Kind: "ingress"}
	parts := []string{nameForKind(ingress.Kind, ingress.Name, ingress.CID)}
	if event.Server.Cluster != "" && (ingress.Kind == server.GATEWAY || ingress.Kind == server.CLIENT) {
		parts = append(parts, fmt.Sprintf("cluster:%q", event.Server.Cluster))
	}
	parts = append(parts, fmt.Sprintf("server:%q", event.Server.Name), fmt.Sprintf("version:%q", event.Server.Version))
	if ingress.Error != "" {
		parts = append(parts, "--X Error: "+ingress.Error)
	}
	root.Detail = strings.Join(parts, " ")

	if mapping := event.SubjectMapping(); mapping != nil {
		root.Children = append(root.Children, TraceHop{
			Kind:   "mapping",
			Detail: fmt.Sprintf("mapping subject:%q", mapping.MappedTo),
		})
	}
	for _, svc := range event.ServiceImports() {
		root.Children = append(root.Children, TraceHop{
			Kind:   "service_import",
			Detail: fmt.Sprintf("service import from:%q to:%q account:%q", svc.From, svc.To, svc.Account),
		})
	}
	for _, stream := range event.StreamExports() {
		root.Children = append(root.Children, TraceHop{
			Kind:   "stream_export",
			Detail: fmt.Sprintf("stream export subject:%q account:%q", stream.To, stream.Account),
		})
	}
	if js := event.JetStream(); js != nil {
		hop := TraceHop{Kind: "jetstream"}
		if js.Error != "" && js.Stream == "" {
			hop.Detail = "!!! Expected JetStream event: " + js.Error
		} else {
			action := "stored"
			if js.NoInterest {
				action = "no interest"
			}
			hop.Detail = fmt.Sprintf("JetStream action:%q stream:%q subject:%q", action, js.Stream, js.Subject)
			if js.Error != "" {
				hop.Detail += " --X Error: " + js.Error
			}
		}
		root.Children = append(root.Children, hop)
	}

	egresses := event.Egresses()
	if len(egresses) == 0 && ingress.Kind == server.CLIENT && ingress.Error == "" {
		root.Children = append(root.Children, TraceHop{Kind: "no_interest", Detail: "--X No active interest"})
	}
	for _, egress := range egresses {
		hop := TraceHop{Kind: "egress"}
		parts := []string{nameForKind(egress.Kind, egress.Name, egress.CID)}
		if egress.Account != "" {
			parts = append(parts, fmt.Sprintf("account:%q", egress.Account))
		}
		if egress.Subscription != "" {
			parts = append(parts, fmt.Sprintf("subject:%q", egress.Subscription))
		}
		if egress.Queue != "" {
			parts = append(parts, fmt.Sprintf("queue:%q", egress.Queue))
		}
		if egress.Error != "" {
			parts = append(parts, "--X Error: "+egress.Error)
		}
		hop.Detail = strings.Join(parts, " ")
		if egress.Link != nil {
			hop.Children = append(hop.Children, traceTree(egress.Link))
		}
		root.Children = append(root.Children, hop)
	}

	return root
}

// nameForKind renders the jsm kind string plus connection name/cid the way
// natscli labels ingress/egress hops, e.g. `Client "Nats Cli Trace" cid:5`.
func nameForKind(kind int, name string, cid uint64) string {
	if name == "" {
		return fmt.Sprintf("%s %s", jsm.ServerKindString(kind), jsm.ServerCidString(kind, cid))
	}
	return fmt.Sprintf("%s %q %s", jsm.ServerKindString(kind), name, jsm.ServerCidString(kind, cid))
}
