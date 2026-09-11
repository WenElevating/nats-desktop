// Package settings loads and atomically saves the app settings file
// (spec §7.1.2). A corrupt file is renamed to .bak and defaults returned.
package settings

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/WenElevating/nats-desktop/desktop/internal/appdir"
)

type Appearance struct {
	Theme    string `json:"theme"`    // light | dark | system
	Language string `json:"language"` // en | zh-CN
}

type Behavior struct {
	PollIntervalSeconds   int    `json:"poll_interval_seconds"`
	RequestTimeoutSeconds int    `json:"request_timeout_seconds"`
	ConfirmLevel          string `json:"confirm_level"` // standard | relaxed
	SessionPushBatching   bool   `json:"session_push_batching"`
	SessionBufferSize     int    `json:"session_buffer_size"`
	LogLevel              string `json:"log_level"` // debug|info|warn|error
}

type Privacy struct {
	CrashReports bool `json:"crash_reports"`
	UpdateCheck  bool `json:"update_check"`
}

type Settings struct {
	Appearance        Appearance `json:"appearance"`
	Behavior          Behavior   `json:"behavior"`
	Privacy           Privacy    `json:"privacy"`
	LastActiveContext string     `json:"last_active_context"`
}

func Default() Settings {
	return Settings{
		Appearance: Appearance{Theme: "system", Language: "en"},
		Behavior: Behavior{PollIntervalSeconds: 5, RequestTimeoutSeconds: 5,
			ConfirmLevel: "standard", SessionPushBatching: false,
			SessionBufferSize: 10000, LogLevel: "info"},
		Privacy: Privacy{CrashReports: false, UpdateCheck: true},
	}
}

func Load(path string) (Settings, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Default(), nil
	}
	if err != nil {
		return Default(), fmt.Errorf("read settings: %w", err)
	}
	var s Settings
	if err := json.Unmarshal(b, &s); err != nil {
		_ = os.Rename(path, path+".bak")
		return Default(), nil // spec §6.12: 损坏回退默认
	}
	return s, nil
}

func Save(path string, s Settings) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return fmt.Errorf("write settings: %w", err)
	}
	return os.Rename(tmp, path) // 原子替换（spec §16.3）
}

// fileMu serializes read-modify-write cycles across all settings writers so
// a concurrent save cannot clobber server-managed fields such as
// last_active_context (which main.go persists on Connect).
var fileMu sync.Mutex

// Update loads, mutates, and atomically saves; ALL writers must use it.
func Update(path string, fn func(*Settings)) error {
	fileMu.Lock()
	defer fileMu.Unlock()
	s, err := Load(path)
	if err != nil {
		return err
	}
	fn(&s)
	return Save(path, s)
}

// Path returns <appdir>/settings.json, creating the directory.
func Path() (string, error) {
	dir, err := appdir.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.json"), nil
}
