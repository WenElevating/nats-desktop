package buckets

import (
	"encoding/base64"
	"fmt"
	"strings"
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

// TestObjBucketListUnavailableLocalServer mirrors the KV wrong-API-prefix
// case for the object half: the JS lister lands on unanswered subjects —
// unavailable guidance (no_responders), not an empty-looking success.
func TestObjBucketListUnavailableLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := NewBucketService(&connStub{nc: nc, prefix: "$WRONG.API"}, nil, nil, "")
	list := svc.ListObjBuckets()
	if list.Ok() || list.UnavailableReason != ReasonNoResponders || len(list.ObjBuckets) != 0 {
		t.Fatalf("expected unavailable guidance, got %+v", list)
	}
}

// b64/mustB64 键值 wire 编码助手（payload_b64 = base64.StdEncoding）；findKey
// 返回键在列表中的下标（未命中 -1）。
func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func mustB64(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func findKey(keys []KeyMeta, k string) int {
	for i := range keys {
		if keys[i].Key == k {
			return i
		}
	}
	return -1
}

// TestKvKeyLifecycle 走键操作全链路（§6.8）：put 三语义（含两种冲突路径）、
// 历史、删除态感知 revert、del/purge 两模式。修订号 = 桶底层流序列，全局
// 递增——本测试内只按预期顺序写入，故序号可精确断言（1..7）：键 a 依次
// put1=1, put2=2, create 冲突（无写入）, update 冲突（无写入）, update3=3,
// revert=4(v2), delete marker=5, revert-after-delete=6(v2)；键 b create=7。
func TestKvKeyLifecycle(t *testing.T) {
	svc := newSvc(t, testutil.StartJSServer(t))
	svc.CreateKvBucket(KvBucketForm{Name: "OPS", History: 10, Replicas: 1})
	// 键 a 系列（修订号 = 桶底层流序列，全局递增——本块内只写 a，序号可预测）
	r1 := svc.PutKey("OPS", "a", b64("v1"), "put", 0)
	if !r1.Ok() || r1.Revision != 1 {
		t.Fatalf("put1: %+v", r1)
	}
	r2 := svc.PutKey("OPS", "a", b64("v2"), "put", 0)
	if !r2.Ok() || r2.Revision != 2 {
		t.Fatalf("put2: %+v", r2)
	}
	// create 冲突（§6.8 异常 1，无写入不占序列）
	if res := svc.PutKey("OPS", "a", b64("x"), "create", 0); res.ErrorCode != CodeConflict {
		t.Fatalf("create conflict: %+v", res)
	}
	// update 期望不符 → conflict + CurrentRevision（§6.8 异常 2，无写入）
	if res := svc.PutKey("OPS", "a", b64("v3"), "update", 1); res.ErrorCode != CodeConflict || res.CurrentRevision != 2 {
		t.Fatalf("update conflict: %+v", res)
	}
	if r3 := svc.PutKey("OPS", "a", b64("v3"), "update", 2); !r3.Ok() || r3.Revision != 3 {
		t.Fatalf("update ok: %+v", r3)
	}
	// 历史（3 次修订含值，升序）
	h := svc.GetKeyHistory("OPS", "a")
	if !h.Ok() || len(h.Entries) != 3 || h.Entries[0].Revision != 1 {
		t.Fatalf("history: %+v", h)
	}
	// revert → 回到 v2（put 产生 revision 4）
	r4 := svc.RevertKey("OPS", "a")
	if !r4.Ok() || r4.Revision != 4 {
		t.Fatalf("revert: %+v", r4)
	}
	v := svc.GetKeyValues("OPS", []string{"a"})
	if string(mustB64(v.Values[0].PayloadB64)) != "v2" {
		t.Fatalf("revert value: %+v", v.Values[0])
	}
	// del（保留历史）→ 列表标记 delete；历史仍在（4 修订 + marker=5 条）
	if res := svc.DeleteKey("OPS", "a", "delete"); !res.Ok() {
		t.Fatalf("del: %+v", res)
	}
	kl := svc.ListKeys("OPS")
	if kl.Keys[findKey(kl.Keys, "a")].Operation != "delete" {
		t.Fatalf("after del: %+v", kl.Keys)
	}
	if h = svc.GetKeyHistory("OPS", "a"); !h.Ok() || len(h.Entries) != 5 {
		t.Fatalf("history after del: %+v", h)
	}
	// 删除态 revert（F-09 语义）：最新为 delete marker → 恢复最后有效值 v2（put 产生 revision 6）
	r6 := svc.RevertKey("OPS", "a")
	if !r6.Ok() || r6.Revision != 6 {
		t.Fatalf("revert after delete: %+v", r6)
	}
	v = svc.GetKeyValues("OPS", []string{"a"})
	if string(mustB64(v.Values[0].PayloadB64)) != "v2" {
		t.Fatalf("revert-after-delete value: %+v", v.Values[0])
	}
	// 键 b（在 a 系列断言全部完成后创建——修订号从 7 起，不干扰上面断言）
	if res := svc.PutKey("OPS", "b", b64("new"), "create", 0); !res.Ok() {
		t.Fatalf("create fresh: %+v", res)
	}
	// 列表（MetaOnly 语义，2 键）+ 批量值补齐（含缺失键 NotFound 路径）
	kl = svc.ListKeys("OPS")
	if !kl.Ok() || len(kl.Keys) != 2 {
		t.Fatalf("list: %+v", kl)
	}
	gv := svc.GetKeyValues("OPS", []string{"a", "missing"})
	if !gv.Ok() || len(gv.Values) != 2 || gv.Values[0].PayloadSize != 2 || gv.Values[1].NotFound != true {
		t.Fatalf("values: %+v", gv)
	}
	// revert 无历史（键 b 仅 1 次修订，§6.8 异常 3 Go 半边）
	if res := svc.RevertKey("OPS", "b"); res.ErrorCode != CodeValidation || !strings.Contains(res.Error, ErrNoHistory.Error()) {
		t.Fatalf("no-history: %+v", res)
	}
	// purge（彻底清除）→ 历史只剩 marker
	if res := svc.DeleteKey("OPS", "a", "purge"); !res.Ok() {
		t.Fatalf("purge: %+v", res)
	}
}

// TestListKeysCapTruncates 验证 ListKeys 封顶（leak B fix 2）：kvListKeysCap
// 缩到 5（包级 var 直接赋值 + t.Cleanup 还原），12 键桶 → Truncated=true、
// len(keys)=5；Total = 已读键数（MetaOnly watcher 无法预知真实总数，截断时
// 只能如实报告已读部分，前端文案不引用具体总数）。
func TestListKeysCapTruncates(t *testing.T) {
	svc := newSvc(t, testutil.StartJSServer(t))
	if res := svc.CreateKvBucket(KvBucketForm{Name: "CAP", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	for i := 0; i < 12; i++ {
		if r := svc.PutKey("CAP", fmt.Sprintf("cap-k-%02d", i), b64("v"), "put", 0); !r.Ok() {
			t.Fatalf("put %d: %+v", i, r)
		}
	}
	kvListKeysCap = 5
	t.Cleanup(func() { kvListKeysCap = 1000 })
	res := svc.ListKeys("CAP")
	if !res.Ok() {
		t.Fatalf("ListKeys: %+v", res)
	}
	if !res.Truncated {
		t.Fatalf("Truncated=false, want true: %+v", res)
	}
	if res.Total != 5 || len(res.Keys) != 5 {
		t.Fatalf("Total=%d len=%d, want 5/5", res.Total, len(res.Keys))
	}
}

// TestListKeysCapExactAtCap 正好等于 cap 的桶必须 truncated=false：封顶判断
// 在 append 之前（还能读到下一条才确有更多）、哨兵判断先于封顶判断——
// 恰好 cap 键时哨兵先到达，不误标截断。
func TestListKeysCapExactAtCap(t *testing.T) {
	svc := newSvc(t, testutil.StartJSServer(t))
	if res := svc.CreateKvBucket(KvBucketForm{Name: "EXACT", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	for i := 0; i < 5; i++ {
		if r := svc.PutKey("EXACT", fmt.Sprintf("exact-k-%02d", i), b64("v"), "put", 0); !r.Ok() {
			t.Fatalf("put %d: %+v", i, r)
		}
	}
	kvListKeysCap = 5
	t.Cleanup(func() { kvListKeysCap = 1000 })
	res := svc.ListKeys("EXACT")
	if !res.Ok() {
		t.Fatalf("ListKeys: %+v", res)
	}
	if res.Truncated {
		t.Fatalf("Truncated=true at exactly cap, want false: %+v", res)
	}
	if res.Total != 5 || len(res.Keys) != 5 {
		t.Fatalf("Total=%d len=%d, want 5/5", res.Total, len(res.Keys))
	}
}

// TestKvKeyLifecycleLocalServer 在长驻本地服务器上复跑键全链路（桶名带
// uniqueSuffix——共享服务器承载其他桶，但桶级流序列隔离，修订断言不受影响）。
func TestKvKeyLifecycleLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newSvcConn(t, nc)
	name := "OPS_" + uniqueSuffix()
	t.Cleanup(func() { _ = svc.DeleteKvBucket(name) }) // 尽力清理；失败（已删/不存在）不影响断言

	if res := svc.CreateKvBucket(KvBucketForm{Name: name, History: 10, Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	r1 := svc.PutKey(name, "a", b64("v1"), "put", 0)
	if !r1.Ok() || r1.Revision != 1 {
		t.Fatalf("put1: %+v", r1)
	}
	r2 := svc.PutKey(name, "a", b64("v2"), "put", 0)
	if !r2.Ok() || r2.Revision != 2 {
		t.Fatalf("put2: %+v", r2)
	}
	// create 冲突：错误文本 = 服务器原文前置 + 指引
	if res := svc.PutKey(name, "a", b64("x"), "create", 0); res.ErrorCode != CodeConflict || !strings.Contains(res.Error, "可改用 put 或查看现有值") {
		t.Fatalf("create conflict: %+v", res)
	}
	// update 期望不符 → conflict + CurrentRevision 回读
	if res := svc.PutKey(name, "a", b64("v3"), "update", 1); res.ErrorCode != CodeConflict || res.CurrentRevision != 2 {
		t.Fatalf("update conflict: %+v", res)
	}
	if r3 := svc.PutKey(name, "a", b64("v3"), "update", 2); !r3.Ok() || r3.Revision != 3 {
		t.Fatalf("update ok: %+v", r3)
	}
	h := svc.GetKeyHistory(name, "a")
	if !h.Ok() || len(h.Entries) != 3 || h.Entries[0].Revision != 1 {
		t.Fatalf("history: %+v", h)
	}
	if r4 := svc.RevertKey(name, "a"); !r4.Ok() || r4.Revision != 4 {
		t.Fatalf("revert: %+v", r4)
	}
	v := svc.GetKeyValues(name, []string{"a"})
	if string(mustB64(v.Values[0].PayloadB64)) != "v2" {
		t.Fatalf("revert value: %+v", v.Values[0])
	}
	if res := svc.DeleteKey(name, "a", "delete"); !res.Ok() {
		t.Fatalf("del: %+v", res)
	}
	kl := svc.ListKeys(name)
	if idx := findKey(kl.Keys, "a"); idx < 0 || kl.Keys[idx].Operation != "delete" {
		t.Fatalf("after del: %+v", kl.Keys)
	}
	if h = svc.GetKeyHistory(name, "a"); !h.Ok() || len(h.Entries) != 5 {
		t.Fatalf("history after del: %+v", h)
	}
	if r6 := svc.RevertKey(name, "a"); !r6.Ok() || r6.Revision != 6 {
		t.Fatalf("revert after delete: %+v", r6)
	}
	v = svc.GetKeyValues(name, []string{"a"})
	if string(mustB64(v.Values[0].PayloadB64)) != "v2" {
		t.Fatalf("revert-after-delete value: %+v", v.Values[0])
	}
	if res := svc.PutKey(name, "b", b64("new"), "create", 0); !res.Ok() {
		t.Fatalf("create fresh: %+v", res)
	}
	kl = svc.ListKeys(name)
	if !kl.Ok() || len(kl.Keys) != 2 {
		t.Fatalf("list: %+v", kl)
	}
	gv := svc.GetKeyValues(name, []string{"a", "missing"})
	if !gv.Ok() || len(gv.Values) != 2 || gv.Values[0].PayloadSize != 2 || gv.Values[1].NotFound != true {
		t.Fatalf("values: %+v", gv)
	}
	if res := svc.RevertKey(name, "b"); res.ErrorCode != CodeValidation || !strings.Contains(res.Error, ErrNoHistory.Error()) {
		t.Fatalf("no-history: %+v", res)
	}
	if res := svc.DeleteKey(name, "a", "purge"); !res.Ok() {
		t.Fatalf("purge: %+v", res)
	}
}
