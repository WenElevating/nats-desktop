// Package jsctx builds JetStream management handles for the active
// connection, honouring the context's JetStream domain / API prefix
// (spec §6.6: wrong domain/prefix must surface as "unavailable", not as
// an empty resource list).
package jsctx

import (
	"time"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// New returns a jetstream handle; domain takes precedence over apiPrefix.
func New(nc *nats.Conn, domain, apiPrefix string) (jetstream.JetStream, error) {
	switch {
	case domain != "":
		return jetstream.NewWithDomain(nc, domain)
	case apiPrefix != "":
		return jetstream.NewWithAPIPrefix(nc, apiPrefix)
	default:
		return jetstream.New(nc)
	}
}

// NewManager returns a jsm manager (natscli's toolkit) with the shared
// request timeout applied to every JS API call.
func NewManager(nc *nats.Conn, domain, apiPrefix string, timeout time.Duration) (*jsm.Manager, error) {
	opts := []jsm.Option{jsm.WithTimeout(timeout)}
	switch {
	case domain != "":
		opts = append(opts, jsm.WithDomain(domain))
	case apiPrefix != "":
		opts = append(opts, jsm.WithAPIPrefix(apiPrefix))
	}
	return jsm.New(nc, opts...)
}
