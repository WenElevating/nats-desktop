// Command loaddata is the M6 Task 6 test-only dataset presetter
// (AC-028/§20.3): it preloads the long-lived local server with the large
// datasets the performance legs measure against —
//
//	go run ./cmd/loaddata -url nats://127.0.0.1:4333 \
//	    -streams 10000 -million 1000000 -kvkeys 100000
//
// It creates -streams streams named LOAD_S%05d, one stream LOAD_MSGS
// (subject load.msgs) with -million 256B messages, and a KV bucket LOAD_KV
// with -kvkeys keys (v%06d, 256B values). Everything is idempotent per name
// (existing streams are skipped via a LoadStream probe; LOAD_MSGS resumes
// from its current message count; LOAD_KV is a CreateOrUpdate) so an
// interrupted minutes-long run can simply be rerun — which is also what
// makes Ctrl-C safe: the run is context-aware (Ctrl-C cancels it) and the
// partial dataset is picked up on the next invocation. Messages publish in
// batches of 500 via js.PublishAsync (the batched form of js.Publish — a
// synchronous round trip per message would not finish 1M in minutes) with
// progress printed every 100k; KV and stream progress print periodically
// too. -c validates the flags and exits without connecting.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"time"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Dataset naming and pacing constants. LOAD_* prefixes keep the preset
// datasets visually separable from app-created resources on the shared
// server; pubBatch/progressEvery are the brief's batched-publish contract.
const (
	streamPrefix = "LOAD_S" // streams are streamPrefix + %05d
	msgStream    = "LOAD_MSGS"
	msgSubject   = "load.msgs"
	kvBucket     = "LOAD_KV" // keys are v%06d

	payloadSize   = 256 // message and KV value size in bytes
	pubBatch      = 500 // PublishAsync futures outstanding per batch
	progressEvery = 100_000
)

type config struct {
	url     string
	streams int // LOAD_S%05d streams to create
	million int // messages in LOAD_MSGS (flag name follows the brief's usage line)
	kvkeys  int // keys in LOAD_KV
}

func parseFlags() (config, error) {
	var c config
	flag.StringVar(&c.url, "url", "nats://127.0.0.1:4333", "NATS server URL")
	flag.IntVar(&c.streams, "streams", 0, "number of LOAD_S%05d streams to create")
	flag.IntVar(&c.million, "million", 0, "number of 256B messages to load into the LOAD_MSGS stream")
	flag.IntVar(&c.kvkeys, "kvkeys", 0, "number of keys to load into the LOAD_KV bucket")
	check := flag.Bool("c", false, "validate flags and exit without connecting")
	flag.Parse()

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
	case c.url == "":
		return fmt.Errorf("-url is required")
	case c.streams < 0 || c.streams > 100_000:
		return fmt.Errorf("-streams must be in [0, 100000], got %d", c.streams)
	case c.million < 0 || c.million > 100_000_000:
		return fmt.Errorf("-million must be in [0, 100000000], got %d", c.million)
	case c.kvkeys < 0 || c.kvkeys > 10_000_000:
		return fmt.Errorf("-kvkeys must be in [0, 10000000], got %d", c.kvkeys)
	}
	return nil
}

func (c config) String() string {
	return fmt.Sprintf("url=%s streams=%d messages=%d kvkeys=%d", c.url, c.streams, c.million, c.kvkeys)
}

// summary reports what one run did (plus per-dataset wall times) — the smoke
// test asserts these counts against server state.
type summary struct {
	StreamsCreated int
	StreamsSkipped int
	MsgsPublished  int
	KvKeysPut      int
	StreamsElapsed time.Duration
	MsgsElapsed    time.Duration
	KvElapsed      time.Duration
}

func main() {
	cfg, err := parseFlags()
	if err != nil {
		fmt.Fprintln(os.Stderr, "loaddata:", err)
		os.Exit(2)
	}
	// Ctrl-C safe: the signal cancels ctx, every loader checks it between
	// units, and the idempotent design picks up partial state on rerun.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx, cfg, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "loaddata:", err)
		os.Exit(1)
	}
}

// run connects and drives all three loaders; split from main so the smoke
// test can run it in-process against an embedded fixture server.
func run(ctx context.Context, cfg config, out io.Writer) error {
	nc, err := nats.Connect(cfg.url, nats.Name("nats-desktop-loaddata"), nats.NoReconnect())
	if err != nil {
		return fmt.Errorf("connect %s: %w", cfg.url, err)
	}
	defer nc.Close()
	_, err = loadAll(ctx, nc, cfg, out)
	return err
}

// loadAll presets streams, messages, and KV keys on an existing connection.
func loadAll(ctx context.Context, nc *nats.Conn, cfg config, out io.Writer) (summary, error) {
	var sum summary

	mgr, err := jsm.New(nc, jsm.WithTimeout(30*time.Second))
	if err != nil {
		return sum, err
	}
	js, err := jetstream.New(nc)
	if err != nil {
		return sum, err
	}

	fmt.Fprintf(out, "loaddata: %s\n", cfg)
	t0 := time.Now()
	if sum.StreamsCreated, sum.StreamsSkipped, err = loadStreams(ctx, mgr, cfg, out); err != nil {
		return sum, err
	}
	sum.StreamsElapsed = time.Since(t0)

	t0 = time.Now()
	if sum.MsgsPublished, err = loadMessages(ctx, js, cfg.million, out); err != nil {
		return sum, err
	}
	sum.MsgsElapsed = time.Since(t0)

	t0 = time.Now()
	if sum.KvKeysPut, err = loadKV(ctx, js, cfg.kvkeys, out); err != nil {
		return sum, err
	}
	sum.KvElapsed = time.Since(t0)

	fmt.Fprintf(out, "loaddata: done in %v (streams %v, messages %v, kv %v) — created %d / skipped %d streams, published %d msgs, put %d kv keys\n",
		sum.StreamsElapsed+sum.MsgsElapsed+sum.KvElapsed,
		sum.StreamsElapsed.Round(time.Millisecond),
		sum.MsgsElapsed.Round(time.Millisecond),
		sum.KvElapsed.Round(time.Millisecond),
		sum.StreamsCreated, sum.StreamsSkipped, sum.MsgsPublished, sum.KvKeysPut)
	return sum, nil
}

// streamName is the fleet naming rule (LOAD_S%05d) shared by the loader and
// the smoke test's server-state assertions.
func streamName(i int) string { return fmt.Sprintf("%s%05d", streamPrefix, i) }

// loadStreams creates the LOAD_S%05d fleet, skipping names that already
// exist (LoadStream probe first — the reviewed idempotency requirement for
// interruptible multi-minute runs).
func loadStreams(ctx context.Context, mgr *jsm.Manager, cfg config, out io.Writer) (created, skipped int, err error) {
	for i := 0; i < cfg.streams; i++ {
		if err := ctx.Err(); err != nil {
			return created, skipped, err
		}
		name := streamName(i)
		if _, err := mgr.LoadStream(name); err == nil {
			skipped++
			continue
		}
		if _, err := mgr.NewStream(name); err != nil {
			return created, skipped, fmt.Errorf("create %s: %w", name, err)
		}
		created++
		if created%2000 == 0 {
			fmt.Fprintf(out, "loaddata: streams %d created, %d skipped\n", created, skipped)
		}
	}
	return created, skipped, nil
}

// loadMessages fills LOAD_MSGS up to total 256B messages, resuming from the
// stream's current message count (so an interrupted run tops up instead of
// duplicating). Publishes in pubBatch-sized PublishAsync batches, verifying
// every ack future, printing progress every progressEvery messages.
func loadMessages(ctx context.Context, js jetstream.JetStream, total int, out io.Writer) (published int, err error) {
	if total == 0 {
		return 0, nil
	}
	str, err := js.Stream(ctx, msgStream)
	switch {
	case errors.Is(err, jetstream.ErrStreamNotFound):
		if str, err = js.CreateStream(ctx, jetstream.StreamConfig{
			Name:     msgStream,
			Subjects: []string{msgSubject},
			Storage:  jetstream.FileStorage,
		}); err != nil {
			return 0, fmt.Errorf("create %s: %w", msgStream, err)
		}
	case err != nil:
		return 0, fmt.Errorf("load %s: %w", msgStream, err)
	}
	start := str.CachedInfo().State.Msgs
	if start >= uint64(total) {
		fmt.Fprintf(out, "loaddata: %s already has %d messages (target %d) — skip\n", msgStream, start, total)
		return 0, nil
	}
	fmt.Fprintf(out, "loaddata: %s has %d messages, publishing %d more\n", msgStream, start, uint64(total)-start)

	payload := make([]byte, payloadSize)
	for i := range payload {
		payload[i] = byte('a' + i%26)
	}

	var batch []jetstream.PubAckFuture
	for i := start; i < uint64(total); i++ {
		if err := ctx.Err(); err != nil {
			return published, err
		}
		f, err := js.PublishAsync(msgSubject, payload)
		if err != nil {
			return published, fmt.Errorf("publish %s: %w", msgSubject, err)
		}
		batch = append(batch, f)
		if len(batch) == pubBatch || i == uint64(total)-1 {
			select {
			case <-js.PublishAsyncComplete(): // all outstanding futures settled
			case <-ctx.Done():
				return published, ctx.Err()
			}
			for _, f := range batch {
				select {
				case <-f.Ok():
				case perr := <-f.Err():
					return published, fmt.Errorf("publish %s: %w", msgSubject, perr)
				}
			}
			prev := published
			published += len(batch)
			batch = batch[:0]
			if published/progressEvery != prev/progressEvery || i == uint64(total)-1 {
				fmt.Fprintf(out, "loaddata: messages %d / %d\n", start+uint64(published), total)
			}
		}
	}
	return published, nil
}

// loadKV creates-or-updates LOAD_KV (jetstream.KeyValue only BINDS an
// existing bucket — first run must create, hence CreateOrUpdateKeyValue)
// and puts v%06d keys. Re-putting the same key/value is idempotent; a
// bucket already holding enough values is skipped entirely for fast reruns.
func loadKV(ctx context.Context, js jetstream.JetStream, total int, out io.Writer) (put int, err error) {
	if total == 0 {
		return 0, nil
	}
	kvs, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{Bucket: kvBucket, History: 1})
	if err != nil {
		return 0, fmt.Errorf("create %s: %w", kvBucket, err)
	}
	if st, err := kvs.Status(ctx); err == nil && st.Values() >= uint64(total) {
		fmt.Fprintf(out, "loaddata: %s already holds %d values (target %d) — skip\n", kvBucket, st.Values(), total)
		return 0, nil
	}

	value := make([]byte, payloadSize)
	for i := range value {
		value[i] = byte('A' + i%26)
	}
	for i := 0; i < total; i++ {
		if err := ctx.Err(); err != nil {
			return put, err
		}
		if _, err := kvs.Put(ctx, fmt.Sprintf("v%06d", i), value); err != nil {
			return put, fmt.Errorf("put v%06d: %w", i, err)
		}
		put++
		if put%(progressEvery/5) == 0 {
			fmt.Fprintf(out, "loaddata: kv keys %d / %d\n", put, total)
		}
	}
	return put, nil
}
