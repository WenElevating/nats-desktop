package monitor

import (
	"fmt"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

func TestParseSysEvent(t *testing.T) {
	now := time.Unix(1700000000, 0)
	// disconnect 载荷（server.DisconnectEventMsg 真实形状——TypedEvent.ID 是
	// string、时间标签是 "timestamp"，严格 unmarshal 下数字 id 会失败）
	ev := parseSysEvent(7, "$SYS.ACCOUNT.APP.DISCONNECT", []byte(`{"type":"io.nats.server.advisory.v1.client_disconnect","id":"7","timestamp":"2023-11-14T22:13:20Z","server":{"name":"S1","cluster":"TEST"},"client":{"host":"127.0.0.1","user":"app","acc":"APP"},"reason":"client closed"}`), now)
	if ev.Seq != 7 || ev.Account != "APP" || ev.ServerName != "S1" {
		t.Fatalf("ev: %+v", ev)
	}
	if ev.Summary == "" {
		t.Fatalf("summary required: %+v", ev)
	}
	if ev.Type != "io.nats.server.advisory.v1.client_disconnect" {
		t.Fatalf("type: %+v", ev)
	}
	// JS advisory：只取 type。
	ev = parseSysEvent(8, "$JS.EVENT.ADVISORY.STREAM.CREATED.TEST", []byte(`{"type":"io.nats.jetstream.advisory.v1.stream_create"}`), now)
	if ev.Type == "" || ev.Summary != ev.Type {
		t.Fatalf("js advisory: %+v", ev)
	}
	// 未知形状：subject+size 保留、无摘要。
	ev = parseSysEvent(9, "$SYS.ODD.EVENT", []byte(`garbage`), now)
	if ev.Subject == "" || ev.SizeBytes != 7 || ev.Summary != "" {
		t.Fatalf("unknown: %+v", ev)
	}
}

// evLog 是 mutex 保护的事件收集器（emit 来自发射 goroutine，-race 门禁）。
type evLog struct {
	mu  sync.Mutex
	evs []SysWatchEvent
}

func (l *evLog) emit(name string, data any) {
	if name == EventSysWatch {
		l.mu.Lock()
		l.evs = append(l.evs, data.(SysWatchEvent))
		l.mu.Unlock()
	}
}

func (l *evLog) len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.evs)
}

func (l *evLog) first() SysWatchEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.evs[0]
}

func TestCreateSysWatchLifecycle(t *testing.T) {
	f := testutil.StartSysServer(t)
	sysNc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	l := &evLog{}
	s := NewMonitorService(connStub{sysNc}, nil, l.emit, "")

	res := s.CreateSysWatch(SysWatchSpec{Types: []string{"account_disconnect"}})
	if !res.Ok() || res.WatchId == "" {
		t.Fatalf("create: %+v", res)
	}
	// 制造断连：开一条 app 连接再关掉。
	victim := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
	victim.Flush()
	victim.Close()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && l.len() == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	if l.len() == 0 {
		t.Fatal("no sys:event observed")
	}
	ev := l.first()
	if ev.Event.Subject == "" || ev.Event.ServerName == "" || ev.DroppedTotal != 0 {
		t.Fatalf("event: %+v", ev)
	}
	if res := s.StopSysWatch(res.WatchId); !res.Ok() {
		t.Fatalf("stop: %+v", res)
	}
}

func TestCreateSysWatchValidation(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	s, _ := newService(t, nc)
	if res := s.CreateSysWatch(SysWatchSpec{Types: []string{"bogus"}}); res.ErrorCode != CodeValidation {
		t.Fatalf("type: %+v", res)
	}
	if res := s.CreateSysWatch(SysWatchSpec{Types: []string{"account_connect"}, Regex: "("}); res.ErrorCode != CodeValidation {
		t.Fatalf("regex: %+v", res)
	}
}

// 洪峰真实链路（Global 5）：200 条断连零丢失、dropped_total=0。
func TestSysWatchFloodNoLoss(t *testing.T) {
	f := testutil.StartSysServer(t)
	sysNc := testutil.ConnectUser(t, f.URL, f.SysUser, f.SysPass)
	l := &evLog{}
	s := NewMonitorService(connStub{sysNc}, nil, l.emit, "")
	res := s.CreateSysWatch(SysWatchSpec{Types: []string{"account_disconnect"}})
	if !res.Ok() {
		t.Fatal(res)
	}
	conns := make([]*nats.Conn, 0, 200) // 保留句柄统一关闭，防止句柄泄漏干扰后续用例
	for i := 0; i < 200; i++ {
		nc := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)
		nc.Flush()
		conns = append(conns, nc)
	}
	for _, nc := range conns {
		nc.Close()
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && l.len() < 200 {
		time.Sleep(100 * time.Millisecond)
	}
	if l.len() < 200 {
		t.Fatalf("flood loss: got %d < 200", l.len())
	}
}

// 10k ingest 性能门（Global 13 的可断言半边，纯内存不经网络）：10,000 条
// 事件过 ingest（正则滤掉一半），断言 <1s、通过事件零丢失、
// filtered_total==5000、dropped_total==0。同时覆盖队列容量满场景。
func TestSysWatchIngest10kWithRegex(t *testing.T) {
	e := newSysWatchEntryForTest(4096) // 生产容量
	defer e.stop()
	re := regexp.MustCompile(`^even\.`)
	start := time.Now()
	for i := 0; i < 10000; i++ {
		subj := fmt.Sprintf("odd.%d", i)
		if i%2 == 0 {
			subj = fmt.Sprintf("even.%d", i)
		}
		e.ingest(parseSysEvent(uint64(i), subj, nil, time.Now()), re)
	}
	elapsed := time.Since(start)
	e.waitDrained(time.Second)
	if elapsed >= time.Second {
		t.Fatalf("10k ingest too slow: %v", elapsed)
	}
	if got := e.filtered.Load(); got != 5000 {
		t.Fatalf("filtered_total: %d", got)
	}
	if got := e.drop.Load(); got != 0 {
		t.Fatalf("dropped_total: %d", got)
	}
	if n := e.emittedCount(); n != 5000 {
		t.Fatalf("emitted: %d", n)
	}
}

// 队列满丢最旧（纯单测，容量 2 注入 5 条）。
func TestSysWatchQueueDropOldest(t *testing.T) {
	e := newSysWatchEntryForTest(2)
	defer e.stop()
	for i := 0; i < 5; i++ {
		e.ingest(parseSysEvent(uint64(i), "x", nil, time.Now()), nil)
	}
	e.waitDrained(time.Second)
	if got := e.drop.Load(); got != 3 {
		t.Fatalf("dropped: %d", got)
	}
}

// newSysWatchEntryForTest 构造惰性发射的测试入口（brief 测试触达缝；同包直
// 接装配，不借生产构造器——后者会立即启动发射 goroutine）。发射 goroutine 不
// 随即启动，而是在积压 ≥1024（sysEmitterAutoStartBacklog）或 waitDrained 时才
// 启动：注入式 ingest 在测试 goroutine 上同步完成，若构造即启动，「容量 2 注
// 入 5 条必丢 3」会因发射者中途取走队列项而不确定；生产容量 4096 的 10k 注入
// 则在积压 1024 时自动转入并行消化，零丢弃断言不受影响。生产路径 launch 立即
// 启动，无此惰性。
func newSysWatchEntryForTest(capacity int) *sysWatchEntry {
	return &sysWatchEntry{
		id:   "test",
		ch:   make(chan SysEvent, capacity),
		done: make(chan struct{}),
		emit: func(string, any) {},
	}
}
