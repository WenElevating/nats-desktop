package jsadmin

import (
	"io"
	"log/slog"
	"sync/atomic"

	"github.com/nats-io/nats.go"
)

// connSource abstracts the two connection accessors JetStream operations
// need. *connections.Manager satisfies it directly (Manager.JSParams, Task 1);
// tests stub it with connStub, which is why the constructor accepts the
// interface rather than the concrete manager type.
type connSource interface {
	Conn() *nats.Conn
	JSParams() (domain, apiPrefix string, ok bool)
}

// JetAdminService is the Wails-bound facade for stream/consumer
// administration (spec §6.6/§6.7). Settings are read per call; every
// method returns a CallResult-embedding struct, never a bare error, so
// the frontend can branch on error_code (spec §8.5.2).
type JetAdminService struct {
	mgr          connSource
	log          *slog.Logger
	emit         func(name string, data any)
	settingsPath string
	backupMu     atomic.Uint64 // 备份/恢复互斥锁（同一时刻只允许一个，Task 6 以 CompareAndSwap 使用）
}

// NewJetAdminService wires the facade onto the active connection. mgr is
// taken as connSource so tests can inject a stub; *connections.Manager
// satisfies it without adaptation.
func NewJetAdminService(mgr connSource, log *slog.Logger, emit func(name string, data any), settingsPath string) *JetAdminService {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if emit == nil {
		emit = func(string, any) {}
	}
	return &JetAdminService{mgr: mgr, log: log, emit: emit, settingsPath: settingsPath}
}
