package jsadmin

import (
	"context"
	"encoding/base64"
	"errors"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// browsePageSizeAllowed is the closed page-size set (spec §6.6): the UI only
// offers 20/50/100/200 rows per page, and the server gate mirrors it so a
// forged IPC call cannot ask for an unbounded fetch.
func browsePageSizeAllowed(n int) bool { return n == 20 || n == 50 || n == 100 || n == 200 }

// browsePayloadPreviewLimit is the per-row payload PREFIX size for messages
// that get truncated (bounds page weight: 50×2MB page → 50×64KB prefix);
// full content of oversized messages comes via GetStreamMessage (single
// message) or download (BrowserMsg.Truncated contract).
const browsePayloadPreviewLimit = 64 * 1024

// browsePayloadTruncateOver is the truncation TRIGGER (spec §6.6): only
// messages strictly over 1MB get preview+download treatment in browse rows;
// messages ≤1MB ship their full payload inline.
const browsePayloadTruncateOver = 1024 * 1024

// BrowseStream returns one stateless page of a stream's messages. Page state
// lives entirely in the request (StartSeq = first stream sequence to return,
// inclusive; NextStartSeq = last returned seq + 1), so the frontend can deep
// link / jump to any position without a server-side cursor. Pages are served
// through a throwaway ephemeral pull consumer (DeliverByStartSequence +
// AckNone) that is deleted on return; the count+1 fetch over-read only to
// compute HasMore — the extra message is never returned (no ack needed, no
// side effect).
func (s *JetAdminService) BrowseStream(req BrowserPageRequest) BrowserPageResult {
	if !browsePageSizeAllowed(req.Count) {
		return BrowserPageResult{CallResult: fail(CodeValidation, "page size must be one of 20/50/100/200")}
	}
	if req.StartSeq == 0 {
		req.StartSeq = 1 // server rejects opt_start_seq=0; 0 means "from the top"
	}
	_, js, res := s.handlesWithJet() // BrowseStream 只需 jetstream 句柄；jsm 句柄弃置
	if !res.Ok() {
		return BrowserPageResult{CallResult: res}
	}
	// jetstream 句柄无 WithTimeout 等价物——用 ctx 兜住整个分页请求（Global 3 超时语义）
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	str, err := js.Stream(ctx, req.Stream)
	if err != nil {
		return BrowserPageResult{CallResult: ClassifyError(err)}
	}
	cons, err := str.CreateConsumer(ctx, jetstream.ConsumerConfig{
		DeliverPolicy:     jetstream.DeliverByStartSequencePolicy,
		OptStartSeq:       req.StartSeq,
		AckPolicy:         jetstream.AckNonePolicy,
		InactiveThreshold: 2 * time.Minute,
		FilterSubject:     req.SubjectFilter, // "" = 不过滤（jetstream 语义）
	})
	if err != nil {
		// e.g. workqueue 流拒绝 ack_none 消费者 → 400 → validation（服务器原文）
		return BrowserPageResult{CallResult: ClassifyError(err)}
	}
	consName := ""
	if ci := cons.CachedInfo(); ci != nil {
		consName = ci.Name
	}
	defer func() {
		if consName != "" {
			_ = str.DeleteConsumer(context.Background(), consName) // 清理路径不限时
		}
	}()
	// 多取 1 条判定 has_more（FetchNoWait 立即返回现有消息）
	batch, err := cons.FetchNoWait(req.Count + 1)
	if err != nil && !errors.Is(err, jetstream.ErrNoMessages) {
		return BrowserPageResult{CallResult: ClassifyError(err)}
	}
	out := BrowserPageResult{Messages: []BrowserMsg{}}
	for m := range batch.Messages() {
		if len(out.Messages) == req.Count {
			out.HasMore = true
			break // 多出的第 count+1 条仅作边界信号，不返回（未 ack，无副作用）
		}
		meta, merr := m.Metadata()
		if merr != nil {
			continue
		}
		msg := encodeFromHeader(m.Subject(), m.Headers(), m.Data(), meta.Sequence.Stream, meta.Timestamp)
		if len(m.Data()) > browsePayloadTruncateOver { // 仅 >1MB 触发截断（§6.6）；64KB 仅为前缀上限
			msg.Truncated = true
			msg.PayloadB64 = base64.StdEncoding.EncodeToString(m.Data()[:browsePayloadPreviewLimit])
		}
		out.Messages = append(out.Messages, msg)
	}
	out.NextStartSeq = req.StartSeq
	if n := len(out.Messages); n > 0 {
		out.NextStartSeq = out.Messages[n-1].Seq + 1
	}
	return out
}

// GetStreamMessage returns one message with its FULL payload (never
// truncated — the 64KB preview cap is browse-row-only). Reads go through
// jsm's direct stream message GET, so the path works on mirror/source
// streams too and 404s on a deleted/never-existing sequence.
func (s *JetAdminService) GetStreamMessage(stream string, seq uint64) GetMsgResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		return GetMsgResult{CallResult: res}
	}
	st, err := mgr.LoadStream(stream)
	if err != nil {
		return GetMsgResult{CallResult: ClassifyError(err)}
	}
	msg, err := st.ReadMessage(seq)
	if err != nil {
		return GetMsgResult{CallResult: ClassifyError(err)}
	}
	m := EncodeBrowserMsg(msg.Subject, msg.Header, msg.Data, msg.Sequence, msg.Time)
	return GetMsgResult{Msg: &m}
}

// RemoveStreamMessage deletes one message from a stream (safe erase —
// noErase=false, data overwritten). Binds as "RemoveStreamMessage" because
// jsm.Manager already exposes a same-named method this service would
// otherwise collide with at the binding layer.
func (s *JetAdminService) RemoveStreamMessage(stream string, seq uint64) CallResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	if err := mgr.DeleteStreamMessage(stream, seq, false); err != nil {
		return ClassifyError(err)
	}
	s.log.Info("message removed", "stream", stream, "seq", seq) // 元数据 only — 日志绝不落 payload 内容
	return CallResult{}
}
