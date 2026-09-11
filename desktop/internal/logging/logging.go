// Package logging provides the application file logger with size-based
// rotation and credential redaction for natscontext values (spec §13.3).
// Logs live in appdir.LogsDir() as nats-desktop.log, rotated at 5MB with
// at most 3 files kept (current + .1 + .2).
package logging

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/WenElevating/nats-desktop/desktop/internal/appdir"
	"github.com/nats-io/jsm.go/natscontext"
)

const (
	logFileName = "nats-desktop.log"
	maxLogBytes = 5 * 1024 * 1024 // 超过 5MB 触发轮转
	keepFiles   = 3               // 当前文件 + 2 个备份
)

// rotatingWriter is a size-rotating file writer. When a write would exceed
// maxBytes it deletes the oldest backup, shifts the others down
// (.1→.2, current→.1) and reopens a fresh file.
type rotatingWriter struct {
	path     string
	f        *os.File
	size     int64
	maxBytes int64
	keep     int

	mu sync.Mutex
}

func newRotatingWriter(path string, maxBytes int64, keep int) (*rotatingWriter, error) {
	f, err := openLogFile(path)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("stat log file: %w", err)
	}
	return &rotatingWriter{path: path, f: f, size: st.Size(), maxBytes: maxBytes, keep: keep}, nil
}

func (w *rotatingWriter) suffix(i int) string { return fmt.Sprintf("%s.%d", w.path, i) }

func (w *rotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.size+int64(len(p)) > w.maxBytes {
		// 轮转失败不丢日志：继续写当前文件。
		_ = w.rotate()
	}
	n, err := w.f.Write(p)
	w.size += int64(n)
	return n, err
}

func (w *rotatingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.f.Close()
}

// rotate shifts backups and reopens the current file. Caller holds w.mu.
func (w *rotatingWriter) rotate() error {
	for i := w.keep - 1; i >= 2; i-- { // 删最旧，逐级后移
		_ = os.Remove(w.suffix(i))
		_ = os.Rename(w.suffix(i-1), w.suffix(i))
	}
	if err := w.f.Close(); err != nil {
		return err
	}
	if err := os.Rename(w.path, w.suffix(1)); err != nil {
		// 重命名失败（如文件被占用）：重开原文件继续追加。
		f, ferr := openLogFile(w.path)
		if ferr != nil {
			return fmt.Errorf("rotate %s: %w (reopen: %v)", w.path, err, ferr)
		}
		w.f = f
		return err
	}
	f, err := openLogFile(w.path)
	if err != nil {
		return fmt.Errorf("reopen log file: %w", err)
	}
	w.f = f
	w.size = 0
	return nil
}

// New returns a slog.Logger writing text records to dir/nats-desktop.log,
// rotated at 5MB with at most 3 files kept, at the given level
// (debug|info|warn|error; unknown values fall back to info).
func New(dir string, level string) (*slog.Logger, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("log dir: %w", err)
	}
	w, err := newRotatingWriter(filepath.Join(dir, logFileName), maxLogBytes, keepFiles)
	if err != nil {
		return nil, err
	}
	return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: ParseLevel(level)})), nil
}

// ParseLevel maps the settings log level string to a slog.Level; unknown or
// empty values fall back to info.
func ParseLevel(level string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default: // "info"、未知、空
		return slog.LevelInfo
	}
}

// masked is the placeholder for any secret field (spec §13.3).
const masked = "***"

// RedactContext returns a slog group value describing a natscontext.Context
// with secrets always masked: password/token/user_jwt/user_seed/nkey become
// "***". Non-secret fields (name, url, description, user) and path-like
// fields (creds, cert, key, ca) are preserved for diagnostics; any
// user:pass@ or token@ part inside server URLs is stripped.
func RedactContext(c *natscontext.Context) slog.Value {
	if c == nil {
		return slog.GroupValue()
	}
	return slog.GroupValue(
		slog.String("name", c.Name),
		slog.String("url", redactURLUserInfo(c.ServerURL())),
		optString("description", c.Description()),
		optString("user", c.User()),
		optMasked("password", c.Password()),
		optMasked("token", c.Token()),
		optMasked("user_jwt", c.UserJWT()),
		optMasked("user_seed", c.UserSeed()),
		optMasked("nkey", c.NKey()),
		optString("creds", c.Creds()),
		optString("cert", c.Certificate()),
		optString("key", c.Key()),
		optString("ca", c.CA()),
	)
}

// optString returns k=v, or an empty (ignored) Attr when v is empty.
func optString(k, v string) slog.Attr {
	if v == "" {
		return slog.Attr{}
	}
	return slog.String(k, v)
}

// optMasked returns k="***" when v is non-empty, else an empty (ignored) Attr.
func optMasked(k, v string) slog.Attr {
	if v == "" {
		return slog.Attr{}
	}
	return slog.String(k, masked)
}

// redactURLUserInfo strips the user-info component (user:pass@ / token@) from
// each URL of a comma-separated server list so credentials embedded in
// connection strings never reach the log.
func redactURLUserInfo(urls string) string {
	if urls == "" {
		return ""
	}
	parts := strings.Split(urls, ",")
	for i, p := range parts {
		p = strings.TrimSpace(p)
		u, err := url.Parse(p)
		if err != nil || u.User == nil {
			parts[i] = p
			continue
		}
		u.User = nil
		parts[i] = u.String()
	}
	return strings.Join(parts, ",")
}

// OpenLogsDir opens the logs directory in the system file manager
// (Explorer on Windows).
func OpenLogsDir() error {
	dir, err := appdir.LogsDir()
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer", dir).Start()
	case "darwin":
		return exec.Command("open", dir).Start()
	default:
		return exec.Command("xdg-open", dir).Start()
	}
}

// Service is the Wails-bound facade exposing log actions to the frontend.
type Service struct{}

func NewService() *Service { return &Service{} }

// OpenLogsDir backs the settings page's "Open logs folder" button.
func (s *Service) OpenLogsDir() error { return OpenLogsDir() }
