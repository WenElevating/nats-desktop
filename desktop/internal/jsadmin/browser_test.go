package jsadmin

import (
	"bytes"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// seedStream creates a stream over name+".>" and publishes n 1-byte messages
// to name+".a" (brief Step 1 fixture).
func seedStream(t *testing.T, url, name string, n int) *JetAdminService {
	t.Helper()
	svc := newAdmin(t, url)
	if res := svc.CreateStream(StreamForm{Name: name, Subjects: []string{name + ".>"}, Storage: "file", Retention: "limits", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	nc := svcRawConn(t, svc)
	for i := 1; i <= n; i++ {
		if err := nc.Publish(name+".a", []byte{byte('0' + i%10)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}
	return svc
}

func TestBrowsePaging(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "PAGE", 120)
	// 第一页：1..50，has_more=true（fetch 51 判定）
	p1 := svc.BrowseStream(BrowserPageRequest{Stream: "PAGE", StartSeq: 1, Count: 50})
	if !p1.Ok() || len(p1.Messages) != 50 || p1.Messages[0].Seq != 1 || p1.Messages[49].Seq != 50 || !p1.HasMore {
		t.Fatalf("page1: %+v", p1)
	}
	if p1.NextStartSeq != 51 {
		t.Fatalf("next start: %d", p1.NextStartSeq)
	}
	// 尾页：101..120，has_more=false
	p3 := svc.BrowseStream(BrowserPageRequest{Stream: "PAGE", StartSeq: 101, Count: 50})
	if !p3.Ok() || len(p3.Messages) != 20 || p3.HasMore {
		t.Fatalf("page3: %+v", p3)
	}
	// 起点越过 last_seq → 空页
	pOver := svc.BrowseStream(BrowserPageRequest{Stream: "PAGE", StartSeq: 999, Count: 50})
	if !pOver.Ok() || len(pOver.Messages) != 0 || pOver.HasMore {
		t.Fatalf("over: %+v", pOver)
	}
	// count 闭集校验
	if res := svc.BrowseStream(BrowserPageRequest{Stream: "PAGE", StartSeq: 1, Count: 33}); res.ErrorCode != CodeValidation {
		t.Fatalf("count gate: %+v", res)
	}
	// StartSeq 0 归一化为 1（server 拒绝 opt_start_seq=0）
	p0 := svc.BrowseStream(BrowserPageRequest{Stream: "PAGE", StartSeq: 0, Count: 50})
	if !p0.Ok() || len(p0.Messages) != 50 || p0.Messages[0].Seq != 1 {
		t.Fatalf("start 0 must normalize to 1: %+v", p0)
	}
}

func TestBrowseSubjectFilter(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "FILT", 0)
	nc := svcRawConn(t, svc)
	for i := 0; i < 30; i++ {
		if err := nc.Publish("FILT.a", []byte("a")); err != nil {
			t.Fatal(err)
		}
		if err := nc.Publish("FILT.b", []byte("b")); err != nil {
			t.Fatal(err)
		}
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}
	p := svc.BrowseStream(BrowserPageRequest{Stream: "FILT", StartSeq: 1, Count: 100, SubjectFilter: "FILT.b"})
	if !p.Ok() || len(p.Messages) != 30 || p.HasMore {
		t.Fatalf("filter: %+v", p)
	}
	for _, m := range p.Messages {
		if m.Subject != "FILT.b" {
			t.Fatalf("foreign subject leaked: %s", m.Subject)
		}
	}
}

func TestGetAndRemoveMessage(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "ONE", 5)
	g := svc.GetStreamMessage("ONE", 3)
	if !g.Ok() || g.Msg.Seq != 3 || g.Msg.PayloadSize != 1 || !g.Msg.IsUtf8 {
		t.Fatalf("get: %+v", g)
	}
	if res := svc.RemoveStreamMessage("ONE", 3); !res.Ok() {
		t.Fatalf("remove: %+v", res)
	}
	d := svc.GetStreamDetail("ONE")
	if d.Summary.Messages != 4 || d.Summary.NumDeleted != 1 {
		t.Fatalf("after delete: %+v", d.Summary)
	}
	if g := svc.GetStreamMessage("ONE", 3); g.ErrorCode != CodeNotFound {
		t.Fatalf("deleted seq must 404: %+v", g)
	}
	// 删除后分页出现 seq 空洞（前端按缺口渲染标记）
	p := svc.BrowseStream(BrowserPageRequest{Stream: "ONE", StartSeq: 1, Count: 50})
	if len(p.Messages) != 4 || p.Messages[1].Seq != 2 || p.Messages[2].Seq != 4 {
		t.Fatalf("hole paging: %+v", p.Messages)
	}
}

// TestBrowsePagingLocalServer reruns the paging contract against the long-lived
// local server (unique-suffix stream; shared server hosts other streams).
func TestBrowsePagingLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newAdminConn(t, nc)
	name := "PAGE_" + uniqueSuffix()
	if res := svc.CreateStream(StreamForm{Name: name, Subjects: []string{name + ".>"}, Storage: "file", Retention: "limits", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	t.Cleanup(func() { _ = svc.DeleteStream(name) })
	ncp := svcRawConn(t, svc)
	for i := 1; i <= 120; i++ {
		if err := ncp.Publish(name+".a", []byte{byte('0' + i%10)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := ncp.Flush(); err != nil {
		t.Fatal(err)
	}

	p1 := svc.BrowseStream(BrowserPageRequest{Stream: name, StartSeq: 1, Count: 50})
	if !p1.Ok() || len(p1.Messages) != 50 || p1.Messages[0].Seq != 1 || p1.Messages[49].Seq != 50 || !p1.HasMore || p1.NextStartSeq != 51 {
		t.Fatalf("page1: %+v", p1)
	}
	p3 := svc.BrowseStream(BrowserPageRequest{Stream: name, StartSeq: 101, Count: 50})
	if !p3.Ok() || len(p3.Messages) != 20 || p3.HasMore {
		t.Fatalf("page3: %+v", p3)
	}
	pOver := svc.BrowseStream(BrowserPageRequest{Stream: name, StartSeq: 999, Count: 50})
	if !pOver.Ok() || len(pOver.Messages) != 0 || pOver.HasMore {
		t.Fatalf("over: %+v", pOver)
	}
	if res := svc.BrowseStream(BrowserPageRequest{Stream: name, StartSeq: 1, Count: 33}); res.ErrorCode != CodeValidation {
		t.Fatalf("count gate: %+v", res)
	}
}

// TestBrowseLargeDatasetLocalServer is the AC-028 full-scale Go-side half:
// 1,000,000 8-byte messages injected via PublishAsync, then tail-page and
// arbitrary-position jump browses must both surface content within 1s.
func TestBrowseLargeDatasetLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newAdminConn(t, nc)
	name := "BIG_" + uniqueSuffix()
	subject := "big." + name + ".msg"
	if res := svc.CreateStream(StreamForm{Name: name, Subjects: []string{"big." + name + ".*"}, Storage: "file", Retention: "limits", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	t.Cleanup(func() { _ = svc.DeleteStream(name) }) // 删流即清百万条；禁止逐条清理

	const total = 1_000_000
	// jetstream PublishAsync 携带真实 PubAck 回执（裸 nc.PublishAsync 对流
	// subject 无应答，future 永不 resolve）；限流 10k 在途，避免百万 future 常驻。
	jsPub, err := jetstream.New(nc, jetstream.WithPublishAsyncMaxPending(10_000))
	if err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, 8)
	setupStart := time.Now()
	for i := 0; i < total; i++ {
		// 首个 10k 突发在长驻 local server 上 ack 滞后会超过 nats.go 内置的
		// 200ms stall 窗口 → ErrTooManyStalledMsgs。该错误在消息上 wire 之前
		// 返回（PAF 已被库清除），重试即安全、无重复；库内 select 自带 200ms
		// 退避。仅豁免该瞬态错误，其余错误照常致命。
		for {
			_, err := jsPub.PublishAsync(subject, payload)
			if err == nil {
				break
			}
			if !errors.Is(err, jetstream.ErrTooManyStalledMsgs) {
				t.Fatal(err)
			}
			if time.Since(setupStart) > 120*time.Second {
				t.Fatalf("publish loop exceeded 120s (at %d/%d)", i, total)
			}
		}
	}
	select {
	case <-jsPub.PublishAsyncComplete():
	case <-time.After(120 * time.Second):
		t.Fatalf("PublishAsync setup exceeded 120s (elapsed %s)", time.Since(setupStart))
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}
	setupElapsed := time.Since(setupStart)
	t.Logf("setup: published %d messages in %s", total, setupElapsed)
	if setupElapsed > 60*time.Second {
		t.Errorf("PublishAsync setup took %s (>60s) — must be flagged, not silently reduced", setupElapsed)
	}

	d := svc.GetStreamDetail(name)
	if !d.Ok() || d.Summary.Messages != total {
		t.Fatalf("stream must hold %d messages: %+v", total, d.Summary)
	}

	// 首页正常
	p0 := svc.BrowseStream(BrowserPageRequest{Stream: name, StartSeq: 1, Count: 50})
	if !p0.Ok() || len(p0.Messages) != 50 || p0.Messages[0].Seq != 1 || !p0.HasMore {
		t.Fatalf("first page: %+v", p0)
	}

	// 尾页：999_951..1_000_000，50 条，≤1s
	tailStart := time.Now()
	pTail := svc.BrowseStream(BrowserPageRequest{Stream: name, StartSeq: 999_951, Count: 50})
	tailElapsed := time.Since(tailStart)
	if !pTail.Ok() || len(pTail.Messages) != 50 || pTail.Messages[0].Seq != 999_951 || pTail.HasMore {
		t.Fatalf("tail page: %+v", pTail)
	}
	if tailElapsed > time.Second {
		t.Fatalf("tail page took %s (>1s)", tailElapsed)
	}

	// 任意位置跳转：500_000 起 50 条，≤1s
	midStart := time.Now()
	pMid := svc.BrowseStream(BrowserPageRequest{Stream: name, StartSeq: 500_000, Count: 50})
	midElapsed := time.Since(midStart)
	if !pMid.Ok() || len(pMid.Messages) != 50 || pMid.Messages[0].Seq != 500_000 || !pMid.HasMore {
		t.Fatalf("mid page: %+v", pMid)
	}
	if midElapsed > time.Second {
		t.Fatalf("mid jump took %s (>1s)", midElapsed)
	}
	t.Logf("browse: tail=%s mid=%s", tailElapsed, midElapsed)
}

// TestBrowseWorkqueueSurfacesError pins that browsing a workqueue stream
// surfaces the server's error text (WQ requires explicit ack) classified as
// validation/server instead of an empty page.
func TestBrowseWorkqueueSurfacesError(t *testing.T) {
	svc := newAdmin(t, testutil.StartJSServer(t))
	if res := svc.CreateStream(StreamForm{Name: "WQ", Subjects: []string{"wq.>"}, Storage: "file", Retention: "workqueue", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	nc := svcRawConn(t, svc)
	if err := nc.Publish("wq.a", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}

	res := svc.BrowseStream(BrowserPageRequest{Stream: "WQ", StartSeq: 1, Count: 50})
	if res.Ok() {
		t.Fatalf("workqueue browse must fail, got page: %+v", res.Messages)
	}
	if res.Error == "" || (res.ErrorCode != CodeValidation && res.ErrorCode != CodeServer) {
		t.Fatalf("expected non-empty server error classified validation/server, got: %+v", res.CallResult)
	}
	t.Logf("workqueue browse error: %s / %s", res.ErrorCode, res.Error)
}

// startOversizeJSServer boots an embedded JS server with a raised max_payload
// (the 1.5MB truncation fixture exceeds the 1MB default server cap).
func startOversizeJSServer(t *testing.T) string {
	t.Helper()
	srv, err := server.NewServer(&server.Options{
		Port:       -1,
		ServerName: "TEST_JS_BIGPAYLOAD",
		StoreDir:   t.TempDir(),
		JetStream:  true,
		MaxPayload: 4 * 1024 * 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	go srv.Start()
	if !srv.ReadyForConnections(10 * time.Second) {
		t.Fatal("server not ready")
	}
	t.Cleanup(srv.Shutdown)
	return srv.ClientURL()
}

// TestBrowseOversizePayloadTruncated: browse rows carry only the first 64KB
// (Truncated=true, full PayloadSize); GetStreamMessage returns the complete
// payload and never sets Truncated.
func TestBrowseOversizePayloadTruncated(t *testing.T) {
	svc := newAdmin(t, startOversizeJSServer(t))
	if res := svc.CreateStream(StreamForm{Name: "BIGROW", Subjects: []string{"bigrow.>"}, Storage: "file", Retention: "limits", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	nc := svcRawConn(t, svc)
	full := make([]byte, 1_572_864) // 1.5MB
	for i := range full {
		full[i] = byte(i % 251)
	}
	if err := nc.Publish("bigrow.a", full); err != nil {
		t.Fatal(err)
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}

	p := svc.BrowseStream(BrowserPageRequest{Stream: "BIGROW", StartSeq: 1, Count: 20})
	if !p.Ok() || len(p.Messages) != 1 {
		t.Fatalf("page: %+v", p)
	}
	row := p.Messages[0]
	if !row.Truncated || row.PayloadSize != len(full) {
		t.Fatalf("row must be truncated with full size: truncated=%v size=%d", row.Truncated, row.PayloadSize)
	}
	raw, err := base64.StdEncoding.DecodeString(row.PayloadB64)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != browsePayloadPreviewLimit || !bytes.Equal(raw, full[:browsePayloadPreviewLimit]) {
		t.Fatalf("payload_b64 must be the exact %d-byte prefix (got %d bytes)", browsePayloadPreviewLimit, len(raw))
	}

	g := svc.GetStreamMessage("BIGROW", 1)
	if !g.Ok() || g.Msg == nil {
		t.Fatalf("get: %+v", g)
	}
	if g.Msg.Truncated || g.Msg.PayloadSize != len(full) {
		t.Fatalf("get must never truncate: truncated=%v size=%d", g.Msg.Truncated, g.Msg.PayloadSize)
	}
	got, err := base64.StdEncoding.DecodeString(g.Msg.PayloadB64)
	if err != nil || !bytes.Equal(got, full) {
		t.Fatalf("get must return the full payload (err=%v, %d bytes)", err, len(got))
	}
}
