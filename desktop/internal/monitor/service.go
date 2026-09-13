package monitor

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/connections"
	"github.com/WenElevating/nats-desktop/desktop/internal/settings"
)

// connSource 是 MonitorService 对 connections.Manager 的最小视图；JSEventPrefix
// 由 Manager 的同名公开访问器提供（spec §8.3 JS 事件主题）。
type connSource interface {
	Conn() *nats.Conn
	JSParams() (domain, apiPrefix string, ok bool)
	JSEventPrefix() string
}

// EventMonitorSnapshot 是每轮询周期推送的事件名（§8.5.1）。
const EventMonitorSnapshot = "monitor:snapshot"

// snapshotTimeout 是节点级请求超时（§6.10 异常表「2s」原文；不随设置变）。
const snapshotTimeout = 2 * time.Second

type MonitorService struct {
	mgr          connSource
	log          *slog.Logger
	emit         func(name string, data any)
	settingsPath string

	runMu      sync.Mutex // 保护 running/ticker/known 三者一致的启停
	running    bool
	tickerDone chan struct{}
	cancel     context.CancelFunc

	snapshotMu sync.Mutex
	last       MonitorSnapshot
	cycleBusy  atomic.Bool // 周期单飞：上一轮未完成跳过本次 tick（Global 1）

	known map[string]MonitorServerRow // 跨周期已知服务器（离线标记）

	sysWatches sysWatchRegistry // $SYS 事件 watch 注册表（Task 7；零值可用）

	// 集群危险操作单飞（Task 8；clusterops.go 持有，key=op+"\x00"+target）。
	opsMu       sync.Mutex
	opsInFlight map[string]bool
}

func NewMonitorService(mgr connSource, log *slog.Logger, emit func(name string, data any), settingsPath string) *MonitorService {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if emit == nil {
		emit = func(string, any) {}
	}
	return &MonitorService{mgr: mgr, log: log, emit: emit, settingsPath: settingsPath, known: map[string]MonitorServerRow{}}
}

// interval 从设置读取轮询间隔并夹取到 2..60s（损坏/缺失文件回退默认 5s）。
// snapshotTimeout 不走这里——固定 2s，不随设置变（§6.10）。
func (s *MonitorService) interval() time.Duration {
	st, err := settings.Load(s.settingsPath)
	if err != nil || st.Behavior.PollIntervalSeconds < 2 {
		return 5 * time.Second
	}
	if st.Behavior.PollIntervalSeconds > 60 {
		return 60 * time.Second
	}
	return time.Duration(st.Behavior.PollIntervalSeconds) * time.Second
}

func (s *MonitorService) StartMonitoring() CallResult {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.running {
		return CallResult{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.running = true
	s.cancel = cancel
	s.tickerDone = make(chan struct{})
	go s.pollLoop(ctx, s.interval())
	return CallResult{}
}

// pollLoop 立即执行一次周期（§6.5「恢复可见后立即执行一次刷新」的 Go 半边），
// 随后按 interval 续推；panic 兜底记 Error 后退出该 goroutine（Global 20），
// 绝不 os.Exit 拖垮整个进程。
func (s *MonitorService) pollLoop(ctx context.Context, interval time.Duration) {
	defer close(s.tickerDone)
	defer func() {
		if r := recover(); r != nil {
			s.log.Error("monitor poll loop panic recovered", "panic", r)
		}
	}()
	tk := time.NewTicker(interval)
	defer tk.Stop()
	s.runCycle(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
			s.runCycle(ctx)
		}
	}
}

// StopMonitoring 幂等；等 poll goroutine 退出后再返回，避免与下一次
// Start 竞争 emit 顺序。
func (s *MonitorService) StopMonitoring() CallResult {
	s.runMu.Lock()
	if !s.running {
		s.runMu.Unlock()
		return CallResult{}
	}
	s.running = false
	cancel, done := s.cancel, s.tickerDone
	s.cancel = nil
	s.runMu.Unlock()
	cancel()
	<-done
	return CallResult{}
}

// runCycle 单飞执行一轮采集并 emit；上一轮未完成则跳过本次 tick（Global 1）。
func (s *MonitorService) runCycle(ctx context.Context) {
	if !s.cycleBusy.CompareAndSwap(false, true) {
		return
	}
	defer s.cycleBusy.Store(false)
	snap := s.collectSnapshot()
	s.snapshotMu.Lock()
	s.last = snap
	s.snapshotMu.Unlock()
	if ctx.Err() == nil { // 停止过程中的最后一轮不再 emit
		s.emit(EventMonitorSnapshot, snap)
	}
}

// GetMonitoringSnapshot 返回最近一轮缓存快照；未启动过时是零值
// （SysAvailable=false）。
func (s *MonitorService) GetMonitoringSnapshot() MonitorSnapshot {
	s.snapshotMu.Lock()
	defer s.snapshotMu.Unlock()
	return s.last
}

// NotifyConnState：非 connected 一律停轮询并停全部 sys watch（事件 watch
// 断连全停，与 M4 buckets watcher 对齐）。
func (s *MonitorService) NotifyConnState(ev connections.StateEvent) {
	if ev.State == connections.StateConnected {
		return
	}
	_ = s.StopMonitoring()
	s.stopAllSysWatches()
	s.log.Warn("monitor polling stopped", "state", string(ev.State))
}
