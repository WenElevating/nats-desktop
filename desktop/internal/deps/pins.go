// Package deps holds compile-time pins so `go mod tidy` (also run by
// `wails3 build` via its Taskfile) keeps the exact NATS library versions
// required by the plan's Global Constraints (#11) until importing code
// lands in later tasks (M1 Tasks 6-8), after which this file may be reduced.
package deps

import (
	_ "github.com/nats-io/jsm.go/natscontext"
	_ "github.com/nats-io/nats-server/v2/server"
)
