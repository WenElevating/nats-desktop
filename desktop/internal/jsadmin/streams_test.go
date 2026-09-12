package jsadmin

import (
	"fmt"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// connStub 满足 JetAdminService 的 connSource 接口（service.go 定义），
// 恒返回给定连接与 domain/prefix——省去拉起完整 connections.Manager。
type connStub struct {
	nc     *nats.Conn
	domain string
	prefix string
}

func (c *connStub) Conn() *nats.Conn                 { return c.nc }
func (c *connStub) JSParams() (string, string, bool) { return c.domain, c.prefix, true }

func newAdmin(t *testing.T, url string) *JetAdminService {
	t.Helper()
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { nc.Close() })
	return newAdminConn(t, nc)
}

// newAdminWithPrefix 模拟错误 API 前缀：JSParams 替身直接返回给定前缀，
// JS 请求因此落到无人应答的主题上（unavailable 语义，spec §6.6）。
func newAdminWithPrefix(t *testing.T, url, prefix string) *JetAdminService {
	t.Helper()
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { nc.Close() })
	return newAdminConnWithPrefix(t, nc, prefix)
}

// newAdminConn 用现成连接构造服务（LocalServer 变体：ConnectLocalServer 已
// 持有拨号与 t.Cleanup，这里只包一层桩）。
func newAdminConn(t *testing.T, nc *nats.Conn) *JetAdminService {
	t.Helper()
	return NewJetAdminService(&connStub{nc: nc}, nil, nil, "")
}

func newAdminConnWithPrefix(t *testing.T, nc *nats.Conn, prefix string) *JetAdminService {
	t.Helper()
	return NewJetAdminService(&connStub{nc: nc, prefix: prefix}, nil, nil, "")
}

// svcRawConn 取回桩持有的连接，供测试直接注入/发布消息。
func svcRawConn(t *testing.T, svc *JetAdminService) *nats.Conn {
	t.Helper()
	return svc.mgr.(interface{ Conn() *nats.Conn }).Conn()
}

func uniqueSuffix() string { return fmt.Sprintf("%d", time.Now().UnixNano()) }

func publishN(t *testing.T, svc *JetAdminService, subject string, n int) {
	t.Helper()
	nc := svcRawConn(t, svc)
	for i := 0; i < n; i++ {
		if err := nc.Publish(subject, []byte{byte('0' + i%10)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}
}

// findStream returns the summary for name, or nil (LocalServer variants list a
// shared server, so they assert on their own entries instead of totals).
func findStream(streams []StreamSummary, name string) *StreamSummary {
	for i := range streams {
		if streams[i].Name == name {
			return &streams[i]
		}
	}
	return nil
}

// waitListMessages polls ListStreams until the named stream reports want
// messages. The pinned v2.15-preview server maintains the STREAM.LIST fast
// state counters via an async flush loop (filestore flushStreamStateLoop), so
// a count read right after publish+Flush can lag; STREAM INFO (GetStreamDetail)
// and PurgeExt counts are synchronous and need no polling.
func waitListMessages(t *testing.T, svc *JetAdminService, name string, want uint64) *StreamSummary {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		list := svc.ListStreams()
		if !list.Ok() {
			t.Fatalf("list failed: %+v", list)
		}
		if sum := findStream(list.Streams, name); sum != nil && sum.Messages == want {
			return sum
		}
		if time.Now().After(deadline) {
			t.Fatalf("stream %s never showed %d messages: %+v", name, want, list)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitDetailMessages polls GetStreamDetail until the named stream reports want
// messages (2s bound, same rationale as waitListMessages). Needed after
// CopyStream: the call returns once the mirror stream exists, but the mirror
// replicates the source data asynchronously — asserting immediately would let
// an empty-copy regression pass. (STREAM INFO counts are synchronous; the wait
// here is for mirror catch-up, not counter flush.)
func waitDetailMessages(t *testing.T, svc *JetAdminService, name string, want uint64) StreamDetail {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		d := svc.GetStreamDetail(name)
		if d.Ok() && d.Summary.Messages == want {
			return d
		}
		if time.Now().After(deadline) {
			t.Fatalf("stream %s detail never showed %d messages: %+v", name, want, d)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestStreamLifecycle(t *testing.T) {
	svc := newAdmin(t, testutil.StartJSServer(t))
	form := StreamForm{Name: "ORDERS", Subjects: []string{"orders.>"}, Storage: "file", Retention: "limits", Replicas: 1}
	if res := svc.CreateStream(form); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	list := svc.ListStreams()
	if !list.Ok() || len(list.Streams) != 1 || list.Streams[0].Name != "ORDERS" {
		t.Fatalf("list: %+v", list)
	}
	// 发布 3 条 → 列表计数（STREAM.LIST 计数异步刷新，见 waitListMessages）
	publishN(t, svc, "orders.a", 3)
	list = svc.ListStreams()
	if list.Streams[0].Name != "ORDERS" {
		t.Fatalf("expected ORDERS, got %+v", list)
	}
	if sum := waitListMessages(t, svc, "ORDERS", 3); sum.Messages != 3 {
		t.Fatalf("expected 3 messages, got %d", sum.Messages)
	}
	// 更新（改动 limits + description）
	form.Description = "edited"
	form.MaxMsgs = 100
	if res := svc.UpdateStream(form); !res.Ok() {
		t.Fatalf("update: %+v", res)
	}
	detail := svc.GetStreamDetail("ORDERS")
	if !detail.Ok() || detail.Form.Description != "edited" || detail.Form.MaxMsgs != 100 {
		t.Fatalf("detail after update: %+v", detail.Form)
	}
	// 复制（subjects 重叠 → 服务器按镜像实现；源端 3 条已先行发布，镜像追赶
	// 当前源数据是确定性的）
	if res := svc.CopyStream("ORDERS", "ORDERS_COPY"); !res.Ok() {
		t.Fatalf("copy: %+v", res)
	}
	// 副本必须呈 mirror 且复制到源端 3 条数据（镜像异步追赶，轮询等待；
	// 空副本回归在此被拦截）
	copyDetail := waitDetailMessages(t, svc, "ORDERS_COPY", 3)
	if !copyDetail.Summary.IsMirror {
		t.Fatalf("copy must render as mirror: %+v", copyDetail.Summary)
	}
	// purge（带计数）
	p := svc.PurgeStream("ORDERS", 0, 0, "")
	if !p.Ok() || p.Purged != 3 {
		t.Fatalf("purge: %+v", p)
	}
	if d := svc.GetStreamDetail("ORDERS"); d.Summary.Messages != 0 {
		t.Fatalf("purge must empty stream, got %d", d.Summary.Messages)
	}
	// 封存：sealed 流仍可读取（写路径被服务器拒绝的完整断言属 Task 10 服务器错误透传测试）
	if res := svc.SealStream("ORDERS"); !res.Ok() {
		t.Fatalf("seal: %+v", res)
	}
	if d := svc.GetStreamDetail("ORDERS"); !d.Ok() {
		t.Fatalf("sealed stream must still be readable: %+v", d)
	}
	// 删除（二级确认在 UI 层；服务端一层）
	if res := svc.DeleteStream("ORDERS_COPY"); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	list = svc.ListStreams()
	if len(list.Streams) != 1 { // 只剩 ORDERS
		t.Fatalf("expected 1 stream after delete, got %d", len(list.Streams))
	}
}

func TestListStreamsNotFoundAndUnavailable(t *testing.T) {
	svc := newAdmin(t, testutil.StartJSServer(t))
	if d := svc.GetStreamDetail("NOPE"); d.ErrorCode != CodeNotFound {
		t.Fatalf("expected not_found, got %+v", d.CallResult)
	}
	svc2 := newAdminWithPrefix(t, testutil.StartJSServer(t), "$WRONG.API") // JSParams 替身返回错误前缀
	list := svc2.ListStreams()
	if list.UnavailableReason != ReasonNoResponders || len(list.Streams) != 0 {
		t.Fatalf("expected unavailable guidance, got %+v", list)
	}
}

func TestStreamValidationGates(t *testing.T) {
	svc := newAdmin(t, testutil.StartJSServer(t))
	if res := svc.CreateStream(StreamForm{Name: "", Subjects: nil, Storage: "file", Retention: "limits"}); res.ErrorCode != CodeValidation {
		t.Fatalf("expected validation gate, got %+v", res)
	}
}

// TestStreamLifecycleLocalServer reruns the lifecycle against the long-lived
// local server. Stream/subject names carry uniqueSuffix (shared server hosts
// other streams), so list checks assert on our own entries, not totals.
func TestStreamLifecycleLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newAdminConn(t, nc)
	suffix := uniqueSuffix()
	name := "ORDERS_" + suffix
	copyName := "ORDERS_COPY_" + suffix
	subject := "orders." + suffix + ".>"
	t.Cleanup(func() {
		_ = svc.DeleteStream(name) // 尽力清理；失败（已删/不存在）不影响断言
		_ = svc.DeleteStream(copyName)
	})

	form := StreamForm{Name: name, Subjects: []string{subject}, Storage: "file", Retention: "limits", Replicas: 1}
	if res := svc.CreateStream(form); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	list := svc.ListStreams()
	if !list.Ok() || findStream(list.Streams, name) == nil {
		t.Fatalf("list missing %s: %+v", name, list)
	}
	// 发布 3 条 → 列表计数（STREAM.LIST 计数异步刷新，见 waitListMessages）
	publishN(t, svc, "orders."+suffix+".a", 3)
	sum := waitListMessages(t, svc, name, 3)
	if sum.Subjects == nil || len(sum.Subjects) != 1 || sum.Subjects[0] != subject {
		t.Fatalf("expected subject %q, got %+v", subject, sum)
	}
	// 更新（改动 limits + description）
	form.Description = "edited"
	form.MaxMsgs = 100
	if res := svc.UpdateStream(form); !res.Ok() {
		t.Fatalf("update: %+v", res)
	}
	detail := svc.GetStreamDetail(name)
	if !detail.Ok() || detail.Form.Description != "edited" || detail.Form.MaxMsgs != 100 {
		t.Fatalf("detail after update: %+v", detail.Form)
	}
	// 复制（subjects 重叠 → 服务器按镜像实现；源端 3 条已先行发布，镜像追赶
	// 当前源数据是确定性的）
	if res := svc.CopyStream(name, copyName); !res.Ok() {
		t.Fatalf("copy: %+v", res)
	}
	// 副本必须呈 mirror 且复制到源端 3 条数据（镜像异步追赶，轮询等待；
	// 空副本回归在此被拦截）
	copyDetail := waitDetailMessages(t, svc, copyName, 3)
	if !copyDetail.Summary.IsMirror {
		t.Fatalf("copy must render as mirror: %+v", copyDetail.Summary)
	}
	// purge（带计数）
	p := svc.PurgeStream(name, 0, 0, "")
	if !p.Ok() || p.Purged != 3 {
		t.Fatalf("purge: %+v", p)
	}
	if d := svc.GetStreamDetail(name); d.Summary.Messages != 0 {
		t.Fatalf("purge must empty stream, got %d", d.Summary.Messages)
	}
	// 封存：sealed 流仍可读取
	if res := svc.SealStream(name); !res.Ok() {
		t.Fatalf("seal: %+v", res)
	}
	if d := svc.GetStreamDetail(name); !d.Ok() {
		t.Fatalf("sealed stream must still be readable: %+v", d)
	}
	// 删除副本；原名保留
	if res := svc.DeleteStream(copyName); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	list = svc.ListStreams()
	if !list.Ok() || findStream(list.Streams, name) == nil || findStream(list.Streams, copyName) != nil {
		t.Fatalf("expected %s to remain and %s gone: %+v", name, copyName, list)
	}
}

func TestListStreamsUnavailableLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newAdminConnWithPrefix(t, nc, "$WRONG.API")
	list := svc.ListStreams()
	if list.UnavailableReason != ReasonNoResponders || len(list.Streams) != 0 {
		t.Fatalf("expected unavailable guidance, got %+v", list)
	}
}

// TestPurgeKeepAndSubjectLocalServer covers keep=N and subject-filtered
// purge with exact Purged counts on the real local server.
func TestPurgeKeepAndSubjectLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newAdminConn(t, nc)
	suffix := uniqueSuffix()
	name := "PURGE_" + suffix
	subjA := "purge." + suffix + ".a"
	subjB := "purge." + suffix + ".b"
	form := StreamForm{Name: name, Subjects: []string{"purge." + suffix + ".*"}, Storage: "file", Retention: "limits", Replicas: 1}
	if res := svc.CreateStream(form); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	t.Cleanup(func() { _ = svc.DeleteStream(name) })

	publishN(t, svc, subjA, 3)
	publishN(t, svc, subjB, 2)
	// keep=2：保留最新 2 条（subjB），清掉 3 条
	p := svc.PurgeStream(name, 2, 0, "")
	if !p.Ok() || p.Purged != 3 {
		t.Fatalf("keep purge: %+v", p)
	}
	// 再发 3 条到 subjA，按 subject 过滤 purge 只清 subjA
	publishN(t, svc, subjA, 3)
	p = svc.PurgeStream(name, 0, 0, subjA)
	if !p.Ok() || p.Purged != 3 {
		t.Fatalf("subject purge: %+v", p)
	}
	if d := svc.GetStreamDetail(name); !d.Ok() || d.Summary.Messages != 2 {
		t.Fatalf("expected 2 remaining messages, got %+v", d.Summary)
	}
}
