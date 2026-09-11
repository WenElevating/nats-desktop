// Package deps is documentation-only: it records that github.com/nats-io/jsm.go
// (imported for real by internal/connections via natscontext) and
// github.com/nats-io/nats-server/v2 (imported for real by internal/testutil)
// are direct dependencies of this module. `go mod tidy` — also run internally
// by `wails3 build` — must keep both as direct requires; do not let tooling
// or refactors downgrade them to indirect entries.
package deps
