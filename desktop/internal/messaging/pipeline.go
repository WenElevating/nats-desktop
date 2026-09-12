package messaging

import (
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nats-io/nats.go"
)

// isUTF8 reports whether a message payload is valid UTF-8 (spec §6.4:
// non-UTF-8 payloads get hex preview + download). The empty payload is
// valid UTF-8.
func isUTF8(b []byte) bool {
	return utf8.Valid(b)
}

// HeadersMatchFilters reports whether every filter key is present with an
// exactly equal value (AND semantics; spec §6.4 optional header filter,
// Go-side so flood-rate streams are filtered near the source). Key lookup is
// case-sensitive (NATS header names are case-sensitive on the wire) and a
// filter matches when ANY of the header's values equals the wanted value.
// Empty/nil filters match everything, so a session without filters pays only
// the len check on its receive path.
func HeadersMatchFilters(h nats.Header, filters map[string]string) bool {
	if len(filters) == 0 {
		return true
	}
	for k, want := range filters {
		got, ok := h[k]
		if !ok {
			return false
		}
		for _, v := range got {
			if v == want {
				goto next
			}
		}
		return false
	next:
	}
	return true
}

// --- ring ------------------------------------------------------------------

// ring is a fixed-capacity FIFO ring buffer that keeps the most recent
// messages of a subscription session (spec §6.4: 满则丢最旧并累加丢弃计数).
// It is safe for concurrent Add/Snapshot/Dropped.
type ring struct {
	mu      sync.Mutex
	buf     []MsgOut // fixed size == capacity
	head    int      // index of the oldest retained message
	size    int      // number of retained messages (<= len(buf))
	dropped int64    // messages evicted (full) or rejected (capacity <= 0)
}

// newRing creates a ring holding at most capacity messages. A capacity
// <= 0 ring retains nothing and counts every Add as dropped.
func newRing(capacity int) *ring {
	return &ring{buf: make([]MsgOut, max(capacity, 0))}
}

// Add stores m; when the ring is full the oldest message is evicted and
// the drop counter incremented.
func (r *ring) Add(m MsgOut) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := len(r.buf)
	if c == 0 {
		r.dropped++
		return
	}
	if r.size < c {
		r.buf[(r.head+r.size)%c] = m
		r.size++
		return
	}
	r.buf[r.head] = m // overwrite oldest
	r.head = (r.head + 1) % c
	r.dropped++
}

// Dropped returns how many messages have been dropped (evicted when full,
// or rejected by a zero-capacity ring). It is monotonic and never resets.
func (r *ring) Dropped() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.dropped
}

// Snapshot returns up to the newest n messages in old→new order. The
// returned slice is a copy; mutating it does not affect the ring.
func (r *ring) Snapshot(n int) []MsgOut {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n > r.size {
		n = r.size
	}
	if n <= 0 {
		return []MsgOut{}
	}
	out := make([]MsgOut, n)
	c := len(r.buf)
	start := (r.head + r.size - n) % c // oldest of the newest n
	for i := 0; i < n; i++ {
		out[i] = r.buf[(start+i)%c]
	}
	return out
}

// --- pusher ----------------------------------------------------------------

const (
	// batchMaxMsgs is the batch-mode message threshold (spec §6.4: 500 条).
	batchMaxMsgs = 500
	// batchInterval is the batch-mode timer period (spec §6.4: 100ms).
	batchInterval = 100 * time.Millisecond
)

// pusher coalesces/emits MsgOut batches toward the frontend according to
// the session's PushMode (spec §6.4):
//
//   - realtime (default): every Add emits a single-element batch
//     immediately.
//   - batch: messages are buffered until 500 accumulate or 100ms elapses,
//     whichever comes first; the whole buffer is then emitted as one
//     batch. Batch mode runs an internal timer goroutine, which Stop()
//     fully terminates (no leak).
//
// Emit contract (re-entrancy): emit is always invoked WITHOUT p.mu held,
// so emit may safely call Add/Flush. It must NOT call Stop synchronously
// from inside emit — Stop waits for the timer goroutine, which is the
// caller of emit in batch mode, and would deadlock. Add after Stop is a
// no-op (buffered-but-unsent messages are discarded by Stop; call Flush
// before Stop if they must be delivered).
type pusher struct {
	mode PushMode
	emit func(batch []MsgOut)

	mu      sync.Mutex
	stopped bool
	buf     []MsgOut // batch mode only

	stopOnce sync.Once
	stopCh   chan struct{} // closed by Stop to wake the timer goroutine
	done     chan struct{} // closed by the timer goroutine on exit
}

// newPusher creates a pusher. In batch mode it starts the internal timer
// goroutine; in realtime mode there is no goroutine.
func newPusher(mode PushMode, emit func(batch []MsgOut)) *pusher {
	p := &pusher{
		mode:   mode,
		emit:   emit,
		stopCh: make(chan struct{}),
		done:   make(chan struct{}),
	}
	if mode == PushBatch {
		go p.run()
	} else {
		close(p.done) // realtime: nothing to wait for in Stop
	}
	return p
}

// run is the batch-mode timer goroutine: every 100ms it emits whatever is
// buffered. It owns no state outside p.mu.
func (p *pusher) run() {
	defer close(p.done)
	ticker := time.NewTicker(batchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-p.stopCh:
			return
		case <-ticker.C:
			p.mu.Lock()
			if p.stopped || len(p.buf) == 0 {
				p.mu.Unlock()
				continue
			}
			b := p.buf
			p.buf = nil
			p.mu.Unlock()
			p.emit(b) // emit outside the lock
		}
	}
}

// Add enqueues m. Realtime mode emits [m] immediately; batch mode buffers
// and emits when the buffer reaches batchMaxMsgs. After Stop, Add is a
// no-op.
func (p *pusher) Add(m MsgOut) {
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return
	}
	if p.mode != PushBatch {
		p.mu.Unlock()
		p.emit([]MsgOut{m}) // realtime: single-element batch
		return
	}
	p.buf = append(p.buf, m)
	if len(p.buf) < batchMaxMsgs {
		p.mu.Unlock()
		return
	}
	b := p.buf
	p.buf = nil
	p.mu.Unlock()
	p.emit(b) // 500 threshold reached: flush outside the lock
}

// Flush emits the current partial batch (if any). Realtime mode buffers
// nothing, so Flush is a no-op there. Safe after Stop (no-op).
func (p *pusher) Flush() {
	p.mu.Lock()
	if p.stopped || len(p.buf) == 0 {
		p.mu.Unlock()
		return
	}
	b := p.buf
	p.buf = nil
	p.mu.Unlock()
	p.emit(b) // emit outside the lock
}

// Stop terminates the pusher: the timer goroutine exits (including any
// in-flight emit), buffered messages are discarded, and all later
// Add/Flush calls are no-ops. Once Stop returns, no further emits occur;
// a single Add racing the Stop call itself may still emit once, so
// callers that stop emitting toward a dead sink must synchronize before
// calling Stop. Buffered-but-unsent messages are discarded (call Flush
// first if they must be delivered). Stop is idempotent and safe for
// concurrent callers, but must not be called from inside emit (see type
// doc).
func (p *pusher) Stop() {
	p.stopOnce.Do(func() {
		p.mu.Lock()
		p.stopped = true
		p.buf = nil
		p.mu.Unlock()
		close(p.stopCh) // wake the timer goroutine
		<-p.done        // wait for full termination; no emit can follow
	})
}

// --- rateMeter ---------------------------------------------------------------

const rateBuckets = 10 // time-slice buckets covering the window

// rateMeter is a sliding-window message rate counter (spec §6.4: msg/s,
// 1s window). Inc is O(1) with no allocation on the hot path: the window
// is divided into rateBuckets equal time slices, each holding a count;
// Rate sums the slices covering the last window. It is safe for
// concurrent Inc/Rate. Resolution is window/rateBuckets, which is ample
// for a UI gauge.
type rateMeter struct {
	mu     sync.Mutex
	window time.Duration
	width  time.Duration // window / rateBuckets (>= 1ns)
	counts [rateBuckets]int64
	cur    int       // index of the current bucket
	start  time.Time // start time of the current bucket
}

// newRateMeter creates a meter over the given sliding window. A window
// <= 0 falls back to 1s.
func newRateMeter(window time.Duration) *rateMeter {
	if window <= 0 {
		window = time.Second
	}
	width := window / rateBuckets
	if width < 1 { // degenerate sub-bucket windows: keep advance() well-defined
		width = 1
	}
	return &rateMeter{
		window: window,
		width:  width,
		start:  time.Now(),
	}
}

// advance rolls the bucket ring forward to now, zeroing expired buckets.
// Caller must hold r.mu.
func (r *rateMeter) advance(now time.Time) {
	elapsed := now.Sub(r.start)
	if elapsed < r.width {
		return
	}
	shift := int(elapsed / r.width)
	if shift >= rateBuckets {
		// The whole window elapsed since the last event: nothing counts.
		r.counts = [rateBuckets]int64{}
	} else {
		for i := 0; i < shift; i++ {
			r.cur = (r.cur + 1) % rateBuckets
			r.counts[r.cur] = 0
		}
	}
	r.start = r.start.Add(time.Duration(shift) * r.width)
}

// Inc counts one message at the current time.
func (r *rateMeter) Inc() {
	now := time.Now()
	r.mu.Lock()
	r.advance(now)
	r.counts[r.cur]++
	r.mu.Unlock()
}

// Rate returns messages per second over the current window.
func (r *rateMeter) Rate() float64 {
	now := time.Now()
	r.mu.Lock()
	r.advance(now)
	var sum int64
	for _, c := range r.counts {
		sum += c
	}
	r.mu.Unlock()
	return float64(sum) / r.window.Seconds()
}
