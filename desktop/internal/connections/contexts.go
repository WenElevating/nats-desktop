package connections

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/nats-io/jsm.go/natscontext"
)

// NewRegistry returns a Registry over the user's default context
// directory, configured identically to the nats CLI's registry (default
// credential resolvers plus a local active-context selector), so that
// contexts created by either side are visible to the other.
func NewRegistry() *natscontext.Registry {
	return natscontext.NewRegistry(
		natscontext.NewDefaultFileBackend(),
		natscontext.WithDefaultResolvers(),
		natscontext.WithLocalSelector(),
	)
}

// Store implements context CRUD over a natscontext.Registry. The zero
// value is not usable; construct with NewStore.
type Store struct {
	reg *natscontext.Registry
}

// NewStore wraps reg with the context CRUD operations.
func NewStore(reg *natscontext.Registry) *Store {
	return &Store{reg: reg}
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
func (s *Store) Save(ctx context.Context, form ContextForm) error {
	if err := natscontext.ValidateName(form.Name); err != nil {
		return err
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
