package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// ---------------------------------------------------------------------------
// $SYS 事件流 watch（§8.3 advisory 订阅）。结构照抄 buckets/watch.go 的 registry
// 模式（M4 裁定：包私有复制式适配，非 import）：每 watch 一个有界 4096 队列
// （满丢最旧 + 原子计数，每 4096 次丢弃一条 WARN）+ 单发射 goroutine 顺序 emit
// （单 goroutine 保序），每条事件捎带 dropped_total/filtered_total。订阅 ctx 一律
// Background 派生的长生命周期 cancel ctx，绝不超时包裹——nats.Context(ctx) 会随
// 超时静默注销订阅（Global 5）；断连时 NotifyConnState 全停（与 M4 对齐）。
// ---------------------------------------------------------------------------

// EventSysWatch 是 $SYS 事件流的事件名。
const EventSysWatch = "sys:event"

// SysWatchSpec 是 CreateSysWatch 的入参：闭集类型过滤（Global 10）+ 可选的
// subject 正则（过滤发生在入队之前，filtered_total 单独计数）。
type SysWatchSpec struct {
	Types []string `json:"types"`
	Regex string   `json:"regex"`
}

// sysWatchQueueCapacity 是每 watch 的有界队列容量（Global 4/5 背压裁定，与
// buckets watch 一致）；sysDropWarnEvery 对齐容量——丢弃计满一圈打一条 WARN。
const (
	sysWatchQueueCapacity = 4096
	sysDropWarnEvery      = 4096
)

type sysWatchRegistry struct {
	mu      sync.Mutex
	next    uint64
	entries map[string]*sysWatchEntry
}

// allocate reserves the next watch id (numeric string) under the registry lock.
func (r *sysWatchRegistry) allocate() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	return strconv.FormatUint(r.next, 10)
}

// add stores the entry under its already-allocated id. Called only after the
// entry is fully wired (subs/stops populated), so anything StopSysWatch/
// stopAll can observe is safe to stop.
func (r *sysWatchRegistry) add(e *sysWatchEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.entries == nil {
		r.entries = make(map[string]*sysWatchEntry)
	}
	r.entries[e.id] = e
}

// remove detaches the entry (nil when unknown) so stop can run lock-free.
func (r *sysWatchRegistry) remove(id string) *sysWatchEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.entries[id]
	delete(r.entries, id)
	return e
}

// stopAll stops every entry and empties the registry (断连全停).
func (r *sysWatchRegistry) stopAll() int {
	r.mu.Lock()
	entries := make([]*sysWatchEntry, 0, len(r.entries))
	for _, e := range r.entries {
		entries = append(entries, e)
	}
	r.entries = make(map[string]*sysWatchEntry)
	r.mu.Unlock()
	for _, e := range entries {
		e.stop()
	}
	return len(entries)
}

type sysWatchEntry struct {
	id   string
	subs []*nats.Subscription
	seq  atomic.Uint64 // 事件序号（订阅回调内递增，过滤前赋值）
	ch   chan SysEvent // 容量 4096；满则丢最旧

	drop     atomic.Uint64 // 队列满丢弃计数（丢最旧）
	filtered atomic.Uint64 // 正则过滤计数（入队前）
	emitted  atomic.Uint64 // 发射 goroutine 实际 emit 条数（测试零丢失断言）

	done  chan struct{}
	log   *slog.Logger // 丢弃 WARN 落点
	emit  func(name string, data any)
	stops []func() // 订阅 ctx cancel + 逐 subject Unsubscribe

	emitterOnce sync.Once
}

// sysEmitterAutoStartBacklog 是发射 goroutine 的惰性启动积压阈值（仅测试构造
// 器使用，见 newSysWatchEntryForTest）：生产构造器立即启动发射 goroutine（M4
// 惯例）；测试构造器延迟到「积压 ≥1024 或 waitDrained」才启动。取绝对值而非
// 容量比例是确定性的关键：生产容量 4096 下 10k 注入在积压 1024 时启动发射者
// （远离容量，之后发射者持续并行消化 → 全程零丢弃）；而微小容量（如丢最旧
// 用例的 2）永远达不到阈值，注满 2 槽丢 3 条的断言完全同步、可精确成立。
const sysEmitterAutoStartBacklog = 1024

// ensureEmitter 恰好启动一次发射 goroutine。
func (e *sysWatchEntry) ensureEmitter() {
	e.emitterOnce.Do(func() { go e.runEmitter() })
}

// newSysWatchEntry 装配 entry 并立即启动发射 goroutine（生产路径；测试经
// newSysWatchEntryForTest 注入容量并惰性启动，见 syswatch_test.go）。
func newSysWatchEntry(id string, capacity int, emit func(name string, data any), log *slog.Logger) *sysWatchEntry {
	e := &sysWatchEntry{id: id, ch: make(chan SysEvent, capacity), done: make(chan struct{}), emit: emit, log: log}
	e.ensureEmitter()
	return e
}

// runEmitter 是单发射 goroutine：顺序 emit 保序；emit 调用 recover 保护
// （Global 20：前端回调 panic 不拖垮发射循环），每条事件捎带累计
// dropped/filtered 计数（wire 来源）。
func (e *sysWatchEntry) runEmitter() {
	for {
		select {
		case ev := <-e.ch:
			we := SysWatchEvent{
				WatchId:       e.id,
				Event:         ev,
				DroppedTotal:  e.drop.Load(),
				FilteredTotal: e.filtered.Load(),
			}
			e.emitted.Add(1)
			e.emitRecover(we)
		case <-e.done:
			return
		}
	}
}

func (e *sysWatchEntry) emitRecover(we SysWatchEvent) {
	defer func() {
		if r := recover(); r != nil && e.log != nil {
			e.log.Error("sys watch emit panic recovered", "watch_id", e.id, "panic", r)
		}
	}()
	e.emit(EventSysWatch, we)
}

// offer 有界入队：满时丢最旧并计数（背压裁定，Global 4/5）；每 4096 次丢弃一条 WARN（§11）。
// 积压达到阈值时惰性启动发射 goroutine（生产路径下发射者早已在跑，此处是
// 一次空操作；仅测试构造器的惰性模式会真正触发，见 sysEmitterAutoStartBacklog）。
func (e *sysWatchEntry) offer(ev SysEvent) {
	if len(e.ch) >= sysEmitterAutoStartBacklog {
		e.ensureEmitter()
	}
	for {
		select {
		case e.ch <- ev:
			return
		default:
			select {
			case <-e.ch: // 丢最旧
				if n := e.drop.Add(1); n%sysDropWarnEvery == 1 && e.log != nil {
					e.log.Warn("sys watch events dropped", "watch_id", e.id, "dropped_total", n)
				}
			default:
			}
		}
	}
}

// ingest 是订阅回调的前置路径：regex subject 过滤（filtered_total 计数）后
// offer 入有界队列。re 为 nil 表示不过滤——测试经同一入口注入正则。
func (e *sysWatchEntry) ingest(ev SysEvent, re *regexp.Regexp) {
	if re != nil && !re.MatchString(ev.Subject) {
		e.filtered.Add(1)
		return
	}
	e.offer(ev)
}

// waitDrained 等待队列排空且发射计数稳定（测试触达缝；生产路径不调用）。
// 先确保发射 goroutine 在跑（惰性模式下此时才真正启动——注满断言型的用例
// 在此之前完全同步），「连续 3 次轮询队列空且 emitted 不再增长」判定排空
// ——排除最后一条已被 emitter 取走但尚未 emit 完成的窗口。
func (e *sysWatchEntry) waitDrained(timeout time.Duration) bool {
	e.ensureEmitter()
	deadline := time.Now().Add(timeout)
	stable := 0
	last := uint64(0)
	for {
		empty := len(e.ch) == 0
		cur := e.emitted.Load()
		if empty && cur == last {
			stable++
			if stable >= 3 {
				return true
			}
		} else {
			stable = 0
		}
		last = cur
		if time.Now().After(deadline) {
			return empty
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// emittedCount 返回发射 goroutine 实际 emit 的条数（测试零丢失断言用）。
func (e *sysWatchEntry) emittedCount() uint64 { return e.emitted.Load() }

// stop closes done (发射 goroutine 退出) then runs the stops (订阅 ctx cancel
// + 逐 subject Unsubscribe——连接消亡本就会失效，这里显式回收)。
func (e *sysWatchEntry) stop() {
	close(e.done)
	for _, f := range e.stops {
		f()
	}
}

// sysDomain 取当前上下文的 JS domain。JSParams 的 ok=false 不阻断 watch 创建：
// $SYS 主题与 domain 无关，domain 只影响 JS advisory 前缀派生（forms.go
// EventSubjects 三级规则），缺省按空 domain（默认 $JS.EVENT 前缀）处理。
func (s *MonitorService) sysDomain() string {
	domain, _, ok := s.mgr.JSParams()
	if !ok {
		return ""
	}
	return domain
}

// CreateSysWatch 订阅 $SYS 事件流：校验（闭集类型/正则）→ subjects =
// EventSubjects(types, JSEventPrefix, domain) → 逐 subject Subscribe（长生命
// 周期 cancel ctx）→ 回调 ingest（regex 过滤 → 解析 → 有界队列）→ 单发射
// goroutine emit("sys:event")。部分订阅失败时回滚已建订阅（fail closed）。
func (s *MonitorService) CreateSysWatch(spec SysWatchSpec) CreateSysWatchResult {
	if len(spec.Types) == 0 {
		return CreateSysWatchResult{CallResult: fail(CodeValidation, "types must not be empty")}
	}
	subjects, err := EventSubjects(spec.Types, s.mgr.JSEventPrefix(), s.sysDomain())
	if err != nil {
		return CreateSysWatchResult{CallResult: fail(CodeValidation, err.Error())}
	}
	re, err := CompileEventRegex(spec.Regex)
	if err != nil {
		return CreateSysWatchResult{CallResult: fail(CodeValidation, err.Error())}
	}
	nc := s.mgr.Conn()
	if nc == nil || nc.IsClosed() {
		return CreateSysWatchResult{CallResult: fail(CodeNotConnected, "not connected")}
	}
	// 长生命周期订阅 ctx：Background 派生 cancel，绝不超时包裹（Global 5）；
	// wcancel 进 entry.stops，Stop/断连时先于 Unsubscribe 触发，回调据此丢弃
	// 停止后仍在飞的最后一批消息（不再 ingest 进已停 watch）。
	wctx, wcancel := context.WithCancel(context.Background())
	id := s.sysWatches.allocate()
	e := newSysWatchEntry(id, sysWatchQueueCapacity, s.emit, s.log)
	for _, subj := range subjects {
		sub, err := nc.Subscribe(subj, func(m *nats.Msg) {
			if wctx.Err() != nil {
				return
			}
			e.ingest(parseSysEvent(e.seq.Add(1), m.Subject, m.Data, time.Now()), re)
		})
		if err != nil {
			wcancel()
			e.stop() // 发射 goroutine 退出
			for _, prev := range e.subs {
				_ = prev.Unsubscribe()
			}
			return CreateSysWatchResult{CallResult: fail(CodeServer, err.Error())}
		}
		e.subs = append(e.subs, sub)
	}
	e.stops = []func(){
		wcancel,
		func() {
			for _, sub := range e.subs {
				_ = sub.Unsubscribe()
			}
		},
	}
	s.sysWatches.add(e)
	s.log.Info("sys watch created", "watch_id", id, "subjects", subjects)
	return CreateSysWatchResult{WatchId: id}
}

// StopSysWatch 关停单个 sys watch：close done + stops（cancel + Unsubscribe）+
// 注册表删除。未知 id → not_found。
func (s *MonitorService) StopSysWatch(watchId string) CallResult {
	if watchId == "" {
		return fail(CodeValidation, "watch_id must not be empty")
	}
	e := s.sysWatches.remove(watchId)
	if e == nil {
		return fail(CodeNotFound, "unknown watch_id")
	}
	e.stop()
	s.log.Info("sys watch stopped", "watch_id", watchId)
	return CallResult{}
}

// stopAllSysWatches 停全部 sys watch 并清空注册表（断连全停，与 M4 对齐）。
// 通知路径非阻塞（stopAll 不持锁执行 stop），可安全从 conn:state 侧带调用。
func (s *MonitorService) stopAllSysWatches() {
	if n := s.sysWatches.stopAll(); n > 0 {
		s.log.Warn("sys watches stopped", "count", n)
	}
}

// parseSysEvent 是事件解析纯函数（$SYS advisory → SysEvent 摘要）。摘要化：
// 载荷原文绝不保留（SizeBytes 只记长度，Global 9）。OccurredMs 优先取载荷
// timestamp（TypedEvent.Time），缺失/未解析回退入参 now。已知形状解析失败
// （如 TypedEvent.ID 非字符串的严格 unmarshal 失败）按未知处理：Type=""、
// Summary=""，UI 显示 subject + size。
func parseSysEvent(seq uint64, subject string, data []byte, now time.Time) SysEvent {
	ev := SysEvent{Seq: seq, Subject: subject, SizeBytes: len(data), OccurredMs: now.UnixMilli()}
	switch {
	case strings.HasPrefix(subject, "$JS."):
		// JS advisory/metric：只取 {Type,Time}，Summary=Type；服务器/账户不填。
		// 前缀取宽到 $JS.*：EventSubjects 在 domain 部署下派生的主题是
		// $JS.<domain>.EVENT.*（jsm.EventSubject 换前缀），同样只该取 type。
		var te server.TypedEvent
		if json.Unmarshal(data, &te) != nil || te.Type == "" {
			return ev // 未知/解析失败：subject+size 保留，无摘要
		}
		ev.Type = te.Type
		ev.Summary = te.Type
		if !te.Time.IsZero() {
			ev.OccurredMs = te.Time.UnixMilli()
		}
		return ev
	case strings.HasPrefix(subject, "$SYS.ACCOUNT.") && strings.HasSuffix(subject, ".CONNECT"),
		strings.HasPrefix(subject, "$SYS.ACCOUNT.") && strings.HasSuffix(subject, ".DISCONNECT"):
		// $SYS.ACCOUNT.<acc>.CONNECT/.DISCONNECT：server.ConnectEventMsg /
		// DisconnectEventMsg（同一 ClientInfo 形状）。Account 取主题段 acc。
		var dm server.DisconnectEventMsg
		if json.Unmarshal(data, &dm) != nil || dm.Type == "" {
			return ev
		}
		if acc := accountFromSubject(subject); acc != "" {
			ev.Account = acc
		}
		ev.Type = dm.Type
		ev.ServerName = dm.Server.Name
		ev.ServerCluster = dm.Server.Cluster
		if !dm.Time.IsZero() {
			ev.OccurredMs = dm.Time.UnixMilli()
		}
		user, host := dm.Client.User, dm.Client.Host
		if strings.HasSuffix(subject, ".DISCONNECT") {
			ev.Summary = fmt.Sprintf("%s@%s %s", user, host, dm.Reason)
		} else {
			ev.Summary = fmt.Sprintf("%s@%s connected", user, host)
		}
		return ev
	case strings.HasPrefix(subject, "$SYS.SERVER.") && strings.HasSuffix(subject, ".CLIENT.AUTH.ERR"):
		// 认证错误 advisory 的载荷就是 DisconnectEventMsg（nats-server
		// sendAuthErrorEvent），Reason 为主构成摘要。
		var dm server.DisconnectEventMsg
		if json.Unmarshal(data, &dm) != nil || dm.Type == "" {
			return ev
		}
		ev.Type = dm.Type
		ev.ServerName = dm.Server.Name
		ev.ServerCluster = dm.Server.Cluster
		if !dm.Time.IsZero() {
			ev.OccurredMs = dm.Time.UnixMilli()
		}
		ev.Summary = fmt.Sprintf("%s %s@%s", dm.Reason, dm.Client.User, dm.Client.Host)
		return ev
	default:
		return ev // 未知形状：subject+size 保留，无摘要
	}
}

// accountFromSubject 从 $SYS.ACCOUNT.<acc>.<verb> 主题取账户段。
func accountFromSubject(subject string) string {
	parts := strings.Split(subject, ".")
	if len(parts) != 4 {
		return ""
	}
	return parts[2]
}
