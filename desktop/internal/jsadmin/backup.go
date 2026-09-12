package jsadmin

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/nats.go"
	"github.com/wailsapp/wails/v3/pkg/application"
)

var ErrRestoreTargetExists = errors.New("restore target stream already exists")
var ErrBackupBusy = errors.New("another backup or restore is already running")

// EventStreamBackup 载荷为 BackupProgress（types.go）：running 在启动与每次
// 进度通知时发出，complete 在成功收尾时发出；任何失败路径先发 incomplete
// 再返回分类错误，绝不以 complete 收尾（spec §6.6 备份中断行）。
const EventStreamBackup = "stream:backup"

// PickBackupDirectory opens the native directory chooser. "" means the
// user cancelled (no error surfaced to the UI).
func (s *JetAdminService) PickBackupDirectory() string {
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return "" // tests / headless
	}
	dir, err := app.Dialog.OpenFile().
		CanChooseDirectories(true).CanChooseFiles(false).CanCreateDirectories(true).
		SetTitle("Select backup directory").
		PromptForSingleSelection()
	if err != nil || dir == "" {
		return ""
	}
	return dir
}

func readBackupName(dir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "backup.json"))
	if err != nil {
		return "", err
	}
	var req struct {
		Config api.StreamConfig `json:"config"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return "", err
	}
	if req.Config.Name == "" {
		return "", errors.New("backup.json has no stream name")
	}
	return req.Config.Name, nil
}

func (s *JetAdminService) emitProgress(p BackupProgress) { s.emit(EventStreamBackup, p) }

// watchConnClose 轮询连接关闭（50ms；不使用 SetClosedHandler——那会覆盖应用
// 可能已注册的关闭回调），一旦断线先置位 dropped 再取消 ctx。先置位是刻意的：
// jsm 收到取消后会保留已完成分片并返回 nil error（见下），若此刻 dropped 尚未
// 置位，调用方会把被中断的备份误判为 complete——违反 §6.6「不得声称完整」。
// BackupStream/RestoreBackup 共用（§6.6 异常表「备份中断」行）。
func watchConnClose(ctx context.Context, cancel context.CancelFunc, nc *nats.Conn, dropped chan struct{}) {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if nc.IsClosed() {
				close(dropped)
				cancel()
				return
			}
		}
	}
}

// backupFailed 收尾失败路径：置位 finished 挡住 jsm 的迟到通知，发出
// incomplete，再返回分类结果（ErrConnectionClosed 单列为 not_connected，
// 引导前端到连接管理，§8.5.2）。
func (s *JetAdminService) backupFailed(stream, direction string, finished *atomic.Bool, err error, logMsg string) CallResult {
	finished.Store(true)
	s.emitProgress(BackupProgress{Stream: stream, Direction: direction, Phase: "incomplete"})
	s.log.Warn(logMsg, "stream", stream, "err", err)
	if errors.Is(err, nats.ErrConnectionClosed) {
		return fail(CodeNotConnected, "connection closed during "+direction+": "+err.Error())
	}
	return ClassifyError(err)
}

// droppedIncomplete 断线取消路径：jsm 的 ctx 取消分支保留已完成分片并返回
// nil error（jsm 行为），这里显式标记不完整——绝不对断连后的产物声称完整。
func (s *JetAdminService) droppedIncomplete(stream, direction string, finished *atomic.Bool) CallResult {
	finished.Store(true)
	s.emitProgress(BackupProgress{Stream: stream, Direction: direction, Phase: "incomplete"})
	s.log.Warn(logIncompleteMsg(direction), "stream", stream)
	return fail(CodeNotConnected, "connection closed during "+direction+": partial artifacts retained")
}

func logIncompleteMsg(direction string) string {
	if direction == "restore" {
		return "restore incomplete: connection closed"
	}
	return "backup incomplete: connection closed"
}

func (s *JetAdminService) BackupStream(stream, dir string, includeConsumers bool) CallResult {
	if !s.backupMu.CompareAndSwap(0, 1) {
		return fail(CodeValidation, ErrBackupBusy.Error())
	}
	defer s.backupMu.Store(0)
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	st, err := mgr.LoadStream(stream)
	if err != nil {
		return ClassifyError(err)
	}
	// 断线监控：jsm 快照是纯接收端——连接关闭后订阅静默停摆，jsm 既不上报
	// 错误也不超时（context.Background() 会永久挂起，无法落实 §6.6「停止
	// 备份」）。监控 goroutine 检测到断线即取消快照 ctx。
	nc := s.mgr.Conn()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dropped := make(chan struct{})
	go watchConnClose(ctx, cancel, nc, dropped)
	// 进度通知收尾防护：jsm 的 bps 心跳/分片回调可能在 SnapshotToDirectory
	// 返回后补发一次 running——finished 置位后丢弃，保证终态事件之后不再有
	// running 尾巴（last-phase 断言确定性）。
	var finished atomic.Bool
	opts := []jsm.SnapshotOption{
		jsm.SnapshotNotify(func(p jsm.SnapshotProgress) {
			if finished.Load() {
				return
			}
			s.emitProgress(BackupProgress{Stream: stream, Direction: "backup", Phase: "running",
				BytesDone: p.BytesReceived(), BytesTotal: p.BytesExpected(), ChunksDone: p.ChunksReceived()})
		}),
	}
	if includeConsumers {
		opts = append(opts, jsm.SnapshotConsumers())
	}
	s.emitProgress(BackupProgress{Stream: stream, Direction: "backup", Phase: "running"})
	if _, err := st.SnapshotToDirectory(ctx, dir, opts...); err != nil {
		// 连接断开/中断：保留已完成分片（jsm 行为），显式标记不完整（§6.6）
		return s.backupFailed(stream, "backup", &finished, err, "backup incomplete")
	}
	select {
	case <-dropped:
		return s.droppedIncomplete(stream, "backup", &finished)
	default:
	}
	finished.Store(true)
	s.emitProgress(BackupProgress{Stream: stream, Direction: "backup", Phase: "complete"})
	s.log.Info("backup complete", "stream", stream)
	return CallResult{}
}

func (s *JetAdminService) RestoreBackup(dir string, overwrite bool) CallResult {
	if !s.backupMu.CompareAndSwap(0, 1) {
		return fail(CodeValidation, ErrBackupBusy.Error())
	}
	defer s.backupMu.Store(0)
	name, err := readBackupName(dir)
	if err != nil {
		return fail(CodeValidation, "invalid backup directory: "+err.Error())
	}
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	known, err := mgr.IsKnownStream(name)
	if err != nil {
		return ClassifyError(err)
	}
	if known {
		if !overwrite {
			return fail(CodeValidation, ErrRestoreTargetExists.Error()+" (confirm delete-and-recreate)")
		}
		if err := mgr.DeleteStream(name); err != nil { // 覆盖语义 = 删除重建（§6.6）
			return ClassifyError(err)
		}
	}
	nc := s.mgr.Conn()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dropped := make(chan struct{})
	go watchConnClose(ctx, cancel, nc, dropped)
	var finished atomic.Bool
	s.emitProgress(BackupProgress{Stream: name, Direction: "restore", Phase: "running"})
	_, _, err = mgr.RestoreSnapshotFromDirectory(ctx, name, dir,
		jsm.RestoreNotify(func(p jsm.RestoreProgress) {
			if finished.Load() {
				return
			}
			s.emitProgress(BackupProgress{Stream: name, Direction: "restore", Phase: "running", ChunksDone: p.ChunksSent()})
		}))
	select {
	case <-dropped:
		// 恢复循环逐块检查 ctx（逐块 nc.Request 断线时本就报错），但取消可能
		// 与请求竞态——dropped 优先判定，语义统一为 not_connected + incomplete
		return s.droppedIncomplete(name, "restore", &finished)
	default:
	}
	if err != nil {
		return s.backupFailed(name, "restore", &finished, err, "restore incomplete")
	}
	finished.Store(true)
	s.emitProgress(BackupProgress{Stream: name, Direction: "restore", Phase: "complete"})
	s.log.Info("restore complete", "stream", name)
	return CallResult{}
}
