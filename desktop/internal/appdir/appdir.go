// Package appdir resolves the application's per-user data directory:
// %APPDATA%/nats-desktop on Windows (os.UserConfigDir on other platforms).
package appdir

import (
	"errors"
	"os"
	"path/filepath"
)

// Dir returns the application data directory, creating it when missing.
func Dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "nats-desktop")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// LogsDir returns the logs subdirectory, creating it when missing.
func LogsDir() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	dir = filepath.Join(dir, "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", errors.New("logs dir: " + err.Error())
	}
	return dir, nil
}
