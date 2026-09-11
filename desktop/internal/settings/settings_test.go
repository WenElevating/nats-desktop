package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDefaults(t *testing.T) {
	s := Default()
	if s.Appearance.Theme != "system" || s.Appearance.Language != "en" ||
		s.Behavior.PollIntervalSeconds != 5 || s.Behavior.RequestTimeoutSeconds != 5 ||
		s.Behavior.ConfirmLevel != "standard" || s.Behavior.SessionPushBatching ||
		s.Behavior.SessionBufferSize != 10000 || s.Behavior.LogLevel != "info" ||
		s.Privacy.CrashReports || !s.Privacy.UpdateCheck {
		t.Fatalf("defaults mismatch: %+v", s)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	s := Default()
	s.Appearance.Language = "zh-CN"
	if err := Save(path, s); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil || got.Appearance.Language != "zh-CN" {
		t.Fatalf("roundtrip failed: %v %+v", err, got)
	}
}

func TestCorruptFileFallsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	os.WriteFile(path, []byte("{not json"), 0o600)
	got, err := Load(path)
	if err != nil {
		t.Fatalf("corrupt file must not error: %v", err)
	}
	if got.Appearance.Theme != "system" {
		t.Fatal("corrupt file must return defaults")
	}
	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Fatal("corrupt file must be renamed to .bak")
	}
}

func TestSaveAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	_ = Save(path, Default())
	// 目录下不应残留临时文件
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Fatal("temp file left behind")
		}
	}
	// 写入的是合法 JSON
	b, _ := os.ReadFile(path)
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("not valid json: %v", err)
	}
}
