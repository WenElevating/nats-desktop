package logging

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nats-io/jsm.go/natscontext"
)

func TestRotationKeepsThreeFiles(t *testing.T) {
	dir := t.TempDir()
	log, err := New(dir, "debug")
	if err != nil {
		t.Fatal(err)
	}
	big := strings.Repeat("x", 64*1024) // 64KB 行
	for i := 0; i < 200; i++ {          // 写 ~12MB，触发 5MB 轮转
		log.Info(big)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "nats-desktop.log*"))
	if len(files) > 3 {
		t.Fatalf("expected at most 3 files, got %d", len(files))
	}
}

// TestRotationActuallyRotates 补充场景：仅断言 ≤3 无法区分「从不轮转」的实现。
func TestRotationActuallyRotates(t *testing.T) {
	dir := t.TempDir()
	log, err := New(dir, "debug")
	if err != nil {
		t.Fatal(err)
	}
	big := strings.Repeat("x", 64*1024)
	for i := 0; i < 200; i++ {
		log.Info(big)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "nats-desktop.log*"))
	if len(files) < 2 {
		t.Fatalf("expected rotation to occur (>=2 files), got %d", len(files))
	}
	st, err := os.Stat(filepath.Join(dir, logFileName))
	if err != nil {
		t.Fatal(err)
	}
	if st.Size() > maxLogBytes+int64(len(big))+1024 {
		t.Fatalf("current file exceeds rotation cap: %d bytes", st.Size())
	}
}

func TestNoCredentialsInLog(t *testing.T) {
	dir := t.TempDir()
	log, _ := New(dir, "info")
	ctx, err := natscontext.New("prod", false,
		natscontext.WithServerURL("nats://a:4222"),
		natscontext.WithUser("u"), natscontext.WithPassword("supersecret"))
	if err != nil {
		t.Fatal(err)
	}
	log.Info("context", "context", RedactContext(ctx))
	b, _ := os.ReadFile(filepath.Join(dir, "nats-desktop.log"))
	if strings.Contains(string(b), "supersecret") {
		t.Fatal("password leaked into log")
	}
	if !strings.Contains(string(b), "prod") {
		t.Fatal("non-secret field missing")
	}
}

// TestRedactURLUserInfoMalformed 回归测试：url.Parse 失败的畸形 URL 里的
// user:pass@ 也不得进入日志（解析失败时脱敏必须降级为掩盖，而非透传原文）。
func TestRedactURLUserInfoMalformed(t *testing.T) {
	cases := []struct {
		name     string
		rawURL   string
		secret   string // 不得出现的机密子串
		keepHost string // 必须保留的主机部分
	}{
		{"bad-percent-encoding", "nats://u:pa%ss@h:4222", "pa%ss", "h:4222"},
		{"bad-port", "nats://alice:s3cret@host:4x22", "s3cret", "host"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, err := natscontext.New("malf", false, natscontext.WithServerURL(tc.rawURL))
			if err != nil {
				t.Fatal(err)
			}
			var sb strings.Builder
			h := slog.NewTextHandler(&sb, nil)
			rec := slog.NewRecord(slog.Record{}.Time, slog.LevelInfo, "m", 0)
			rec.AddAttrs(slog.Attr{Key: "ctx", Value: RedactContext(ctx)})
			if err := h.Handle(context.Background(), rec); err != nil {
				t.Fatal(err)
			}
			out := sb.String()
			if strings.Contains(out, tc.secret) {
				t.Errorf("secret %q leaked via malformed URL: %q", tc.secret, out)
			}
			if !strings.Contains(out, tc.keepHost) {
				t.Errorf("host %q missing after redaction: %q", tc.keepHost, out)
			}
		})
	}
}

func TestParseLevel(t *testing.T) {
	cases := map[string]slog.Level{
		"debug": slog.LevelDebug,
		"info":  slog.LevelInfo,
		"warn":  slog.LevelWarn,
		"error": slog.LevelError,
		"":      slog.LevelInfo, // 未知/缺省回退 info
		"bogus": slog.LevelInfo,
	}
	for in, want := range cases {
		if got := ParseLevel(in); got != want {
			t.Errorf("ParseLevel(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestRedactContextHidesTokenAndSeed(t *testing.T) {
	ctx, err := natscontext.New("ci", false,
		natscontext.WithServerURL("nats://b:4222"),
		natscontext.WithToken("tok-123"),
		natscontext.WithUserSeed("SUAFK2ZO4Q"),
		natscontext.WithDescription("ci context"))
	if err != nil {
		t.Fatal(err)
	}
	v := RedactContext(ctx)
	// slog.GroupValue 渲染为文本后不得包含机密，但须保留非机密字段。
	var sb strings.Builder
	h := slog.NewTextHandler(&sb, nil)
	rec := slog.NewRecord(slog.Record{}.Time, slog.LevelInfo, "m", 0)
	rec.AddAttrs(slog.Attr{Key: "ctx", Value: v})
	_ = h.Handle(context.Background(), rec)
	out := sb.String()
	for _, secret := range []string{"tok-123", "SUAFK2ZO4Q"} {
		if strings.Contains(out, secret) {
			t.Errorf("secret %q leaked in %q", secret, out)
		}
	}
	for _, want := range []string{"ci", "ci context", "nats://b:4222"} {
		if !strings.Contains(out, want) {
			t.Errorf("non-secret %q missing in %q", want, out)
		}
	}
}

// TestRotationFailureKeepsWriting covers the rotation failure branch (M3
// §6-9): both backup slots are occupied by non-empty directories, so every
// Remove/Rename inside rotate fails and the reopen lands on the original
// file. rotate must surface a wrapped error (not panic), and the writer must
// keep accepting writes afterwards — rotation failure never takes the
// process down (spec §13.3 best-effort handling).
func TestRotationFailureKeepsWriting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, logFileName)
	w, err := newRotatingWriter(path, 64, keepFiles)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("seed")); err != nil {
		t.Fatal(err)
	}
	// 占位：.1/.2 备份位放非空目录——rotate 的 Remove/Rename 全部失败，
	// 且 .1 无法被「文件换入」，reopen 只能落在原文件上。
	for _, i := range []int{1, 2} {
		d := filepath.Join(dir, fmt.Sprintf("%s.%d", logFileName, i))
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "occupied"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// 直接调用 rotate（Write 端对轮转错误为 best-effort 丢弃）：断言错误被
	// 返回且不含 panic。
	if err := w.rotate(); err == nil {
		t.Fatal("expected rotate to report the rename failure, got nil")
	} else if !strings.Contains(err.Error(), logFileName) {
		t.Fatalf("rotate error should reference the log path: %v", err)
	}
	// 失败后 writer 仍可用：后续写入照常落盘（不丢日志、进程不崩）。
	if _, err := w.Write([]byte("after-rotate")); err != nil {
		t.Fatalf("write after rotate failure: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "after-rotate") {
		t.Fatalf("post-failure write lost: %q", b)
	}
}
