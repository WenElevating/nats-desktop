//go:build windows

package logging

import (
	"fmt"
	"io"
	"os"

	"golang.org/x/sys/windows"
)

// openLogFile opens (creating if needed) the log file for appended writes.
// FILE_SHARE_DELETE is included so the file can be renamed or deleted by
// rotation or cleanup tools while our handle stays open; the pointer is
// seeked to the end to get append semantics.
func openLogFile(path string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, fmt.Errorf("log path: %w", err)
	}
	h, err := windows.CreateFile(
		p,
		windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_ALWAYS,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return nil, fmt.Errorf("open log file: %w", err)
	}
	f := os.NewFile(uintptr(h), path)
	if f == nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("open log file: invalid handle")
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		f.Close()
		return nil, fmt.Errorf("seek log file: %w", err)
	}
	return f, nil
}
