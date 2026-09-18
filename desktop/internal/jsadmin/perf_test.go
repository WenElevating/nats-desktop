// Performance tests against the long-lived local server (spec §12 capacity
// lines, M3 Task 14). All fixtures gate on testutil.ConnectLocalServer — no
// local server means skip, no build tags. Fixtures follow the big-fixture
// hygiene rules: uniqueSuffix names (the server hosts other tenants' streams)
// and t.Cleanup/b.Cleanup stream deletion (删流即清数据，禁止逐条清理).
//
// Deliver-path benchmarking note: BenchmarkHeaderFilterPipeline (session
// deliver path + header filter, 100k msgs/op, pure logic) lives in
// internal/messaging/pipeline_bench_test.go — session.handle/deliver and the
// ring/pusher machinery are unexported there, and the pure-FunctionsMatch
// timing test TestHeaderMatchPerformance covers the filter alone. It is
// referenced, not duplicated, from this package.

package jsadmin

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// adminOver builds a service over an existing connection (Task 3 brief name;
// the tests here connect via testutil.ConnectLocalServer, which already owns
// dial + t.Cleanup, so only the stub layer is added).
func adminOver(t *testing.T, nc *nats.Conn) *JetAdminService {
	t.Helper()
	return newAdminConn(t, nc)
}

// cleanupStreams registers a t.Cleanup that lists the server's streams and
// deletes every name carrying the fixture suffix (fixture self-healing: a
// failed run leaves no PERF*/CON* debris behind on the shared server).
func cleanupStreams(t *testing.T, svc *JetAdminService, suffix string) {
	t.Cleanup(func() {
		list := svc.ListStreams(suffix) // suffix 过滤：共享服务器上只列出本 fixture 的残留
		if !list.Ok() {
			return
		}
		for _, s := range list.Streams {
			if strings.Contains(s.Name, suffix) {
				_ = svc.DeleteStream(s.Name) // 尽力清理；失败不影响断言
			}
		}
	})
}

// connectLocalServerTB mirrors testutil.ConnectLocalServer for benchmarks:
// that helper is fixed to *testing.T, while *testing.B shares the
// Cleanup/Skipf surface through testing.TB. Same 2s probe + skip semantics.
func connectLocalServerTB(tb testing.TB) *nats.Conn {
	tb.Helper()
	nc, err := nats.Connect(testutil.LocalServerURL, nats.Timeout(2*time.Second), nats.MaxReconnects(0))
	if err != nil {
		tb.Skipf("local server %s not running: %v", testutil.LocalServerURL, err)
	}
	tb.Cleanup(func() { nc.Close() })
	return nc
}

// publishAsyncN injects n 8-byte messages through jetstream PublishAsync and
// waits for every PubAck. Returns the publish-loop wall time (the flood-rate
// datum for the M3 test report). The retry loop exists for the same reason as
// TestBrowseLargeDatasetLocalServer: on the long-lived local server the ack
// stall window of nats.go can trip ErrTooManyStalledMsgs for a burst — that
// error returns before the message hits the wire (no duplicate on retry), so
// only it is exempted; every other error is fatal.
func publishAsyncN(tb testing.TB, nc *nats.Conn, subject string, n int) time.Duration {
	tb.Helper()
	jsPub, err := jetstream.New(nc, jetstream.WithPublishAsyncMaxPending(10_000))
	if err != nil {
		tb.Fatal(err)
	}
	payload := make([]byte, 8)
	start := time.Now()
	for i := 0; i < n; i++ {
		for {
			_, err := jsPub.PublishAsync(subject, payload)
			if err == nil {
				break
			}
			if !errors.Is(err, jetstream.ErrTooManyStalledMsgs) {
				tb.Fatal(err)
			}
			if time.Since(start) > 120*time.Second {
				tb.Fatalf("publish loop exceeded 120s (at %d/%d)", i, n)
			}
		}
	}
	select {
	case <-jsPub.PublishAsyncComplete():
	case <-time.After(120 * time.Second):
		tb.Fatalf("PublishAsync setup exceeded 120s (elapsed %s)", time.Since(start))
	}
	if err := nc.Flush(); err != nil {
		tb.Fatal(err)
	}
	return time.Since(start)
}

// TestStreamList500LocalServer is the §12 low-spec regression gate: listing a
// ≥500-stream server must complete within 1.5s. The one-shot fixture (500
// memory streams, ~20-40s) is accepted per brief; the measured wall time is
// logged as the M3 test report's §性能 datum (高配实测记录在报告).
func TestStreamList500LocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	suffix := uniqueSuffix()
	svc := adminOver(t, nc)
	cleanupStreams(t, svc, suffix)

	for i := 0; i < 500; i++ {
		if res := svc.CreateStream(StreamForm{
			Name:      fmt.Sprintf("PERF%s_%04d", suffix, i),
			Subjects:  []string{fmt.Sprintf("perf%s.%04d.>", suffix, i)},
			Storage:   "memory",
			Retention: "limits",
			Replicas:  1,
		}); !res.Ok() {
			t.Fatalf("setup %d: %+v", i, res)
		}
	}

	start := time.Now()
	list := svc.ListStreams("")
	elapsed := time.Since(start)
	if !list.Ok() || len(list.Streams) < 500 {
		t.Fatalf("list: n=%d err=%v", len(list.Streams), list.Error)
	}
	// 低配回归门（§12 低配 1.5s；高配实测值写入 M3 测试报告）
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("list of %d streams took %v (budget 1.5s)", len(list.Streams), elapsed)
	}
	t.Logf("list 500 streams: %v (%d total on server)", elapsed, len(list.Streams))
}

// BenchmarkStreamListLocalServer measures one ListStreams round trip (STREAM.LIST
// + per-stream INFO fast-state) against the shared local server as found:
//
//	go test ./internal/jsadmin/ -bench BenchmarkStreamListLocalServer -benchtime=5x -run XXX
func BenchmarkStreamListLocalServer(b *testing.B) {
	nc := connectLocalServerTB(b)
	svc := NewJetAdminService(&connStub{nc: nc}, nil, nil, "")
	if list := svc.ListStreams(""); !list.Ok() {
		b.Fatalf("warmup list: %+v", list)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if list := svc.ListStreams(""); !list.Ok() {
			b.Fatalf("list: %+v", list)
		}
	}
}

// BenchmarkBrowseTailPageLocalServer seeds a 100k-message memory stream
// (PublishAsync, 删流即清 fixture) and times the tail-page browse
// StartSeq=99_951/Count=50 — the worst meaningful page: a throwaway filtered
// consumer is created AND deleted per operation, so ns/op covers the full
// browser round trip. The one-shot ≤1s assertion variant over a 1,000,000-msg
// fixture already exists as TestBrowseLargeDatasetLocalServer (browser_test.go,
// M3 Task 4 / AC-028) — referenced, not duplicated.
//
//	go test ./internal/jsadmin/ -bench BenchmarkBrowseTailPageLocalServer -benchtime=5x -run XXX
func BenchmarkBrowseTailPageLocalServer(b *testing.B) {
	nc := connectLocalServerTB(b)
	svc := NewJetAdminService(&connStub{nc: nc}, nil, nil, "")
	name := "BENCH_" + uniqueSuffix()
	if res := svc.CreateStream(StreamForm{
		Name:      name,
		Subjects:  []string{name + ".*"},
		Storage:   "memory",
		Retention: "limits",
		Replicas:  1,
	}); !res.Ok() {
		b.Fatalf("create: %+v", res)
	}
	b.Cleanup(func() { _ = svc.DeleteStream(name) })

	const total = 100_000
	elapsed := publishAsyncN(b, nc, name+".a", total)
	d := svc.GetStreamDetail(name)
	if !d.Ok() || d.Summary.Messages != total {
		b.Fatalf("stream must hold %d messages: %+v", total, d.Summary)
	}
	b.Logf("setup: %d msgs injected in %s (%.0f msg/s)", total, elapsed, float64(total)/elapsed.Seconds())

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p := svc.BrowseStream(BrowserPageRequest{Stream: name, StartSeq: 99_951, Count: 50})
		if !p.Ok() || len(p.Messages) != 50 || p.Messages[0].Seq != 99_951 {
			b.Fatalf("tail page: %+v", p)
		}
	}
}
