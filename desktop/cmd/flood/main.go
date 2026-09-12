// Command flood is the M2 acceptance flood injector (Task 13): a standalone
// core-NATS publish pacer for driving spec §6.4/§12/AC-005/AC-007 load
// profiles against a real nats-server, e.g.
//
//	go run ./cmd/flood -url nats://127.0.0.1:4333 -subject m2flood.x \
//	    -rate 50000 -size 1024 -dur 10s
//
// It publishes -rate messages/s of -size bytes for -dur via nc.PublishMsg
// (session-less: it measures the publisher+server leg; the session/pipeline
// side is gated by the Go tests, see internal/messaging). Rate pacing uses a
// batched ticker — a per-message timer cannot keep 50k msg/s on Windows — and
// flushes periodically so the run ends with everything delivered to the
// server. On completion it prints the achieved rate (published / wall time).
// -c validates the flags (config check, no connection) and exits.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
)

// maxPayload mirrors the nats-server default max_payload (8MB): payloads at or
// below it are server-acceptable; larger ones are rejected here up front.
const maxPayload = 8 * 1024 * 1024

// flushEvery is the periodic Flush interval during the run: keeps the client's
// async output buffer bounded and bounds the tail delivery after the loop.
const flushEvery = 250 * time.Millisecond

// tickEvery is the pacing tick. rate*tickEvery messages are due per tick; a
// plain time.Ticker handles 1k msg/s (1 msg/tick) through 50k msg/s (50
// msgs/tick) well within Windows timer resolution.
const tickEvery = time.Millisecond

type config struct {
	url     string
	subject string
	rate    int
	size    int
	dur     time.Duration
	headers nats.Header // from repeatable -header k=v flags; nil when none
}

// headerFlags collects repeatable -header k=v occurrences (flag.Value): Task
// 15's UIA smoke drives "flood with mixed headers" sessions through it.
type headerFlags []string

func (h *headerFlags) String() string { return strings.Join(*h, ",") }
func (h *headerFlags) Set(s string) error {
	*h = append(*h, s)
	return nil
}

// parseHeaders turns the raw -header k=v entries into a nats.Header: at most
// 8 pairs (the session header-filter form bound, spec §6.4), non-empty key,
// key/value at most 256 bytes each. The FIRST '=' splits, so values may
// contain '='; repeated keys accumulate multiple values.
func parseHeaders(raw []string) (nats.Header, error) {
	if len(raw) > 8 {
		return nil, fmt.Errorf("-header allows at most 8 pairs, got %d", len(raw))
	}
	h := make(nats.Header, len(raw))
	for _, kv := range raw {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || strings.TrimSpace(k) == "" {
			return nil, fmt.Errorf("-header must be k=v with a non-empty key, got %q", kv)
		}
		if len(k) > 256 || len(v) > 256 {
			return nil, fmt.Errorf("-header key/value must be at most 256 bytes each")
		}
		h[k] = append(h[k], v)
	}
	return h, nil
}

func parseFlags() (config, error) {
	var c config
	var dur time.Duration
	var rawHeaders headerFlags
	flag.StringVar(&c.url, "url", "nats://127.0.0.1:4333", "NATS server URL")
	flag.StringVar(&c.subject, "subject", "m2flood.x", "subject to publish to")
	flag.IntVar(&c.rate, "rate", 1000, "target rate in messages per second")
	flag.IntVar(&c.size, "size", 1024, "payload size in bytes")
	flag.DurationVar(&dur, "dur", 10*time.Second, "publish duration (e.g. 10s, 1m)")
	flag.Var(&rawHeaders, "header", "message header k=v (repeatable, at most 8 pairs, key/value up to 256 bytes)")
	check := flag.Bool("c", false, "validate flags and exit without connecting")
	flag.Parse()
	c.dur = dur

	hdrs, err := parseHeaders(rawHeaders)
	if err != nil {
		return c, err
	}
	c.headers = hdrs

	if err := c.validate(); err != nil {
		return c, err
	}
	if *check {
		fmt.Printf("config OK: %s\n", c)
		os.Exit(0)
	}
	return c, nil
}

func (c config) validate() error {
	switch {
	case strings.TrimSpace(c.url) == "":
		return fmt.Errorf("-url is required")
	case strings.TrimSpace(c.subject) == "" || strings.ContainsAny(c.subject, " \t"):
		return fmt.Errorf("-subject must be a non-empty NATS subject without spaces: %q", c.subject)
	case c.rate < 1 || c.rate > 10_000_000:
		return fmt.Errorf("-rate must be in [1, 10000000], got %d", c.rate)
	case c.size < 1 || c.size > maxPayload:
		return fmt.Errorf("-size must be in [1, %d] bytes (server default max payload), got %d", maxPayload, c.size)
	case c.dur <= 0:
		return fmt.Errorf("-dur must be positive, got %v", c.dur)
	}
	return nil
}

func (c config) String() string {
	return fmt.Sprintf("url=%s subject=%s rate=%d msg/s size=%dB dur=%v headers=%d", c.url, c.subject, c.rate, c.size, c.dur, len(c.headers))
}

func main() {
	c, err := parseFlags()
	if err != nil {
		fmt.Fprintln(os.Stderr, "flood:", err)
		os.Exit(2)
	}

	nc, err := nats.Connect(c.url, nats.Name("nats-desktop-flood"), nats.NoReconnect())
	if err != nil {
		fmt.Fprintf(os.Stderr, "flood: connect %s: %v\n", c.url, err)
		os.Exit(1)
	}
	defer nc.Drain()

	payload := make([]byte, c.size)
	for i := range payload {
		payload[i] = byte('a' + i%26)
	}

	perTick := float64(c.rate) * tickEvery.Seconds()
	fmt.Printf("flood: %s\n", c)

	msg := nats.NewMsg(c.subject)
	msg.Data = payload
	if len(c.headers) > 0 { // Task 15 UIA smoke: flood with mixed headers
		msg.Header = c.headers
	}

	// Token-accumulator pacing: each tick credits rate*tickEvery tokens
	// (fractional tokens carry over), so the long-run average is exactly the
	// target even though ticks fire in whole messages.
	t0 := time.Now()
	deadline := t0.Add(c.dur)
	ticker := time.NewTicker(tickEvery)
	defer ticker.Stop()

	var published int64
	acc := 0.0
	lastFlush := time.Now()

publish:
	for {
		select {
		case <-ticker.C:
			if time.Now().After(deadline) {
				break publish
			}
			acc += perTick
			n := int(acc)
			acc -= float64(n)
			for i := 0; i < n; i++ {
				if err := nc.PublishMsg(msg); err != nil {
					fmt.Fprintf(os.Stderr, "flood: publish after %d msgs: %v\n", published, err)
					os.Exit(1)
				}
				published++
			}
			if now := time.Now(); now.Sub(lastFlush) >= flushEvery {
				if err := nc.Flush(); err != nil {
					fmt.Fprintf(os.Stderr, "flood: flush after %d msgs: %v\n", published, err)
					os.Exit(1)
				}
				lastFlush = now
			}
		}
	}

	publishWall := time.Since(t0)
	if err := nc.Flush(); err != nil { // deliver the <=1-tick tail before reporting
		fmt.Fprintf(os.Stderr, "flood: final flush: %v\n", err)
		os.Exit(1)
	}
	totalWall := time.Since(t0)

	if published == 0 || publishWall == 0 {
		fmt.Println("flood: published 0 messages (duration too short for the pacing tick)")
		return
	}
	achieved := float64(published) / publishWall.Seconds()
	fmt.Printf("flood: published %d msgs in %v (loop) / %v (incl. final flush)\n", published, publishWall.Round(time.Millisecond), totalWall.Round(time.Millisecond))
	fmt.Printf("flood: achieved %.0f msg/s (%.1f%% of target %d msg/s)\n",
		achieved, 100*achieved/float64(c.rate), c.rate)
}
