// M6 Task 6 smoke for the loaddata presetter: flag validation plus a
// small-scale end-to-end run (5 streams / 100 messages / 50 KV keys — the
// brief's smoke profile) against an embedded testutil.StartSysServer
// fixture, asserting the loader's summary counts against actual server
// state (jsm StreamNames, stream state, kvs.Keys), then rerunning to prove
// the idempotency contract the multi-minute full preset relies on.
package main

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
)

func TestValidateConfig(t *testing.T) {
	cases := []struct {
		name    string
		cfg     config
		wantErr bool
	}{
		{"full preset values", config{url: "nats://127.0.0.1:4333", streams: 10000, million: 1000000, kvkeys: 100000}, false},
		{"all zero is a no-op run", config{url: "nats://x:4222"}, false},
		{"missing url", config{streams: 1}, true},
		{"negative streams", config{url: "x", streams: -1}, true},
		{"negative million", config{url: "x", million: -1}, true},
		{"negative kvkeys", config{url: "x", kvkeys: -5}, true},
		{"streams over bound", config{url: "x", streams: 100_001}, true},
		{"million over bound", config{url: "x", million: 100_000_001}, true},
		{"kvkeys over bound", config{url: "x", kvkeys: 10_000_001}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.cfg.validate()
			if (err != nil) != tc.wantErr {
				t.Fatalf("validate(%+v) = %v, wantErr=%v", tc.cfg, err, tc.wantErr)
			}
		})
	}
}

// TestLoadSmokeEmbedded runs the full loader (5 streams / 100 msgs / 50 KV
// keys) against the embedded fixture and cross-checks every summary number
// against server state; the second run must change nothing (skip/resume
// idempotency).
func TestLoadSmokeEmbedded(t *testing.T) {
	f := testutil.StartSysServer(t)
	nc := testutil.ConnectUser(t, f.URL, f.AppUser, f.AppPass)

	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatal(err)
	}
	mgr, err := jsm.New(nc)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	cfg := config{url: f.URL, streams: 5, million: 100, kvkeys: 50}
	var out bytes.Buffer
	sum, err := loadAll(ctx, nc, cfg, &out)
	if err != nil {
		t.Fatalf("loadAll: %v", err)
	}
	if sum.StreamsCreated != 5 || sum.StreamsSkipped != 0 || sum.MsgsPublished != 100 || sum.KvKeysPut != 50 {
		t.Fatalf("first-run summary: %+v", sum)
	}
	assertServerState(t, ctx, mgr, js, 5, 100, 50)

	// Rerun: everything already in place — nothing created, nothing published,
	// nothing put, server state unchanged (the interrupted-run resume path).
	sum2, err := loadAll(ctx, nc, cfg, &out)
	if err != nil {
		t.Fatalf("rerun loadAll: %v", err)
	}
	if sum2.StreamsCreated != 0 || sum2.StreamsSkipped != 5 || sum2.MsgsPublished != 0 || sum2.KvKeysPut != 0 {
		t.Fatalf("rerun summary not idempotent: %+v", sum2)
	}
	assertServerState(t, ctx, mgr, js, 5, 100, 50)
}

// assertServerState cross-checks the dataset invariants on the server side:
// wantStreams LOAD_S%05d streams + LOAD_MSGS + the LOAD_KV bucket's
// underlying KV_LOAD_KV stream, exactly wantMsgs messages in LOAD_MSGS, and
// exactly wantKeys keys in LOAD_KV.
func assertServerState(t *testing.T, ctx context.Context, mgr *jsm.Manager, js jetstream.JetStream, wantStreams, wantMsgs, wantKeys int) {
	t.Helper()
	names, err := mgr.StreamNames(nil)
	if err != nil {
		t.Fatalf("StreamNames: %v", err)
	}
	if len(names) != wantStreams+2 { // + LOAD_MSGS + KV_LOAD_KV
		t.Fatalf("stream names = %v, want %d LOAD_S* + LOAD_MSGS + KV_LOAD_KV", names, wantStreams)
	}
	for _, extra := range []string{msgStream, "KV_" + kvBucket} {
		found := false
		for _, n := range names {
			if n == extra {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("stream %s missing from %v", extra, names)
		}
	}
	for i := 0; i < wantStreams; i++ {
		want := streamName(i)
		found := false
		for _, n := range names {
			if n == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("stream %s missing from %v", want, names)
		}
	}
	str, err := js.Stream(ctx, msgStream)
	if err != nil {
		t.Fatalf("load %s: %v", msgStream, err)
	}
	if got := str.CachedInfo().State.Msgs; got != uint64(wantMsgs) {
		t.Fatalf("%s msgs = %d, want %d", msgStream, got, wantMsgs)
	}
	kvs, err := js.KeyValue(ctx, kvBucket)
	if err != nil {
		t.Fatalf("bind %s: %v", kvBucket, err)
	}
	keys, err := kvs.Keys(ctx)
	if err != nil {
		t.Fatalf("keys %s: %v", kvBucket, err)
	}
	if len(keys) != wantKeys {
		t.Fatalf("%s keys = %d, want %d", kvBucket, len(keys), wantKeys)
	}
}
