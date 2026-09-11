//go:build !windows

package logging

import "os"

// openLogFile opens (creating if needed) the log file for appended writes.
func openLogFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
}
