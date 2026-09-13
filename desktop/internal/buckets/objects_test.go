package buckets

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/WenElevating/nats-desktop/desktop/internal/jsctx"
	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// TestObjBucketAndObjectLifecycle 走对象桶全链路（§6.9）：桶创建/列表/详情、
// 对象列表/改名/删除/重删、ShowDeleted「已删除」徽标、封存与写拒绝。单一 url：
// svc 与直连 osb 必须指向同一内嵌服务器（对象上传是 Task 6，这里经 jetstream
// 直放对象充当数据源）。
func TestObjBucketAndObjectLifecycle(t *testing.T) {
	url := testutil.StartJSServer(t)
	svc := newSvc(t, url)
	if res := svc.CreateObjBucket(ObjBucketForm{Name: "FILES", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	// 直接经 jetstream 放一个对象（上传是 Task 6）
	inj := mustConn(t, url)
	defer inj.Close()
	js, err := jsctx.New(inj, "", "")
	if err != nil {
		t.Fatal(err)
	}
	osb, err := js.ObjectStore(context.Background(), "FILES")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := osb.PutBytes(context.Background(), "doc.txt", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	list := svc.ListObjBuckets()
	if !list.Ok() || len(list.ObjBuckets) != 1 || list.ObjBuckets[0].Name != "FILES" {
		t.Fatalf("buckets: %+v", list)
	}
	objs := svc.ListObjects("FILES")
	if !objs.Ok() || len(objs.Objects) != 1 || objs.Objects[0].Size != 5 || objs.Objects[0].Digest == "" {
		t.Fatalf("objects: %+v", objs)
	}
	// 详情：表单回显（未封存）
	if d := svc.GetObjBucketDetail("FILES"); !d.Ok() || d.Form.Name != "FILES" || d.Sealed {
		t.Fatalf("detail: %+v", d)
	}
	// 改名 + 删除
	if res := svc.RenameObject("FILES", "doc.txt", "readme.txt"); !res.Ok() {
		t.Fatalf("rename: %+v", res)
	}
	if objs = svc.ListObjects("FILES"); !objs.Ok() || objs.Objects[0].Name != "readme.txt" {
		t.Fatalf("after rename: %+v", objs)
	}
	if res := svc.DeleteObject("FILES", "readme.txt"); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	// 已删除对象仍出现在列表（ShowDeleted）且带 Deleted 徽标（§6.9 浏览语义）
	objs = svc.ListObjects("FILES")
	if !objs.Ok() || len(objs.Objects) != 1 || !objs.Objects[0].Deleted {
		t.Fatalf("after delete: %+v", objs)
	}
	// 对不存在对象 → not_found；对已删除对象再删 → Ok（库文档语义，钉住）
	if res := svc.DeleteObject("FILES", "ghost"); res.ErrorCode != CodeNotFound {
		t.Fatalf("missing: %+v", res)
	}
	if res := svc.DeleteObject("FILES", "readme.txt"); !res.Ok() {
		t.Fatalf("re-delete deleted: %+v", res)
	}
	// 封存 → 写操作被拒（错误原文透传由前端展示）+ Sealed 状态可见（§6.9 异常 3 半边）
	if res := svc.SealObjBucket("FILES"); !res.Ok() {
		t.Fatalf("seal: %+v", res)
	}
	d := svc.GetObjBucketDetail("FILES")
	if !d.Ok() || !d.Sealed {
		t.Fatalf("sealed detail: %+v", d)
	}
	if _, err := osb.PutBytes(context.Background(), "x", []byte("y")); err == nil {
		t.Fatal("write to sealed bucket must fail")
	}
}

// TestObjBucketValidationAndErrors 钉住错误语义：校验门、差异配置重复创建 →
// conflict（与 KV 同：同配置幂等成功）、缺失桶 not_found、空桶 ListObjects →
// Ok + 空数组（ErrNoObjectsFound 吞掉，非 nil）、改名占用名 → conflict、
// 详情表单回显 MaxBytes（status 接口无 MaxBytes，经 StreamInfo 补齐）。
func TestObjBucketValidationAndErrors(t *testing.T) {
	url := testutil.StartJSServer(t)
	svc := newSvc(t, url)
	if res := svc.CreateObjBucket(ObjBucketForm{Name: "", Replicas: 1}); res.ErrorCode != CodeValidation {
		t.Fatalf("gate: %+v", res)
	}
	if res := svc.CreateObjBucket(ObjBucketForm{Name: "CFG", Replicas: 1}); !res.Ok() {
		t.Fatal(res)
	}
	// 重复创建 → conflict：nats-server 对"完全相同配置"的重复 CREATE 是幂等
	// 成功（同 KV，kv_test.go 注释），必须用差异配置（不同 Description）才能
	// 确定性拿到 ErrBucketExists（nats.go 经 ErrStreamNameAlreadyInUse join）。
	if res := svc.CreateObjBucket(ObjBucketForm{Name: "CFG", Description: "other", Replicas: 1}); res.ErrorCode != CodeConflict {
		t.Fatalf("dup: %+v", res)
	}
	// 更新（描述 + MaxBytes）→ 详情回显（含 status 接口缺口字段 MaxBytes）
	if res := svc.UpdateObjBucket(ObjBucketForm{Name: "CFG", Description: "v2", MaxBytes: 1 << 20, Replicas: 1}); !res.Ok() {
		t.Fatalf("update: %+v", res)
	}
	if d := svc.GetObjBucketDetail("CFG"); !d.Ok() || d.Form.Description != "v2" || d.Form.MaxBytes != 1<<20 {
		t.Fatalf("detail after update: %+v", d)
	}
	// 缺失桶 → not_found（update/delete/list 三路）
	if res := svc.UpdateObjBucket(ObjBucketForm{Name: "NOPE", Replicas: 1}); res.ErrorCode != CodeNotFound {
		t.Fatalf("update missing: %+v", res)
	}
	if res := svc.DeleteObjBucket("NOPE"); res.ErrorCode != CodeNotFound {
		t.Fatalf("delete missing: %+v", res)
	}
	if objs := svc.ListObjects("NOPE"); objs.Ok() || objs.ErrorCode != CodeNotFound {
		t.Fatalf("list missing bucket: %+v", objs)
	}
	// watch 缺失桶 → not_found（CreateObjWatch 错误路径）
	if w := svc.CreateObjWatch("NOPE"); w.Ok() || w.ErrorCode != CodeNotFound {
		t.Fatalf("watch missing bucket: %+v", w)
	}
	// 空桶列表：ErrNoObjectsFound 吞掉 → Ok + 空数组（非 nil）
	objs := svc.ListObjects("CFG")
	if !objs.Ok() || objs.Objects == nil || len(objs.Objects) != 0 {
		t.Fatalf("empty list: %+v", objs)
	}
	// 直连放两个对象供改名冲突断言
	inj := mustConn(t, url)
	defer inj.Close()
	js, err := jsctx.New(inj, "", "")
	if err != nil {
		t.Fatal(err)
	}
	osb, err := js.ObjectStore(context.Background(), "CFG")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.txt", "b.txt"} {
		if _, err := osb.PutBytes(context.Background(), name, []byte(name)); err != nil {
			t.Fatal(err)
		}
	}
	// 改名：源对象不存在 → not_found（GetInfo 把缺失对象由 ErrMsgNotFound 归一为
	// ErrObjectNotFound，服务层还原 not_found；ErrUpdateMetaDeleted 是 UpdateMeta
	// 自己的 remap，此路径不会出现）；目标名已占用 → conflict
	if res := svc.RenameObject("CFG", "ghost", "x"); res.ErrorCode != CodeNotFound {
		t.Fatalf("rename missing: %+v", res)
	}
	if res := svc.RenameObject("CFG", "a.txt", "b.txt"); res.ErrorCode != CodeConflict {
		t.Fatalf("rename occupied: %+v", res)
	}
	if objs = svc.ListObjects("CFG"); !objs.Ok() || len(objs.Objects) != 2 {
		t.Fatalf("after puts: %+v", objs)
	}
}

// TestObjWatchLifecycle 补 Task 4 审查指出的缺口：CreateObjWatch 实测——初始
// 快照 + name="" 哨兵、直连 put/delete 增量、StopWatch 后无事件。
func TestObjWatchLifecycle(t *testing.T) {
	url := testutil.StartJSServer(t)
	var mu sync.Mutex
	var events []ObjWatchEvent
	svc := NewBucketService(&connStub{nc: mustConn(t, url)}, nil, func(name string, data any) {
		if name == EventObjWatch {
			mu.Lock()
			events = append(events, data.(ObjWatchEvent))
			mu.Unlock()
		}
	}, "")
	if res := svc.CreateObjBucket(ObjBucketForm{Name: "OW", Replicas: 1}); !res.Ok() {
		t.Fatalf("create bucket: %+v", res)
	}
	// 初始对象先于 watch 放入（初始快照 = 1 对象 + 哨兵）
	inj := mustConn(t, url)
	defer inj.Close()
	js, err := jsctx.New(inj, "", "")
	if err != nil {
		t.Fatal(err)
	}
	osb, err := js.ObjectStore(context.Background(), "OW")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := osb.PutBytes(context.Background(), "seed.txt", []byte("seed")); err != nil {
		t.Fatal(err)
	}
	wid := svc.CreateObjWatch("OW")
	if !wid.Ok() || wid.WatchId == "" {
		t.Fatalf("watch: %+v", wid)
	}
	// 初始对象 + sentinel（name="" 为初始快照完成哨兵）
	waitForCond(t, 2*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(events) >= 2 && events[len(events)-1].Name == ""
	})
	mu.Lock()
	first := events[0]
	mu.Unlock()
	if first.Name != "seed.txt" || first.Size != 4 || first.Digest == "" || first.Deleted {
		t.Fatalf("initial event: %+v", first)
	}
	// 增量：直连 put + delete（删除事件 Deleted=true、Size 清零）
	if _, err := osb.PutBytes(context.Background(), "more.bin", []byte("12345")); err != nil {
		t.Fatal(err)
	}
	if err := osb.Delete(context.Background(), "seed.txt"); err != nil {
		t.Fatal(err)
	}
	waitForCond(t, 2*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(events) >= 4 && events[len(events)-1].Name == "seed.txt" && events[len(events)-1].Deleted
	})
	// 停止后再无事件
	if res := svc.StopWatch(wid.WatchId); !res.Ok() {
		t.Fatalf("stop: %+v", res)
	}
	mu.Lock()
	n := len(events)
	mu.Unlock()
	if _, err := osb.PutBytes(context.Background(), "late.txt", []byte("late")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(events) != n {
		t.Fatalf("events after stop: %d != %d", len(events), n)
	}
}

// TestObjBucketAndObjectLifecycleLocalServer 在长驻本地服务器上复跑对象全链路
// （桶名带 uniqueSuffix——共享服务器承载其他桶，列表断言只看自己的条目）。
func TestObjBucketAndObjectLifecycleLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newSvcConn(t, nc)
	name := "FILES_" + uniqueSuffix()
	t.Cleanup(func() { _ = svc.DeleteObjBucket(name) }) // 尽力清理；失败（已删/不存在）不影响断言

	if res := svc.CreateObjBucket(ObjBucketForm{Name: name, Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	// 直连放一个对象（上传是 Task 6）
	inj := testutil.ConnectLocalServer(t)
	js, err := jsctx.New(inj, "", "")
	if err != nil {
		t.Fatal(err)
	}
	osb, err := js.ObjectStore(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := osb.PutBytes(context.Background(), "doc.txt", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	list := svc.ListObjBuckets()
	if !list.Ok() {
		t.Fatalf("list: %+v", list)
	}
	// findObjBucket 与 findKvBucket 同构：共享服务器只断言自己的条目
	found := 0
	for _, sum := range list.ObjBuckets {
		if sum.Name == name {
			found++
		}
	}
	if found != 1 {
		t.Fatalf("list missing %s: %+v", name, list)
	}
	objs := svc.ListObjects(name)
	if !objs.Ok() || len(objs.Objects) != 1 || objs.Objects[0].Name != "doc.txt" || objs.Objects[0].Size != 5 || objs.Objects[0].Digest == "" {
		t.Fatalf("objects: %+v", objs)
	}
	if d := svc.GetObjBucketDetail(name); !d.Ok() || d.Form.Name != name || d.Sealed {
		t.Fatalf("detail: %+v", d)
	}
	// 改名 + 删除 + ShowDeleted 徽标
	if res := svc.RenameObject(name, "doc.txt", "readme.txt"); !res.Ok() {
		t.Fatalf("rename: %+v", res)
	}
	if objs = svc.ListObjects(name); !objs.Ok() || objs.Objects[0].Name != "readme.txt" {
		t.Fatalf("after rename: %+v", objs)
	}
	if res := svc.DeleteObject(name, "readme.txt"); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	objs = svc.ListObjects(name)
	if !objs.Ok() || len(objs.Objects) != 1 || !objs.Objects[0].Deleted {
		t.Fatalf("after delete: %+v", objs)
	}
	if res := svc.DeleteObject(name, "ghost"); res.ErrorCode != CodeNotFound {
		t.Fatalf("missing: %+v", res)
	}
	if res := svc.DeleteObject(name, "readme.txt"); !res.Ok() {
		t.Fatalf("re-delete deleted: %+v", res)
	}
	// 封存 → 详情 Sealed 可见 + 写拒绝（服务器拒绝删封存流的路径不存在——
	// DELETE 不检查 sealed，t.Cleanup 的 DeleteObjBucket 在封存后仍可用）
	if res := svc.SealObjBucket(name); !res.Ok() {
		t.Fatalf("seal: %+v", res)
	}
	d := svc.GetObjBucketDetail(name)
	if !d.Ok() || !d.Sealed {
		t.Fatalf("sealed detail: %+v", d)
	}
	if _, err := osb.PutBytes(context.Background(), "x", []byte("y")); err == nil {
		t.Fatal("write to sealed bucket must fail")
	}
}

// TestRenameObjectPreservesMetadata（Task 5 审查裁定 carry-in）：nats.go 的
// UpdateMeta 以传入 meta **整体覆盖** Description/Headers/Metadata（零值即清空）
// ——改名必须先 GetInfo 回填旧值，否则外部创建的带描述/头/元数据对象改名即静默
// 丢元数据。直连 UpdateMeta 设置 Description+Headers+Metadata 后经服务层改名，
// 断言全部存活。
func TestRenameObjectPreservesMetadata(t *testing.T) {
	url := testutil.StartJSServer(t)
	svc := newSvc(t, url)
	if res := svc.CreateObjBucket(ObjBucketForm{Name: "RM", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	inj := mustConn(t, url)
	defer inj.Close()
	js, err := jsctx.New(inj, "", "")
	if err != nil {
		t.Fatal(err)
	}
	osb, err := js.ObjectStore(context.Background(), "RM")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := osb.PutBytes(context.Background(), "ext.txt", []byte("meta")); err != nil {
		t.Fatal(err)
	}
	if err := osb.UpdateMeta(context.Background(), "ext.txt", jetstream.ObjectMeta{
		Name:        "ext.txt",
		Description: "外部创建",
		Headers:     nats.Header{"X-Test": {"1"}},
		Metadata:    map[string]string{"k": "v"},
	}); err != nil {
		t.Fatal(err)
	}
	if res := svc.RenameObject("RM", "ext.txt", "renamed.txt"); !res.Ok() {
		t.Fatalf("rename: %+v", res)
	}
	info, err := osb.GetInfo(context.Background(), "renamed.txt")
	if err != nil {
		t.Fatal(err)
	}
	if info.Description != "外部创建" || info.Metadata["k"] != "v" || info.Headers.Get("X-Test") != "1" {
		t.Fatalf("metadata lost on rename: %+v", info.ObjectMeta)
	}
}
