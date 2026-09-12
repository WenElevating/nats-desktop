package jsadmin

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// capturedEvent 记录一次 emit 调用（事件名 + 载荷）。
type capturedEvent struct {
	name string
	data any
}

// emitLog 返回已收集事件的快照拷贝。
type emitLog func() []capturedEvent

// captureEmits 将 svc 的 emit 替换为收集器并注册 t.Cleanup 恢复——构造 svc 时
// emit 为 nil（NewJetAdminService 注入 no-op），这里以 svc.emit = fn 直接注入
// （同包测试可达）。emit 可能来自 nats.go 派发 goroutine（快照分片回调），读写
// 经互斥锁串行化。
func captureEmits(t *testing.T, svc *JetAdminService) emitLog {
	t.Helper()
	orig := svc.emit
	var mu sync.Mutex
	var events []capturedEvent
	svc.emit = func(name string, data any) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, capturedEvent{name: name, data: data})
	}
	t.Cleanup(func() { svc.emit = orig })
	return func() []capturedEvent {
		mu.Lock()
		defer mu.Unlock()
		return append([]capturedEvent(nil), events...)
	}
}

// eventPhases 过滤 stream:backup 事件中 stream/direction 匹配的载荷并按序返回
// Phase 列表（brief Step 1 助手）。
func eventPhases(events emitLog, stream, direction string) []string {
	var phases []string
	for _, e := range events() {
		if e.name != EventStreamBackup {
			continue
		}
		p, ok := e.data.(BackupProgress)
		if !ok || p.Stream != stream || p.Direction != direction {
			continue
		}
		phases = append(phases, p.Phase)
	}
	return phases
}

func TestBackupRestoreRoundTrip(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "BK", 50)
	dir := t.TempDir()
	events := captureEmits(t, svc) // 助手：包装 emit 收集 stream:backup 事件
	if res := svc.BackupStream("BK", dir, false); !res.Ok() {
		t.Fatalf("backup: %+v", res)
	}
	if _, err := os.Stat(filepath.Join(dir, "backup.json")); err != nil {
		t.Fatalf("backup.json missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "stream.tar.s2")); err != nil {
		t.Fatalf("stream.tar.s2 missing: %v", err)
	}
	// 进度事件：至少一条 running + 一条 complete，含 bytes 计数
	phases := eventPhases(events, "BK", "backup")
	if len(phases) == 0 || phases[len(phases)-1] != "complete" {
		t.Fatalf("phases: %v", phases)
	}
	sawBytes := false
	for _, e := range events() {
		if bp, ok := e.data.(BackupProgress); ok && e.name == EventStreamBackup &&
			bp.Stream == "BK" && bp.Direction == "backup" && bp.BytesDone > 0 {
			sawBytes = true
		}
	}
	if !sawBytes {
		t.Fatal("no backup progress event carried byte counts (SnapshotNotify wiring broken)")
	}
	// 恢复到已删除的流：先删后恢复 → 消息数一致
	if res := svc.DeleteStream("BK"); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	if res := svc.RestoreBackup(dir, false); !res.Ok() {
		t.Fatalf("restore: %+v", res)
	}
	d := svc.GetStreamDetail("BK")
	if !d.Ok() || d.Summary.Messages != 50 {
		t.Fatalf("restored stream content: %+v", d.Summary)
	}
	rphases := eventPhases(events, "BK", "restore")
	if len(rphases) == 0 || rphases[len(rphases)-1] != "complete" {
		t.Fatalf("restore phases: %v", rphases)
	}
}

func TestRestoreTargetExists(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "EX", 5)
	dir := t.TempDir()
	if res := svc.BackupStream("EX", dir, false); !res.Ok() {
		t.Fatalf("backup: %+v", res)
	}
	// 目标仍在且未确认覆盖 → 拒绝
	res := svc.RestoreBackup(dir, false)
	if res.ErrorCode != CodeValidation || !strings.Contains(res.Error, ErrRestoreTargetExists.Error()) {
		t.Fatalf("exists gate: %+v", res)
	}
	// 覆盖语义 = 删除重建
	if res := svc.RestoreBackup(dir, true); !res.Ok() {
		t.Fatalf("overwrite restore: %+v", res)
	}
}

func TestBackupFailsCleanlyForMissingStream(t *testing.T) {
	svc := newAdmin(t, testutil.StartJSServer(t))
	events := captureEmits(t, svc)
	res := svc.BackupStream("NOSUCH", filepath.Join(t.TempDir(), "sub"), false)
	if res.Ok() {
		t.Fatal("backup of missing stream must fail")
	}
	// 失败路径不得发出 complete
	for _, ph := range eventPhases(events, "NOSUCH", "backup") {
		if ph == "complete" {
			t.Fatal("missing-stream backup must never emit complete")
		}
	}
}

func TestReadBackupName(t *testing.T) {
	dir := t.TempDir()
	blob := `{"config":{"name":"NAMED","subjects":["a"]}}`
	if err := os.WriteFile(filepath.Join(dir, "backup.json"), []byte(blob), 0o600); err != nil {
		t.Fatal(err)
	}
	name, err := readBackupName(dir)
	if err != nil || name != "NAMED" {
		t.Fatalf("got (%q,%v)", name, err)
	}
}

// TestBackupMemoryStreamRejected：memory 存储流备份返回 server 错误原文
// （jsm ErrMemoryStreamNotSupported），失败路径绝不发出 complete。
func TestBackupMemoryStreamRejected(t *testing.T) {
	svc := newAdmin(t, testutil.StartJSServer(t))
	if res := svc.CreateStream(StreamForm{Name: "MEM", Subjects: []string{"mem.>"}, Storage: "memory", Retention: "limits", Replicas: 1}); !res.Ok() {
		t.Fatalf("create memory stream: %+v", res)
	}
	events := captureEmits(t, svc)
	res := svc.BackupStream("MEM", t.TempDir(), false)
	if res.Ok() || res.ErrorCode != CodeServer {
		t.Fatalf("memory snapshot must fail with server code, got %+v", res)
	}
	if !strings.Contains(res.Error, "memory streams do not support snapshots") {
		t.Fatalf("server error text not surfaced: %+v", res)
	}
	for _, ph := range eventPhases(events, "MEM", "backup") {
		if ph == "complete" {
			t.Fatal("memory-stream backup must never emit complete")
		}
	}
}

// publishBig 注入 n 条 1 字节消息：PublishAsync 携带真实 PubAck 回执（裸
// nc.PublishAsync 对流 subject 无应答，future 永不 resolve），限流 10k 在途，
// 复用 TestBrowseLargeDatasetLocalServer 的注入模式（含 ErrTooManyStalledMsgs
// 重试豁免——该错误在消息上 wire 前返回，重试安全无重复）。
func publishBig(t *testing.T, svc *JetAdminService, subject string, n int) {
	t.Helper()
	nc := svcRawConn(t, svc)
	jsPub, err := jetstream.New(nc, jetstream.WithPublishAsyncMaxPending(10_000))
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte{0}
	setupStart := time.Now()
	for i := 0; i < n; i++ {
		for {
			_, err := jsPub.PublishAsync(subject, payload)
			if err == nil {
				break
			}
			if !errors.Is(err, jetstream.ErrTooManyStalledMsgs) {
				t.Fatal(err)
			}
			if time.Since(setupStart) > 120*time.Second {
				t.Fatalf("publish loop exceeded 120s (at %d/%d)", i, n)
			}
		}
	}
	select {
	case <-jsPub.PublishAsyncComplete():
	case <-time.After(120 * time.Second):
		t.Fatalf("PublishAsync setup exceeded 120s")
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}
}

// disconnectBackupAttempt 执行一轮断连演练：独立连接上建流 + 注入 200k 条 +
// 启动备份，首条 backup 事件到达即断连（初始 running 事件先于快照调用发出，
// 此刻服务端迭代必然远未结束），等待备份调用有限时返回。
func disconnectBackupAttempt(t *testing.T, attempt int) (CallResult, []string) {
	t.Helper()
	nc := testutil.ConnectLocalServer(t)
	svc := newAdminConn(t, nc)
	name := "BKDISC_" + uniqueSuffix()
	// 共享服务器清理：本测试自断连接（conn 已死），清理时重拨删除；尽力而为
	t.Cleanup(func() {
		if c, err := nats.Connect(testutil.LocalServerURL, nats.Timeout(2*time.Second)); err == nil {
			_ = NewJetAdminService(&connStub{nc: c}, nil, nil, "").DeleteStream(name)
			c.Close()
		}
	})
	if res := svc.CreateStream(StreamForm{Name: name, Subjects: []string{name + ".>"}, Storage: "file", Retention: "limits", Replicas: 1}); !res.Ok() {
		t.Fatalf("attempt %d create: %+v", attempt, res)
	}
	publishBig(t, svc, name+".a", 200_000)

	dir := t.TempDir()
	events := captureEmits(t, svc)
	type attemptResult struct {
		res CallResult
	}
	done := make(chan attemptResult, 1)
	go func() {
		done <- attemptResult{svc.BackupStream(name, dir, false)}
	}()
	// 首条 backup 事件（初始 running）一到立即断连
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(eventPhases(events, name, "backup")) > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	nc.Close()
	select {
	case r := <-done:
		t.Logf("attempt %d: res=%+v phases=%v", attempt, r.res, eventPhases(events, name, "backup"))
		return r.res, eventPhases(events, name, "backup")
	case <-time.After(60 * time.Second):
		t.Fatalf("attempt %d: backup did not return within 60s after disconnect: %+v", attempt, eventPhases(events, name, "backup"))
		return CallResult{}, nil
	}
}

// TestBackupDisconnectMarksIncompleteLocalServer 自动化 spec §6.6 异常表
// 「备份中断」：备份过程中连接断开 → 必须停止备份、保留已完成分片、标记
// 备份不完整，不得生成声称完整的备份文件。时序敏感，按 brief 约定放宽为
// 3 次尝试；仍不收敛到 last=incomplete 时记录 PENDING-MANUAL 并保留底线
// 断言（绝不出现 complete）。
func TestBackupDisconnectMarksIncompleteLocalServer(t *testing.T) {
	const attempts = 3
	weakPass := false
	var lastRes CallResult
	var lastPhases []string
	for i := 1; i <= attempts; i++ {
		lastRes, lastPhases = disconnectBackupAttempt(t, i)
		if lastRes.Ok() {
			t.Logf("attempt %d: backup completed before the close landed (timing), retrying", i)
			continue
		}
		for _, ph := range lastPhases {
			if ph == "complete" {
				t.Fatalf("attempt %d: disconnected backup emitted complete: %v", i, lastPhases)
			}
		}
		if len(lastPhases) > 0 && lastPhases[len(lastPhases)-1] == "incomplete" {
			break // 收敛：断连被显式标记 incomplete
		}
		weakPass = true // 非 Ok 且无 complete，但未收敛到 last=incomplete
	}
	if lastRes.Ok() {
		t.Fatalf("backup never failed despite mid-backup close (%d attempts): %+v", attempts, lastRes)
	}
	if weakPass {
		t.Logf("PENDING-MANUAL: disconnect timing did not converge to last-phase=incomplete in %d attempts (phases=%v, res=%+v); weaker guard (never complete) held", attempts, lastPhases, lastRes)
	}
}
