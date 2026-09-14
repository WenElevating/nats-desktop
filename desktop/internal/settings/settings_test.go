package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
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

// TestLoadCorruptedEqualsDefault: 损坏回退的**全结构等值**强化（既有测试只断言无错+默认主题）。
func TestLoadCorruptedEqualsDefault(t *testing.T) {
	path := t.TempDir() + "/settings.json"
	if err := os.WriteFile(path, []byte(`{"behavior":`), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := Load(path)
	if err != nil {
		t.Fatalf("corrupted settings must fall back, got err: %v", err)
	}
	if st != Default() {
		t.Fatalf("corrupted settings must equal Default(), got %+v", st)
	}
	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Fatalf("corrupted file must be preserved as .bak: %v", err)
	}
}

// TestLoadNotExistsReturnsDefault（未覆盖分支：os.IsNotExist 早退）。
func TestLoadNotExistsReturnsDefault(t *testing.T) {
	st, err := Load(t.TempDir() + "/absent.json")
	if err != nil || st != Default() {
		t.Fatalf("absent settings = (%+v, %v), want (Default, nil)", st, err)
	}
}

// TestUpdateConcurrentNoLostWrite: 两个并发 Update 各改一个字段，落盘后两者都在
// （fileMu 串行化——settings.go:87 的契约半边）。
func TestUpdateConcurrentNoLostWrite(t *testing.T) {
	path := t.TempDir() + "/settings.json"
	if err := Save(path, Default()); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_ = Update(path, func(cur *Settings) {
				if i == 0 {
					cur.Behavior.PollIntervalSeconds = 7
				} else {
					cur.Behavior.RequestTimeoutSeconds = 9
				}
			})
		}(i)
	}
	wg.Wait()
	st, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Behavior.PollIntervalSeconds != 7 || st.Behavior.RequestTimeoutSeconds != 9 {
		t.Fatalf("lost write: %+v", st.Behavior)
	}
}

// setUserConfigBase 驱动 os.UserConfigDir 指向 base（各 GOOS 的环境键不同），
// 返回 UserConfigDir 应报出的基目录。
func setUserConfigBase(t *testing.T, base string) string {
	t.Helper()
	switch runtime.GOOS {
	case "windows":
		t.Setenv("AppData", base)
		return base
	case "darwin":
		t.Setenv("HOME", base)
		return filepath.Join(base, "Library", "Application Support")
	default:
		t.Setenv("XDG_CONFIG_HOME", base)
		return base
	}
}

// TestPathJoinsAppdir: Path() = <appdir>/settings.json 且目录被创建（此前 0% 覆盖）。
func TestPathJoinsAppdir(t *testing.T) {
	base := setUserConfigBase(t, t.TempDir())
	got, err := Path()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(base, "nats-desktop", "settings.json"); got != want {
		t.Fatalf("Path() = %q, want %q", got, want)
	}
	if _, err := os.Stat(filepath.Join(base, "nats-desktop")); err != nil {
		t.Fatalf("appdir not created by Path(): %v", err)
	}
}

// TestPathUserConfigError: 底层 appdir.Dir 失败时 Path 原样上抛错误。
func TestPathUserConfigError(t *testing.T) {
	switch runtime.GOOS {
	case "windows":
		t.Setenv("AppData", "")
	case "darwin":
		t.Setenv("HOME", "")
	default:
		t.Setenv("XDG_CONFIG_HOME", "")
		t.Setenv("HOME", "")
	}
	if got, err := Path(); err == nil || got != "" {
		t.Fatalf("Path with undefined config dir = (%q, %v), want error", got, err)
	}
}

// TestGetSettingsFacade: Service.GetSettings 直通 Load（此前 0% 覆盖）。
func TestGetSettingsFacade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	got, err := NewService(path).GetSettings()
	if err != nil || got != Default() {
		t.Fatalf("GetSettings absent file = (%+v, %v), want (Default, nil)", got, err)
	}
}

// TestLoadUnreadablePathIsError: 非 not-exist 的读失败必须报错（不得静默回退
// 默认——那会把真实故障伪装成「从未保存过」）。路径给成目录：ReadFile 必失败
// 且 os.IsNotExist 为假。
func TestLoadUnreadablePathIsError(t *testing.T) {
	st, err := Load(t.TempDir())
	if err == nil {
		t.Fatalf("directory path must error, got settings %+v", st)
	}
	if st != Default() {
		t.Fatalf("error path must still return defaults: %+v", st)
	}
}

// TestUpdatePropagatesLoadError: Update 的 Load 失败分支原样上抛。
func TestUpdatePropagatesLoadError(t *testing.T) {
	if err := Update(t.TempDir(), func(*Settings) {}); err == nil {
		t.Fatal("Update on unreadable path must error")
	}
}

// TestSaveWriteError: 落盘失败（.tmp 被目录占位）必须报错而非静默成功。
func TestSaveWriteError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.Mkdir(path+".tmp", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Save(path, Default()); err == nil {
		t.Fatal("Save with blocked .tmp must error")
	}
}

// Regression (final review C1): the Service facade must merge user sections
// only — a stale frontend draft saving settings must not clobber the
// server-managed last_active_context that startup auto-reconnect relies on.
func TestSaveSettingsDoesNotClobberLastActiveContext(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := Update(path, func(s *Settings) { s.LastActiveContext = "demo" }); err != nil {
		t.Fatal(err)
	}
	stale := Default()
	stale.Appearance.Theme = "dark"
	if err := NewService(path).SaveSettings(stale); err != nil {
		t.Fatal(err)
	}
	got, _ := Load(path)
	if got.LastActiveContext != "demo" {
		t.Fatalf("clobbered: %q", got.LastActiveContext)
	}
	if got.Appearance.Theme != "dark" {
		t.Fatal("user sections not saved")
	}
}
