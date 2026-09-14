package appdir

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// setUserConfigBase 驱动 os.UserConfigDir 指向 base（各 GOOS 的环境键不同），
// 返回 UserConfigDir 此时应报出的基目录。
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

func TestDirCreated(t *testing.T) {
	dir, err := Dir()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("dir not created: %v", err)
	}
}

func TestLogsDirCreated(t *testing.T) {
	base, err := Dir()
	if err != nil {
		t.Fatal(err)
	}
	logs, err := LogsDir()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(base, "logs"); logs != want {
		t.Fatalf("LogsDir() = %q, want %q", logs, want)
	}
	if _, err := os.Stat(filepath.Join(base, "logs")); err != nil {
		t.Fatalf("logs dir not created: %v", err)
	}
}

// TestDirEnvDrivenPath: 环境驱动的路径拼接断言（审查 F24：本包只导出
// Dir/LogsDir，路径 = <UserConfigDir>/nats-desktop）。
func TestDirEnvDrivenPath(t *testing.T) {
	base := setUserConfigBase(t, t.TempDir())
	got, err := Dir()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(base, "nats-desktop"); got != want {
		t.Fatalf("Dir() = %q, want %q", got, want)
	}
	if fi, err := os.Stat(got); err != nil || !fi.IsDir() {
		t.Fatalf("Dir() must create the directory: %v", err)
	}
}

// TestDirMissingEnvIsError: 环境缺失时的后备分支——UserConfigDir 报错，
// Dir 原样上抛且不返回半途路径。
func TestDirMissingEnvIsError(t *testing.T) {
	switch runtime.GOOS {
	case "windows":
		t.Setenv("AppData", "")
	case "darwin":
		t.Setenv("HOME", "")
	default:
		t.Setenv("XDG_CONFIG_HOME", "")
		t.Setenv("HOME", "")
	}
	if dir, err := Dir(); err == nil || dir != "" {
		t.Fatalf("Dir() with undefined config dir = (%q, %v), want error", dir, err)
	}
}

// TestDirBlockedByFileIsError: MkdirAll 失败分支——同路径已有普通文件时
// 目录创建失败，Dir 不得假装成功。
func TestDirBlockedByFileIsError(t *testing.T) {
	base := setUserConfigBase(t, t.TempDir())
	if err := os.WriteFile(filepath.Join(base, "nats-desktop"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if dir, err := Dir(); err == nil {
		t.Fatalf("Dir() blocked by regular file must error, got %q", dir)
	}
}

// TestLogsDirBlockedByFileIsError: LogsDir 自身的 MkdirAll 失败分支（错误带
// 「logs dir: 」包装）。
func TestLogsDirBlockedByFileIsError(t *testing.T) {
	base := setUserConfigBase(t, t.TempDir())
	app := filepath.Join(base, "nats-desktop")
	if err := os.MkdirAll(app, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "logs"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if dir, err := LogsDir(); err == nil {
		t.Fatalf("LogsDir() blocked by regular file must error, got %q", dir)
	}
}
