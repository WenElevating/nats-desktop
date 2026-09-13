package buckets

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/WenElevating/nats-desktop/desktop/internal/jsctx"
	"github.com/WenElevating/nats-desktop/desktop/internal/settings"
)

// connSource abstracts the two connection accessors bucket operations need.
// *connections.Manager satisfies it directly (Manager.JSParams); tests stub
// it with connStub, which is why the constructor accepts the interface rather
// than the concrete manager type — jsadmin's connSource pattern re-declared
// in this package.
type connSource interface {
	Conn() *nats.Conn
	JSParams() (domain, apiPrefix string, ok bool)
}

// BucketService is the Wails-bound facade for KeyValue / Object Store
// management (spec §6.8/§6.9). Settings are read per call; every method
// returns a CallResult-embedding struct, never a bare error, so the frontend
// can branch on error_code (spec §8.5.2).
type BucketService struct {
	mgr          connSource
	log          *slog.Logger
	emit         func(name string, data any)
	settingsPath string
	watches      *watchRegistry // Task 4 接入；本任务为 nil 安全
}

// NewBucketService wires the facade onto the active connection. mgr is taken
// as connSource so tests can inject a stub; *connections.Manager satisfies it
// without adaptation.
func NewBucketService(mgr connSource, log *slog.Logger, emit func(name string, data any), settingsPath string) *BucketService {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if emit == nil {
		emit = func(string, any) {}
	}
	return &BucketService{mgr: mgr, log: log, emit: emit, settingsPath: settingsPath}
}

// watchRegistry 占位：Task 4 在 watch.go 落地完整实现（mu/next/entries +
// launch）时**删除本占位**以免重声明。本任务的绑定方法一律不触碰 s.watches
// （nil 解引用安全——指针字段零值即 nil）。
type watchRegistry struct{}

// timeout reads the request timeout from settings on every call (spec §7.1.2:
// behavior changes apply without restart); falls back to the 5s default when
// the file is missing, corrupt, or the value is non-positive (aligned with
// jsadmin).
func (s *BucketService) timeout() time.Duration {
	st, err := settings.Load(s.settingsPath)
	if err != nil || st.Behavior.RequestTimeoutSeconds <= 0 {
		return 5 * time.Second
	}
	return time.Duration(st.Behavior.RequestTimeoutSeconds) * time.Second
}

// js builds the jetstream handle for the active connection, honouring the
// context's domain/API prefix. The build is client-side only — no network
// round trips — so a wrong prefix surfaces later as no-responders on the
// first API call (unavailable semantics, spec §6.6).
func (s *BucketService) js() (jetstream.JetStream, CallResult) {
	nc := s.mgr.Conn()
	if nc == nil {
		return nil, fail(CodeNotConnected, "not connected")
	}
	domain, prefix, ok := s.mgr.JSParams()
	if !ok {
		return nil, fail(CodeNotConnected, "not connected")
	}
	js, err := jsctx.New(nc, domain, prefix)
	if err != nil {
		return nil, fail(CodeServer, err.Error())
	}
	return js, CallResult{}
}

// isNoResponders / isTimeout distinguish the JS-layer unavailability causes
// for the list guidance panel. errors.Is — never string matching.
func isNoResponders(err error) bool { return errors.Is(err, nats.ErrNoResponders) }
func isTimeout(err error) bool      { return errors.Is(err, context.DeadlineExceeded) }
