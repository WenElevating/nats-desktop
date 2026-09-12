package jsadmin

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/nats-io/jsm.go"
	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/WenElevating/nats-desktop/desktop/internal/jsctx"
	"github.com/WenElevating/nats-desktop/desktop/internal/settings"
)

// timeout reads the request timeout from settings on every call (spec §7.1.2:
// behavior changes apply without restart); falls back to the 5s default when
// the file is missing, corrupt, or the value is non-positive.
func (s *JetAdminService) timeout() time.Duration {
	st, err := settings.Load(s.settingsPath)
	if err != nil || st.Behavior.RequestTimeoutSeconds <= 0 {
		return 5 * time.Second
	}
	return time.Duration(st.Behavior.RequestTimeoutSeconds) * time.Second
}

// handles builds the jsm manager handle for the active connection, honouring
// the context's domain/API prefix. The jetstream handle is only needed by the
// browser/preview paths, which construct it on demand via jsctx.New; callers
// here ignore the second return.
func (s *JetAdminService) handles() (mgr *jsm.Manager, js jetstream.JetStream, res CallResult) {
	nc := s.mgr.Conn()
	if nc == nil {
		return nil, nil, fail(CodeNotConnected, "not connected")
	}
	domain, prefix, ok := s.mgr.JSParams()
	if !ok {
		return nil, nil, fail(CodeNotConnected, "not connected")
	}
	mgr, err := jsctx.NewManager(nc, domain, prefix, s.timeout())
	if err != nil {
		return nil, nil, fail(CodeServer, err.Error())
	}
	return mgr, nil, CallResult{}
}

// isNoResponders / isTimeout distinguish the JS-layer unavailability causes
// for the list guidance panel. errors.Is — never string matching (M2 遗留
// §6-9 记录的坏味道不沿用).
func isNoResponders(err error) bool { return errors.Is(err, nats.ErrNoResponders) }
func isTimeout(err error) bool      { return errors.Is(err, context.DeadlineExceeded) }

func (s *JetAdminService) ListStreams() ListStreamsResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		// UnavailableReason 仅描述 JS 层不可用成因（no_responders/timeout/server）；
		// not_connected 不属于指引面板语义（前端按连接状态整体 gate），置空。
		reason := ""
		if res.ErrorCode == CodeJSUnavailable {
			reason = ReasonNoResponders
		}
		return ListStreamsResult{CallResult: res, UnavailableReason: reason}
	}
	streams, _, _, err := mgr.Streams(nil)
	if err != nil {
		reason := ReasonServer
		if isNoResponders(err) {
			reason = ReasonNoResponders
		} else if isTimeout(err) {
			reason = ReasonTimeout
		}
		return ListStreamsResult{CallResult: ClassifyError(err), UnavailableReason: reason}
	}
	out := make([]StreamSummary, 0, len(streams))
	for _, st := range streams {
		info, err := st.LatestInformation()
		if err != nil {
			continue // 单流信息失败不拖垮整表（natscli missing 语义）
		}
		out = append(out, BuildStreamSummary(info.Config.Name, info.Config, info.State, info.Cluster))
	}
	return ListStreamsResult{Streams: out}
}

func (s *JetAdminService) GetStreamDetail(name string) StreamDetail {
	mgr, _, res := s.handles()
	if !res.Ok() {
		return StreamDetail{CallResult: res}
	}
	st, err := mgr.LoadStream(name)
	if err != nil {
		return StreamDetail{CallResult: ClassifyError(err)}
	}
	info, err := st.LatestInformation()
	if err != nil {
		return StreamDetail{CallResult: ClassifyError(err)}
	}
	return BuildStreamDetail(*info)
}

func (s *JetAdminService) CreateStream(form StreamForm) CallResult {
	if err := ValidateStreamForm(&form); err != nil {
		return fail(CodeValidation, err.Error())
	}
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	_, err := mgr.NewStreamFromDefault(form.Name, StreamFormToConfig(&form))
	if err != nil {
		return ClassifyError(err)
	}
	s.log.Info("stream created", "stream", form.Name)
	return CallResult{}
}

func (s *JetAdminService) UpdateStream(form StreamForm) CallResult {
	if err := ValidateStreamForm(&form); err != nil {
		return fail(CodeValidation, err.Error())
	}
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	st, err := mgr.LoadStream(form.Name)
	if err != nil {
		return ClassifyError(err)
	}
	cur := st.Configuration() // 本版 jsm.Configuration() 无错误返回：LoadStream 已装载最新配置
	merged := MergeStreamUpdate(cur, &form)
	if err := st.UpdateConfiguration(merged); err != nil {
		return ClassifyError(err) // 400 → validation（服务器原文，表单内联）
	}
	s.log.Info("stream updated", "stream", form.Name)
	return CallResult{}
}

func (s *JetAdminService) CopyStream(src, newName string) CallResult {
	if strings.TrimSpace(newName) == "" {
		return fail(CodeValidation, "new name is required")
	}
	if err := ValidateStreamForm(&StreamForm{Name: newName, Storage: "file", Retention: "limits", Subjects: []string{"placeholder"}}); err != nil {
		return fail(CodeValidation, err.Error())
	}
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	st, err := mgr.LoadStream(src)
	if err != nil {
		return ClassifyError(err)
	}
	cfg := st.Configuration()
	cfg.Name = newName // Created 等时间戳字段由服务器在创建时设置（api.StreamConfig 无此字段，无需清理）
	// 服务器无条件拒绝与现有流 subjects 重叠的新流（10065），因此带 subjects
	// 的源流按原配置直接复制必然失败——改为镜像拷贝：subjects/Sources 清空、
	// Mirror 指向源流，配置（存储/保留/限额）与数据随镜像复制。副本镜像依赖
	// 源流存续：删除源流后镜像停止跟踪，但已复制的数据仍保留。镜像/来源型
	// 源流本身不声明 subjects，无重叠问题，按原配置直接复制。
	if len(cfg.Subjects) > 0 {
		cfg.Mirror = &api.StreamSource{Name: src}
		cfg.Subjects = nil
		cfg.Sources = nil
	}
	if _, err := mgr.NewStreamFromDefault(newName, cfg); err != nil {
		return ClassifyError(err)
	}
	s.log.Info("stream copied", "stream", src, "new", newName)
	return CallResult{}
}

func (s *JetAdminService) DeleteStream(name string) CallResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	if err := mgr.DeleteStream(name); err != nil {
		return ClassifyError(err) // 404 → not_found（前端刷新列表）
	}
	s.log.Info("stream deleted", "stream", name)
	return CallResult{}
}

func (s *JetAdminService) PurgeStream(name string, keep, upToSeq uint64, subject string) PurgeResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		return PurgeResult{CallResult: res}
	}
	st, err := mgr.LoadStream(name)
	if err != nil {
		return PurgeResult{CallResult: ClassifyError(err)}
	}
	req := &api.JSApiStreamPurgeRequest{Keep: keep, Sequence: upToSeq, Subject: subject}
	resp, err := st.PurgeExt(req)
	if err != nil {
		return PurgeResult{CallResult: ClassifyError(err)}
	}
	s.log.Info("stream purged", "stream", name, "purged", resp.Purged)
	return PurgeResult{Purged: resp.Purged}
}

func (s *JetAdminService) SealStream(name string) CallResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	st, err := mgr.LoadStream(name)
	if err != nil {
		return ClassifyError(err)
	}
	if err := st.Seal(); err != nil {
		return ClassifyError(err)
	}
	s.log.Info("stream sealed", "stream", name)
	return CallResult{}
}
