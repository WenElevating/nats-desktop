package connections

import (
	"errors"
	"testing"

	"github.com/WenElevating/nats-desktop/desktop/internal/testutil"
	"github.com/nats-io/jsm.go/natscontext"
)

func newTestService(t *testing.T) *Service {
	t.Helper()
	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	return NewService(NewStore(reg), NewManager(reg, nil, nil), nil, nil)
}

func TestServiceListSaveGetForm(t *testing.T) {
	svc := newTestService(t)

	if got := svc.ListContexts(); len(got) != 0 {
		t.Fatalf("fresh service lists %d contexts, want 0", len(got))
	}

	form := ContextForm{Name: "dev", URL: "nats://127.0.0.1:4222", User: "u", Password: "p", JSDomain: "cloud"}
	if err := svc.SaveContext(form); err != nil {
		t.Fatalf("SaveContext: %v", err)
	}

	list := svc.ListContexts()
	if len(list) != 1 || list[0].Name != "dev" || list[0].AuthType != "userpass" {
		t.Fatalf("ListContexts = %+v, want one 'dev' userpass context", list)
	}

	// GetContextForm round-trips every stored field (edit prefill).
	got, err := svc.GetContextForm("dev")
	if err != nil {
		t.Fatalf("GetContextForm: %v", err)
	}
	if got.URL != form.URL || got.User != form.User || got.Password != form.Password || got.JSDomain != form.JSDomain {
		t.Fatalf("GetContextForm = %+v, want the saved fields back", got)
	}

	if _, err := svc.GetContextForm("nope"); err == nil {
		t.Fatal("GetContextForm of unknown context should error")
	}
}

func TestServiceCopyAndDelete(t *testing.T) {
	svc := newTestService(t)
	if err := svc.SaveContext(ContextForm{Name: "a", URL: "nats://127.0.0.1:4222"}); err != nil {
		t.Fatalf("save a: %v", err)
	}
	if err := svc.CopyContext("a", "b"); err != nil {
		t.Fatalf("CopyContext: %v", err)
	}
	if len(svc.ListContexts()) != 2 {
		t.Fatalf("want 2 contexts after copy, got %d", len(svc.ListContexts()))
	}
	if err := svc.DeleteContext("b"); err != nil {
		t.Fatalf("DeleteContext: %v", err)
	}
	if len(svc.ListContexts()) != 1 {
		t.Fatalf("want 1 context after delete, got %d", len(svc.ListContexts()))
	}
}

func TestServiceConnectPersistsOnlyOnSuccess(t *testing.T) {
	url := testutil.StartJSServer(t)
	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	persisted := make(chan string, 4)
	svc := NewService(NewStore(reg), NewManager(reg, nil, nil), nil, func(name string) error {
		persisted <- name
		return errors.New("boom") // must NOT fail the Connect
	})
	t.Cleanup(func() { _ = svc.Disconnect() })

	// The context does not exist: Connect fails at load and persist must
	// not run.
	if err := svc.Connect("missing"); err == nil {
		t.Fatal("Connect to unknown context should error")
	}
	select {
	case name := <-persisted:
		t.Fatalf("persist ran for a failed connect (%q)", name)
	default:
	}

	// Success path: persist runs exactly once with the context name, and a
	// persist error does not leak into Connect's result.
	if err := svc.SaveContext(ContextForm{Name: "saved-ctx", URL: url}); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := svc.Connect("saved-ctx"); err != nil {
		t.Fatalf("Connect (persist error must not surface): %v", err)
	}
	if name := <-persisted; name != "saved-ctx" {
		t.Fatalf("persisted %q, want %q", name, "saved-ctx")
	}
	select {
	case extra := <-persisted:
		t.Fatalf("persist ran twice: %q", extra)
	default:
	}
}

func TestServiceSnapshotAndDisconnect(t *testing.T) {
	svc := newTestService(t)

	snap := svc.ConnSnapshot()
	if snap.State != StateDisconnected {
		t.Fatalf("fresh snapshot state = %q, want disconnected", snap.State)
	}
	if err := svc.Disconnect(); err != nil {
		t.Fatalf("Disconnect: %v", err)
	}
}

func TestServiceListContextsNeverNil(t *testing.T) {
	// Even a store over the default (possibly unreadable) backend must
	// yield a non-nil slice so the frontend can map over it.
	reg := NewRegistry()
	svc := NewService(NewStore(reg), NewManager(reg, nil, nil), nil, nil)
	if got := svc.ListContexts(); got == nil {
		t.Fatal("ListContexts must never return nil")
	}
}
