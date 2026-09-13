package monitor

import (
	"errors"
	"fmt"
	"regexp"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/nats.go"
)

// ClassifyMonitorError maps monitor request failures onto the closed
// error_code set. The monitoring surface has no JS-only semantics, so the
// api.ApiError branch and every generic failure fold into CodeServer with
// the server 原文 preserved — timeouts included (no separate timeout code;
// global M5 constraint). Plain nats.ErrNoResponders (errors.Is — it is a
// sentinel) also lands on CodeServer with err text; callers decide
// SysAvailable separately, so "system privileges" is NOT string-matched
// here.
func ClassifyMonitorError(err error) CallResult {
	switch {
	case err == nil:
		return CallResult{}
	case errors.Is(err, nats.ErrNoResponders):
		return fail(CodeServer, err.Error())
	}
	var ae api.ApiError
	if errors.As(err, &ae) {
		return fail(CodeServer, ae.Description)
	}
	return fail(CodeServer, err.Error())
}

// connQuerySortWhitelist is the nats-server SortOpt subset accepted by
// ListServerConnections (Global 11); empty sort means the server default
// (cid). offset >= 0, limit 1..1024 (nats-server DefaultConnListSize).
var connQuerySortWhitelist = map[string]bool{
	"cid":        true,
	"subs":       true,
	"pending":    true,
	"msgs_to":    true,
	"msgs_from":  true,
	"bytes_to":   true,
	"bytes_from": true,
	"last":       true,
	"idle":       true,
	"uptime":     true,
	"rtt":        true,
}

// ValidateConnQuery validates the connection-list sort/offset/limit inputs;
// an empty sort string is valid (server default cid).
func ValidateConnQuery(sort string, offset, limit int) error {
	if sort != "" && !connQuerySortWhitelist[sort] {
		return fmt.Errorf("invalid sort %q: must be one of cid/subs/pending/msgs_to/msgs_from/bytes_to/bytes_from/last/idle/uptime/rtt", sort)
	}
	if offset < 0 {
		return errors.New("offset must be >= 0")
	}
	if limit < 1 || limit > 1024 {
		return errors.New("limit must be between 1 and 1024")
	}
	return nil
}

// CompileEventRegex compiles the optional subject-matching regex for system
// event watches. An empty pattern means "no filtering" and yields (nil, nil).
func CompileEventRegex(pattern string) (*regexp.Regexp, error) {
	if pattern == "" {
		return nil, nil
	}
	return regexp.Compile(pattern)
}

// EventSubjects maps the closed event-type filter set (Global 10) onto
// subscribe subjects, deduplicating while preserving order. Unknown types
// fail closed. The JS event prefix is derived in three explicit levels
// (I3): an explicit eventPrefix (the active context's jetstream_event_prefix
// field) wins; else "$JS."+domain+".EVENT" for domain-scoped deployments;
// else "" — jsm.EventSubject then keeps the default $JS.EVENT prefix. The
// prefix must be passed through jsm.EventSubject (which replaces the
// subject's $JS.EVENT prefix); passing a bare domain would produce subjects
// like "A.ADVISORY". $SYS.* types are fixed regardless of prefix/domain.
func EventSubjects(types []string, eventPrefix, domain string) ([]string, error) {
	p := eventPrefix
	if p == "" && domain != "" {
		p = "$JS." + domain + ".EVENT"
	}
	seen := make(map[string]bool, len(types))
	out := make([]string, 0, len(types))
	for _, t := range types {
		var subj string
		switch t {
		case "account_connect":
			subj = "$SYS.ACCOUNT.*.CONNECT"
		case "account_disconnect":
			subj = "$SYS.ACCOUNT.*.DISCONNECT"
		case "auth_error":
			subj = "$SYS.SERVER.*.CLIENT.AUTH.ERR"
		case "js_advisory":
			subj = jsm.EventSubject(api.JSAdvisoryPrefix, p) + ".>"
		case "js_metric":
			subj = jsm.EventSubject(api.JSMetricPrefix, p) + ".>"
		default:
			return nil, fmt.Errorf("unknown event type %q", t)
		}
		if seen[subj] {
			continue
		}
		seen[subj] = true
		out = append(out, subj)
	}
	return out, nil
}
