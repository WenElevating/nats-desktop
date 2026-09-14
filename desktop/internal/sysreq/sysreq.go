// Package sysreq is a race-free adaptation of jsm.go serverdata.DoReqAsync
// (M6 CI -race first-run finding): the upstream trailing
// `log.Debugf("=== Received %d responses", ctr)` reads the handler-written
// counter without the handler mutex, which the race detector flags on every
// $SYS request with in-flight late responses. The logic here is copied
// 1:1 from serverdata (Apache-2.0, jsm.go@v0.4.2-0.20260907110945) minus
// that unguarded read; snappy decompression, the 503→no-responders mapping,
// adaptive waitFor==0 finisher and the snappy opt-out subjects behave
// identically. Swap back to serverdata once upstream fixes the race.
package sysreq

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/s2"
	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/nats.go"
)

// DoReq mirrors serverdata.DoReq: publishes req on subj, collects responses
// into a slice. waitFor > 0 stops after that many responses; waitFor == 0 is
// adaptive — the first response may take up to timeout, then a 300ms
// quiescence window closes the call.
func DoReq(ctx context.Context, req any, subj string, waitFor int, nc *nats.Conn, timeout time.Duration, log api.Logger) ([][]byte, error) {
	res := [][]byte{}
	var mu sync.Mutex
	err := DoReqAsync(ctx, req, subj, waitFor, nc, timeout, log, func(r []byte) {
		mu.Lock()
		res = append(res, r)
		mu.Unlock()
	})
	return res, err
}

// DoReqAsync mirrors serverdata.DoReqAsync with the callback collecting
// responses. See the package comment for the one behavioral difference
// (no unguarded counter read at return).
func DoReqAsync(ctx context.Context, req any, subj string, waitFor int, nc *nats.Conn, timeout time.Duration, log api.Logger, cb func([]byte)) error {
	if log == nil {
		// DoReqAsync unconditionally calls log.Debugf; nil panics upstream
		// and would here too.
		log = api.NewDiscardLogger()
	}
	jreq := []byte("{}")
	var err error
	if req != nil {
		switch val := req.(type) {
		case string:
			jreq = []byte(val)
		default:
			jreq, err = json.Marshal(req)
			if err != nil {
				return err
			}
		}
	}

	var (
		ctr      = 0
		mu       sync.Mutex
		finisher *time.Timer
	)

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if waitFor == 0 {
		finisher = time.NewTimer(timeout)
		go func() {
			select {
			case <-finisher.C:
				cancel()
			case <-ctx.Done():
				return
			}
		}()
	}

	errs := make(chan error, 1)
	sub, err := nc.Subscribe(nc.NewRespInbox(), func(m *nats.Msg) {
		mu.Lock()
		defer mu.Unlock()

		data := m.Data
		if m.Header.Get("Content-Encoding") == "snappy" {
			ud, err := io.ReadAll(s2.NewReader(bytes.NewBuffer(data)))
			if err != nil {
				errs <- err
				return
			}
			data = ud
		}

		if finisher != nil {
			finisher.Reset(300 * time.Millisecond)
		}

		if m.Header.Get("Status") == "503" {
			errs <- nats.ErrNoResponders
			return
		}

		cb(data)
		ctr++

		if waitFor > 0 && ctr == waitFor {
			cancel()
		}
	})
	if err != nil {
		return err
	}
	defer sub.Unsubscribe()

	if waitFor > 0 {
		sub.AutoUnsubscribe(waitFor)
	}

	msg := nats.NewMsg(subj)
	msg.Data = jreq
	if subj != "$SYS.REQ.SERVER.PING" && !strings.HasPrefix(subj, "$SYS.REQ.ACCOUNT") {
		msg.Header.Set("Accept-Encoding", "snappy")
	}
	msg.Reply = sub.Subject

	if err := nc.PublishMsg(msg); err != nil {
		return err
	}

	select {
	case err = <-errs:
		if err == nats.ErrNoResponders && strings.HasPrefix(subj, "$SYS") {
			return fmt.Errorf("server request failed, ensure the account used has system privileges and appropriate permissions")
		}
		return err
	case <-ctx.Done():
	}

	// The upstream races here (reads ctr without mu for a debug log); we read
	// it under the same mutex the handler holds. The discard logger makes the
	// line a no-op in practice, but the read itself is what -race flags.
	mu.Lock()
	received := ctr
	mu.Unlock()
	log.Debugf("=== Received %d responses", received)

	return nil
}
