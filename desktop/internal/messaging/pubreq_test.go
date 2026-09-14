package messaging

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// localServerURL is the long-lived real local nats-server used for M2
// NATS-connectivity tests (JetStream enabled, monitor :8333/jsz). Real-server
// test variants probe it with a 2s budget and skip cleanly when unreachable so
// CI machines without it still pass (pattern from M2 Task 1).
const localServerURL = "nats://127.0.0.1:4333"

// requireLocalServer probes the real local nats-server and skips the test when
// it cannot be reached within 2 seconds.
func requireLocalServer(t *testing.T) {
	t.Helper()
	probe, err := nats.Connect(localServerURL, nats.Timeout(2*time.Second), nats.MaxReconnects(0))
	if err != nil {
		t.Skipf("local nats-server at %s unreachable: %v", localServerURL, err)
	}
	probe.Close()
}

// uniqueSuffix builds a per-run subject suffix so tests against the shared
// long-lived local server never collide with each other or earlier runs.
func uniqueSuffix() string {
	return strconv.FormatInt(time.Now().UnixNano(), 36)
}

// createJSStream creates a throwaway memory JetStream stream (best-effort
// deleting leftovers from an aborted prior run first) and registers its
// deletion with t.Cleanup.
func createJSStream(t *testing.T, nc *nats.Conn, name string, subjects ...string) {
	t.Helper()
	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = js.DeleteStream(ctx, name) // best-effort cleanup of a previous aborted run
	if _, err := js.CreateStream(ctx, jetstream.StreamConfig{
		Name:     name,
		Subjects: subjects,
		Storage:  jetstream.MemoryStorage,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer dcancel()
		if err := js.DeleteStream(dctx, name); err != nil {
			t.Errorf("cleanup: delete stream %s: %v", name, err)
		}
	})
}

// connect opens a plain client connection to url, failing the test on error.
// Unlike requireLocalServer's 2s probe (skip semantics — do not touch), this
// runs against a server already known up, so its budget is pure load
// tolerance: 10s headroom per the M6 T1 flake list.
func connect(t *testing.T, url string) *nats.Conn {
	t.Helper()
	nc, err := nats.Connect(url, nats.Timeout(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(nc.Close)
	return nc
}

// recvMsg waits up to d for one message on ch.
func recvMsg(t *testing.T, ch <-chan *nats.Msg, d time.Duration) *nats.Msg {
	t.Helper()
	select {
	case m := <-ch:
		return m
	case <-time.After(d):
		t.Fatal("timed out waiting for message")
		return nil
	}
}

// --- embedded-fixture scenarios (hermetic path) -----------------------------

// scenarioPublishCore publishes to subject with a test header and asserts a
// subscriber receives the payload and headers; PubResult.OK and ElapsedMs.
func scenarioPublishCore(t *testing.T, url, subject string) {
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

	res := Publish(nc, PubForm{
		Subject: subject,
		Headers: map[string][]string{"X-Test": {"v1"}},
		Payload: []byte("hello core"),
	})
	if !res.OK {
		t.Fatalf("Publish not OK: %q", res.Error)
	}
	if res.Error != "" {
		t.Fatalf("OK publish with Error %q", res.Error)
	}
	if res.ElapsedMs < 0 {
		t.Fatalf("ElapsedMs = %d, want >= 0", res.ElapsedMs)
	}

	m := recvMsg(t, got, 5*time.Second)
	if string(m.Data) != "hello core" {
		t.Fatalf("payload = %q, want %q", m.Data, "hello core")
	}
	if m.Header.Get("X-Test") != "v1" {
		t.Fatalf("header X-Test = %q, want v1", m.Header.Get("X-Test"))
	}
}

// scenarioPublishJetStream publishes twice with the same Nats-Msg-Id into a
// throwaway stream and asserts the PubAck fields (Stream/Sequence) and the
// duplicate flag on the second publish. streamSubject must be a valid
// wildcard (e.g. "m2t3.js.>"); publishSubject must match it.
func scenarioPublishJetStream(t *testing.T, url, stream, streamSubject, publishSubject, msgID string) {
	t.Helper()
	nc := connect(t, url)
	createJSStream(t, nc, stream, streamSubject)

	res := Publish(nc, PubForm{
		Subject:   publishSubject,
		JetStream: true,
		TimeoutMs: 0, // exercises the <=0 -> 5000ms default clamp
		Headers:   map[string][]string{"Nats-Msg-Id": {msgID}},
		Payload:   []byte("js one"),
	})
	if !res.OK {
		t.Fatalf("JS Publish not OK: %q", res.Error)
	}
	if !res.JetStream {
		t.Fatal("PubResult.JetStream = false, want true")
	}
	if res.Stream != stream {
		t.Fatalf("PubResult.Stream = %q, want %q", res.Stream, stream)
	}
	if res.Sequence <= 0 {
		t.Fatalf("PubResult.Sequence = %d, want > 0", res.Sequence)
	}

	res2 := Publish(nc, PubForm{
		Subject:   publishSubject,
		JetStream: true,
		TimeoutMs: 5000,
		Headers:   map[string][]string{"Nats-Msg-Id": {msgID}}, // same ID -> dedupe
		Payload:   []byte("js one again"),
	})
	if !res2.OK {
		t.Fatalf("JS duplicate Publish not OK: %q", res2.Error)
	}
	if !res2.Duplicate {
		t.Fatalf("republish with same Nats-Msg-Id: Duplicate = false, want true (res=%+v)", res2)
	}
}

// scenarioRequestEcho uses the testutil echo service and an inline header
// mirror to assert payload round-trip, ReqResult.Headers surfacing, request
// header delivery, and ElapsedMs recording.
func scenarioRequestEcho(t *testing.T, url, hdrSubject string) {
	t.Helper()
	testutil.StartEcho(t, url)
	nc := connect(t, url)

	res := Request(nc, ReqForm{
		Subject: "echo",
		Headers: map[string][]string{"X-Sent": {"1"}},
		Payload: []byte("ping"),
	})
	if !res.OK {
		t.Fatalf("Request not OK: %q", res.Error)
	}
	if string(res.Payload) != "ping" {
		t.Fatalf("echo payload = %q, want %q", res.Payload, "ping")
	}
	if res.ElapsedMs < 0 {
		t.Fatalf("ElapsedMs = %d, want >= 0", res.ElapsedMs)
	}

	// Inline responder mirrors the request header into the response so the
	// test can assert both directions of header handling.
	got := make(chan *nats.Msg, 1)
	sub, err := nc.Subscribe(hdrSubject, func(m *nats.Msg) {
		got <- m
		resp := nats.NewMsg(m.Reply)
		resp.Header.Set("Echoed", "true")
		resp.Data = m.Data
		_ = nc.PublishMsg(resp)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Unsubscribe()
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}

	res2 := Request(nc, ReqForm{
		Subject: hdrSubject,
		Headers: map[string][]string{"X-Sent": {"1"}},
		Payload: []byte("hdr"),
	})
	if !res2.OK {
		t.Fatalf("header Request not OK: %q", res2.Error)
	}
	sent := recvMsg(t, got, 5*time.Second)
	if sent.Header.Get("X-Sent") != "1" {
		t.Fatalf("request header X-Sent = %q, want 1", sent.Header.Get("X-Sent"))
	}
	if h := res2.Headers["Echoed"]; len(h) != 1 || h[0] != "true" {
		t.Fatalf("response headers = %v, want Echoed=[true]", res2.Headers)
	}
	if string(res2.Payload) != "hdr" {
		t.Fatalf("header echo payload = %q, want %q", res2.Payload, "hdr")
	}
}

// scenarioRequestNoResponders requests a subject nobody subscribes to and
// asserts the NoResponder mapping of nats.ErrNoResponders.
func scenarioRequestNoResponders(t *testing.T, url, subject string) {
	t.Helper()
	nc := connect(t, url)

	res := Request(nc, ReqForm{Subject: subject, Payload: []byte("x"), TimeoutMs: 500})
	if res.OK {
		t.Fatal("request without responders must not succeed")
	}
	if !res.NoResponder {
		t.Fatalf("NoResponder = false, Error = %q", res.Error)
	}
	if !strings.Contains(strings.ToLower(res.Error), "no responders") {
		t.Fatalf("Error = %q, want it to contain %q", res.Error, "no responders")
	}
}

// scenarioRequestTimeout subscribes without replying and asserts the timeout
// result: Error mentions timeout and ElapsedMs >= the requested timeout.
func scenarioRequestTimeout(t *testing.T, url, subject string) {
	t.Helper()
	nc := connect(t, url)

	sub, err := nc.SubscribeSync(subject)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Unsubscribe()
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}

	const timeoutMs = 500
	res := Request(nc, ReqForm{Subject: subject, Payload: []byte("x"), TimeoutMs: timeoutMs})
	if res.OK {
		t.Fatal("request with silent responder must not succeed")
	}
	if res.NoResponder {
		t.Fatal("NoResponder = true, want false (a subscriber exists)")
	}
	if !strings.Contains(strings.ToLower(res.Error), "timeout") {
		t.Fatalf("Error = %q, want it to contain %q", res.Error, "timeout")
	}
	if res.ElapsedMs < timeoutMs {
		t.Fatalf("ElapsedMs = %d, want >= %d", res.ElapsedMs, timeoutMs)
	}
}

// scenarioPublishTooLarge asserts an over-MaxPayload payload is rejected with
// ErrPayloadTooLarge without any network side effect: the same connection must
// remain usable for both Publish and Request afterwards, and Request rejects
// oversize too.
func scenarioPublishTooLarge(t *testing.T, url, subject, okSubject string) {
	t.Helper()
	nc := connect(t, url)

	res := Publish(nc, PubForm{Subject: subject, Payload: make([]byte, MaxPayload+1)})
	if res.OK {
		t.Fatal("oversize publish must fail")
	}
	if res.Error != ErrPayloadTooLarge.Error() {
		t.Fatalf("Error = %q, want %q", res.Error, ErrPayloadTooLarge.Error())
	}

	rres := Request(nc, ReqForm{Subject: subject, Payload: make([]byte, MaxPayload+1), TimeoutMs: 500})
	if rres.OK {
		t.Fatal("oversize request must fail")
	}
	if rres.Error != ErrPayloadTooLarge.Error() {
		t.Fatalf("Request Error = %q, want %q", rres.Error, ErrPayloadTooLarge.Error())
	}

	// No network side effect: the same connection must remain usable.
	res2 := Publish(nc, PubForm{Subject: okSubject, Payload: []byte("ok")})
	if !res2.OK {
		t.Fatalf("conn unusable after oversize rejection: %q", res2.Error)
	}
}

// --- embedded-fixture tests (CI-hermetic path) -------------------------------

func TestPublishCore(t *testing.T) {
	scenarioPublishCore(t, testutil.StartJSServer(t), "pubcore.test")
}

func TestPublishJetStreamAck(t *testing.T) {
	scenarioPublishJetStream(t, testutil.StartJSServer(t),
		"M2T3EMB", "m2t3emb.js.>", "m2t3emb.js.one", "m2t3-emb-dup-1")
}

func TestPublishNotConnected(t *testing.T) {
	res := Publish(nil, PubForm{Subject: "s", Payload: []byte("x")})
	if res.OK {
		t.Fatal("publish on nil conn must not succeed")
	}
	if res.Error != ErrNotConnected.Error() {
		t.Fatalf("Error = %q, want %q", res.Error, ErrNotConnected.Error())
	}
	rres := Request(nil, ReqForm{Subject: "s", Payload: []byte("x")})
	if rres.OK {
		t.Fatal("request on nil conn must not succeed")
	}
	if rres.Error != ErrNotConnected.Error() {
		t.Fatalf("Request Error = %q, want %q", rres.Error, ErrNotConnected.Error())
	}
}

func TestPublishTooLarge(t *testing.T) {
	scenarioPublishTooLarge(t, testutil.StartJSServer(t), "toobig.test", "toobig.ok")
}

func TestRequestEcho(t *testing.T) {
	scenarioRequestEcho(t, testutil.StartJSServer(t), "hdr-echo.test")
}

func TestRequestNoResponders(t *testing.T) {
	scenarioRequestNoResponders(t, testutil.StartJSServer(t), "noresp.test")
}

func TestRequestTimeout(t *testing.T) {
	scenarioRequestTimeout(t, testutil.StartJSServer(t), "silent.test")
}

// TestRequestTimeoutClamp pins the TimeoutMs <= 0 -> 5000ms default clamp.
func TestRequestTimeoutClamp(t *testing.T) {
	cases := []struct {
		ms   int
		want time.Duration
	}{
		{0, 5000 * time.Millisecond},
		{-1, 5000 * time.Millisecond},
		{-1000, 5000 * time.Millisecond},
		{1, 1 * time.Millisecond},
		{500, 500 * time.Millisecond},
	}
	for _, c := range cases {
		if got := reqTimeout(c.ms); got != c.want {
			t.Fatalf("reqTimeout(%d) = %v, want %v", c.ms, got, c.want)
		}
	}
}

// --- real local nats-server variants (M2 mandate) ----------------------------

func TestPublishCoreLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioPublishCore(t, localServerURL, "m2t3.pub."+uniqueSuffix())
}

func TestPublishJetStreamAckLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioPublishJetStream(t, localServerURL,
		"M2T3", "m2t3.js.>", "m2t3.js.one", "m2t3-dup-"+uniqueSuffix())
}

func TestPublishTooLargeLocalServer(t *testing.T) {
	requireLocalServer(t)
	sfx := uniqueSuffix()
	scenarioPublishTooLarge(t, localServerURL, "m2t3.big."+sfx, "m2t3.bigok."+sfx)
}

func TestRequestEchoLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioRequestEcho(t, localServerURL, "m2t3.hdreq."+uniqueSuffix())
}

func TestRequestNoRespondersLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioRequestNoResponders(t, localServerURL, "m2t3.noresp."+uniqueSuffix())
}

func TestRequestTimeoutLocalServer(t *testing.T) {
	requireLocalServer(t)
	scenarioRequestTimeout(t, localServerURL, "m2t3.silent."+uniqueSuffix())
}
