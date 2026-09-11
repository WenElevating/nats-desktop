package connections

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/nats-io/jsm.go/natscontext"
)

// ErrContextModified reports that a context file changed on disk after
// the caller loaded it (external edit via the nats CLI or an editor), so
// overwriting it would clobber changes the user never saw. Exported for
// tests and errors.Is; the frontend matches the sentinel sentence
// "context modified externally" in the binding error string — keep it
// byte-stable.
var ErrContextModified = errors.New("context modified externally")

// NewRegistry returns a Registry over the user's default context
// directory, configured identically to the nats CLI's registry (default
// credential resolvers plus a local active-context selector), so that
// contexts created by either side are visible to the other.
func NewRegistry() *natscontext.Registry {
	reg, _ := NewRegistryAndBackend()
	return reg
}

// NewRegistryAndBackend returns the CLI-interop Registry together with
// its file backend. The backend is not reachable through the Registry,
// but Store needs it to stat context files for external-modification
// detection (NewStoreWithBackend), so it is handed out alongside.
func NewRegistryAndBackend() (*natscontext.Registry, *natscontext.FileBackend) {
	backend := natscontext.NewDefaultFileBackend()
	reg := natscontext.NewRegistry(
		backend,
		natscontext.WithDefaultResolvers(),
		natscontext.WithLocalSelector(),
	)
	return reg, backend
}

// Store implements context CRUD over a natscontext.Registry. The zero
// value is not usable; construct with NewStore (or NewStoreWithBackend
// when external-modification detection is wanted).
type Store struct {
	reg *natscontext.Registry
	// pather stats context files by name; non-nil only when the Store was
	// built with a file backend (see NewStoreWithBackend).
	pather interface {
		Path(name string) string
	}
}

// NewStore wraps reg with the context CRUD operations. ModTime and the
// known-mtime check of Save are unavailable (they error) because reg's
// backend cannot be mapped to file paths; use NewStoreWithBackend for
// that. Save with knownModTimeMs=0 bypasses the check entirely, so this
// constructor stays valid for callers that never pass one.
func NewStore(reg *natscontext.Registry) *Store {
	return &Store{reg: reg}
}

// NewStoreWithBackend behaves like NewStore and additionally enables
// external-modification detection by stat-ing context files through the
// file backend the registry stores into. A non-file backend leaves the
// detection disabled (Save then fails closed on known>0, like NewStore).
func NewStoreWithBackend(reg *natscontext.Registry, backend *natscontext.FileBackend) *Store {
	s := NewStore(reg)
	if backend != nil {
		s.pather = backend
	}
	return s
}

// ModTime returns the context file's modification time in Unix
// milliseconds, or 0 when the context does not exist. It is the read
// half of the external-modification check: the edit dialog snapshots it
// with the form, and Save compares it against the file on disk.
func (s *Store) ModTime(ctx context.Context, name string) (int64, error) {
	if err := natscontext.ValidateName(name); err != nil {
		return 0, err
	}
	if s.pather == nil {
		return 0, fmt.Errorf("mtime probe unavailable for context %q: no file backend", name)
	}

	info, err := os.Stat(s.pather.Path(name))
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("stat context %q: %w", name, err)
	}

	return info.ModTime().UnixMilli(), nil
}

// List returns a summary of every stored context, ordered by name (the
// registry sorts directory entries).
func (s *Store) List(ctx context.Context) ([]ContextSummary, error) {
	names, err := s.reg.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list contexts: %w", err)
	}

	out := make([]ContextSummary, 0, len(names))
	for _, name := range names {
		c, err := s.reg.Load(ctx, name)
		if err != nil {
			return nil, fmt.Errorf("load context %q: %w", name, err)
		}
		out = append(out, ContextSummary{
			Name:        c.Name,
			Description: c.Description(),
			URL:         c.ServerURL(),
			AuthType:    authType(c),
			ColorScheme: c.ColorScheme(),
		})
	}

	return out, nil
}

// authType classifies a context's credential scheme in the spec's
// display order: creds -> nkey -> token -> userpass -> none.
func authType(c *natscontext.Context) string {
	switch {
	case c.Creds() != "":
		return "creds"
	case c.NKey() != "":
		return "nkey"
	case c.Token() != "":
		return "token"
	case c.User() != "":
		return "userpass"
	default:
		return "none"
	}
}

// Save stores form under form.Name. When the name already exists the
// stored context is loaded first and the form's non-empty fields are
// applied on top (edit semantics: fields left empty keep their stored
// values, matching `nats context save` behavior).
//
// knownModTimeMs guards against external modification (spec §6.2): a
// value > 0 is the ModTime snapshot taken when the edit dialog loaded
// the form, and a file whose mtime has moved since (or that vanished)
// aborts the save with an ErrContextModified error naming the context.
// 0 skips the check — used for creates and for the "keep mine" choice
// after the user has been offered the conflict resolution.
func (s *Store) Save(ctx context.Context, form ContextForm, knownModTimeMs int64) error {
	if err := natscontext.ValidateName(form.Name); err != nil {
		return err
	}
	if knownModTimeMs != 0 {
		current, err := s.ModTime(ctx, form.Name)
		if err != nil {
			return err
		}
		if current != knownModTimeMs {
			return fmt.Errorf("context %q: %w", form.Name, ErrContextModified)
		}
	}

	opts := formOptions(form)

	var (
		c   *natscontext.Context
		err error
	)
	if s.reg.Known(ctx, form.Name) {
		// Edit path: load through OUR registry so temp-dir and custom
		// backends work. natscontext.New(name, true, ...) would load via
		// the package-default registry (~/.config/nats) instead, which
		// is only correct when this Store already uses the default
		// backend. Registry.Load applies opts on top of the stored
		// payload — the same code path New(name, true, opts...) takes.
		c, err = s.reg.Load(ctx, form.Name, opts...)
	} else {
		c, err = natscontext.New(form.Name, false, opts...)
	}
	if err != nil {
		return err
	}

	return s.reg.Save(ctx, c, form.Name)
}

// formOptions translates the form into natscontext options, skipping
// empty fields so they never override loaded values.
func formOptions(f ContextForm) []natscontext.Option {
	var opts []natscontext.Option
	set := func(v string, o func(string) natscontext.Option) {
		if v != "" {
			opts = append(opts, o(v))
		}
	}

	set(f.URL, natscontext.WithServerURL)
	set(f.User, natscontext.WithUser)
	set(f.Password, natscontext.WithPassword)
	set(f.Token, natscontext.WithToken)
	set(f.Creds, natscontext.WithCreds)
	set(f.Nkey, natscontext.WithNKey)
	set(f.Cert, natscontext.WithCertificate)
	set(f.Key, natscontext.WithKey)
	set(f.CA, natscontext.WithCA)
	set(f.JSDomain, natscontext.WithJSDomain)
	set(f.JSAPIPrefix, natscontext.WithJSAPIPrefix)
	set(f.JSEventPrefix, natscontext.WithJSEventPrefix)
	set(f.InboxPrefix, natscontext.WithInboxPrefix)
	set(f.SocksProxy, natscontext.WithSocksProxy)
	set(f.ColorScheme, natscontext.WithColorScheme)
	set(f.Description, natscontext.WithDescription)

	// LIMITATION (M1): a false TLSFirst is indistinguishable from
	// "unset" — empty and false both skip the Option, so an edit cannot
	// clear a stored tls_first=true; the loaded value always wins when
	// the form leaves it false. Clearing it requires a tri-state "unset"
	// marker on ContextForm, which is out of M1 scope (Task 10's form
	// treats booleans as non-source-of-truth for exactly this reason).
	if f.TLSFirst {
		opts = append(opts, natscontext.WithTLSHandshakeFirst())
	}

	return opts
}

// Form loads the named context as a full ContextForm so an edit dialog can
// prefill every field (the edit path skips empty fields, so "unchanged" is
// the norm — the form must show what is stored). The authType is not part
// of ContextForm; callers derive it from the List summary.
func (s *Store) Form(ctx context.Context, name string) (ContextForm, error) {
	if err := natscontext.ValidateName(name); err != nil {
		return ContextForm{}, err
	}

	c, err := s.reg.Load(ctx, name)
	if err != nil {
		return ContextForm{}, err
	}

	return ContextForm{
		Name:          c.Name,
		Description:   c.Description(),
		URL:           c.ServerURL(),
		User:          c.User(),
		Password:      c.Password(),
		Token:         c.Token(),
		Creds:         c.Creds(),
		Nkey:          c.NKey(),
		Cert:          c.Certificate(),
		Key:           c.Key(),
		CA:            c.CA(),
		JSDomain:      c.JSDomain(),
		JSAPIPrefix:   c.JSAPIPrefix(),
		JSEventPrefix: c.JSEventPrefix(),
		InboxPrefix:   c.InboxPrefix(),
		SocksProxy:    c.SocksProxy(),
		ColorScheme:   c.ColorScheme(),
		TLSFirst:      c.TLSHandshakeFirst(),
	}, nil
}

// Delete removes the named context file. If it is the currently
// selected context the selection is cleared first (active-context
// bookkeeping beyond that is the Manager layer's job).
func (s *Store) Delete(ctx context.Context, name string) error {
	if err := natscontext.ValidateName(name); err != nil {
		return err
	}

	selected, err := s.reg.Selected(ctx)
	switch {
	case err == nil && selected == name:
		if _, err := s.reg.Unselect(ctx); err != nil {
			return fmt.Errorf("unselect before delete: %w", err)
		}
	case err != nil && !errors.Is(err, natscontext.ErrNoneSelected):
		return fmt.Errorf("resolve selected context: %w", err)
	}

	return s.reg.Delete(ctx, name)
}

// Copy duplicates the stored context src under a new name.
func (s *Store) Copy(ctx context.Context, src, name string) error {
	if err := natscontext.ValidateName(src); err != nil {
		return err
	}
	if err := natscontext.ValidateName(name); err != nil {
		return err
	}

	c, err := s.reg.Load(ctx, src)
	if err != nil {
		return err
	}

	// Registry.Save renames: it stamps the target name onto the context
	// before persisting, so the copy carries every field of the source.
	return s.reg.Save(ctx, c, name)
}

// Validate loads the named context, checks its structural validity, and
// verifies that every file it references (credentials, nkey, TLS
// material) is readable on disk. URI-backed references (nsc://, op://,
// env://, ...) are resolved at connect time by natscontext and are not
// checked here.
func (s *Store) Validate(ctx context.Context, name string) error {
	if err := natscontext.ValidateName(name); err != nil {
		return err
	}

	c, err := s.reg.Load(ctx, name)
	if err != nil {
		return err
	}

	if err := c.Validate(); err != nil {
		return fmt.Errorf("context %q: %w", name, err)
	}

	return checkFileRefs(c)
}

// fileRefs pairs a field label with its configured reference.
type fileRefs struct {
	field string
	ref   string
}

// checkFileRefs Stats every file-backed reference of c and reports all
// inaccessible paths in one error.
func checkFileRefs(c *natscontext.Context) error {
	refs := []fileRefs{
		{"creds", c.Creds()},
		{"nkey", c.NKey()},
		{"cert", c.Certificate()},
		{"key", c.Key()},
		{"ca", c.CA()},
	}

	var missing []string
	for _, r := range refs {
		path := filePath(r.ref)
		if path == "" {
			continue
		}
		if _, err := os.Stat(path); err != nil {
			missing = append(missing, fmt.Sprintf("%s %s", r.field, path))
		}
	}

	if len(missing) > 0 {
		return fmt.Errorf("inaccessible file(s): %s", strings.Join(missing, ", "))
	}

	return nil
}

// filePath maps a credential/TLS reference to a stat-able filesystem
// path, or "" when the reference is empty or handled by a connect-time
// credential resolver instead of the local filesystem. Scheme matching
// is case-insensitive, mirroring the library's EqualFold scheme
// parsing, and covers opaque data: URIs (which have no "//" separator).
func filePath(ref string) string {
	if ref == "" {
		return ""
	}

	lower := strings.ToLower(ref)
	switch {
	case strings.HasPrefix(lower, "file://"):
		return ref[len("file://"):]
	case strings.HasPrefix(lower, "data:"):
		return "" // inline payload; nothing on disk to check
	case strings.Contains(lower, "://"):
		return "" // nsc://, op://, env:// — resolved at connect time
	default:
		return ref
	}
}

// envWarningVars is the closed set of environment variables that
// override or shadow context-based NATS configuration.
var envWarningVars = []string{
	"NATS_URL",
	"NATS_CONTEXT",
	"NATS_USER",
	"NATS_PASSWORD",
	"NATS_CREDS",
	"NATS_NKEY",
}

// EnvWarnings returns the names of the NATS_* environment variables
// from the warning set that are currently set to a non-empty value.
// The result is never nil so it JSON-serializes as [] rather than null
// (the frontend maps over it).
func EnvWarnings() []string {
	present := make([]string, 0, len(envWarningVars))
	for _, name := range envWarningVars {
		if os.Getenv(name) != "" {
			present = append(present, name)
		}
	}

	return present
}
