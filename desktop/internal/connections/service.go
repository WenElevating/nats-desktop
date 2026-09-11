package connections

import (
	"context"
	"io"
	"log/slog"
)

// Service is the Wails-bound facade over the context Store (CRUD) and the
// connection Manager (lifecycle), exposing the exact method set the
// frontend bindings need (Task 10). Bound methods take no request context
// (nothing here is cancellable from the UI) and use context.Background()
// internally.
//
// persistActive is invoked after every successful Connect so main.go can
// record settings.LastActiveContext (load-modify-save); a persist failure
// is logged but does not fail the Connect.
type Service struct {
	store         *Store
	manager       *Manager
	log           *slog.Logger
	persistActive func(name string) error
}

// NewService aggregates store and manager behind the bound facade. A nil
// log discards output; a nil persistActive skips last-active persistence.
func NewService(store *Store, manager *Manager, log *slog.Logger, persistActive func(name string) error) *Service {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Service{store: store, manager: manager, log: log, persistActive: persistActive}
}

// ListContexts returns every stored context summary, ordered by name. On
// error an empty (non-nil) slice is returned and the error logged — the
// UI renders an empty list, not a crash.
func (s *Service) ListContexts() []ContextSummary {
	out, err := s.store.List(context.Background())
	if err != nil {
		s.log.Warn("list contexts", "error", err)
		return []ContextSummary{}
	}
	return out
}

// GetContextForm loads the full stored context as a form so the edit
// dialog prefills every field (Task 6 caution: edits skip empty fields,
// so the form must show stored values to keep "unchanged" the norm).
func (s *Service) GetContextForm(name string) (ContextForm, error) {
	return s.store.Form(context.Background(), name)
}

// SaveContext creates or edits the context described by form.
func (s *Service) SaveContext(form ContextForm) error {
	return s.store.Save(context.Background(), form)
}

// DeleteContext removes the named context (unselecting it first when it
// is the registry's selected context).
func (s *Service) DeleteContext(name string) error {
	return s.store.Delete(context.Background(), name)
}

// CopyContext duplicates the stored context src under name.
func (s *Service) CopyContext(src, name string) error {
	return s.store.Copy(context.Background(), src, name)
}

// CheckConnection dials a throwaway connection from form (nothing is
// persisted, the live Manager state machine is untouched) and reports
// RTT and JetStream availability.
func (s *Service) CheckConnection(form ContextForm) TestResult {
	return s.manager.CheckConnection(context.Background(), form)
}

// Connect establishes the live connection for the stored context name,
// replacing any active one; on success the name is persisted as the last
// active context (spec §6.1).
func (s *Service) Connect(name string) error {
	if err := s.manager.Connect(context.Background(), name); err != nil {
		return err
	}
	if s.persistActive != nil {
		if err := s.persistActive(name); err != nil {
			s.log.Warn("persist last active context", "name", name, "error", err)
		}
	}
	return nil
}

// Disconnect user-closes the live connection. It cannot fail.
func (s *Service) Disconnect() error {
	s.manager.Disconnect()
	return nil
}

// ConnSnapshot returns the Manager's current state (frontend hydration on
// mount, covering transitions that fired before the UI subscribed).
func (s *Service) ConnSnapshot() StateEvent {
	return s.manager.Snapshot()
}

// EnvWarnings lists the NATS_* override variables currently set.
func (s *Service) EnvWarnings() []string {
	return EnvWarnings()
}
