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
	if _, err := os.Stat(filepath.Join(dir)); err != nil {
		t.Fatalf("dir not created: %v", err)
	}
}
