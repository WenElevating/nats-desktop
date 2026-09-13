package buckets

import (
	"fmt"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// connStub 满足 BucketService 的 connSource 接口（service.go 定义），恒返回
// 给定连接与 domain/prefix——省去拉起完整 connections.Manager（对齐 jsadmin
// Task 3 模式；connStub/newSvc 后续任务复用）。
type connStub struct {
	nc     *nats.Conn
	domain string
	prefix string
}

func (c *connStub) Conn() *nats.Conn                 { return c.nc }
func (c *connStub) JSParams() (string, string, bool) { return c.domain, c.prefix, true }

func newSvc(t *testing.T, url string) *BucketService {
	t.Helper()
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { nc.Close() })
	return NewBucketService(&connStub{nc: nc}, nil, nil, "")
}

// newSvcConn 用现成连接构造服务（LocalServer 变体：ConnectLocalServer 已持有
// 拨号与 t.Cleanup，这里只包一层桩；不可达时 skip 而非 fail）。
func newSvcConn(t *testing.T, nc *nats.Conn) *BucketService {
	t.Helper()
	return NewBucketService(&connStub{nc: nc}, nil, nil, "")
}

func uniqueSuffix() string { return fmt.Sprintf("%d", time.Now().UnixNano()) }

// findKvBucket returns the summary for name, or nil (LocalServer variants list
// a shared server, so they assert on their own entries instead of totals).
func findKvBucket(buckets []KvBucketSummary, name string) *KvBucketSummary {
	for i := range buckets {
		if buckets[i].Name == name {
			return &buckets[i]
		}
	}
	return nil
}

func TestKvBucketLifecycle(t *testing.T) {
	svc := newSvc(t, testutil.StartJSServer(t))
	form := KvBucketForm{Name: "CFG", History: 5, Replicas: 1}
	if res := svc.CreateKvBucket(form); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	list := svc.ListKvBuckets()
	if !list.Ok() || len(list.KvBuckets) != 1 || list.KvBuckets[0].Name != "CFG" || list.KvBuckets[0].History != 5 {
		t.Fatalf("list: %+v", list)
	}
	// 详情 → 表单回显
	d := svc.GetKvBucketDetail("CFG")
	if !d.Ok() || d.Form.History != 5 {
		t.Fatalf("detail: %+v", d)
	}
	// 更新（history 5→10）
	form.History = 10
	if res := svc.UpdateKvBucket(form); !res.Ok() {
		t.Fatalf("update: %+v", res)
	}
	if d = svc.GetKvBucketDetail("CFG"); !d.Ok() || d.Form.History != 10 {
		t.Fatalf("after update: %+v", d.Form)
	}
	// 删除
	if res := svc.DeleteKvBucket("CFG"); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	if list = svc.ListKvBuckets(); !list.Ok() || len(list.KvBuckets) != 0 {
		t.Fatalf("after delete: %+v", list)
	}
}

func TestKvBucketValidationAndErrors(t *testing.T) {
	svc := newSvc(t, testutil.StartJSServer(t))
	if res := svc.CreateKvBucket(KvBucketForm{Name: "", Replicas: 1}); res.ErrorCode != CodeValidation {
		t.Fatalf("gate: %+v", res)
	}
	if res := svc.CreateKvBucket(KvBucketForm{Name: "CFG", Replicas: 1}); !res.Ok() {
		t.Fatal(res)
	}
	// 重复创建 → conflict。注意：nats-server 对"完全相同配置"的重复 CREATE 是幂等成功
	// （DeepEqual 短路，server/stream.go:881-905；nats.go 客户端另有同构兼容分支）——
	// 必须用**差异配置**（不同 Description）才能确定性拿到 ErrBucketExists。
	if res := svc.CreateKvBucket(KvBucketForm{Name: "CFG", Description: "other", Replicas: 1}); res.ErrorCode != CodeConflict {
		t.Fatalf("dup: %+v", res)
	}
	if res := svc.DeleteKvBucket("NOPE"); res.ErrorCode != CodeNotFound {
		t.Fatalf("missing: %+v", res)
	}
}

// TestKvBucketLifecycleLocalServer reruns the lifecycle against the long-lived
// local server. Bucket names carry uniqueSuffix (shared server hosts other
// buckets), so list checks assert on our own entries, not totals.
func TestKvBucketLifecycleLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newSvcConn(t, nc)
	name := "CFG_" + uniqueSuffix()
	t.Cleanup(func() { _ = svc.DeleteKvBucket(name) }) // 尽力清理；失败（已删/不存在）不影响断言

	form := KvBucketForm{Name: name, History: 5, Replicas: 1}
	if res := svc.CreateKvBucket(form); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	list := svc.ListKvBuckets()
	if !list.Ok() {
		t.Fatalf("list: %+v", list)
	}
	sum := findKvBucket(list.KvBuckets, name)
	if sum == nil || sum.History != 5 {
		t.Fatalf("list missing %s or wrong history: %+v", name, list)
	}
	// 详情 → 表单回显
	d := svc.GetKvBucketDetail(name)
	if !d.Ok() || d.Form.Name != name || d.Form.History != 5 {
		t.Fatalf("detail: %+v", d)
	}
	// 更新（history 5→10）
	form.History = 10
	if res := svc.UpdateKvBucket(form); !res.Ok() {
		t.Fatalf("update: %+v", res)
	}
	if d = svc.GetKvBucketDetail(name); !d.Ok() || d.Form.History != 10 {
		t.Fatalf("after update: %+v", d.Form)
	}
	// 删除 → 列表消失；重复删除 → not_found（共享服务器上确定性断言）
	if res := svc.DeleteKvBucket(name); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	list = svc.ListKvBuckets()
	if !list.Ok() || findKvBucket(list.KvBuckets, name) != nil {
		t.Fatalf("after delete %s still present: %+v", name, list)
	}
	if res := svc.DeleteKvBucket(name); res.ErrorCode != CodeNotFound {
		t.Fatalf("double delete: %+v", res)
	}
}

// TestKvBucketListUnavailableLocalServer mirrors jsadmin's wrong-API-prefix
// case: the JSParams stub returns a bogus prefix, so the KV lister lands on
// unanswered subjects — unavailable guidance, not an empty-looking success.
func TestKvBucketListUnavailableLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := NewBucketService(&connStub{nc: nc, prefix: "$WRONG.API"}, nil, nil, "")
	list := svc.ListKvBuckets()
	if list.Ok() || list.UnavailableReason != ReasonNoResponders || len(list.KvBuckets) != 0 {
		t.Fatalf("expected unavailable guidance, got %+v", list)
	}
}
