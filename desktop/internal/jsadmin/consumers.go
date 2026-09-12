package jsadmin

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/WenElevating/nats-desktop/desktop/internal/natsver"
)

// previewBatchMax is the closed batch upper bound (spec §6.7 拉取预览批量 1–256).
const previewBatchMax = 256

// pauseGate guards 2.11-only consumer features (PauseUntil/PriorityGroups)
// before any request leaves the client (natscli RequireAPILevel(1) 同款).
// 低于 2.11 的版本与解析失败的版本一律失败关闭（err != nil），调用方据此
// 返回 fail(CodeValidation, ErrNeedsServer211.Error())。ErrNeedsServer211
// 定义于 forms.go（Task 2）。
func pauseGate(serverVersion string) (bool, error) {
	ok, err := natsver.ServerAtLeast(serverVersion, 2, 11, 0)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, ErrNeedsServer211
	}
	return true, nil
}

// serverVersion reads the connected server's version; empty when offline
// (offline is already gated by handles(), so the gate only sees live values).
func (s *JetAdminService) serverVersion() string {
	if nc := s.mgr.Conn(); nc != nil {
		return nc.ConnectedServerVersion()
	}
	return ""
}

// listConsumersFailure classifies a list-level error the same way as
// ListStreams: unavailable_reason carries no_responders/timeout/server for
// genuine unavailability, stays empty for not_connected (前端按连接状态整体
// gate) and for not_found (确定性答案，不属于"不可用"指引面板语义).
func listConsumersFailure(err error) ListConsumersResult {
	res := ClassifyError(err)
	reason := ""
	switch {
	case res.ErrorCode == CodeJSUnavailable:
		reason = ReasonNoResponders
	case isTimeout(err):
		reason = ReasonTimeout
	case res.ErrorCode != CodeNotFound:
		reason = ReasonServer
	}
	return ListConsumersResult{CallResult: res, UnavailableReason: reason}
}

func (s *JetAdminService) ListConsumers(stream string) ListConsumersResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		reason := ""
		if res.ErrorCode == CodeJSUnavailable {
			reason = ReasonNoResponders
		}
		return ListConsumersResult{CallResult: res, UnavailableReason: reason}
	}
	st, err := mgr.LoadStream(stream)
	if err != nil {
		return listConsumersFailure(err)
	}
	out := make([]ConsumerSummary, 0)
	_, _, err = st.EachConsumer(func(c *jsm.Consumer) {
		info, ierr := c.LatestState()
		if ierr != nil {
			return // 外部删除竞态：单个消费者信息失败不拖垮列表（natscli missing 语义）
		}
		out = append(out, BuildConsumerSummary(info))
	})
	if err != nil {
		return listConsumersFailure(err)
	}
	return ListConsumersResult{Consumers: out}
}

func (s *JetAdminService) GetConsumerDetail(stream, name string) ConsumerDetail {
	mgr, _, res := s.handles()
	if !res.Ok() {
		return ConsumerDetail{CallResult: res}
	}
	c, err := mgr.LoadConsumer(stream, name)
	if err != nil {
		return ConsumerDetail{CallResult: ClassifyError(err)} // 404 → not_found（§6.7 表 1：前端刷新列表）
	}
	info, err := c.LatestState()
	if err != nil {
		return ConsumerDetail{CallResult: ClassifyError(err)}
	}
	return ConsumerDetail{
		Summary: BuildConsumerSummary(info),
		Form:    consumerConfigToForm(c.StreamName(), info.Config),
		Cluster: clusterOut(info.Cluster),
	}
}

// consumerConfigToForm rebuilds the edit form from the live consumer config.
// deliver_policy/opt_start_* 回显的即服务器现值（编辑时 UI 禁改，ConsumerForm 注）。
func consumerConfigToForm(stream string, cfg api.ConsumerConfig) ConsumerForm {
	f := ConsumerForm{
		Stream:                   stream,
		Durable:                  cfg.Durable,
		Description:              cfg.Description,
		AckPolicy:                ackPolicyFromAPI(cfg.AckPolicy),
		AckWaitSeconds:           int64(cfg.AckWait / time.Second),
		MaxDeliver:               cfg.MaxDeliver,
		MaxWaiting:               cfg.MaxWaiting,
		MaxAckPending:            cfg.MaxAckPending,
		MaxRequestBatch:          cfg.MaxRequestBatch,
		MaxRequestExpiresSeconds: int64(cfg.MaxRequestExpires / time.Second),
		MaxRequestMaxBytes:       int64(cfg.MaxRequestMaxBytes),
		ReplayPolicy:             replayPolicyFromAPI(cfg.ReplayPolicy),
		DeliverPolicy:            deliverPolicyFromAPI(cfg.DeliverPolicy),
		OptStartSeq:              cfg.OptStartSeq,
		PriorityGroups:           cfg.PriorityGroups,
		HeadersOnly:              cfg.HeadersOnly,
		Replicas:                 cfg.Replicas,
		MemoryStorage:            cfg.MemoryStorage,
		InactiveThresholdSeconds: int64(cfg.InactiveThreshold / time.Second),
		FilterSubjects:           cfg.FilterSubjects,
	}
	// MaxDeliver 回显归一：服务器把「无限制」存为 -1（explicit 消费者的默认值，
	// ack_none 由 ConsumerFormToConfig 主动写入 -1），而表单契约是 0=不设置
	//（服务器默认）且 ValidateConsumerForm 拒绝负数——-1 原样回显会让编辑
	// 往返（d.Form → UpdateConsumer）未出网即被拒，故归一为 0。
	if f.MaxDeliver < 0 {
		f.MaxDeliver = 0
	}
	if len(f.FilterSubjects) == 0 && cfg.FilterSubject != "" {
		f.FilterSubjects = []string{cfg.FilterSubject}
	}
	if cfg.DeliverSubject != "" {
		f.DeliverMode = "push"
		f.DeliverSubject = cfg.DeliverSubject
		f.DeliverGroup = cfg.DeliverGroup
	} else {
		f.DeliverMode = "pull"
	}
	if cfg.OptStartTime != nil {
		f.OptStartTimeMs = cfg.OptStartTime.UnixMilli()
	}
	for _, d := range cfg.BackOff {
		f.BackoffSeconds = append(f.BackoffSeconds, int64(d/time.Second))
	}
	return f
}

func (s *JetAdminService) CreateConsumer(form ConsumerForm) CallResult {
	if err := ValidateConsumerForm(&form, false); err != nil {
		return fail(CodeValidation, err.Error())
	}
	if len(form.PriorityGroups) > 0 {
		// 双保险门：PriorityGroups 表单在 ValidateConsumerForm 已被客户端闭集
		// 拒绝（Task 2 裁定，v1 表单不承载该特性）；此处拦在出网前——即使未来
		// 表单层放行，<2.11 服务器也无法处理（natscli RequireAPILevel(1) 同款）。
		if _, err := pauseGate(s.serverVersion()); err != nil {
			return fail(CodeValidation, ErrNeedsServer211.Error())
		}
	}
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	if _, err := mgr.NewConsumerFromDefault(form.Stream, ConsumerFormToConfig(&form)); err != nil {
		return ClassifyError(err) // 400 → validation（服务器原文，表单内联）
	}
	s.log.Info("consumer created", "stream", form.Stream, "consumer", form.Durable)
	return CallResult{}
}

func (s *JetAdminService) UpdateConsumer(form ConsumerForm) CallResult {
	if strings.TrimSpace(form.Durable) == "" {
		return fail(CodeValidation, "durable name is required")
	}
	if err := ValidateConsumerForm(&form, true); err != nil {
		return fail(CodeValidation, err.Error())
	}
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	c, err := mgr.LoadConsumer(form.Stream, form.Durable)
	if err != nil {
		return ClassifyError(err)
	}
	cur := c.Configuration()
	cfg := ConsumerFormToConfig(&form)
	// 不可编辑字段处理（编辑=重建提交，jsm/natscli 同语义）：
	//   - opt_start_*：表单不暴露（UI 禁改），一律以服务器现值回填；
	//   - filter subjects：表单未携带时回填服务器现值，防前端回显缺失意外清空；
	//   - deliver_policy：表单值原样提交——正常回显流程与服务器现值一致（不可变
	//     字段无漂移），被篡改/过期值由服务器 400 原文兜底（validation 透传，
	//     TestConsumerEditImmutableRejected 钉死该语义）。
	cfg.OptStartSeq = cur.OptStartSeq
	cfg.OptStartTime = cur.OptStartTime
	if len(form.FilterSubjects) == 0 {
		cfg.FilterSubject = cur.FilterSubject
		cfg.FilterSubjects = cur.FilterSubjects
	}
	if cfg.Replicas == 0 {
		cfg.Replicas = cur.Replicas
	}
	if _, err := mgr.NewConsumerFromDefault(form.Stream, cfg); err != nil {
		return ClassifyError(err) // 400（不可变变更/BackOff+AckWait 冲突等）→ validation 原文
	}
	s.log.Info("consumer updated", "stream", form.Stream, "consumer", form.Durable)
	return CallResult{}
}

func (s *JetAdminService) CopyConsumer(stream, name, newName string) CallResult {
	if strings.TrimSpace(name) == "" {
		return fail(CodeValidation, "consumer name is required")
	}
	if strings.TrimSpace(newName) == "" {
		return fail(CodeValidation, "new name is required")
	}
	if strings.ContainsFunc(newName, func(r rune) bool { return !validDurableName(r) }) {
		return fail(CodeValidation, "durable name must not contain '.', '*' or '>'")
	}
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	c, err := mgr.LoadConsumer(stream, name)
	if err != nil {
		return ClassifyError(err)
	}
	cfg := c.Configuration()
	cfg.Durable = newName // 同 stream 复制（签名单流）；重命名即提交
	cfg.Name = newName
	cfg.PauseUntil = time.Time{} // 副本以未暂停状态创建
	if _, err := mgr.NewConsumerFromDefault(stream, cfg); err != nil {
		return ClassifyError(err) // 重名 → 400 → validation（服务器原文）
	}
	s.log.Info("consumer copied", "stream", stream, "consumer", name, "new", newName)
	return CallResult{}
}

func (s *JetAdminService) DeleteConsumer(stream, name string) CallResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	if err := mgr.DeleteConsumer(stream, name); err != nil {
		return ClassifyError(err) // 404 → not_found（§6.7 表 1：前端刷新列表）
	}
	s.log.Info("consumer deleted", "stream", stream, "consumer", name)
	return CallResult{}
}

func (s *JetAdminService) ResetConsumer(stream, name string, toSeq uint64) CallResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	c, err := mgr.LoadConsumer(stream, name)
	if err != nil {
		return ClassifyError(err)
	}
	// toSeq=0 → 清空投递状态（从流头重新投递）。RESET 为 2.15 系 API，
	// natscli 同样不加版本门（parity）：旧服务器以错误原文透传（验收记录注明）。
	if _, err := c.ResetConsumerState(toSeq); err != nil {
		return ClassifyError(err)
	}
	s.log.Info("consumer reset", "stream", stream, "consumer", name, "seq", toSeq)
	return CallResult{}
}

func (s *JetAdminService) PauseConsumer(stream, name string, seconds int64) PauseResult {
	if seconds <= 0 {
		return PauseResult{CallResult: fail(CodeValidation, "pause duration must be a positive number of seconds")}
	}
	mgr, _, res := s.handles()
	if !res.Ok() {
		return PauseResult{CallResult: res}
	}
	// PauseUntil 为 2.11 系特性：版本门在出网前（§6.7）。
	if _, err := pauseGate(s.serverVersion()); err != nil {
		return PauseResult{CallResult: fail(CodeValidation, ErrNeedsServer211.Error())}
	}
	c, err := mgr.LoadConsumer(stream, name)
	if err != nil {
		return PauseResult{CallResult: ClassifyError(err)}
	}
	resp, err := c.Pause(time.Now().Add(time.Duration(seconds) * time.Second))
	if err != nil {
		return PauseResult{CallResult: ClassifyError(err)}
	}
	return PauseResult{Paused: resp.Paused, UntilMs: resp.PauseUntil.UnixMilli(), RemainingMs: resp.PauseRemaining.Milliseconds()}
}

func (s *JetAdminService) ResumeConsumer(stream, name string) CallResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	if _, err := pauseGate(s.serverVersion()); err != nil {
		return fail(CodeValidation, ErrNeedsServer211.Error())
	}
	c, err := mgr.LoadConsumer(stream, name)
	if err != nil {
		return ClassifyError(err)
	}
	if err := c.Resume(); err != nil {
		return ClassifyError(err)
	}
	s.log.Info("consumer resumed", "stream", stream, "consumer", name)
	return CallResult{}
}

func (s *JetAdminService) PreviewNext(stream, name string, batch int, autoAck bool) PreviewNextResult {
	if batch < 1 || batch > previewBatchMax {
		return PreviewNextResult{CallResult: fail(CodeValidation, "batch must be between 1 and 256")}
	}
	_, js, res := s.handlesWithJet()
	if !res.Ok() {
		return PreviewNextResult{CallResult: res}
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	str, err := js.Stream(ctx, stream)
	if err != nil {
		return PreviewNextResult{CallResult: ClassifyError(err)}
	}
	cons, err := str.Consumer(ctx, name)
	if err != nil {
		return PreviewNextResult{CallResult: ClassifyError(err)} // 外部删除 → 404 → not_found（§6.7 表 1）
	}
	info, err := cons.Info(ctx)
	if err != nil {
		return PreviewNextResult{CallResult: ClassifyError(err)}
	}
	if info.Paused {
		// 暂停中拉取被拒（§6.7 异常表第 2 行：前端禁用按钮并展示剩余时长）
		return PreviewNextResult{CallResult: fail(CodeValidation, "consumer is paused; resume first")}
	}
	nb, err := cons.Fetch(batch, jetstream.FetchMaxWait(s.timeout()))
	if err != nil {
		// push 消费者 → jetstream.ErrNotPullConsumer → validation「not a pull consumer」
		return PreviewNextResult{CallResult: ClassifyError(err)}
	}
	out := PreviewNextResult{Messages: []NextMsg{}} // 空批 = 消息耗尽（Ok + 空数组）
	var acks []jetstream.Msg
	for m := range nb.Messages() {
		meta, merr := m.Metadata()
		if merr != nil {
			continue
		}
		out.Messages = append(out.Messages, NextMsg{
			BrowserMsg:   encodeFromHeader(m.Subject(), m.Headers(), m.Data(), meta.Sequence.Stream, meta.Timestamp),
			NumDelivered: meta.NumDelivered,
			NumPending:   meta.NumPending,
		})
		if autoAck {
			acks = append(acks, m)
		}
	}
	if ferr := nb.Error(); ferr != nil && !errors.Is(ferr, jetstream.ErrNoMessages) {
		return PreviewNextResult{CallResult: ClassifyError(ferr)}
	}
	// autoAck：收集后统一 ack；单条失败仅记日志（元数据 only，绝不落 payload），
	// 不影响已取批次返回（§6.7 默认不 ack，除非用户显式开启）。
	for _, m := range acks {
		if aerr := m.Ack(); aerr != nil {
			s.log.Warn("preview ack failed", "stream", stream, "consumer", name)
		}
	}
	return out
}
