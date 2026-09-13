package buckets

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
	"github.com/WenElevating/nats-desktop/desktop/internal/jsctx"
	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// mustConn dials url and registers Close with t.Cleanup（对齐 jsadmin/messaging
// 的 connect 惯例；waitForCond 同）。
func mustConn(t *testing.T, url string) *nats.Conn {
	t.Helper()
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { nc.Close() })
	return nc
}

// waitForCond polls cond every 20ms until it holds, failing the test after
// timeout（watch 事件经发射 goroutine 异步到达，轮询而非等待 channel）。
func waitForCond(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("condition not met within %v", timeout)
}

// watchCount / watchDropped：注册表内省（仅测试用，注册表零值/nil 安全）。
func (s *BucketService) watchCount() int {
	if s.watches == nil {
		return 0
	}
	s.watches.mu.Lock()
	defer s.watches.mu.Unlock()
	return len(s.watches.entries)
}

func (s *BucketService) watchDropped() uint64 {
	if s.watches == nil {
		return 0
	}
	s.watches.mu.Lock()
	defer s.watches.mu.Unlock()
	var total uint64
	for _, e := range s.watches.entries {
		total += e.drop.Load()
	}
	return total
}

// TestWatchEntryOfferDropOldest pins the bounded-queue backpressure semantics
// (watch.go, Global 4): on a full queue offer drops the OLDEST entry and
// counts the drop (no server needed — direct struct exercise).
func TestWatchEntryOfferDropOldest(t *testing.T) {
	e := &watchEntry{id: "t", ch: make(chan any, 2), done: make(chan struct{})}
	for i := 0; i < 3; i++ {
		e.offer(KvWatchEvent{WatchId: fmt.Sprintf("w%d", i)})
	}
	if got := e.drop.Load(); got != 1 {
		t.Fatalf("drop count: %d != 1", got)
	}
	if len(e.ch) != 2 {
		t.Fatalf("queue len: %d != 2", len(e.ch))
	}
	if first := (<-e.ch).(KvWatchEvent).WatchId; first != "w1" { // w0 被丢最旧
		t.Fatalf("queue head: %s != w1", first)
	}
}

func TestKvWatchLifecycle(t *testing.T) {
	url := testutil.StartJSServer(t)
	var mu sync.Mutex
	var events []KvWatchEvent
	svc := NewBucketService(&connStub{nc: mustConn(t, url)}, nil, func(name string, data any) {
		if name == EventKvWatch {
			mu.Lock()
			events = append(events, data.(KvWatchEvent))
			mu.Unlock()
		}
	}, "")
	svc.CreateKvBucket(KvBucketForm{Name: "W", Replicas: 1})
	svc.PutKey("W", "k1", b64("v1"), "put", 0)
	// 单结构体返回（Wails 多返回值序列化为 JSON 数组，破坏前端消费模式）
	wid := svc.CreateKvWatch("W", "")
	if !wid.Ok() || wid.WatchId == "" {
		t.Fatalf("watch: %+v", wid)
	}
	// 初始值 + sentinel 到达
	waitForCond(t, 2*time.Second, func() bool {
		mu.Lock(); defer mu.Unlock()
		return len(events) >= 2 && events[len(events)-1].Key == ""
	})
	// 增量：另一连接 put + del
	inj := mustConn(t, url)
	defer inj.Close()
	js2, _ := jsctx.New(inj, "", "")
	kv2, _ := js2.KeyValue(context.Background(), "W")
	kv2.Put(context.Background(), "k2", []byte("v2"))
	kv2.Delete(context.Background(), "k1")
	waitForCond(t, 2*time.Second, func() bool {
		mu.Lock(); defer mu.Unlock()
		return len(events) >= 4 && events[len(events)-1].Operation == "delete" && events[len(events)-1].Key == "k1"
	})
	// 停止后再无事件
	if res := svc.StopWatch(wid.WatchId); !res.Ok() {
		t.Fatalf("stop: %+v", res)
	}
	n := len(events)
	kv2.Put(context.Background(), "k3", []byte("v3"))
	time.Sleep(300 * time.Millisecond)
	mu.Lock(); defer mu.Unlock()
	if len(events) != n {
		t.Fatalf("events after stop: %d != %d", len(events), n)
	}
}

// TestWatchStopsOnDisconnect：NotifyConnState(disconnected) → 全部 watch 停止、
// 注册表空、后续 Put 不再产生事件（断连全停语义，Global 6）。
func TestWatchStopsOnDisconnect(t *testing.T) {
	url := testutil.StartJSServer(t)
	var mu sync.Mutex
	var events []KvWatchEvent
	svc := NewBucketService(&connStub{nc: mustConn(t, url)}, nil, func(name string, data any) {
		if name == EventKvWatch {
			mu.Lock()
			events = append(events, data.(KvWatchEvent))
			mu.Unlock()
		}
	}, "")
	svc.CreateKvBucket(KvBucketForm{Name: "D1", Replicas: 1})
	svc.CreateKvBucket(KvBucketForm{Name: "D2", Replicas: 1})
	w1 := svc.CreateKvWatch("D1", "")
	if !w1.Ok() || w1.WatchId == "" {
		t.Fatalf("watch1: %+v", w1)
	}
	w2 := svc.CreateKvWatch("D2", "")
	if !w2.Ok() || w2.WatchId == "" {
		t.Fatalf("watch2: %+v", w2)
	}
	// 两个 watch 的初始 sentinel 都到达（每 watch 恰 1 条，len>=2 ⟺ 两条都到）
	waitForCond(t, 2*time.Second, func() bool {
		mu.Lock(); defer mu.Unlock()
		return len(events) >= 2
	})
	if got := svc.watchCount(); got != 2 {
		t.Fatalf("watchCount before disconnect: %d != 2", got)
	}
	svc.NotifyConnState(connections.StateEvent{State: connections.StateDisconnected})
	if got := svc.watchCount(); got != 0 {
		t.Fatalf("watchCount after disconnect: %d != 0", got)
	}
	// 已停止的 id 再 Stop → not_found（注册表已删）
	if res := svc.StopWatch(w1.WatchId); res.ErrorCode != CodeNotFound {
		t.Fatalf("double stop: %+v", res)
	}
	// 后续 Put 不产生事件
	n := len(events)
	inj := mustConn(t, url)
	defer inj.Close()
	js2, _ := jsctx.New(inj, "", "")
	kv2, _ := js2.KeyValue(context.Background(), "D1")
	kv2.Put(context.Background(), "late", []byte("x"))
	time.Sleep(300 * time.Millisecond)
	mu.Lock(); defer mu.Unlock()
	if len(events) != n {
		t.Fatalf("events after disconnect: %d != %d", len(events), n)
	}
}

// TestKvWatchFloodNoLossLocalServer（Global 9，长驻本地服务器 4333）：1k 初始
// 键（等 sentinel）→ 计数清零 → 注入连接 10k 次 Put 单键 → 计数==10k 且零丢弃
// （有界队列 4096 + 丢最旧兜底，发射单 goroutine 顺序不丢）。
func TestKvWatchFloodNoLossLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	var count atomic.Int64
	svc := NewBucketService(&connStub{nc: nc}, nil, func(name string, data any) {
		if name == EventKvWatch {
			count.Add(1)
		}
	}, "")
	bucket := "FLOOD_" + uniqueSuffix()
	t.Cleanup(func() { _ = svc.DeleteKvBucket(bucket) })
	// History 64（KV 上限）：桶流 MaxMsgsPerSubject=64，服务器仅在消费滞后
	// 超过 64 条时才会丢弃未投递的旧消息——默认 history=1 时服务器会随写随
	// 清旧消息，消费端任何抖动都会造成服务器侧丢失（与客户端背压无关），
	// 零丢失断言不成立。客户端零丢失（Global 9 背压）与服务器留存是两回事。
	if res := svc.CreateKvBucket(KvBucketForm{Name: bucket, History: 64, Replicas: 1}); !res.Ok() {
		t.Fatalf("create bucket: %+v", res)
	}
	// 注入连接：1k 初始键（先于 watch 建立注入完成，初始快照恰为 1000 值 + sentinel）
	inj := testutil.ConnectLocalServer(t)
	js2, err := jsctx.New(inj, "", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	kv2, err := js2.KeyValue(ctx, bucket)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1000; i++ {
		if _, err := kv2.Put(ctx, fmt.Sprintf("k%d", i), []byte("v")); err != nil {
			t.Fatal(err)
		}
	}
	wid := svc.CreateKvWatch(bucket, "")
	if !wid.Ok() || wid.WatchId == "" {
		t.Fatalf("watch: %+v", wid)
	}
	// 1k 初始值 + sentinel（无并发写入，恰好 1001 条）
	waitForCond(t, 10*time.Second, func() bool {
		return count.Load() >= 1001
	})
	base := count.Load() // 计数清零（基线法：与在途发射无竞争）
	if dropped := svc.watchDropped(); dropped != 0 {
		t.Fatalf("initial snapshot dropped: %d", dropped)
	}
	// 10k 次单键 Put（零丢失断言）
	for i := 0; i < 10000; i++ {
		if _, err := kv2.Put(ctx, "hot", []byte(fmt.Sprintf("v%d", i))); err != nil {
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
