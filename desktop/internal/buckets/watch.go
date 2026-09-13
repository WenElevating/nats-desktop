package buckets

import (
	"context"
	"log/slog"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/nats-io/nats.go/jetstream"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
)

// ---------------------------------------------------------------------------
// 通用 watch 管理器（KV + 对象，§6.8/§6.9 watch 语义）。每 watcher：有界 4096
// 队列（满则丢最旧 + 原子计数）+ 单发射 goroutine 顺序 emit（单 goroutine 保序），
// 每条事件捎带 dropped_total（前端丢弃计数 wire 来源），每 4096 次丢弃一条 WARN
// （对齐 messaging 丢弃语义，§11）。订阅 ctx 一律 Background 派生 cancel ctx，
// 绝不带 s.timeout()——nats.Context(ctx) 会随超时静默注销订阅。
// ---------------------------------------------------------------------------

// CreateWatchResult：单结构体返回（Wails 多返回值序列化为 JSON 数组，破坏前端
// 既有 CallResult 消费模式）；WatchId 为注册表内递增的数字串。
type CreateWatchResult struct {
	CallResult
	WatchId string `json:"watch_id"`
}

// watchQueueCapacity 是每 watcher 的有界队列容量（Global 4 背压裁定）；
// dropWarnEvery 对齐容量——丢弃计满一圈打一条 WARN。
const (
	watchQueueCapacity = 4096
	dropWarnEvery      = 4096
)

type watchRegistry struct {
	mu      sync.Mutex
	next    uint64
	entries map[string]*watchEntry
}

type watchEntry struct {
	id    string
	ch    chan any // 容量 4096；满则丢最旧
	drop  atomic.Uint64
	done  chan struct{}
	log   *slog.Logger // 丢弃 WARN 落点
	stops []func()     // watcher.Stop + 发射 goroutine 退出
}

// allocate reserves the next watch id (numeric string) under the registry lock.
func (r *watchRegistry) allocate() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	return strconv.FormatUint(r.next, 10)
}

// add stores the entry under its already-allocated id. Called only after the
// entry is fully wired (stops populated), so anything StopWatch/remove can
// observe is safe to stop.
func (r *watchRegistry) add(e *watchEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.entries == nil {
		r.entries = make(map[string]*watchEntry)
	}
	r.entries[e.id] = e
}

// remove detaches the entry (nil when unknown) so stop can run lock-free.
func (r *watchRegistry) remove(id string) *watchEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.entries[id]
	delete(r.entries, id)
	return e
}

// stopAll stops every entry and empties the registry (断连全停); returns the
// number of watchers stopped for the WARN count.
func (r *watchRegistry) stopAll() int {
	r.mu.Lock()
	entries := make([]*watchEntry, 0, len(r.entries))
	for _, e := range r.entries {
		entries = append(entries, e)
	}
	r.entries = make(map[string]*watchEntry)
	r.mu.Unlock()
	for _, e := range entries {
		e.stop()
	}
	return len(entries)
}

func (r *watchRegistry) launch(id string, emit func(string, any), eventName string) *watchEntry {
	e := &watchEntry{id: id, ch: make(chan any, watchQueueCapacity), done: make(chan struct{})}
	go func() {
		for {
			select {
			case v := <-e.ch:
				switch ev := v.(type) { // 每条事件捎带累计丢弃数（wire 来源）
				case KvWatchEvent:
					ev.DroppedTotal = e.drop.Load()
					emit(eventName, ev)
				case ObjWatchEvent:
					ev.DroppedTotal = e.drop.Load()
					emit(eventName, ev)
				}
			case <-e.done:
				return
			}
		}
	}()
	return e
}

// offer 有界入队：满时丢最旧并计数（背压裁定，Global 4）；每 4096 次丢弃一条 WARN（§11）。
func (e *watchEntry) offer(v any) {
	for {
		select {
		case e.ch <- v:
			return
		default:
			select {
			case <-e.ch: // 丢最旧
				if n := e.drop.Add(1); n%dropWarnEvery == 1 && e.log != nil {
					e.log.Warn("watch events dropped", "watch_id", e.id, "dropped_total", n)
				}
			default:
			}
		}
	}
}

// stop closes done (发射 goroutine 退出) then runs the stops (wcancel +
// watcher.Stop —— Updates chan 随订阅关闭而关闭，reader goroutine 随之退出)。
func (e *watchEntry) stop() {
	close(e.done)
	for _, f := range e.stops {
		f()
	}
}

// CreateKvWatch 订阅 KV 桶：keys 空 = 整桶（WatchAll），否则经 ValidateWatchFilter
// 的过滤串（Watch）。事件 kv:watch：初始逐键 + key="" sentinel（初始快照完成），
// 随后增量；值含 payload（不用 UpdatesOnly）。桶句柄解析走请求超时，订阅 ctx 用
// Background 派生的长生命周期 cancel ctx（绝不 s.timeout()）。
func (s *BucketService) CreateKvWatch(bucket, keys string) CreateWatchResult {
	js, res := s.js()
	if !res.Ok() {
		return CreateWatchResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	kv, err := js.KeyValue(ctx, bucket)
	if err != nil {
		return CreateWatchResult{CallResult: ClassifyKvError(err)} // ErrBucketNotFound → not_found
	}
	if keys != "" {
		if err := ValidateWatchFilter(keys); err != nil {
			return CreateWatchResult{CallResult: fail(CodeValidation, err.Error())}
		}
	}
	// 长生命周期订阅 ctx：wcancel 进 entry.stops，Stop/断连时注销订阅。
	wctx, wcancel := context.WithCancel(context.Background())
	var (
		watcher jetstream.KeyWatcher
		werr    error
	)
	if keys == "" {
		watcher, werr = kv.WatchAll(wctx)
	} else {
		watcher, werr = kv.Watch(wctx, keys)
	}
	if werr != nil {
		wcancel()
		return CreateWatchResult{CallResult: ClassifyKvError(werr)}
	}
	id := s.watches.allocate()
	e := s.watches.launch(id, s.emit, EventKvWatch)
	e.log = s.log
	e.stops = []func(){wcancel, func() { _ = watcher.Stop() }}
	s.watches.add(e)
	go func() {
		for entry := range watcher.Updates() {
			if entry == nil { // 初始快照完成 sentinel：offer 后继续（增量仍来）
				e.offer(KvWatchEvent{WatchId: id, Bucket: bucket})
				continue
			}
			v := encodeValue(entry.Key(), entry.Value(), entry.Revision(), entry.Created(), kvOpToWire(entry.Operation()))
			e.offer(KvWatchEvent{
				WatchId:     id,
				Bucket:      bucket,
				Key:         v.Key,
				Revision:    v.Revision,
				Operation:   v.Operation,
				PayloadB64:  v.PayloadB64,
				PayloadSize: v.PayloadSize,
				IsUtf8:      v.IsUtf8,
				TimestampMs: v.CreatedMs,
			})
		}
	}()
	s.log.Info("kv watch created", "watch_id", id, "bucket", bucket)
	return CreateWatchResult{WatchId: id}
}

// CreateObjWatch 订阅对象桶（Task 5 UI 消费）：事件 obj:watch，初始全量 +
// name="" sentinel，随后增量。ObjectInfo → ObjWatchEvent（ModTime → 毫秒 epoch）。
func (s *BucketService) CreateObjWatch(bucket string) CreateWatchResult {
	js, res := s.js()
	if !res.Ok() {
		return CreateWatchResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	obs, err := js.ObjectStore(ctx, bucket)
	if err != nil {
		return CreateWatchResult{CallResult: ClassifyKvError(err)} // ErrBucketNotFound → not_found
	}
	wctx, wcancel := context.WithCancel(context.Background())
	watcher, err := obs.Watch(wctx)
	if err != nil {
		wcancel()
		return CreateWatchResult{CallResult: ClassifyKvError(err)}
	}
	id := s.watches.allocate()
	e := s.watches.launch(id, s.emit, EventObjWatch)
	e.log = s.log
	e.stops = []func(){wcancel, func() { _ = watcher.Stop() }}
	s.watches.add(e)
	go func() {
		for info := range watcher.Updates() {
			if info == nil { // 初始快照完成 sentinel
				e.offer(ObjWatchEvent{WatchId: id, Bucket: bucket})
				continue
			}
			e.offer(ObjWatchEvent{
				WatchId:   id,
				Bucket:    bucket,
				Name:      info.Name,
				Size:      info.Size,
				Chunks:    info.Chunks,
				Digest:    info.Digest,
				ModTimeMs: info.ModTime.UnixMilli(),
				Deleted:   info.Deleted,
			})
		}
	}()
	s.log.Info("object watch created", "watch_id", id, "bucket", bucket)
	return CreateWatchResult{WatchId: id}
}

// StopWatch 关停单个 watcher：close done + stops（wcancel + watcher.Stop）+
// 注册表删除。未知 id → not_found。
func (s *BucketService) StopWatch(watchId string) CallResult {
	if watchId == "" {
		return fail(CodeValidation, "watch_id must not be empty")
	}
	e := s.watches.remove(watchId)
	if e == nil {
		return fail(CodeNotFound, "unknown watch_id")
	}
	e.stop()
	s.log.Info("watch stopped", "watch_id", watchId)
	return CallResult{}
}

// NotifyConnState 是 main.go 的 conn:state side-band（对齐 messaging
// SessionManager 惯例）：state != connected → 全部 watcher Stop + 注册表清空 +
// WARN 计数。订阅随连接消亡本就会失效，这里显式回收注册表与 goroutine。通知
// 路径非阻塞（stopAll 不持锁执行 stop），可安全从 Manager 的 emit 路径调用。
func (s *BucketService) NotifyConnState(ev connections.StateEvent) {
	if ev.State == connections.StateConnected {
		return
	}
	if n := s.watches.stopAll(); n > 0 {
		s.log.Warn("watchers stopped", "count", n, "state", string(ev.State))
	}
}
