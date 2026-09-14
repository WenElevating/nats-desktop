//go:build race

package messaging

// raceEnabled reports whether the race detector instrumentation is active.
// Perf-budget tests skip under -race: the instrumentation slows code 2-20x,
// making wall-clock budgets meaningless (CI -race first-run finding, M6).
const raceEnabled = true
