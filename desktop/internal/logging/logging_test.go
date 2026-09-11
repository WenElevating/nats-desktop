package logging

import (
	"context"
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
