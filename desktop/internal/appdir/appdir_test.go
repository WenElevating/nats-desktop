package appdir

import (
	"os"
	"path/filepath"
	"testing"
)

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
