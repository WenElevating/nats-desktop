//go:build m4_task3

// TestKvBucketCompact 依赖 Task 3 的 PutKey/DeleteKey（键操作半边）——本文件
// 以 build tag m4_task3 搁置使 Task 2 全量编译通过，Task 3 Step 3 删除该标签
// 启用（跨任务编译交接）。启用时若 PutKey/DeleteKey 签名与本文件调用有出入，
// 以 Task 3 实现为准调整（签名来源：M4 plan Task 3 Produces 清单——
// PutKey(bucket, key, payloadB64, mode string, expectedRevision uint64)、
// DeleteKey(bucket, key, mode string)）。
package buckets

import (
	"testing"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

func TestKvBucketCompact(t *testing.T) {
	svc := newSvc(t, testutil.StartJSServer(t))
	if res := svc.CreateKvBucket(KvBucketForm{Name: "CMP", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	// 放键 + 删键 → compact 后桶 Values 下降（删除标记与历史被清除）。
	// history=1（服务器默认）：删 k 后其删除标记顶掉原值，桶内 2 条
	// （k 的 delete marker + k2 的值）；compact（DeleteMarkersOlderThan(-1)
	// 无条件全删）→ 仅剩 k2 的 1 条。
	if _, res := svc.PutKey("CMP", "k", "djE=", "put", 0); !res.Ok() {
		t.Fatal(res)
	}
	if _, res := svc.PutKey("CMP", "k2", "djE=", "put", 0); !res.Ok() {
		t.Fatal(res)
	}
	if res := svc.DeleteKey("CMP", "k", "delete"); !res.Ok() {
		t.Fatal(res)
	}
	values := func() uint64 {
		t.Helper()
		list := svc.ListKvBuckets()
		if !list.Ok() {
			t.Fatalf("list: %+v", list)
		}
		if sum := findKvBucket(list.KvBuckets, "CMP"); sum != nil {
			return sum.Values
		}
		t.Fatal("bucket CMP missing from list")
		return 0
	}
	if got := values(); got != 2 {
		t.Fatalf("expected 2 values before compact, got %d", got)
	}
	if res := svc.CompactKvBucket("CMP"); !res.Ok() {
		t.Fatalf("compact: %+v", res)
	}
	if got := values(); got != 1 {
		t.Fatalf("expected 1 value after compact, got %d", got)
	}
}
