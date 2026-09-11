package messaging

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// Trace adapts the server-side message tracing API (NATS Server >= 2.11) into
// a frontend-friendly tree of TraceHop nodes. The scenarios below run against
// both the embedded fixture and the real local nats-server (M2 mandate).

// scenarioTraceSingle subscribes a responder on subject, runs Trace with
// deliver=false and asserts the resulting tree: non-empty, ingress root with a
// kind and server detail, at least one egress hop, and that the trace-only
// request never reached the responder.
func scenarioTraceSingle(t *testing.T, url, subject string) {
	t.Helper()
	nc := connect(t, url)

	got := make(chan *nats.Msg, 1)
	sub, err := nc.ChanSubscribe(subject, got)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Unsubscribe()
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}

	hop, err := Trace(nc, TraceForm{
		Subject: subject,
		Headers: map[string][]string{"X-Trace": {"1"}},
		Payload: []byte("trace me"),
		Deliver: false, // trace-only: the message must NOT reach the responder
	})
	if err != nil {
		t.Fatalf("Trace: %v", err)
	}

	if hop.Kind == "" {
		t.Fatal("root hop Kind is empty")
	}
	if hop.Detail == "" {
		t.Fatal("root hop Detail is empty")
	}
	if hop.Kind != "ingress" {
		t.Fatalf("root hop Kind = %q, want ingress", hop.Kind)
	}
	if !strings.Contains(hop.Detail, "server:") {
		t.Fatalf("root hop Detail = %q, want it to contain %q", hop.Detail, "server:")
	}

	egress := findHop(hop, "egress")
	if egress == nil {
		t.Fatalf("no egress hop in tree: %+v", treeKinds(hop))
	}

	// deliver=false adds Nats-Trace-Only: the responder must stay silent.
	select {
	case m := <-got:
		t.Fatalf("trace-only message was delivered to subscriber: %+v", m)
	case <-time.After(300 * time.Millisecond):
	}
}

// scenarioTraceDeliver runs Trace with deliver=true and asserts the responder
// receives the traced message AND a populated tree is still returned.
func scenarioTraceDeliver(t *testing.T, url, subject string) {
	t.Helper()
	nc := connect(t, url)

	got := make(chan *nats.Msg, 1)
	sub, err := nc.ChanSubscribe(subject, got)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Unsubscribe()
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}

	hop, err := Trace(nc, TraceForm{Subject: subject, Payload: []byte("deliver me"), Deliver: true})
	if err != nil {
		t.Fatalf("Trace: %v", err)
	}
	if hop.Kind != "ingress" {
		t.Fatalf("root hop Kind = %q, want ingress", hop.Kind)
	}
	if findHop(hop, "egress") == nil {
		t.Fatalf("no egress hop in tree: %+v", treeKinds(hop))
	}

	m := recvMsg(t, got, 5*time.Second)
	if string(m.Data) != "deliver me" {
		t.Fatalf("delivered payload = %q, want %q", m.Data, "deliver me")
	}
}

// scenarioTraceTooLarge asserts an over-MaxPayload payload is rejected with
// ErrPayloadTooLarge before any network side effect.
func scenarioTraceTooLarge(t *testing.T, url, subject string) {
	t.Helper()
	nc := connect(t, url)

	hop, err := Trace(nc, TraceForm{Subject: subject, Payload: make([]byte, MaxPayload+1)})
	if err == nil {
		t.Fatal("oversize trace must fail")
	}
	if !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("err = %v, want ErrPayloadTooLarge", err)
	}
	if hop.Kind != "" {
		t.Fatalf("failed trace returned a populated tree (%+v)", hop)
	}

	// No network side effect: the same connection must remain usable.
	if _, err := Trace(nc, TraceForm{Subject: subject, Payload: []byte("ok")}); err != nil {
		t.Fatalf("conn unusable after oversize rejection: %v", err)
	}
}

// findHop depth-first searches the tree for the first node with the given Kind.
func findHop(h TraceHop, kind string) *TraceHop {
	if h.Kind == kind {
		return &h
	}
	for _, c := range h.Children {
		if got := findHop(c, kind); got != nil {
			return got
		}
	}
	return nil
}

// treeKinds flattens the tree kinds for failure messages.
func treeKinds(h TraceHop) []string {
	kinds := []string{h.Kind}
	for _, c := range h.Children {
		kinds = append(kinds, treeKinds(c)...)
	}
	return kinds
}

// --- embedded-fixture tests (CI-hermetic path) -------------------------------

func TestTraceSingleServer(t *testing.T) {
	scenarioTraceSingle(t, testutil.StartJSServer(t), "m2t6.trace."+uniqueSuffix())
}

func TestTraceDeliver(t *testing.T) {
	scenarioTraceDeliver(t, testutil.StartJSServer(t), "m2t6.deliver."+uniqueSuffix())
}

func TestTraceTooLarge(t *testing.T) {
	scenarioTraceTooLarge(t, testutil.StartJSServer(t), "m2t6.big."+uniqueSuffix())
}

func TestTraceNotConnected(t *testing.T) {
	hop, err := Trace(nil, TraceForm{Subject: "s", Payload: []byte("x")})
	if !errors.Is(err, ErrNotConnected) {
		t.Fatalf("err = %v, want ErrNotConnected", err)
	}
	if hop.Kind != "" {
		t.Fatalf("nil-conn trace returned a populated tree (%+v)", hop)
	}
}

// TestTraceVersionCheck pins the mirrored natscli ServerMinVersion comparison
// on injected version strings (the server fixtures all satisfy >= 2.11, so the
// gating logic is only observable through this pure helper).
func TestTraceVersionCheck(t *testing.T) {
	cases := []struct {
		version string
		want    bool
	}{
		{"2.10.0", false},
		{"2.10.9", false},
		{"2.9.15", false},
		{"2.11.0", true},
		{"2.15.0-preview.1", true}, // embedded fixture and shared local server version
		{"2.15.1", true},
		{"3.0.0", true},
		{"v2.11.0", true}, // leading v tolerated like natscli's semver regex
	}
	for _, c := range cases {
		if got := serverVersionAtLeast(c.version, 2, 11, 0); got != c.want {
			t.Fatalf("serverVersionAtLeast(%q, 2, 11, 0) = %v, want %v", c.version, got, c.want)
		}
	}
}

// TestTraceTimeoutClamp pins the TimeoutMs <= 0 -> 5000ms default clamp that
// Trace applies via the shared reqTimeout helper.
func TestTraceTimeoutClamp(t *testing.T) {
	cases := []struct {
		ms   int
		want time.Duration
	}{
		{0, 5000 * time.Millisecond},
		{-1, 5000 * time.Millisecond},
		{1, 1 * time.Millisecond},
		{5000, 5000 * time.Millisecond},
	}
	for _, c := range cases {
		if got := reqTimeout(c.ms); got != c.want {
			t.Fatalf("reqTimeout(%d) = %v, want %v", c.ms, got, c.want)
		}
	}
}

// TestTraceHopJSONTags pins the frozen frontend contract: lowercase snake json
// tags with children omitted when empty.
func TestTraceHopJSONTags(t *testing.T) {
	b, err := json.Marshal(TraceHop{Kind: "ingress", Detail: "d"})
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	if !strings.Contains(got, `"kind"`) || !strings.Contains(got, `"detail"`) || strings.Contains(got, "children") {
		t.Fatalf("json = %s, want kind/detail tags and no empty children key", got)
	}
}

// --- real local nats-server variants (M2 mandate) ----------------------------

func TestTraceSingleServerLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioTraceSingle(t, localServerURL, "m2t6.trace."+uniqueSuffix())
}

func TestTraceDeliverLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioTraceDeliver(t, localServerURL, "m2t6.deliver."+uniqueSuffix())
}

func TestTraceTooLargeLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioTraceTooLarge(t, localServerURL, "m2t6.big."+uniqueSuffix())
}
