package buckets

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// ---------------------------------------------------------------------------
// 对象上传/下载（spec §6.9）：阻塞绑定方法 + obj:transfer 事件。transferMu 单飞
// （同 M3 backupMu CAS 模式，多文件排队由前端负责）；传输 ctx 不设超时但挂
// conn-close watchdog（jsadmin/backup.go watchConnClose 同款）——断连 → Put/Read
// 返回错误 → phase=incomplete + 服务器原文，已完成分片保留在服务器（服务层不做
// 任何删除），重试入口=前端再调一次（Global 2）。running 事件经节流器发射（每
// ≥64KB 或 ≥200ms 一条）；终态事件（complete/incomplete）每传输恰一次（finished
// 挡迟到回调，对齐 backup.go）。对象名/尺寸/摘要可入日志，内容绝不入日志（§13.3）。
// ---------------------------------------------------------------------------

// running 事件节流阈值（brief Step 2）：每累计 ≥64KB 或距上次 ≥200ms 发一条，
// 兼顾 2MB 小文件的进度可见度与百 MB 级传输的事件密度。
const (
	transferEmitBytes = 64 << 10
	transferEmitEvery = 200 * time.Millisecond
)

// diskFree 是磁盘预检的可替换实现（测试 stub 点）：平台实现在 disk_windows.go
//（GetDiskFreeSpaceEx），非 Windows 桩返回 0 = 未知（disk_other.go，不阻止）。
var diskFree = defaultDiskFree

// progressThrottle 是单传输的 running 事件节流器（非并发安全——仅在 Put 读循环
// / io.Copy 的单 goroutine 回调路径使用）。
type progressThrottle struct {
	lastN uint64
	lastT time.Time
}

func newProgressThrottle() *progressThrottle {
	return &progressThrottle{lastT: time.Now()}
}

func (t *progressThrottle) allow(n uint64) bool {
	if n-t.lastN >= transferEmitBytes || time.Since(t.lastT) >= transferEmitEvery {
		t.lastN, t.lastT = n, time.Now()
		return true
	}
	return false
}

// countingReader 包装上传源文件：累计已读字节并按节流回调发 running 事件
// （Put 读到 EOF 为止，全部回调发生在 Put 返回之前）。
type countingReader struct {
	r    io.Reader
	n    uint64
	th   *progressThrottle
	fin  *atomic.Bool
	tpl  ObjTransferEvent
	emit func(ObjTransferEvent)
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 {
		c.n += uint64(n)
		if !c.fin.Load() && c.th.allow(c.n) {
			e := c.tpl
			e.Phase = "running"
			e.BytesDone = c.n
			c.emit(e)
		}
	}
	return n, err
}

// countingWriter 包装下载目标文件：累计已写字节并按节流回调发 running 事件
//（io.Copy 的 32KB 缓冲下每 2 次写达 64KB 阈值，200ms 兜底慢速链路）。
type countingWriter struct {
	w    io.Writer
	n    uint64
	th   *progressThrottle
	fin  *atomic.Bool
	tpl  ObjTransferEvent
	emit func(ObjTransferEvent)
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	if n > 0 {
		c.n += uint64(n)
		if !c.fin.Load() && c.th.allow(c.n) {
			e := c.tpl
			e.Phase = "running"
			e.BytesDone = c.n
			c.emit(e)
		}
	}
	return n, err
}

// watchConnClose 轮询连接关闭（50ms；不使用 SetClosedHandler——那会覆盖应用
// 可能已注册的关闭回调），一旦断线先置位 dropped 再取消 ctx。先置位是刻意的：
// Put/Read 收到取消后的返回值存在竞态窗口，调用方以 dropped 通道为中断权威判定，
// 绝不对断连后的产物声称完整——jsadmin/backup.go 同款（UploadObject/DownloadObject
// 共用，§6.9 上传/下载中断行）。
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

func (s *BucketService) emitObjTransfer(e ObjTransferEvent) { s.emit(EventObjTransfer, e) }

// nextTransferId reserves the next transfer id (numeric string, watch_id 同款).
func (s *BucketService) nextTransferId() string {
	return strconv.FormatUint(s.transferSeq.Add(1), 10)
}

// PickUploadFiles opens the native multi-select file chooser (M3
// PickBackupDirectory 同款链). Returns the selected paths; cancel/err → empty
// slice (no error surfaced to the UI, 同 PickBackupDirectory 语义).
func (s *BucketService) PickUploadFiles() []string {
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return []string{} // tests / headless
	}
	files, err := app.Dialog.OpenFile().
		CanChooseFiles(true).CanChooseDirectories(false).
		SetTitle("Select files to upload").
		PromptForMultipleSelection()
	if err != nil || len(files) == 0 {
		return []string{}
	}
	return files
}

// PickDownloadDirectory opens the native directory chooser (对齐
// PickBackupDirectory). "" means the user cancelled.
func (s *BucketService) PickDownloadDirectory() string {
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return "" // tests / headless
	}
	dir, err := app.Dialog.OpenFile().
		CanChooseDirectories(true).CanChooseFiles(false).CanCreateDirectories(true).
		SetTitle("Select download directory").
		PromptForSingleSelection()
	if err != nil || dir == "" {
		return ""
	}
	return dir
}

// UploadObject 上传本地文件到对象桶（§6.9）：阻塞调用 + obj:transfer 事件。
// CompareAndSwap 门在任何 IO 之前；bytes_total = os.stat 的 size；rename 为空
// 时取 filepath.Base(path)。传输 ctx 不设超时（nats.go Put 在无 deadline ctx 下
// 用 per-publish 默认超时，大文件不受绝对期限截断），watchdog 兜断连。失败路径
// 先发 incomplete 再返回分类错误，成功才以 complete 收尾（bytes_done == bytes_total）。
func (s *BucketService) UploadObject(bucket, path, rename string) CallResult {
	if !s.transferMu.CompareAndSwap(0, 1) {
		return fail(CodeValidation, ErrTransferBusy.Error())
	}
	defer s.transferMu.Store(0)
	if path == "" {
		return fail(CodeValidation, "path must not be empty")
	}
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	osb, err := js.ObjectStore(ctx, bucket)
	if err != nil {
		return ClassifyKvError(err) // ErrBucketNotFound → not_found
	}
	f, err := os.Open(path)
	if err != nil {
		return fail(CodeValidation, err.Error()) // 本地路径问题（缺失/权限）
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return fail(CodeValidation, err.Error())
	}
	if st.IsDir() {
		return fail(CodeValidation, "path is a directory, not a file")
	}
	total := uint64(st.Size())
	name := rename
	if name == "" {
		name = filepath.Base(path)
	}
	// 断线监控：Put 是长时操作，服务器无响应时 per-publish 超时兜底，但连接
	// 关闭必须立即中断（取消 Put 的读取循环），watchdog 检测到即取消传输 ctx。
	nc := s.mgr.Conn()
	pctx, pcancel := context.WithCancel(context.Background())
	defer pcancel()
	dropped := make(chan struct{})
	go watchConnClose(pctx, pcancel, nc, dropped)
	var finished atomic.Bool
	tpl := ObjTransferEvent{
		TransferId: s.nextTransferId(),
		Bucket:     bucket,
		Name:       name,
		Direction:  "upload",
		BytesTotal: total,
	}
	cr := &countingReader{r: f, th: newProgressThrottle(), fin: &finished, tpl: tpl, emit: s.emitObjTransfer}
	s.emitObjTransfer(tpl) // 初始 running（bytes_done=0，对齐 backup.go emit 顺序）
	info, err := osb.Put(pctx, jetstream.ObjectMeta{Name: name}, cr)
	if err != nil {
		finished.Store(true)
		e := tpl
		e.Phase = "incomplete"
		e.Error = err.Error()
		s.emitObjTransfer(e)
		s.log.Warn("upload incomplete", "bucket", bucket, "object", name, "err", err)
		if errors.Is(err, nats.ErrConnectionClosed) {
			return fail(CodeNotConnected, "connection closed during upload: "+err.Error())
		}
		return ClassifyKvError(err)
	}
	select {
	case <-dropped:
		// 与取消竞态：Put 可能返回 nil 但连接已死——绝不声称完整（backup.go 同款）
		finished.Store(true)
		e := tpl
		e.Phase = "incomplete"
		e.Error = "connection closed during upload"
		s.emitObjTransfer(e)
		s.log.Warn("upload incomplete: connection closed", "bucket", bucket, "object", name)
		return fail(CodeNotConnected, "connection closed during upload: partial artifacts retained")
	default:
	}
	finished.Store(true)
	done := total
	if info != nil && info.Size > 0 {
		done = info.Size
	}
	e := tpl
	e.Phase = "complete"
	e.BytesDone = done
	s.emitObjTransfer(e)
	s.log.Info("upload complete", "bucket", bucket, "object", name, "bytes", done)
	return CallResult{}
}

// DownloadObject 下载桶内对象到目录（§6.9）：磁盘预检（free>0 且 < info.Size
// 才拒绝——0 = 未知平台/查询失败，绝不阻止）→ os.Get（info 返回时即就绪，取
// bytes_total/digest）→ 覆盖写（已存在先删，Windows rename 语义）→ io.Copy
//（countingWriter 节流 running + TeeReader 进 sha256）→ 摘要复核。摘要不匹配
//（含 nats.go Read 在 EOF 的内建 ErrDigestMismatch——tee 是第二道双保险）→
// phase=incomplete + error「digest mismatch」，文件保留供人工比对；匹配 →
// complete + digest_match=true。传输 ctx 不设超时（nats.go Read 在无 deadline
// ctx 下用 per-read 默认 API 超时，大文件不受绝对期限截断），watchdog 兜断连
//（取消 ctx → Read 返回错误 → incomplete）。
func (s *BucketService) DownloadObject(bucket, name, dir string) CallResult {
	if !s.transferMu.CompareAndSwap(0, 1) {
		return fail(CodeValidation, ErrTransferBusy.Error())
	}
	defer s.transferMu.Store(0)
	if name == "" {
		return fail(CodeValidation, "name must not be empty")
	}
	if dir == "" {
		return fail(CodeValidation, "dir must not be empty")
	}
	js, res := s.js()
	if !res.Ok() {
		return res
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	osb, err := js.ObjectStore(ctx, bucket)
	if err != nil {
		return ClassifyKvError(err) // ErrBucketNotFound → not_found
	}
	// 断线监控：Get/Read 是长时操作，连接关闭必须立即中断（取消后 Read 返回
	// 错误），watchdog 检测到即取消传输 ctx。
	nc := s.mgr.Conn()
	dctx, dcancel := context.WithCancel(context.Background())
	defer dcancel()
	dropped := make(chan struct{})
	go watchConnClose(dctx, dcancel, nc, dropped)
	result, err := osb.Get(dctx, name)
	if err != nil {
		return classifyObjError(err) // ErrObjectNotFound → not_found
	}
	defer result.Close()
	info, err := result.Info()
	if err != nil {
		return classifyObjError(err)
	}
	// 磁盘预检（开始写盘前阻止，Global 2）：free == 0 = 未知 → 不阻止
	//（disk_other 桩返回 0；漏掉 free>0 前置会让非 Windows 全部下载被阻止）。
	if free, _ := diskFree(dir); free > 0 && free < info.Size {
		s.log.Warn("download blocked: insufficient disk space", "bucket", bucket, "object", name, "need", info.Size, "free", free)
		return fail(CodeValidation, ErrDiskSpace.Error())
	}
	var finished atomic.Bool
	tpl := ObjTransferEvent{
		TransferId: s.nextTransferId(),
		Bucket:     bucket,
		Name:       name,
		Direction:  "download",
		BytesTotal: info.Size,
	}
	target := filepath.Join(dir, name)
	_ = os.Remove(target) // 已存在 → 覆盖前先删（Windows rename 语义）
	f, err := os.Create(target)
	if err != nil {
		return fail(CodeValidation, err.Error()) // 本地目录问题（缺失/权限）
	}
	defer f.Close()
	cw := &countingWriter{w: f, th: newProgressThrottle(), fin: &finished, tpl: tpl, emit: s.emitObjTransfer}
	hash := sha256.New()
	s.emitObjTransfer(tpl) // 初始 running（bytes_done=0）
	_, copyErr := io.Copy(cw, io.TeeReader(result, hash))
	if copyErr != nil {
		finished.Store(true)
		msg := copyErr.Error()
		if errors.Is(copyErr, jetstream.ErrDigestMismatch) {
			msg = "digest mismatch"
		}
		e := tpl
		e.Phase = "incomplete"
		e.Error = msg
		s.emitObjTransfer(e)
		s.log.Warn("download incomplete", "bucket", bucket, "object", name, "err", copyErr)
		return fail(CodeServer, msg)
	}
	// 第二道摘要复核：EOF 时 nats.go 已内建校验（ErrDigestMismatch 走上面的
	// copy 错误路径），这里以结构化 digest_match 字段固化结论。
	digestMatch := "SHA-256="+base64.URLEncoding.EncodeToString(hash.Sum(nil)) == info.Digest
	if !digestMatch {
		finished.Store(true)
		e := tpl
		e.Phase = "incomplete"
		e.Error = "digest mismatch"
		s.emitObjTransfer(e)
		s.log.Warn("download digest mismatch", "bucket", bucket, "object", name)
		return fail(CodeServer, "digest mismatch") // 文件保留供人工比对
	}
	finished.Store(true)
	matched := true
	e := tpl
	e.Phase = "complete"
	e.BytesDone = info.Size
	e.DigestMatch = &matched
	s.emitObjTransfer(e)
	s.log.Info("download complete", "bucket", bucket, "object", name, "bytes", info.Size)
	return CallResult{}
}
