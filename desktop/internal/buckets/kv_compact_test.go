// TestKvBucketCompact 依赖 Task 3 的 PutKey/DeleteKey（键操作半边）。Task 2
// 期间以 build tag m4_task3 搁置，Task 3 Step 3 已移除标签启用；调用处按
// Task 3 落地签名（PutKey 单返回值、CallResult 内嵌于 PutKeyResult）对齐。
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
	if res := svc.PutKey("CMP", "k", "djE=", "put", 0); !res.Ok() {
		t.Fatal(res)
	}
	if res := svc.PutKey("CMP", "k2", "djE=", "put", 0); !res.Ok() {
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
