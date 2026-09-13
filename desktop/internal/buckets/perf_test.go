// Performance / throughput verification against the long-lived local server
// (M4 Task 10, spec §12 capacity lines; M3 Task 14 same shape). All fixtures
// gate on testutil.ConnectLocalServer — no local server means skip, no build
// tags. Fixture hygiene: uniqueSuffix names (the shared server hosts other
// tenants' buckets) and t.Cleanup bucket deletion (删桶即清数据，禁止逐条清理).
//
// Benchmark between-run state note (M3 Task 14 lesson): the shared local
// server's resident state (other tenants' streams/buckets) varies run-to-run
// by 2–3×, so benchmarks here use the -benchtime=5x discipline — short
// fixed-iteration runs, fixture built inside the benchmark, b.ResetTimer after
// setup — and cross-run comparisons only ever compare magnitudes.
package buckets

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/jsctx"
	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// connectLocalServerTB mirrors testutil.ConnectLocalServer for benchmarks:
// that helper is fixed to *testing.T, while *testing.B shares the
// Cleanup/Skipf surface through testing.TB. Same 2s probe + skip semantics
// (jsadmin/perf_test.go 同款).
func connectLocalServerTB(tb testing.TB) *nats.Conn {
	tb.Helper()
	nc, err := nats.Connect(testutil.LocalServerURL, nats.Timeout(2*time.Second), nats.MaxReconnects(0))
	if err != nil {
		tb.Skipf("local server %s not running: %v", testutil.LocalServerURL, err)
	}
	tb.Cleanup(func() { nc.Close() })
	return nc
}

// injectKvKeys dials a second connection and puts n keys (k0000..) via direct
// jetstream — the perf fixtures inject outside the measured window (对齐
// watch_test.go flood 注入手法).
func injectKvKeys(tb testing.TB, nc *nats.Conn, bucket string, n int) {
	tb.Helper()
	js2, err := jsctx.New(nc, "", "")
	if err != nil {
		tb.Fatal(err)
	}
	ctx := context.Background()
	kv2, err := js2.KeyValue(ctx, bucket)
	if err != nil {
		tb.Fatal(err)
	}
	for i := 0; i < n; i++ {
		if _, err := kv2.Put(ctx, fmt.Sprintf("k%04d", i), []byte("v")); err != nil {
			tb.Fatal(err)
		}
	}
}

// TestKvKeys1000BrowseLocalServer is the §12/§20.1 browse regression gate:
// 1,000-key bucket (History 1, the default browsing profile) → ListKeys
// (full metadata snapshot) + current-page 50-key GetKeyValues (value fill-in)
// must total ≤1.5s on low-spec hardware (binding gate, t.Fatalf above); the
// measured wall time is logged as the M4 test report's datum (高配 ≤500ms 预期
// 记录在报告，超标仅 NOTE 不失败——绑定门只有 1.5s 低配线).
func TestKvKeys1000BrowseLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newSvcConn(t, nc)
	bucket := "PERF_" + uniqueSuffix()
	t.Cleanup(func() { _ = svc.DeleteKvBucket(bucket) }) // 删桶即清 1000 键；禁止逐条清理
	if res := svc.CreateKvBucket(KvBucketForm{Name: bucket, History: 1, Replicas: 1}); !res.Ok() {
		t.Fatalf("create bucket: %+v", res)
	}
	injectKvKeys(t, testutil.ConnectLocalServer(t), bucket, 1000)

	// 测量窗口：ListKeys 全量快照 + 当前页（前 50 键）值补齐
	start := time.Now()
	kl := svc.ListKeys(bucket)
	if !kl.Ok() || len(kl.Keys) != 1000 {
		t.Fatalf("list keys: n=%d err=%v", len(kl.Keys), kl.Error)
	}
	page := make([]string, 50)
	for i, k := range kl.Keys[:50] {
		page[i] = k.Key
	}
	gv := svc.GetKeyValues(bucket, page)
	if !gv.Ok() || len(gv.Values) != 50 || gv.Values[0].NotFound {
		t.Fatalf("key values: n=%d err=%v", len(gv.Values), gv.Error)
	}
	elapsed := time.Since(start)
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("browse 1000 keys (list + 50-value page) took %v (budget 1.5s)", elapsed)
	}
	if elapsed > 500*time.Millisecond {
		t.Logf("NOTE: measured %v exceeds the 500ms high-spec expectation (recorded for the M4 test report)", elapsed)
	}
	t.Logf("browse 1000 keys: ListKeys(1000) + GetKeyValues(50) in %v", elapsed)
}

// BenchmarkKvListKeysLocalServer measures one full ListKeys snapshot over a
// 1,000-key bucket — the browse path's dominant cost (ordered consumer create +
// 1000 meta entries + sentinel + Stop). The fixture (bucket + 1000 puts) is
// built inside the benchmark and excluded via b.ResetTimer; the bucket is
// deleted by b.Cleanup (删桶即清 fixture).
//
// Run with the -benchtime=5x discipline (M3 Task 14):
//
//	go test ./internal/buckets/ -bench BenchmarkKvListKeysLocalServer -benchtime=5x -run XXX
func BenchmarkKvListKeysLocalServer(b *testing.B) {
	nc := connectLocalServerTB(b)
	svc := NewBucketService(&connStub{nc: nc}, nil, nil, "")
	bucket := "BENCH_" + uniqueSuffix()
	if res := svc.CreateKvBucket(KvBucketForm{Name: bucket, History: 1, Replicas: 1}); !res.Ok() {
		b.Fatalf("create bucket: %+v", res)
	}
	b.Cleanup(func() { _ = svc.DeleteKvBucket(bucket) })
	injectKvKeys(b, nc, bucket, 1000)

	b.ReportAllocs()
	b.ResetTimer() // setup (bucket create + 1000 puts) excluded from the measurement
	for i := 0; i < b.N; i++ {
		if kl := svc.ListKeys(bucket); !kl.Ok() || len(kl.Keys) != 1000 {
			b.Fatalf("list keys: n=%d err=%v", len(kl.Keys), kl.Error)
		}
	}
}

// fileSHA256 streams a file in chunks (the 100MB fixture is not loaded a
// second time in full for the byte-equality check).
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// transferRunningBytes returns the BytesDone of running-phase events for
// bucket+direction (transferLog 定义于 transfer_test.go，同包直用).
func transferRunningBytes(l *transferLog, bucket, direction string) []uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]uint64, 0, len(l.evs))
	for _, e := range l.evs {
		if e.Bucket == bucket && e.Direction == direction && e.Phase == "running" {
			out = append(out, e.BytesDone)
		}
	}
	return out
}

// TestTransfer100MBLocalServer is the §6.9 large-object round trip: a 100MB
// random temp file (t.TempDir, auto-removed) uploaded and downloaded through
// the blocking transfer path. Asserts per-direction terminal-event byte
// exactness (phase=complete 且 bytes_done == bytes_total == 100MB，running 事件
// 字节单调递增且不超总量——末事件字节精确性的完整版)、SHA256 digest_match=true、
// 下载文件字节相等（流式 SHA256 + 长度）；双向吞吐 MB/s 经 t.Logf 记录（M4 测试
// 报告数据源）。服务端 100MB 由删桶清理（删桶即清；禁止逐条清理）。
func TestTransfer100MBLocalServer(t *testing.T) {
	const size = 100 << 20
	src := filepath.Join(t.TempDir(), "big100.bin")
	payload := make([]byte, size)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	want := hex.EncodeToString(sum[:])

	nc := testutil.ConnectLocalServer(t) // 不可达 → skip（此时夹具仅剩 TempDir，由框架清理）
	var log transferLog
	svc := NewBucketService(&connStub{nc: nc}, nil, log.capture, "")
	bucket := "TRPERF_" + uniqueSuffix()
	t.Cleanup(func() { _ = svc.DeleteObjBucket(bucket) })
	if res := svc.CreateObjBucket(ObjBucketForm{Name: bucket, Replicas: 1}); !res.Ok() {
		t.Fatalf("create bucket: %+v", res)
	}

	upStart := time.Now()
	if res := svc.UploadObject(bucket, src, ""); !res.Ok() {
		t.Fatalf("upload: %+v", res)
	}
	upElapsed := time.Since(upStart)
	if last := log.last(); last.Direction != "upload" || last.Phase != "complete" ||
		last.BytesTotal != size || last.BytesDone != size {
		t.Fatalf("upload terminal event: %+v", last)
	}
	t.Logf("upload %dMB in %v (%.1f MB/s)", size>>20, upElapsed, float64(size)/(1<<20)/upElapsed.Seconds())

	dst := t.TempDir()
	dlStart := time.Now()
	if res := svc.DownloadObject(bucket, "big100.bin", dst); !res.Ok() {
		t.Fatalf("download: %+v", res)
	}
	dlElapsed := time.Since(dlStart)
	if last := log.last(); last.Direction != "download" || last.Phase != "complete" ||
		last.DigestMatch == nil || !*last.DigestMatch ||
		last.BytesTotal != size || last.BytesDone != size {
		t.Fatalf("download terminal event: %+v", last)
	}
	t.Logf("download %dMB in %v (%.1f MB/s)", size>>20, dlElapsed, float64(size)/(1<<20)/dlElapsed.Seconds())

	// 进度事件字节精确（running 链）：首条为初始 running（bytes_done=0，transfer.go
	// 对齐 backup.go 的 emit 顺序），其后字节严格单调递增且不超 bytes_total——
	// 末事件（terminal complete）已在上面对两方向断言 bytes_done == bytes_total。
	for _, dir := range []string{"upload", "download"} {
		prev := uint64(0)
		for i, n := range transferRunningBytes(&log, bucket, dir) {
			if i == 0 && n == 0 {
				continue // 初始 running（bytes_done=0）
			}
			if n <= prev || n > size {
				t.Fatalf("%s running bytes not strictly monotonic within total: %d after %d", dir, n, prev)
			}
			prev = n
		}
	}

	// 下载文件字节相等：流式 SHA256 + 长度（payload 已在内存，不再整载第二份）
	gotPath := filepath.Join(dst, "big100.bin")
	st, err := os.Stat(gotPath)
	if err != nil || st.Size() != size {
		t.Fatalf("downloaded size: %+v err=%v", st, err)
	}
	if got, err := fileSHA256(gotPath); err != nil {
		t.Fatal(err)
	} else if got != want {
		t.Fatalf("downloaded bytes differ: sha256 %s != %s", got, want)
	}
}
