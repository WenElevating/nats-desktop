package jsadmin

import (
	"strings"
	"testing"
	"time"

	"github.com/nats-io/jsm.go/api"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

func consumerForm(stream, durable string) ConsumerForm {
	return ConsumerForm{Stream: stream, Durable: durable, DeliverMode: "pull",
		AckPolicy: "explicit", DeliverPolicy: "all", ReplayPolicy: "instant",
		FilterSubjects: []string{stream + ".a"}}
}

func TestConsumerLifecycle(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "CSTR", 10)
	if res := svc.CreateConsumer(consumerForm("CSTR", "worker")); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	list := svc.ListConsumers("CSTR")
	if !list.Ok() || len(list.Consumers) != 1 || list.Consumers[0].Name != "worker" || !list.Consumers[0].IsPull {
		t.Fatalf("list: %+v", list)
	}
	// 拉取预览：批量 5、默认不 ack → NumAckPending 上升
	prev := svc.PreviewNext("CSTR", "worker", 5, false)
	if !prev.Ok() || len(prev.Messages) != 5 || prev.Messages[0].NumDelivered != 1 {
		t.Fatalf("preview: %+v", prev)
	}
	d := svc.GetConsumerDetail("CSTR", "worker")
	if !d.Ok() || d.Summary.NumAckPending != 5 {
		t.Fatalf("pending after no-ack preview: %+v", d.Summary)
	}
	// 自动 ack 预览 → ack floor 前进。注意：已投递未 ack 的消息不会立刻重投
	//（ack_wait 内的下一次 Fetch 拿到的是其后新消息，服务器按 delivered 游标
	// 前进），所以 floor 断言用一条未被预览过的消费者钉死 0→5。
	if res := svc.CreateConsumer(consumerForm("CSTR", "worker_ack")); !res.Ok() {
		t.Fatalf("create ack-floor consumer: %+v", res)
	}
	if res := svc.PreviewNext("CSTR", "worker_ack", 5, true); !res.Ok() {
		t.Fatalf("ack preview: %+v", res)
	}
	if sum := waitAckFloor(t, svc, "CSTR", "worker_ack", 5); sum.NumAckPending != 0 {
		t.Fatalf("ack floor advanced but acks pending: %+v", sum)
	}
	// 更新（改 ack_wait/description）
	f := consumerForm("CSTR", "worker")
	f.Description = "edited"
	f.AckWaitSeconds = 30
	if res := svc.UpdateConsumer(f); !res.Ok() {
		t.Fatalf("update: %+v", res)
	}
	if d = svc.GetConsumerDetail("CSTR", "worker"); !d.Ok() || d.Form.AckWaitSeconds != 30 {
		t.Fatalf("after update: %+v", d.Form)
	}
	// 复制 / 重置 / 删除
	if res := svc.CopyConsumer("CSTR", "worker", "worker2"); !res.Ok() {
		t.Fatalf("copy: %+v", res)
	}
	if res := svc.ResetConsumer("CSTR", "worker", 0); !res.Ok() {
		t.Fatalf("reset: %+v", res)
	}
	if d = svc.GetConsumerDetail("CSTR", "worker"); d.Summary.DeliveredConsumerSeq != 0 {
		t.Fatalf("reset must clear delivery: %+v", d.Summary)
	}
	if res := svc.DeleteConsumer("CSTR", "worker2"); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
}

func TestPauseResumeAndGates(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "CSTR", 10) // 内嵌 2.15-preview：支持 pause
	if res := svc.CreateConsumer(consumerForm("CSTR", "pw")); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	p := svc.PauseConsumer("CSTR", "pw", 60)
	if !p.Ok() || !p.Paused || p.RemainingMs <= 0 {
		t.Fatalf("pause: %+v", p)
	}
	// 暂停中拉取被拒（§6.7 异常表）
	if res := svc.PreviewNext("CSTR", "pw", 1, false); res.ErrorCode != CodeValidation {
		t.Fatalf("paused fetch gate: %+v", res)
	}
	if res := svc.ResumeConsumer("CSTR", "pw"); !res.Ok() {
		t.Fatalf("resume: %+v", res)
	}
	if res := svc.PreviewNext("CSTR", "pw", 1, false); !res.Ok() {
		t.Fatalf("fetch after resume: %+v", res)
	}
	// 批量闭集 1–256
	if res := svc.PreviewNext("CSTR", "pw", 999, false); res.ErrorCode != CodeValidation {
		t.Fatalf("batch gate: %+v", res)
	}
	// 旧服务器版本门（桩注入 serverVersion）
	if _, err := pauseGate("2.10.24"); err == nil {
		t.Fatal("pause must be gated on 2.11")
	}
	if _, err := pauseGate("2.15.0-preview.1"); err != nil {
		t.Fatalf("2.15 must pass: %v", err)
	}
}

// TestConsumerLifecycleLocalServer reruns the lifecycle against the long-lived
// local server (unique-suffix stream/consumers; shared server hosts others).
func TestConsumerLifecycleLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newAdminConn(t, nc)
	suffix := uniqueSuffix()
	stream := "CSTR_" + suffix
	name := "worker_" + suffix
	nameAck := "worker_ack_" + suffix
	nameCopy := "worker2_" + suffix
	t.Cleanup(func() { _ = svc.DeleteStream(stream) }) // 删流即清消费者

	if res := svc.CreateStream(StreamForm{Name: stream, Subjects: []string{stream + ".>"}, Storage: "file", Retention: "limits", Replicas: 1}); !res.Ok() {
		t.Fatalf("create stream: %+v", res)
	}
	publishN(t, svc, stream+".a", 10)

	if res := svc.CreateConsumer(consumerForm(stream, name)); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	list := svc.ListConsumers(stream)
	if !list.Ok() || findConsumer(list.Consumers, name) == nil || !findConsumer(list.Consumers, name).IsPull {
		t.Fatalf("list missing %s: %+v", name, list)
	}
	prev := svc.PreviewNext(stream, name, 5, false)
	if !prev.Ok() || len(prev.Messages) != 5 || prev.Messages[0].NumDelivered != 1 {
		t.Fatalf("preview: %+v", prev)
	}
	d := svc.GetConsumerDetail(stream, name)
	if !d.Ok() || d.Summary.NumAckPending != 5 {
		t.Fatalf("pending after no-ack preview: %+v", d.Summary)
	}
	if res := svc.CreateConsumer(consumerForm(stream, nameAck)); !res.Ok() {
		t.Fatalf("create ack-floor consumer: %+v", res)
	}
	if res := svc.PreviewNext(stream, nameAck, 5, true); !res.Ok() {
		t.Fatalf("ack preview: %+v", res)
	}
	if sum := waitAckFloor(t, svc, stream, nameAck, 5); sum.NumAckPending != 0 {
		t.Fatalf("ack floor advanced but acks pending: %+v", sum)
	}
	f := consumerForm(stream, name)
	f.Description = "edited"
	f.AckWaitSeconds = 30
	if res := svc.UpdateConsumer(f); !res.Ok() {
		t.Fatalf("update: %+v", res)
	}
	if d = svc.GetConsumerDetail(stream, name); !d.Ok() || d.Form.AckWaitSeconds != 30 || d.Form.Description != "edited" {
		t.Fatalf("after update: %+v", d.Form)
	}
	if res := svc.CopyConsumer(stream, name, nameCopy); !res.Ok() {
		t.Fatalf("copy: %+v", res)
	}
	if res := svc.ResetConsumer(stream, name, 0); !res.Ok() {
		t.Fatalf("reset: %+v", res)
	}
	if d = svc.GetConsumerDetail(stream, name); d.Summary.DeliveredConsumerSeq != 0 {
		t.Fatalf("reset must clear delivery: %+v", d.Summary)
	}
	if res := svc.DeleteConsumer(stream, nameCopy); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	list = svc.ListConsumers(stream)
	if !list.Ok() || findConsumer(list.Consumers, nameCopy) != nil || findConsumer(list.Consumers, name) == nil {
		t.Fatalf("expected %s gone and %s present: %+v", nameCopy, name, list)
	}
}

// TestPauseResumeLocalServer covers pause/resume + preview gates on the real
// local server (2.15-preview, supports pause).
func TestPauseResumeLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newAdminConn(t, nc)
	suffix := uniqueSuffix()
	stream := "CPZ_" + suffix
	name := "pw_" + suffix
	t.Cleanup(func() { _ = svc.DeleteStream(stream) })

	if res := svc.CreateStream(StreamForm{Name: stream, Subjects: []string{stream + ".>"}, Storage: "file", Retention: "limits", Replicas: 1}); !res.Ok() {
		t.Fatalf("create stream: %+v", res)
	}
	publishN(t, svc, stream+".a", 10)
	if res := svc.CreateConsumer(consumerForm(stream, name)); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	p := svc.PauseConsumer(stream, name, 60)
	if !p.Ok() || !p.Paused || p.RemainingMs <= 0 {
		t.Fatalf("pause: %+v", p)
	}
	if res := svc.PreviewNext(stream, name, 1, false); res.ErrorCode != CodeValidation {
		t.Fatalf("paused fetch gate: %+v", res)
	}
	if res := svc.ResumeConsumer(stream, name); !res.Ok() {
		t.Fatalf("resume: %+v", res)
	}
	if res := svc.PreviewNext(stream, name, 1, false); !res.Ok() {
		t.Fatalf("fetch after resume: %+v", res)
	}
	if res := svc.PreviewNext(stream, name, 999, false); res.ErrorCode != CodeValidation {
		t.Fatalf("batch gate: %+v", res)
	}
	if res := svc.PreviewNext(stream, name, 0, false); res.ErrorCode != CodeValidation {
		t.Fatalf("batch 0 gate: %+v", res)
	}
}

// TestPushConsumerFetchRejected: a push consumer must reject preview with the
// jetstream not-a-pull-consumer sentinel mapped to validation.
func TestPushConsumerFetchRejected(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "CPUSH", 3)
	f := consumerForm("CPUSH", "pushw")
	f.DeliverMode = "push"
	f.DeliverSubject = "push.outside" // 必须落在流 subjects（CPUSH.>）之外
	if res := svc.CreateConsumer(f); !res.Ok() {
		t.Fatalf("create push consumer: %+v", res)
	}
	res := svc.PreviewNext("CPUSH", "pushw", 1, false)
	if res.ErrorCode != CodeValidation || !strings.Contains(res.Error, "not a pull consumer") {
		t.Fatalf("push fetch must be rejected as validation: %+v", res)
	}
}

// TestConsumerNotFoundRefresh: a consumer deleted outside the app must yield
// not_found on detail and preview (§6.7 异常表第 1 行 → 前端刷新列表)。
func TestConsumerNotFoundRefresh(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "CGONE", 5)
	if res := svc.CreateConsumer(consumerForm("CGONE", "ghost")); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	nc := svcRawConn(t, svc)
	if _, err := nc.Request("$JS.API.CONSUMER.DELETE.CGONE.ghost", nil, 2*time.Second); err != nil {
		t.Fatalf("external delete: %v", err)
	}
	if d := svc.GetConsumerDetail("CGONE", "ghost"); d.ErrorCode != CodeNotFound {
		t.Fatalf("detail must report not_found after external delete: %+v", d.CallResult)
	}
	if res := svc.PreviewNext("CGONE", "ghost", 1, false); res.ErrorCode != CodeNotFound {
		t.Fatalf("preview must report not_found after external delete: %+v", res.CallResult)
	}
}

// TestConsumerEditImmutableRejected: changing deliver_policy on edit must
// surface the server's 400 original text as validation.
func TestConsumerEditImmutableRejected(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "CEDIT", 5)
	if res := svc.CreateConsumer(consumerForm("CEDIT", "fixed")); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	f := consumerForm("CEDIT", "fixed")
	f.DeliverPolicy = "new" // 不可变字段变更
	res := svc.UpdateConsumer(f)
	if res.ErrorCode != CodeValidation || res.Error == "" {
		t.Fatalf("immutable deliver_policy change must surface server 400: %+v", res)
	}
	// 详情确认 deliver_policy 未被改动（服务器拒绝后现值不变）
	if d := svc.GetConsumerDetail("CEDIT", "fixed"); !d.Ok() || d.Form.DeliverPolicy != "all" {
		t.Fatalf("deliver_policy must be unchanged: %+v", d.Form)
	}
}

// waitAckFloor polls GetConsumerDetail until the consumer's ack floor reaches
// want. Ack propagation (async ack replies + server-side floor advance) is not
// synchronous with m.Ack(), so an immediate read can still see the old floor.
func waitAckFloor(t *testing.T, svc *JetAdminService, stream, name string, want uint64) ConsumerSummary {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		d := svc.GetConsumerDetail(stream, name)
		if d.Ok() && d.Summary.AckFloorConsumer == want {
			return d.Summary
		}
		if time.Now().After(deadline) {
			t.Fatalf("consumer %s ack floor never reached %d: %+v", name, want, d.Summary)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestClassifyConsumerCreateRejection pins the wire reality that the server
// wraps consumer create/update config rejections (immutable-field checks etc.)
// in the generic HTTP-500 envelope err_code 10012 — classified as validation
// with the original text, while plain 500s stay server.
func TestClassifyConsumerCreateRejection(t *testing.T) {
	res := ClassifyError(api.ApiError{Code: 500, ErrCode: 10012, Description: "deliver policy can not be updated"})
	if res.ErrorCode != CodeValidation || res.Error == "" {
		t.Fatalf("10012 envelope must classify as validation: %+v", res)
	}
	if res := ClassifyError(api.ApiError{Code: 500, Description: "boom"}); res.ErrorCode != CodeServer {
		t.Fatalf("plain 500 must stay server: %+v", res)
	}
}

// findConsumer returns the summary for name, or nil (LocalServer variants list
// consumers on a shared server's own streams only, but the helper keeps the
// assertions symmetric with findStream).
func findConsumer(consumers []ConsumerSummary, name string) *ConsumerSummary {
	for i := range consumers {
		if consumers[i].Name == name {
			return &consumers[i]
		}
	}
	return nil
}
