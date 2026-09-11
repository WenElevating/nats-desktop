package connections

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/jsm.go/natscontext"
)

// conflictFixture builds a Store wired for external-modification detection
// over a temp-dir FileBackend and returns the backend so tests can reach
// the on-disk context file (os.Chtimes / os.Remove model external edits).
func conflictFixture(t *testing.T) (*Store, *natscontext.FileBackend) {
	t.Helper()

	fb := natscontext.NewFileBackendAt(t.TempDir())
	reg := natscontext.NewRegistry(fb)
	return NewStoreWithBackend(reg, fb), fb
}

// shiftMtime moves the context file's mtime into the future, the way an
// external writer (nats CLI, editor) would.
func shiftMtime(t *testing.T, path string, d time.Duration) {
	t.Helper()

	future := time.Now().Add(d)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatalf("Chtimes %s: %v", path, err)
	}
}

func TestModTime(t *testing.T) {
	store, _ := conflictFixture(t)
	ctx := context.Background()

	// Missing context: 0, no error (callers treat 0 as "check disabled").
	mt, err := store.ModTime(ctx, "ghost")
	if err != nil {
		t.Fatalf("ModTime of missing context: %v", err)
	}
	if mt != 0 {
		t.Fatalf("ModTime of missing context = %d, want 0", mt)
	}

	if err := store.Save(ctx, ContextForm{Name: "dev", URL: "nats://a:4222"}, 0); err != nil {
		t.Fatal(err)
	}
	if mt, err = store.ModTime(ctx, "dev"); err != nil {
		t.Fatal(err)
	}
	if mt <= 0 {
		t.Fatalf("ModTime after save = %d, want > 0", mt)
	}

	if _, err := store.ModTime(ctx, "bad/name"); err == nil {
		t.Fatal("ModTime of an invalid name should error")
	}
}

func TestSaveDetectsExternalModification(t *testing.T) {
	store, fb := conflictFixture(t)
	ctx := context.Background()

	if err := store.Save(ctx, ContextForm{Name: "dev", URL: "nats://a:4222"}, 0); err != nil {
		t.Fatal(err)
	}
	known, err := store.ModTime(ctx, "dev")
	if err != nil {
		t.Fatal(err)
	}

	// External writer touches the file between the edit dialog's load and
	// the user's save: a save carrying the stale known mtime must be
	// rejected with the sentinel (message names the context).
	shiftMtime(t, fb.Path("dev"), 2*time.Second)
	err = store.Save(ctx, ContextForm{Name: "dev", URL: "nats://b:4222"}, known)
	if !errors.Is(err, ErrContextModified) {
		t.Fatalf("stale save: want ErrContextModified, got %v", err)
	}
	// The frontend matches on this exact sentence via the bindings — it
	// must stay byte-stable.
	if !strings.Contains(err.Error(), "context modified externally") {
		t.Fatalf("error %q does not carry the stable sentinel string", err)
	}
	if !strings.Contains(err.Error(), "dev") {
		t.Fatalf("error %q does not name the context", err)
	}
	// The conflicting save must not have written.
	if got, _ := store.Form(ctx, "dev"); got.URL != "nats://a:4222" {
		t.Fatalf("rejected save overwrote the file: url=%q", got.URL)
	}

	// A fresh known mtime passes.
	fresh, err := store.ModTime(ctx, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save(ctx, ContextForm{Name: "dev", URL: "nats://c:4222"}, fresh); err != nil {
		t.Fatalf("save with fresh mtime: %v", err)
	}

	// known=0 skips the check entirely (back-compat + "keep mine" path):
	// it must succeed even though the file was touched after `fresh` was
	// taken... and re-taking the mtime must differ from `fresh` to prove
	// the skip is real rather than a coincidental match.
	if err := store.Save(ctx, ContextForm{Name: "dev", URL: "nats://d:4222"}, 0); err != nil {
		t.Fatalf("save with known=0 must skip the check: %v", err)
	}
	after, err := store.ModTime(ctx, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if after == fresh {
		t.Fatal("save did not rewrite the file; skip-check assertion is vacuous")
	}
}

func TestSaveKnownOnMissingFileConflicts(t *testing.T) {
	store, fb := conflictFixture(t)
	ctx := context.Background()

	if err := store.Save(ctx, ContextForm{Name: "dev", URL: "nats://a:4222"}, 0); err != nil {
		t.Fatal(err)
	}
	known, err := store.ModTime(ctx, "dev")
	if err != nil {
		t.Fatal(err)
	}

	// Deleted externally (e.g. `nats context delete`): re-creating it from
	// a stale editor session would silently resurrect data — conflict.
	if err := os.Remove(fb.Path("dev")); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(ctx, ContextForm{Name: "dev", URL: "nats://b:4222"}, known); !errors.Is(err, ErrContextModified) {
		t.Fatalf("save over an externally deleted file: want ErrContextModified, got %v", err)
	}

	// Creating a brand-new context with known=0 is unaffected (no file to
	// check; the create path never carries a known mtime).
	if err := store.Save(ctx, ContextForm{Name: "fresh", URL: "nats://a:4222"}, 0); err != nil {
		t.Fatalf("create with known=0: %v", err)
	}
}

func TestSaveWithoutBackendFailsClosed(t *testing.T) {
	// A Store built without a path-able backend cannot stat the file. It
	// must refuse a known-mtime save rather than silently skipping the
	// check the caller explicitly asked for; known=0 keeps working.
	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	store := NewStore(reg)
	ctx := context.Background()

	if err := store.Save(ctx, ContextForm{Name: "dev", URL: "nats://a:4222"}, 0); err != nil {
		t.Fatalf("known=0 save without backend: %v", err)
	}
	if err := store.Save(ctx, ContextForm{Name: "dev", URL: "nats://b:4222"}, 123); err == nil {
		t.Fatal("known>0 save without a stat-able backend must fail closed")
	}
	if _, err := store.ModTime(ctx, "dev"); err == nil {
		t.Fatal("ModTime without a stat-able backend must error")
	}
}

func TestServiceConflictPassthrough(t *testing.T) {
	fb := natscontext.NewFileBackendAt(t.TempDir())
	reg := natscontext.NewRegistry(fb)
	svc := NewService(NewStoreWithBackend(reg, fb), NewManager(reg, nil, nil), nil, nil)

	form := ContextForm{Name: "dev", URL: "nats://a:4222", User: "u"}
	if err := svc.SaveContext(form, 0); err != nil {
		t.Fatalf("SaveContext: %v", err)
	}

	// GetContextForm returns the form plus the observed mtime in one call
	// so the edit dialog can hand it back on save.
	res, err := svc.GetContextForm("dev")
	if err != nil {
		t.Fatalf("GetContextForm: %v", err)
	}
	if res.Form.URL != form.URL || res.Form.User != form.User {
		t.Fatalf("GetContextForm form = %+v, want the saved fields back", res.Form)
	}
	if res.ModTimeMs <= 0 {
		t.Fatalf("GetContextForm modTimeMs = %d, want > 0", res.ModTimeMs)
	}

	shiftMtime(t, fb.Path("dev"), 2*time.Second)
	err = svc.SaveContext(form, res.ModTimeMs)
	if !errors.Is(err, ErrContextModified) {
		t.Fatalf("stale SaveContext: want ErrContextModified, got %v", err)
	}
	if !strings.Contains(err.Error(), "context modified externally") {
		t.Fatalf("binding error string %q must contain the stable sentinel", err)
	}

	// Keep-mine (0) and a re-freshened known value both go through.
	if err := svc.SaveContext(form, 0); err != nil {
		t.Fatalf("keep-mine SaveContext: %v", err)
	}
	res2, err := svc.GetContextForm("dev")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SaveContext(form, res2.ModTimeMs); err != nil {
		t.Fatalf("fresh SaveContext: %v", err)
	}

	if _, err := svc.GetContextForm("nope"); err == nil {
		t.Fatal("GetContextForm of unknown context should error")
	}
}
