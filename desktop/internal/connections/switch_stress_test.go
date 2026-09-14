package connections

import (
	"context"
	"runtime"
	"testing"
	"time"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

// TestSwitchStress100Cycles covers §20.3-3 (M6 Task 5, AC-023 Go-side leg):
// 100 frequent Connect(A)/Connect(B) switches must not leak goroutines and
// must leave the Manager in a clean connected state.
//
// Method: a single in-process StartSysServer fixture, two contexts saved in
// a temp-dir registry (per-test isolation, no real user settings touched),
// then 100 full cycles of Connect("switch-a") -> wait connected ->
// Connect("switch-b") -> wait connected. Connect() replaces the previous
// connection (user-close path), so each cycle exercises the full
// teardown+dial state machine twice.
//
// Goroutine-delta baseline: taken AFTER an initial single connection is up
// (not before any connection), so the <10 assertion measures per-cycle leak
// rather than the steady-state footprint of the one connection that is
// intentionally left connected at the end (client read/flush goroutines +
// the server-side conn handler goroutines all count into runtime.NumGoroutine).
//
// No explicit panic assertion: any panic in the Manager or the nats.go
// callbacks fails the test run. Overall cap 10 minutes (§20.3-3); each
// per-connect wait is bounded so the loop cannot outlive that cap.
func TestSwitchStress100Cycles(t *testing.T) {
	const cycles = 100
	start := time.Now()

	ss := testutil.StartSysServer(t)
	m, rec, store := newRecordingManager(t)
	t.Cleanup(m.Disconnect)

	saveContext(t, store, "switch-a", ss.URL, withUser(ss.AppUser, ss.AppPass))
	saveContext(t, store, "switch-b", ss.URL, withUser(ss.AppUser, ss.AppPass))

	// Baseline with one live connection (see doc comment above).
	if err := m.Connect(context.Background(), "switch-a"); err != nil {
		t.Fatal(err)
	}
	waitConnected(t, m, 10*time.Second)
	baseGoroutines := runtime.NumGoroutine()

	for i := 0; i < cycles; i++ {
		if time.Since(start) > 9*time.Minute {
			t.Fatalf("switch loop overran its 9min budget at cycle %d (cap 10min)", i)
		}
		if err := m.Connect(context.Background(), "switch-a"); err != nil {
			t.Fatalf("cycle %d: Connect(switch-a): %v", i, err)
		}
		waitConnected(t, m, 10*time.Second)
		if err := m.Connect(context.Background(), "switch-b"); err != nil {
			t.Fatalf("cycle %d: Connect(switch-b): %v", i, err)
		}
		waitConnected(t, m, 10*time.Second)
	}

	// Let the goroutines of the 100 closed connections (client + server
	// side) wind down before the delta measurement.
	time.Sleep(2 * time.Second)
	if delta := runtime.NumGoroutine() - baseGoroutines; delta >= 10 {
		t.Fatalf("goroutine leak: delta %d >= 10 after %d switch cycles (base %d, now %d)",
			delta, cycles, baseGoroutines, runtime.NumGoroutine())
	}

	snap := m.Snapshot()
	if snap.State != StateConnected || snap.Context != "switch-b" {
		t.Fatalf("final snapshot = %+v, want connected/switch-b (events: %d)",
			snap, rec.count())
	}
	t.Logf("100 switch cycles ok in %v (goroutines base=%d final=%d)",
		time.Since(start).Round(time.Millisecond), baseGoroutines, runtime.NumGoroutine())
}

// waitConnected polls the Manager snapshot until the state machine reaches
// connected (the Connect handler may land just after Connect returns).
func waitConnected(t *testing.T, m *Manager, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if snap := m.Snapshot(); snap.State == StateConnected {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("state connected not reached within %v; snapshot=%+v", timeout, m.Snapshot())
}
