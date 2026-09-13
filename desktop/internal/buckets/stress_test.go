// Stress / concurrency verification against the long-lived local server
// (M4 Task 10; M3 Task 14 same shape). Gated on testutil.ConnectLocalServer
// like the perf suite; uniqueSuffix + t.Cleanup bucket deletion keep the
// shared server clean (删桶即清，禁止逐条清理).
//
// Concurrency-safety argument (why one *BucketService may be shared by 12
// goroutines below):
//   - every operation resolves its own jetstream.JetStream handle per call
//     (s.js() → jsctx.New, service.go) — no handle is stored on the service or
//     reused across requests;
//   - BucketService itself carries no mutable state except transferMu /
//     transferSeq (atomics, touched only by the upload/download single-flight
//     — not exercised here) and the watch registry (mutex + atomics, watch.go
//     — not exercised here); log/emit/mgr/settingsPath are immutable after
//     NewBucketService;
//   - the per-call traffic is request-reply over the shared *nats.Conn, which
//     nats.go documents as goroutine-safe.
//
// TestConcurrentBucketOpsLocalServer is the executable proof of the above; the
// CI go job re-runs the whole suite under -race wherever the server is present.
package buckets

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/WenElevating/nats-desktop/desktop/internal/jsctx"
	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// cleanupBuckets registers a t.Cleanup that lists both bucket halves and
// deletes every name carrying the fixture suffix (fixture self-healing: a
// failed run leaves no OFLOOD*/CON* debris behind on the shared server).
func cleanupBuckets(t *testing.T, svc *BucketService, suffix string) {
	t.Cleanup(func() {
		if list := svc.ListKvBuckets(); list.Ok() {
			for _, b := range list.KvBuckets {
				if strings.Contains(b.Name, suffix) {
					_ = svc.DeleteKvBucket(b.Name) // 尽力清理；失败不影响断言
				}
			}
		}
		if list := svc.ListObjBuckets(); list.Ok() {
			for _, b := range list.ObjBuckets {
				if strings.Contains(b.Name, suffix) {
					_ = svc.DeleteObjBucket(b.Name)
				}
			}
		}
	})
}

// TestObjWatchFloodNoLossLocalServer（Global 9，长驻本地服务器 4333）is the
// object flavor of the Task 4 KV flood (TestKvWatchFloodNoLossLocalServer):
// 100 objects via direct connection → obj watch (initial snapshot = 100 +
// sentinel) → 计数清零 → 注入连接 10k 次 re-put 既有对象 → 计数恰为 10k 且客户端
// 丢弃为 0（有界队列 4096 + 丢最旧兜底，发射单 goroutine 顺序不丢）。
//
// 服务端留存类比（对齐 KV flood 的 History 64 理由注释）：对象桶无需特殊配置——
// 每次 Put 末尾的 meta 消息携带 Nats-Rollup:sub 头（nats.go object.go
// PublishMsgAsync），服务器以 rollup 替换该对象主题上的旧 meta，流内每对象恒
// 1 条，不存在 KV history=1 那种「随写随清未消费旧消息」的服务端丢失面；消费端
// 是 DeliverLastPerSubject 有序消费者。因此零丢失应直接成立，无需放大留存配置
// （已验证：10k re-put 恰好 10k 事件）。
func TestObjWatchFloodNoLossLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	var count atomic.Int64
	svc := NewBucketService(&connStub{nc: nc}, nil, func(name string, data any) {
		if name == EventObjWatch {
			count.Add(1)
		}
	}, "")
	bucket := "OFLOOD_" + uniqueSuffix()
	cleanupBuckets(t, svc, bucket) // 删桶即清 100 对象；禁止逐条清理
	if res := svc.CreateObjBucket(ObjBucketForm{Name: bucket, Replicas: 1}); !res.Ok() {
		t.Fatalf("create bucket: %+v", res)
	}
	// 注入连接：100 对象先于 watch 建立放入（初始快照恰为 100 + 哨兵）
	inj := testutil.ConnectLocalServer(t)
	js2, err := jsctx.New(inj, "", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	osb, err := js2.ObjectStore(ctx, bucket)
	if err != nil {
		t.Fatal(err)
	}
	const objects = 100
	payload := []byte("flood-payload")
	for i := 0; i < objects; i++ {
		if _, err := osb.PutBytes(ctx, fmt.Sprintf("obj%03d", i), payload); err != nil {
			t.Fatal(err)
		}
	}
	wid := svc.CreateObjWatch(bucket)
	if !wid.Ok() || wid.WatchId == "" {
		t.Fatalf("watch: %+v", wid)
	}
	// 100 初始对象 + 哨兵（name="" 为初始快照完成哨兵；无并发写入恰 101 条）
	waitForCond(t, 10*time.Second, func() bool {
		return count.Load() >= objects+1
	})
	base := count.Load() // 计数清零（基线法：与在途发射无竞争）
	if dropped := svc.watchDropped(); dropped != 0 {
		t.Fatalf("initial snapshot dropped: %d", dropped)
	}
	// 10k 次 re-put 既有对象（每次 Put 恰发布 1 条 rollup meta = 1 事件）
	for i := 0; i < 10000; i++ {
		if _, err := osb.PutBytes(ctx, fmt.Sprintf("obj%03d", i%objects), payload); err != nil {
			t.Fatal(err)
		}
	}
	waitForCond(t, 30*time.Second, func() bool {
		return count.Load()-base >= 10000
	})
	if got := count.Load() - base; got != 10000 {
		t.Fatalf("flood events: %d != 10000", got)
	}
	if dropped := svc.watchDropped(); dropped != 0 {
		t.Fatalf("flood dropped: %d", dropped)
	}
	// 收尾：Stop 后注册表归零
	if res := svc.StopWatch(wid.WatchId); !res.Ok() {
		t.Fatalf("stop: %+v", res)
	}
	if got := svc.watchCount(); got != 0 {
		t.Fatalf("watchCount after stop: %d != 0", got)
	}
}

// TestConcurrentBucketOpsLocalServer: 12 goroutines share one *BucketService —
// 4× KV bucket create/delete cycles, 4× concurrent key put/delete on a shared
// bucket (distinct keys per goroutine), 4× object bucket create/delete cycles.
// Every op must succeed (collection via errCh, zero tolerance — any error is
// t.Error'ed). See the package-header concurrency-safety argument above.
func TestConcurrentBucketOpsLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newSvcConn(t, nc)
	suffix := uniqueSuffix()
	cleanupBuckets(t, svc, suffix)

	// 共享 KV 桶：4 个键 goroutine 在其上 put/delete 各自的键（同桶不同键）
	shared := "CSHARE_" + suffix
	if res := svc.CreateKvBucket(KvBucketForm{Name: shared, History: 1, Replicas: 1}); !res.Ok() {
		t.Fatalf("create shared bucket: %+v", res)
	}

	var wg sync.WaitGroup
	errCh := make(chan error, 32)
	const cycles = 3
	// 4× KV 桶 create/delete 循环
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			name := fmt.Sprintf("CKV%s_%02d", suffix, i)
			for c := 0; c < cycles; c++ {
				if res := svc.CreateKvBucket(KvBucketForm{Name: name, History: 1, Replicas: 1}); !res.Ok() {
					errCh <- fmt.Errorf("kv create %s (cycle %d): %s", name, c, res.Error)
					return
				}
				if res := svc.DeleteKvBucket(name); !res.Ok() {
					errCh <- fmt.Errorf("kv delete %s (cycle %d): %s", name, c, res.Error)
					return
				}
			}
		}(i)
	}
	// 4× 键并发 put/delete（共享桶、每 goroutine 独占键名）
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for c := 0; c < 20; c++ {
				key := fmt.Sprintf("g%d-k%02d", i, c)
				if res := svc.PutKey(shared, key, b64("v"), "put", 0); !res.Ok() {
					errCh <- fmt.Errorf("put %s/%s: %s", shared, key, res.Error)
					return
				}
				if res := svc.DeleteKey(shared, key, "delete"); !res.Ok() {
					errCh <- fmt.Errorf("delete %s/%s: %s", shared, key, res.Error)
					return
				}
			}
		}(i)
	}
	// 4× 对象桶 create/delete 循环
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			name := fmt.Sprintf("COBJ%s_%02d", suffix, i)
			for c := 0; c < cycles; c++ {
				if res := svc.CreateObjBucket(ObjBucketForm{Name: name, Replicas: 1}); !res.Ok() {
					errCh <- fmt.Errorf("obj create %s (cycle %d): %s", name, c, res.Error)
					return
				}
				if res := svc.DeleteObjBucket(name); !res.Ok() {
					errCh <- fmt.Errorf("obj delete %s (cycle %d): %s", name, c, res.Error)
					return
				}
			}
		}(i)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err) // 零容忍：任何一条即计失败
	}
	// 收尾：共享桶删除（cleanupBuckets 兜底自愈，正常路径在此即清）
	if res := svc.DeleteKvBucket(shared); !res.Ok() {
		t.Fatalf("delete shared bucket: %+v", res)
	}
}
