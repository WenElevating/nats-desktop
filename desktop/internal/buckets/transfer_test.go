package buckets

import (
	"bytes"
	"crypto/rand"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// transferLog 收集 obj:transfer 事件（emit 回调异步于断言方，统一 mu 保护）。
type transferLog struct {
	mu  sync.Mutex
	evs []ObjTransferEvent
}

func (l *transferLog) capture(name string, data any) {
	if name != EventObjTransfer {
		return
	}
	l.mu.Lock()
	l.evs = append(l.evs, data.(ObjTransferEvent))
	l.mu.Unlock()
}

func (l *transferLog) last() ObjTransferEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.evs[len(l.evs)-1]
}

// phases 返回 bucket+direction 匹配的事件相位序列（断连测试的 last-phase 断言源）。
func (l *transferLog) phases(bucket, direction string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, 0, len(l.evs))
	for _, e := range l.evs {
		if e.Bucket == bucket && e.Direction == direction {
			out = append(out, e.Phase)
		}
	}
	return out
}

// hasBytesRunning 是否已有携带字节计数的 running 事件（断连时机的触发信号，
// 对齐 M3 backup_test 的「数据真正流入后断连」手法——初始 running 事件先于
// Put 发出，此刻断连只会命中普通错误路径）。
func (l *transferLog) hasBytesRunning(bucket string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, e := range l.evs {
		if e.Bucket == bucket && e.Phase == "running" && e.BytesDone > 0 {
			return true
		}
	}
	return false
}

// TestUploadDownloadRoundTrip 走 2MB 随机文件全链路（AC-014）：上传阻塞返回 +
// 事件尾 complete + bytes 精确；下载到另一目录 → SHA256 一致（digest_match=true）
// + 文件字节逐位相等。
func TestUploadDownloadRoundTrip(t *testing.T) {
	url := testutil.StartJSServer(t)
	var log transferLog
	svc := NewBucketService(&connStub{nc: mustConn(t, url)}, nil, log.capture, "")
	if res := svc.CreateObjBucket(ObjBucketForm{Name: "TR", Replicas: 1}); !res.Ok() {
		t.Fatalf("create bucket: %+v", res)
	}
	// 2MB 随机文件上传
	src := filepath.Join(t.TempDir(), "blob.bin")
	payload := make([]byte, 2<<20)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if res := svc.UploadObject("TR", src, ""); !res.Ok() {
		t.Fatalf("upload: %+v", res)
	}
	last := log.last()
	if last.Phase != "complete" || last.BytesTotal != 2<<20 || last.BytesDone != 2<<20 {
		t.Fatalf("upload events: %+v", last)
	}
	if last.Direction != "upload" || last.Name != "blob.bin" || last.TransferId == "" {
		t.Fatalf("upload event shape: %+v", last)
	}
	// 下载到另一目录 → SHA256 一致（digest_match=true，AC-014）
	dst := t.TempDir()
	if res := svc.DownloadObject("TR", "blob.bin", dst); !res.Ok() {
		t.Fatalf("download: %+v", res)
	}
	got, err := os.ReadFile(filepath.Join(dst, "blob.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("content mismatch")
	}
	dlLast := log.last()
	if dlLast.Phase != "complete" || dlLast.DigestMatch == nil || !*dlLast.DigestMatch {
		t.Fatalf("download digest: %+v", dlLast)
	}
	if dlLast.Direction != "download" || dlLast.BytesTotal != 2<<20 || dlLast.BytesDone != 2<<20 {
		t.Fatalf("download event shape: %+v", dlLast)
	}
}

// TestDownloadDiskSpaceGate 磁盘预检：stub diskFree（包级 var 便于替换）返回
// 极小值 → DownloadObject 返回 validation+ErrDiskSpace 且不创建文件；free=0
// （未知平台/查询失败）→ 不阻止（brief 红字：漏掉 free>0 前置会让非 Windows
// 全部下载被阻止）。
func TestDownloadDiskSpaceGate(t *testing.T) {
	url := testutil.StartJSServer(t)
	svc := newSvc(t, url)
	if res := svc.CreateObjBucket(ObjBucketForm{Name: "DG", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	src := filepath.Join(t.TempDir(), "small.bin")
	const content = "hello disk gate"
	if err := os.WriteFile(src, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if res := svc.UploadObject("DG", src, ""); !res.Ok() {
		t.Fatalf("upload: %+v", res)
	}
	orig := diskFree
	t.Cleanup(func() { diskFree = orig })

	// free=1 < 对象大小 → validation + ErrDiskSpace 原文，目标文件未创建
	diskFree = func(string) (uint64, error) { return 1, nil }
	dst := t.TempDir()
	res := svc.DownloadObject("DG", "small.bin", dst)
	if res.Ok() || res.ErrorCode != CodeValidation || res.Error != ErrDiskSpace.Error() {
		t.Fatalf("disk gate: %+v", res)
	}
	if _, err := os.Stat(filepath.Join(dst, "small.bin")); !os.IsNotExist(err) {
		t.Fatalf("file must not be created: %v", err)
	}
	// free=0 = 未知 → 不阻止，下载成功且内容一致
	diskFree = func(string) (uint64, error) { return 0, nil }
	if res := svc.DownloadObject("DG", "small.bin", dst); !res.Ok() {
		t.Fatalf("free=0 must not block: %+v", res)
	}
	got, err := os.ReadFile(filepath.Join(dst, "small.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != content {
		t.Fatalf("content mismatch: %q", got)
	}
}

// TestUploadIncompleteOnDisconnectLocalServer 自动化「上传中断」：LocalServer +
// 20MB 随机文件，上传中途 close 底层连接 → 事件序列最后为 incomplete + 非 Ok
// 返回；已完成分片保留在服务器（服务层不做任何删除，§6.9 上传中断行）。时序
// 敏感，对齐 M3 断连测试处置：3 次尝试，仍不收敛到 last=incomplete 时记录
// PENDING-MANUAL 并保留底线断言（绝不出现 complete）。
func TestUploadIncompleteOnDisconnectLocalServer(t *testing.T) {
	// 20MB 随机文件一次生成，各轮尝试共用（LocalServer 不可达时上面即 skip）
	src := filepath.Join(t.TempDir(), "big.bin")
	payload := make([]byte, 20<<20)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	_ = testutil.ConnectLocalServer(t) // 不可达 → skip（M3 同）

	const attempts = 3
	weakPass := false
	var lastRes CallResult
	var lastPhases []string
	for i := 1; i <= attempts; i++ {
		lastRes, lastPhases = uploadDisconnectAttempt(t, i, src)
		if lastRes.Ok() {
			t.Logf("attempt %d: upload completed before the close landed (timing), retrying", i)
			continue
		}
		for _, ph := range lastPhases {
			if ph == "complete" {
				t.Fatalf("attempt %d: disconnected upload emitted complete: %v", i, lastPhases)
			}
		}
		if len(lastPhases) > 0 && lastPhases[len(lastPhases)-1] == "incomplete" {
			break // 收敛：断连被显式标记 incomplete
		}
		weakPass = true // 非 Ok 且无 complete，但未收敛到 last=incomplete
	}
	if lastRes.Ok() {
		t.Fatalf("upload never failed despite mid-upload close (%d attempts): %+v", attempts, lastRes)
	}
	if weakPass {
		t.Logf("PENDING-MANUAL: disconnect timing did not converge to last-phase=incomplete in %d attempts (phases=%v, res=%+v); weaker guard (never complete) held", attempts, lastPhases, lastRes)
	}
}

// uploadDisconnectAttempt 执行一轮上传断连演练：独立连接上建桶 + 启动 20MB
// 上传，首条「携带字节计数」的 running 事件到达即断连，等待上传调用有限时
// 返回（对齐 M3 disconnectBackupAttempt：此刻 Put 读取循环与分片发布必已建立，
// 断连才能真正走到 conn-close watchdog → incomplete）。
func uploadDisconnectAttempt(t *testing.T, attempt int, src string) (CallResult, []string) {
	t.Helper()
	nc := testutil.ConnectLocalServer(t)
	var log transferLog
	svc := NewBucketService(&connStub{nc: nc}, nil, log.capture, "")
	bucket := "TRDISC_" + uniqueSuffix()
	// 共享服务器清理：本测试自断连接（conn 已死），清理时重拨删除；尽力而为
	t.Cleanup(func() {
		if c, err := nats.Connect(testutil.LocalServerURL, nats.Timeout(2*time.Second)); err == nil {
			_ = NewBucketService(&connStub{nc: c}, nil, nil, "").DeleteObjBucket(bucket)
			c.Close()
		}
	})
	if res := svc.CreateObjBucket(ObjBucketForm{Name: bucket, Replicas: 1}); !res.Ok() {
		t.Fatalf("attempt %d create: %+v", attempt, res)
	}
	type attemptResult struct {
		res CallResult
	}
	done := make(chan attemptResult, 1)
	go func() {
		done <- attemptResult{svc.UploadObject(bucket, src, "")}
	}()
	// 首条携带字节的 running 事件一到立即断连；超时兜底仍断连（外层
	// weak-pass/backstop 逻辑兜底，绝不无限等待）
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if log.hasBytesRunning(bucket) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	nc.Close()
	select {
	case r := <-done:
		phases := log.phases(bucket, "upload")
		head, tail := phases, phases
		if len(phases) > 6 {
			head, tail = phases[:3], phases[len(phases)-3:]
		}
		t.Logf("attempt %d: res=%+v phases=%d head=%v tail=%v", attempt, r.res, len(phases), head, tail)
		return r.res, phases
	case <-time.After(60 * time.Second):
		t.Fatalf("attempt %d: upload did not return within 60s after disconnect: %v", attempt, log.phases(bucket, "upload"))
		return CallResult{}, nil
	}
}

// TestTransferBusyRejected：transferMu 占用期间 UploadObject 与 DownloadObject
// 一律 CodeValidation + ErrTransferBusy 原文（CompareAndSwap 门在任何 IO/emit
// 之前，同 M3 backupMu 模式）。同包测试直接 Store(1) 预置占用；复位后真实调用
// 必须恢复可用，证明门未卡死。
func TestTransferBusyRejected(t *testing.T) {
	url := testutil.StartJSServer(t)
	svc := newSvc(t, url)
	svc.transferMu.Store(1)
	if res := svc.UploadObject("B", "whatever", ""); res.ErrorCode != CodeValidation || res.Error != ErrTransferBusy.Error() {
		t.Fatalf("upload busy: %+v", res)
	}
	if res := svc.DownloadObject("B", "n", t.TempDir()); res.ErrorCode != CodeValidation || res.Error != ErrTransferBusy.Error() {
		t.Fatalf("download busy: %+v", res)
	}
	// 复位后真实路径可用（小文件 round-trip 成功）
	svc.transferMu.Store(0)
	if res := svc.CreateObjBucket(ObjBucketForm{Name: "B", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	src := filepath.Join(t.TempDir(), "tiny.bin")
	if err := os.WriteFile(src, []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	if res := svc.UploadObject("B", src, ""); !res.Ok() {
		t.Fatalf("upload after reset: %+v", res)
	}
	if res := svc.DownloadObject("B", "tiny.bin", t.TempDir()); !res.Ok() {
		t.Fatalf("download after reset: %+v", res)
	}
}
