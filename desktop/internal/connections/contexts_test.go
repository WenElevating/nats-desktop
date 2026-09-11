package connections

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nats-io/jsm.go/natscontext"
)

func newTestStore(t *testing.T) (*Store, *natscontext.Registry) {
	t.Helper()

	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	return NewStore(reg), reg
}

func TestSaveThenList(t *testing.T) {
	store, _ := newTestStore(t)
	err := store.Save(context.Background(), ContextForm{
		Name: "demo", URL: "nats://demo.nats.io:4222", User: "u", Password: "p",
	})
	if err != nil {
		t.Fatal(err)
	}
	list, _ := store.List(context.Background())
	if len(list) != 1 || list[0].Name != "demo" || list[0].AuthType != "userpass" {
		t.Fatalf("unexpected list: %+v", list)
	}
}

// TestInteropRoundTrip covers spec §17.3 / AC-003: files written by the
// app must load verbatim through a CLI-equivalent Registry (same
// natscontext library, same directory, fresh instance).
func TestInteropRoundTrip(t *testing.T) {
	// The backend directory must be shared between the app-side Store and
	// the CLI-side registry; natscontext does not expose a backend root
	// accessor, so the test constructs both explicitly.
	dir := t.TempDir()
	store := NewStore(natscontext.NewRegistry(natscontext.NewFileBackendAt(dir)))

	err := store.Save(context.Background(), ContextForm{Name: "demo", URL: "nats://a:4222", Creds: "C:/x.creds"})
	if err != nil {
		t.Fatal(err)
	}

	// The CLI uses the same natscontext library and directory: a fresh
	// Registry models the CLI reading the app's file.
	fresh := natscontext.NewRegistry(natscontext.NewFileBackendAt(dir))
	got, err := fresh.Load(context.Background(), "demo")
	if err != nil {
		t.Fatalf("CLI-side load failed: %v", err)
	}
	if got.ServerURL() != "nats://a:4222" {
		t.Fatal("url mismatch")
	}
	if got.Creds() != "C:/x.creds" {
		t.Fatalf("creds mismatch: %q", got.Creds())
	}
}

func TestSaveEditSemantics(t *testing.T) {
	store, reg := newTestStore(t)
	ctx := context.Background()

	err := store.Save(ctx, ContextForm{
		Name:        "demo",
		Description: "first",
		URL:         "nats://a:4222",
		User:        "u",
		Password:    "p",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Same-name save with only some fields set: fields left empty in the
	// form must keep their stored values (edit semantics).
	err = store.Save(ctx, ContextForm{Name: "demo", URL: "nats://b:4222"})
	if err != nil {
		t.Fatal(err)
	}

	got, err := reg.Load(ctx, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if got.ServerURL() != "nats://b:4222" {
		t.Fatalf("url not updated: %q", got.ServerURL())
	}
	if got.User() != "u" || got.Password() != "p" {
		t.Fatalf("credentials not preserved: user=%q", got.User())
	}
	if got.Description() != "first" {
		t.Fatalf("description not preserved: %q", got.Description())
	}

	list, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("edit must not duplicate: %+v", list)
	}
}

func TestDelete(t *testing.T) {
	store, reg := newTestStore(t)
	ctx := context.Background()

	for _, name := range []string{"a", "b"} {
		if err := store.Save(ctx, ContextForm{Name: name, URL: "nats://a:4222"}); err != nil {
			t.Fatal(err)
		}
	}

	// Deleting the selected context must unselect first and still succeed.
	if _, err := reg.Select(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(ctx, "a"); err != nil {
		t.Fatalf("delete selected context: %v", err)
	}
	if _, err := reg.Selected(ctx); !errors.Is(err, natscontext.ErrNoneSelected) {
		t.Fatalf("selection not cleared: %v", err)
	}

	if err := store.Delete(ctx, "b"); err != nil {
		t.Fatal(err)
	}

	list, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("expected empty list after deletes: %+v", list)
	}
}

func TestValidateName(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	for _, name := range []string{"", "a/b", `a\b`, ".."} {
		err := store.Save(ctx, ContextForm{Name: name, URL: "nats://a:4222"})
		if err == nil {
			t.Fatalf("expected rejection for name %q", name)
		}
		if !errors.Is(err, natscontext.ErrInvalidName) {
			t.Fatalf("name %q: want ErrInvalidName, got %v", name, err)
		}
	}

	// Nothing may have been written by the rejected saves.
	list, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("rejected saves must not persist: %+v", list)
	}
}

func TestEnvWarnings(t *testing.T) {
	t.Setenv("NATS_URL", "x")
	t.Setenv("NATS_NKEY", "y")

	got := EnvWarnings()
	for _, want := range []string{"NATS_URL", "NATS_NKEY"} {
		found := false
		for _, v := range got {
			if v == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("EnvWarnings() = %v, want %q present", got, want)
		}
	}
}

func TestCopy(t *testing.T) {
	store, reg := newTestStore(t)
	ctx := context.Background()

	err := store.Save(ctx, ContextForm{
		Name:        "src",
		Description: "origin",
		URL:         "nats://a:4222",
		User:        "u",
		Password:    "p",
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Copy(ctx, "src", "dst"); err != nil {
		t.Fatal(err)
	}

	got, err := reg.Load(ctx, "dst")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "dst" {
		t.Fatalf("copy must save under the new name: %q", got.Name)
	}
	if got.ServerURL() != "nats://a:4222" || got.User() != "u" || got.Description() != "origin" {
		t.Fatalf("copy lost fields: %+v", got)
	}

	list, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("source must survive a copy: %+v", list)
	}

	if err := store.Copy(ctx, "missing", "x"); !errors.Is(err, natscontext.ErrNotFound) {
		t.Fatalf("copy of unknown source: want ErrNotFound, got %v", err)
	}
}

func TestValidateAccessibility(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	// Plain context: structurally valid, no file references -> valid.
	err := store.Save(ctx, ContextForm{Name: "plain", URL: "nats://a:4222", User: "u", Password: "p"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Validate(ctx, "plain"); err != nil {
		t.Fatalf("plain context should validate: %v", err)
	}

	// Context referencing missing files on disk -> error listing them.
	dir := t.TempDir()
	missingCert := filepath.Join(dir, "no-cert.pem")
	missingCA := filepath.Join(dir, "no-ca.pem")
	err = store.Save(ctx, ContextForm{
		Name:  "files",
		URL:   "nats://a:4222",
		Creds: filepath.Join(dir, "no.creds"),
		Cert:  missingCert,
		Key:   filepath.Join(dir, "no-key.pem"),
		CA:    missingCA,
	})
	if err != nil {
		t.Fatal(err)
	}

	err = store.Validate(ctx, "files")
	if err == nil {
		t.Fatal("expected accessibility error for missing files")
	}
	for _, want := range []string{missingCert, missingCA} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not mention %q", err, want)
		}
	}

	// Existing files validate cleanly.
	cert := filepath.Join(dir, "cert.pem")
	creds := filepath.Join(dir, "u.creds")
	for _, p := range []string{cert, creds} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	err = store.Save(ctx, ContextForm{Name: "ok-files", URL: "nats://a:4222", Creds: creds, Cert: cert, Key: cert})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Validate(ctx, "ok-files"); err != nil {
		t.Fatalf("existing files should validate: %v", err)
	}

	// URI-backed credentials are resolved at connect time, not by Stat.
	err = store.Save(ctx, ContextForm{Name: "uri-creds", URL: "nats://a:4222", Creds: "nsc://OP/ACC/USER"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Validate(ctx, "uri-creds"); err != nil {
		t.Fatalf("URI creds must not be Stat-ed: %v", err)
	}

	if err := store.Validate(ctx, "missing"); !errors.Is(err, natscontext.ErrNotFound) {
		t.Fatalf("unknown context: want ErrNotFound, got %v", err)
	}
}
