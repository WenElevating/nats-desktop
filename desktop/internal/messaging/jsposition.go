// JetStream positioned replay sessions (spec §6.4, Task 5). A session created
// with a non-nil SessionSpec.JSPosition binds an ephemeral JetStream consumer
// over the stream covering its subject, positioned per the mode closed set:
//
//	all            DeliverAllPolicy                  (replay everything)
//	new            DeliverNewPolicy                  (only new messages)
//	start_sequence DeliverByStartSequencePolicy      (OptStartSeq)
//	start_time     DeliverByStartTimePolicy          (OptStartTime, RFC3339)
//
// (nil keeps the Task 4 core-subscription path.) The consumer config mirrors
// natscli makeConsumerConfig for replay positioning: ephemeral, AckNone
// (fire-and-forget display traffic), filtered to the session subject. Messages
// flow through the same ring/pusher/rate machinery as core sessions; the only
// wire difference is MsgOut.StreamSeq, filled from the stream sequence in the
// message metadata (core sessions keep 0).
//
// Reconnect semantics: the position IS the replay source of truth. Unlike
// core sessions (which nats.go re-arms itself on a same-connection
// reconnect), a JS session is always stop+re-created on every connected
// event — an ephemeral consumer does not survive a server restart behind an
// auto-reconnect, so a deterministic re-create from the SAME position spec is
// the only safe posture. Re-applying the same spec re-replays for
// all/start_* (idempotent from the position — replaying is exactly what the
// user asked for) and `new` naturally continues after the fresh consumer's
// creation. No dedup is attempted or needed. Close stops the ConsumeContext.
//
// Payload content is never logged (spec §13.3).

package messaging

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// jsOpTimeout bounds each JetStream RPC round trip (stream lookup, consumer
// creation) during subscribe/resubscribe; the caller context (CreateSession)
// caps the whole chain.
const jsOpTimeout = 10 * time.Second

// subscribeJS arms the session on nc by resolving the stream for the subject,
// creating the positioned ephemeral consumer, and starting the consume loop.
// An error (e.g. jetstream.ErrStreamNotFound mapped below) closes the session
// with the verbatim error text (spec §6.4: 服务器拒绝 → state=closed + 原文)
// and is returned to the CreateSession/resubscribe caller. parent may be nil
// (resubscribe path) and is then replaced by context.Background().
func (s *session) subscribeJS(nc *nats.Conn, parent context.Context) error {
	s.mu.Lock()
	if s.state == SessionClosed {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	if nc == nil {
		s.fail(ErrNotConnected.Error())
		return ErrNotConnected
	}
	cctx, err := s.startConsumer(nc, parent)
	if err != nil {
		s.fail(err.Error())
		return err
	}
	s.mu.Lock()
	if s.state == SessionClosed {
		// A Close raced the network setup: stop the fresh consumer so a
		// closed session never keeps one live.
		s.mu.Unlock()
		cctx.Stop()
		return nil
	}
	s.cctx, s.cctxNC = cctx, nc
	s.mu.Unlock()
	return nil
}

// startConsumer resolves the stream, creates the positioned consumer, and
// starts Consume. Returned ConsumeContext is live on success.
func (s *session) startConsumer(nc *nats.Conn, parent context.Context) (jetstream.ConsumeContext, error) {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, jsOpTimeout)
	defer cancel()

	jsctx, err := jetstream.New(nc)
	if err != nil {
		return nil, err
	}
	streamName, err := jsctx.StreamNameBySubject(ctx, s.subject)
	if err != nil {
		if errors.Is(err, jetstream.ErrStreamNotFound) {
			// Remap for §6.6-style troubleshooting (message copy is verbatim
			// in SessionState.Error); the library error stays wrapped for
			// errors.Is checks.
			return nil, fmt.Errorf("messaging: no stream found for subject %q: %w", s.subject, err)
		}
		return nil, err
	}
	stream, err := jsctx.Stream(ctx, streamName)
	if err != nil {
		return nil, err
	}
	cfg, err := consumerConfigFor(s.js, s.subject)
	if err != nil {
		return nil, err
	}
	cons, err := stream.CreateConsumer(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return cons.Consume(func(m jetstream.Msg) { s.handleJS(m) })
}

// consumerConfigFor maps a JSPosition to the jetstream.ConsumerConfig for the
// session subject (natscli makeConsumerConfig shape: ephemeral, AckNone,
// FilterSubject). start_sequence/start_time parameters are validated locally
// so a malformed position fails with a clear error instead of a cryptic
// server rejection.
func consumerConfigFor(pos *JSPosition, subject string) (jetstream.ConsumerConfig, error) {
	cfg := jetstream.ConsumerConfig{
		AckPolicy:     jetstream.AckNonePolicy,
		FilterSubject: subject,
	}
	switch pos.Mode {
	case jsModeAll:
		cfg.DeliverPolicy = jetstream.DeliverAllPolicy
	case jsModeNew:
		cfg.DeliverPolicy = jetstream.DeliverNewPolicy
	case jsModeStartSequence:
		if pos.StartSeq == 0 {
			return jetstream.ConsumerConfig{}, fmt.Errorf("messaging: js_position mode %q requires a positive start_seq", jsModeStartSequence)
		}
		cfg.DeliverPolicy = jetstream.DeliverByStartSequencePolicy
		cfg.OptStartSeq = pos.StartSeq
	case jsModeStart:
		st, err := time.Parse(time.RFC3339, strings.TrimSpace(pos.StartTime))
		if err != nil {
			return jetstream.ConsumerConfig{}, fmt.Errorf("messaging: js_position mode %q requires a valid RFC3339 start_time: %v", jsModeStart, err)
		}
		cfg.DeliverPolicy = jetstream.DeliverByStartTimePolicy
		cfg.OptStartTime = &st
	default:
		return jetstream.ConsumerConfig{}, fmt.Errorf("messaging: invalid js_position mode %q (closed set: all|new|start_sequence|start_time)", pos.Mode)
	}
	return cfg, nil
}

// handleJS is the Consume callback for positioned sessions. nats.go runs it
// serially per consume context, so emissions keep StreamSeq order. StreamSeq
// carries the stream sequence from the message metadata (a failure would
// mean a non-JS delivery — logged without payload, never expected); ring /
// pause / push handling is shared with the core path via deliver.
func (s *session) handleJS(m jetstream.Msg) {
	out := buildMsgOut(s.id, s.seq.Add(1), s.subject, m.Data(), m.Headers())
	if meta, err := m.Metadata(); err != nil {
		s.log.Warn("jetstream message metadata unavailable", "id", s.id, "subject", s.subject, "err", err)
	} else {
		out.StreamSeq = int64(meta.Sequence.Stream)
	}
	s.deliver(out)
}

// resubscribeJS re-creates the positioned consumer on a (re)connection. See
// the file header for the reconnect semantics: same-conn sessions are NOT
// skipped (the core skip relies on nats.go re-arming core subscriptions,
// which does not cover ephemeral consumers), the old consume context is
// stopped first, and the SAME position spec is re-applied.
func (s *session) resubscribeJS(nc *nats.Conn) {
	s.mu.Lock()
	if s.state == SessionClosed {
		s.mu.Unlock()
		return
	}
	old := s.cctx
	s.cctx, s.cctxNC = nil, nil
	s.mu.Unlock()
	if old != nil {
		old.Stop() // best-effort: terminate the stale consume loop before re-creating
	}
	_ = s.subscribeJS(nc, nil)
	if st := s.snapshot(); st.State == SessionClosed {
		s.throttle.fireNow() // terminal: consumer re-creation was refused
	} else {
		s.throttle.notify()
	}
}
