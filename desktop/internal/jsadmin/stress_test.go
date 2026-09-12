// Concurrency / stress verification against the long-lived local server
// (M3 Task 14). Gated on testutil.ConnectLocalServer like the perf suite;
// uniqueSuffix + t.Cleanup stream deletion keep the shared server clean.
//
// Concurrency-safety argument (why one *JetAdminService may be shared by 12
// goroutines below):
//   - handles()/handlesWithJet() (streams.go) build a FRESH jsm.Manager and
//     jetstream.JetStream handle on every call — no handle is stored on the
//     service or reused across requests;
//   - JetAdminService itself carries no mutable state except backupMu (an
//     atomic, used only by backup/restore to serialize that one feature —
//     untouched by the stream ops exercised here); log/emit/mgr/settingsPath
//     are immutable after NewJetAdminService;
//   - the per-call traffic is request-reply over the shared *nats.Conn, which
//     nats.go documents as goroutine-safe.
//
// TestConcurrentStreamOpsLocalServer is the executable proof of the above; the
// CI go job re-runs the whole suite under -race wherever the server is present.
package jsadmin

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// TestConcurrentStreamOpsLocalServer: 10 goroutines each drive their own
// uniquely-named stream through create→update→delete while 2 goroutines hammer
// ListStreams 20× concurrently — every op must succeed (collection via errCh;
// the listers tolerate CodeServer only, per the brief, so transient overload
// is visible but unrelated-stream churn on the shared server is not fatal).
func TestConcurrentStreamOpsLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := adminOver(t, nc)
	suffix := uniqueSuffix()
	cleanupStreams(t, svc, suffix)

	var wg sync.WaitGroup
	errCh := make(chan error, 60)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			name := fmt.Sprintf("CON%s_%02d", suffix, i)
			if res := svc.CreateStream(StreamForm{
				Name: name, Subjects: []string{name + ".>"},
				Storage: "memory", Retention: "limits", Replicas: 1,
			}); !res.Ok() {
				errCh <- fmt.Errorf("create %s: %s", name, res.Error)
				return
			}
			if res := svc.UpdateStream(StreamForm{
				Name: name, Subjects: []string{name + ".>"},
				Storage: "memory", Retention: "limits", Replicas: 1, Description: "c",
			}); !res.Ok() {
				errCh <- fmt.Errorf("update %s: %s", name, res.Error)
				return
			}
			if res := svc.DeleteStream(name); !res.Ok() {
				errCh <- fmt.Errorf("delete %s: %s", name, res.Error)
			}
		}(i)
	}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				if list := svc.ListStreams(); !list.Ok() && list.ErrorCode != CodeServer {
					errCh <- fmt.Errorf("list: %s", list.Error)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
}

// TestBrowseSubjectFilterFloodLocalServer: 100,000 messages injected across two
// subjects (50k A then 50k B via PublishAsync), then a SubjectFilter=b browse
// must page through B's rows with exact per-page counts, zero A leakage, and
// contiguous stream sequences — the server-side filtered consumer is correct
// at flood scale, not just on the 30-message unit fixture.
func TestBrowseSubjectFilterFloodLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := newAdminConn(t, nc)
	name := "FLOOD_" + uniqueSuffix()
	subjA := name + ".a"
	subjB := name + ".b"
	if res := svc.CreateStream(StreamForm{
		Name: name, Subjects: []string{name + ".*"},
		Storage: "memory", Retention: "limits", Replicas: 1,
	}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	t.Cleanup(func() { _ = svc.DeleteStream(name) }) // 删流即清 10 万条；禁止逐条清理

	const perSubject = 50_000
	start := time.Now()
	eA := publishAsyncN(t, nc, subjA, perSubject)
	eB := publishAsyncN(t, nc, subjB, perSubject)
	injected := time.Since(start)
	t.Logf("injected 2x%d msgs in %s (%.0f msg/s): A=%s B=%s",
		perSubject, injected,
		float64(2*perSubject)/injected.Seconds(), eA, eB)

	// 服务器同步计数必须守恒：两批各 50k
	d := svc.GetStreamDetail(name)
	if !d.Ok() || d.Summary.Messages != 2*perSubject {
		t.Fatalf("stream must hold %d messages: %+v", 2*perSubject, d.Summary)
	}

	// 过滤浏览 5 页：每页 50 行、全部 subjB、seq 连续（B 在 A 之后注入 →
	// B 的流内 seq 恰为 50_001..100_000 连续段）
	const wantPages = 5
	const pageSize = 50
	req := BrowserPageRequest{Stream: name, StartSeq: 1, Count: pageSize, SubjectFilter: subjB}
	var seqs []uint64
	browseStart := time.Now()
	for p := 0; p < wantPages; p++ {
		page := svc.BrowseStream(req)
		if !page.Ok() || len(page.Messages) != pageSize || !page.HasMore {
			t.Fatalf("filtered page %d: %+v", p, page)
		}
		for _, m := range page.Messages {
			if m.Subject != subjB {
				t.Fatalf("page %d: foreign subject leaked: %s", p, m.Subject)
			}
			seqs = append(seqs, m.Seq)
		}
		req.StartSeq = page.NextStartSeq
	}
	browseElapsed := time.Since(browseStart)
	for i := 1; i < len(seqs); i++ {
		if seqs[i] != seqs[i-1]+1 {
			t.Fatalf("filtered seqs not contiguous at %d: %v..%v", i, seqs[i-1], seqs[i])
		}
	}
	if seqs[0] != perSubject+1 || seqs[len(seqs)-1] != perSubject+uint64(len(seqs)) {
		t.Fatalf("filtered page must cover B's head: first=%d last=%d", seqs[0], seqs[len(seqs)-1])
	}
	t.Logf("5 filtered pages (250 rows) over 100k msgs: %v (%.2f ms/page)",
		browseElapsed, float64(browseElapsed.Microseconds())/float64(wantPages*1000))
}
