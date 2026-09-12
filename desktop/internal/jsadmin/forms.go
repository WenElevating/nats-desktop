package jsadmin

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/textproto"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// ClassifyError maps jsm (api.ApiError) AND nats.go jetstream (JetStreamError)
// failures onto the closed error_code set. Two branches are required: the
// browser/preview paths go through jetstream and never produce api.ApiError.
func ClassifyError(err error) CallResult {
	switch {
	case err == nil:
		return CallResult{}
	case errors.Is(err, nats.ErrNoResponders):
		return fail(CodeJSUnavailable, "JetStream API unreachable: "+err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		return fail(CodeServer, "request timed out")
	case errors.Is(err, jetstream.ErrNotPullConsumer):
		// Client-side jetstream sentinel: APIError() is nil (no server round
		// trip), but semantically this is a request/validation failure.
		return fail(CodeValidation, err.Error())
	}
	var jse jetstream.JetStreamError
	if errors.As(err, &jse) {
		if ae := jse.APIError(); ae != nil {
			switch {
			case ae.Code == 404:
				return fail(CodeNotFound, err.Error())
			case ae.Code >= 400 && ae.Code < 500:
				return fail(CodeValidation, err.Error())
			case ae.Code == 503:
				return fail(CodeJSUnavailable, err.Error())
			}
		}
		return fail(CodeServer, err.Error())
	}
	var ae api.ApiError
	if errors.As(err, &ae) {
		switch {
		case ae.NotFoundError():
			return fail(CodeNotFound, ae.Error())
		case ae.Code == 400, ae.UserError():
			return fail(CodeValidation, ae.Error())
		case ae.ErrCode == 10012:
			// JSConsumerCreateErrF「consumer creation failed: {err}」：服务器把
			// 消费者创建/更新的配置类拒绝（含不可变字段检查"deliver policy can
			// not be updated"等）统一包进这个 HTTP 500 信封（errors.json code:
			// 500, err_code: 10012）。语义上是表单级拒绝（前端表单内联显示），
			// 故按 validation 分类并保留服务器原文。极少数真正的服务端故障
			// （存储写入失败等）也会走此信封——原文照透，可接受偏差。
			return fail(CodeValidation, ae.Error())
		default:
			return fail(CodeServer, ae.Error())
		}
	}
	return fail(CodeServer, err.Error())
}

var validStreamName = func(r rune) bool {
	return r == '_' || r == '-' || r == '.' || r == '>' || r == '*' || unicode.IsLetter(r) || unicode.IsDigit(r)
}

func ValidateStreamForm(f *StreamForm) error {
	if strings.TrimSpace(f.Name) == "" {
		return errors.New("name is required")
	}
	if strings.ContainsFunc(f.Name, func(r rune) bool { return r == ' ' || !validStreamName(r) }) {
		return errors.New("stream name contains illegal characters")
	}
	if f.Mirror == nil && len(f.Subjects) == 0 {
		return errors.New("at least one subject is required unless mirroring")
	}
	for _, s := range f.Subjects {
		if strings.TrimSpace(s) == "" {
			return errors.New("subjects must not be empty strings")
		}
	}
	switch f.Storage {
	case "file", "memory":
	default:
		return fmt.Errorf("storage must be file or memory, got %q", f.Storage)
	}
	switch f.Retention {
	case "limits", "interest", "workqueue":
	default:
		return fmt.Errorf("retention must be limits/interest/workqueue, got %q", f.Retention)
	}
	for _, v := range []int64{f.MaxMsgs, f.MaxBytes, f.MaxMsgsPerSubject} {
		if v < -1 {
			return errors.New("limits must be >= -1 (-1 means unlimited)")
		}
	}
	if f.MaxAgeSeconds < 0 {
		return errors.New("max age must be >= 0 seconds")
	}
	if f.Replicas == 0 {
		f.Replicas = 1
	}
	if f.Replicas < 1 || f.Replicas > 5 {
		return errors.New("replicas must be between 1 and 5")
	}
	if f.Mirror != nil && strings.TrimSpace(f.Mirror.Name) == "" {
		return errors.New("mirror source name is required")
	}
	for _, s := range f.Sources {
		if strings.TrimSpace(s.Name) == "" {
			return errors.New("source name is required")
		}
	}
	return nil
}

func storageToAPI(s string) api.StorageType {
	if s == "memory" {
		return api.MemoryStorage
	}
	return api.FileStorage
}
func storageFromAPI(s api.StorageType) string {
	if s == api.MemoryStorage {
		return "memory"
	}
	return "file"
}
func retentionToAPI(r string) api.RetentionPolicy {
	switch r {
	case "interest":
		return api.InterestPolicy
	case "workqueue":
		return api.WorkQueuePolicy
	default:
		return api.LimitsPolicy
	}
}
func retentionFromAPI(r api.RetentionPolicy) string {
	switch r {
	case api.InterestPolicy:
		return "interest"
	case api.WorkQueuePolicy:
		return "workqueue"
	default:
		return "limits"
	}
}

func sourceFormsToAPI(in []StreamSourceForm) []*api.StreamSource {
	if len(in) == 0 {
		return nil
	}
	out := make([]*api.StreamSource, len(in))
	for i, s := range in {
		out[i] = &api.StreamSource{Name: s.Name, FilterSubject: s.FilterSubject, OptStartSeq: s.OptStartSeq}
	}
	return out
}

func StreamFormToConfig(f *StreamForm) api.StreamConfig {
	replicas := f.Replicas
	if replicas == 0 {
		replicas = 1
	}
	cfg := api.StreamConfig{
		Name:        f.Name,
		Description: f.Description,
		Subjects:    f.Subjects,
		Storage:     storageToAPI(f.Storage),
		Retention:   retentionToAPI(f.Retention),
		MaxMsgs:     f.MaxMsgs,
		MaxBytes:    f.MaxBytes,
		MaxAge:      time.Duration(f.MaxAgeSeconds) * time.Second,
		MaxMsgsPer:  f.MaxMsgsPerSubject,
		Replicas:    replicas,
	}
	if f.PlacementCluster != "" || len(f.PlacementTags) > 0 {
		cfg.Placement = &api.Placement{Cluster: f.PlacementCluster, Tags: f.PlacementTags}
	}
	if f.Mirror != nil {
		cfg.Mirror = &api.StreamSource{Name: f.Mirror.Name, FilterSubject: f.Mirror.FilterSubject, OptStartSeq: f.Mirror.OptStartSeq}
	}
	cfg.Sources = sourceFormsToAPI(f.Sources)
	return cfg
}

// MergeStreamUpdate overlays editable form fields onto the live config;
// server-managed fields (MaxConsumers, Duplicates, Metadata, Sealed,
// api_level-gated flags) survive untouched. Sealing happens
// only via the dedicated SealStream op.
func MergeStreamUpdate(existing api.StreamConfig, f *StreamForm) api.StreamConfig {
	cfg := existing
	cfg.Description = f.Description
	cfg.Subjects = f.Subjects
	cfg.Storage = storageToAPI(f.Storage)
	cfg.Retention = retentionToAPI(f.Retention)
	cfg.MaxMsgs = f.MaxMsgs
	cfg.MaxBytes = f.MaxBytes
	cfg.MaxAge = time.Duration(f.MaxAgeSeconds) * time.Second
	cfg.MaxMsgsPer = f.MaxMsgsPerSubject
	if f.Replicas > 0 {
		cfg.Replicas = f.Replicas
	}
	if f.PlacementCluster != "" || len(f.PlacementTags) > 0 {
		cfg.Placement = &api.Placement{Cluster: f.PlacementCluster, Tags: f.PlacementTags}
	} else {
		cfg.Placement = nil
	}
	if f.Mirror != nil {
		cfg.Mirror = &api.StreamSource{Name: f.Mirror.Name, FilterSubject: f.Mirror.FilterSubject, OptStartSeq: f.Mirror.OptStartSeq}
	} else {
		cfg.Mirror = nil
	}
	cfg.Sources = sourceFormsToAPI(f.Sources)
	return cfg
}

func configToForm(cfg api.StreamConfig) StreamForm {
	f := StreamForm{
		Name:              cfg.Name,
		Description:       cfg.Description,
		Subjects:          cfg.Subjects,
		Storage:           storageFromAPI(cfg.Storage),
		Retention:         retentionFromAPI(cfg.Retention),
		MaxMsgs:           cfg.MaxMsgs,
		MaxBytes:          cfg.MaxBytes,
		MaxAgeSeconds:     int64(cfg.MaxAge / time.Second),
		MaxMsgsPerSubject: cfg.MaxMsgsPer,
		Replicas:          cfg.Replicas,
	}
	if cfg.Placement != nil {
		f.PlacementCluster = cfg.Placement.Cluster
		f.PlacementTags = cfg.Placement.Tags
	}
	if cfg.Mirror != nil {
		f.Mirror = &StreamSourceForm{Name: cfg.Mirror.Name, FilterSubject: cfg.Mirror.FilterSubject, OptStartSeq: cfg.Mirror.OptStartSeq}
	}
	for _, s := range cfg.Sources {
		if s != nil {
			f.Sources = append(f.Sources, StreamSourceForm{Name: s.Name, FilterSubject: s.FilterSubject, OptStartSeq: s.OptStartSeq})
		}
	}
	return f
}

// clusterHealth renders cluster health columns; natscli renderCluster counts
// the leader itself on top of the replica list.
func clusterHealth(c *api.ClusterInfo) (leaderMissing bool, unhealthy, count int) {
	if c == nil {
		return false, 0, 0
	}
	leaderMissing = c.Leader == ""
	for _, p := range c.Replicas {
		if p == nil {
			continue
		}
		count++
		if p.Offline || !p.Current {
			unhealthy++
		}
	}
	if c.Leader != "" {
		count++ // leader 自身（natscli renderCluster 同口径）
	}
	return leaderMissing, unhealthy, count
}

func clusterOut(c *api.ClusterInfo) *ClusterOut {
	if c == nil {
		return nil
	}
	out := &ClusterOut{Name: c.Name, RaftGroup: c.RaftGroup, Leader: c.Leader}
	if c.LeaderSince != nil {
		out.LeaderSinceMs = c.LeaderSince.UnixMilli()
	}
	for _, p := range c.Replicas {
		if p == nil {
			continue
		}
		// Active 为 time.Duration（纳秒）——必须除以 time.Millisecond，否则毫秒字段错 10^6
		out.Peers = append(out.Peers, PeerOut{Name: p.Name, Current: p.Current, Offline: p.Offline, ActiveMs: int64(p.Active / time.Millisecond), Lag: p.Lag})
	}
	return out
}

func BuildStreamSummary(name string, cfg api.StreamConfig, st api.StreamState, cluster *api.ClusterInfo) StreamSummary {
	s := StreamSummary{
		Name:        name,
		Description: cfg.Description,
		Subjects:    cfg.Subjects,
		Storage:     storageFromAPI(cfg.Storage),
		Retention:   retentionFromAPI(cfg.Retention),
		Messages:    st.Msgs,
		Bytes:       st.Bytes,
		Consumers:   st.Consumers,
		FirstSeq:    st.FirstSeq,
		LastSeq:     st.LastSeq,
		LastTimeMs:  st.LastTime.UnixMilli(),
		NumDeleted:  st.NumDeleted,
		IsMirror:    cfg.Mirror != nil,
		IsSource:    len(cfg.Sources) > 0,
	}
	switch {
	case strings.HasPrefix(name, "KV_"):
		s.InternalKind = "kv"
	case strings.HasPrefix(name, "O_"):
		s.InternalKind = "object"
	}
	if st.Lost != nil {
		s.LostMsgs = len(st.Lost.Msgs)
		s.LostBytes = st.Lost.Bytes
	}
	s.LeaderMissing, s.UnhealthyReplicas, s.ReplicaCount = clusterHealth(cluster)
	return s
}

func sourceInfoFromAPI(ssi *api.StreamSourceInfo) *SourceInfo {
	if ssi == nil {
		return nil
	}
	si := &SourceInfo{Name: ssi.Name, Lag: ssi.Lag, FilterSubject: ssi.FilterSubject}
	if ssi.Error != nil { // *api.ApiError → 文本
		si.Error = ssi.Error.Error()
	}
	switch {
	case ssi.Active < 0: // -1 哨兵：无活动，原样透传
		si.ActiveMs = -1
	case ssi.Active == 0:
		si.ActiveMs = 0
	default:
		si.ActiveMs = int64(ssi.Active / time.Millisecond) // Duration(ns) → ms
	}
	return si
}

func BuildStreamDetail(info api.StreamInfo) StreamDetail {
	d := StreamDetail{
		Summary:   BuildStreamSummary(info.Config.Name, info.Config, info.State, info.Cluster),
		Form:      configToForm(info.Config),
		CreatedMs: info.Created.UnixMilli(),
		State:     StreamStateOut{FirstTimeMs: info.State.FirstTime.UnixMilli(), LastTimeMs: info.State.LastTime.UnixMilli(), NumSubjects: uint64(info.State.NumSubjects)},
		Cluster:   clusterOut(info.Cluster),
	}
	if d.Summary.LastTimeMs == 0 {
		d.Summary.LastTimeMs = info.State.LastTime.UnixMilli()
	}
	if m := sourceInfoFromAPI(info.Mirror); m != nil {
		d.Mirror = m
		d.Mirror.OptStartSeq = 0
	}
	for _, ssi := range info.Sources {
		if si := sourceInfoFromAPI(ssi); si != nil {
			d.Sources = append(d.Sources, *si)
		}
	}
	return d
}

// ErrNeedsServer211 is returned when a form requests a feature gated on NATS
// Server 2.11+ (e.g. consumer priority groups). The service layer maps it to
// a validation CallResult carrying this text as guidance.
var ErrNeedsServer211 = errors.New("requires NATS Server 2.11 or newer")

var validDurableName = func(r rune) bool {
	return r != '.' && r != '*' && r != '>'
}

func ValidateConsumerForm(f *ConsumerForm, editing bool) error {
	if strings.TrimSpace(f.Stream) == "" {
		return errors.New("stream is required")
	}
	if strings.TrimSpace(f.Durable) == "" && !editing {
		return errors.New("durable name is required")
	}
	if strings.ContainsFunc(f.Durable, func(r rune) bool { return !validDurableName(r) }) {
		return errors.New("durable name must not contain '.', '*' or '>'")
	}
	if len(f.PriorityGroups) > 0 {
		return ErrNeedsServer211
	}
	switch f.DeliverMode {
	case "pull":
		// Heartbeat/flow-control style fields are not exposed on the form, so
		// pull mode cannot carry them by construction.
	case "push":
		if strings.TrimSpace(f.DeliverSubject) == "" {
			return errors.New("deliver subject is required for push consumers")
		}
	default:
		return fmt.Errorf("deliver mode must be pull or push, got %q", f.DeliverMode)
	}
	switch f.AckPolicy {
	case "explicit", "none", "all":
	default:
		return fmt.Errorf("ack policy must be explicit/none/all, got %q", f.AckPolicy)
	}
	switch f.ReplayPolicy {
	case "instant", "original":
	default:
		return fmt.Errorf("replay policy must be instant or original, got %q", f.ReplayPolicy)
	}
	switch f.DeliverPolicy {
	case "all", "last", "new":
	case "start_sequence":
		if f.OptStartSeq < 1 {
			return errors.New("opt start seq must be >= 1 for start_sequence")
		}
	case "start_time":
		if f.OptStartTimeMs <= 0 {
			return errors.New("opt start time must be > 0 for start_time")
		}
	default:
		return fmt.Errorf("deliver policy must be all/last/new/start_sequence/start_time, got %q", f.DeliverPolicy)
	}
	if f.AckWaitSeconds < 0 || f.MaxRequestExpiresSeconds < 0 {
		return errors.New("seconds fields must be >= 0")
	}
	for _, v := range []int{f.MaxDeliver, f.MaxWaiting, f.MaxAckPending, f.MaxRequestBatch} {
		if v < 0 {
			return errors.New("count limits must be >= 0")
		}
	}
	if len(f.BackoffSeconds) > 100 {
		return errors.New("at most 100 backoff steps")
	}
	for _, s := range f.BackoffSeconds {
		if s < 1 {
			return errors.New("backoff steps must be >= 1 second")
		}
	}
	if len(f.FilterSubjects) > 10 {
		return errors.New("at most 10 filter subjects")
	}
	for _, s := range f.FilterSubjects {
		if strings.TrimSpace(s) == "" {
			return errors.New("filter subjects must not be empty strings")
		}
	}
	return nil
}

func ackPolicyToAPI(s string) api.AckPolicy {
	switch s {
	case "none":
		return api.AckNone
	case "all":
		return api.AckAll
	default:
		return api.AckExplicit
	}
}
func ackPolicyFromAPI(p api.AckPolicy) string {
	switch p {
	case api.AckNone:
		return "none"
	case api.AckAll:
		return "all"
	default:
		return "explicit"
	}
}
func deliverPolicyToAPI(s string) api.DeliverPolicy {
	switch s {
	case "last":
		return api.DeliverLast
	case "new":
		return api.DeliverNew
	case "start_sequence":
		return api.DeliverByStartSequence
	case "start_time":
		return api.DeliverByStartTime
	default:
		return api.DeliverAll
	}
}
func deliverPolicyFromAPI(p api.DeliverPolicy) string {
	switch p {
	case api.DeliverLast:
		return "last"
	case api.DeliverNew:
		return "new"
	case api.DeliverByStartSequence:
		return "start_sequence"
	case api.DeliverByStartTime:
		return "start_time"
	default:
		return "all"
	}
}
func replayPolicyToAPI(s string) api.ReplayPolicy {
	if s == "original" {
		return api.ReplayOriginal
	}
	return api.ReplayInstant
}
func replayPolicyFromAPI(p api.ReplayPolicy) string {
	if p == api.ReplayOriginal {
		return "original"
	}
	return "instant"
}

func ConsumerFormToConfig(f *ConsumerForm) api.ConsumerConfig {
	cfg := api.ConsumerConfig{
		Durable:            f.Durable,
		Name:               f.Durable,
		Description:        f.Description,
		DeliverPolicy:      deliverPolicyToAPI(f.DeliverPolicy),
		AckPolicy:          ackPolicyToAPI(f.AckPolicy),
		AckWait:            time.Duration(f.AckWaitSeconds) * time.Second,
		MaxDeliver:         f.MaxDeliver,
		MaxWaiting:         f.MaxWaiting,
		MaxAckPending:      f.MaxAckPending,
		MaxRequestBatch:    f.MaxRequestBatch,
		MaxRequestExpires:  time.Duration(f.MaxRequestExpiresSeconds) * time.Second,
		MaxRequestMaxBytes: int(f.MaxRequestMaxBytes),
		ReplayPolicy:       replayPolicyToAPI(f.ReplayPolicy),
		FilterSubjects:     f.FilterSubjects,
		HeadersOnly:        f.HeadersOnly,
		Replicas:           f.Replicas,
		MemoryStorage:      f.MemoryStorage,
		InactiveThreshold:  time.Duration(f.InactiveThresholdSeconds) * time.Second,
	}
	for _, s := range f.BackoffSeconds {
		cfg.BackOff = append(cfg.BackOff, time.Duration(s)*time.Second)
	}
	if f.DeliverMode == "push" {
		cfg.DeliverSubject = f.DeliverSubject
		cfg.DeliverGroup = f.DeliverGroup
	}
	switch f.DeliverPolicy {
	case "start_sequence":
		cfg.OptStartSeq = f.OptStartSeq
	case "start_time":
		t := time.UnixMilli(f.OptStartTimeMs)
		cfg.OptStartTime = &t
	}
	if f.AckPolicy == "none" {
		// natscli 同款规避：ack_none + max_deliver 会被服务端拒绝
		cfg.MaxDeliver = -1
	}
	return cfg
}

func BuildConsumerSummary(info api.ConsumerInfo) ConsumerSummary {
	cfg := info.Config
	name := info.Name
	if name == "" {
		name = cfg.Durable
	}
	s := ConsumerSummary{
		Name:                 name,
		Stream:               info.Stream,
		IsPull:               cfg.DeliverSubject == "", // jsm Consumer.IsPullMode 同口径
		IsEphemeral:          cfg.Durable == "",
		AckPolicy:            ackPolicyFromAPI(cfg.AckPolicy),
		DeliverPolicy:        deliverPolicyFromAPI(cfg.DeliverPolicy),
		FilterSubjects:       cfg.FilterSubjects,
		NumPending:           info.NumPending,
		NumAckPending:        info.NumAckPending,
		AckFloorConsumer:     info.AckFloor.Consumer,
		NumRedelivered:       info.NumRedelivered,
		NumWaiting:           info.NumWaiting,
		DeliveredConsumerSeq: info.Delivered.Consumer,
		Paused:               info.Paused,
		PauseRemainingMs:     info.PauseRemaining.Milliseconds(),
		CreatedMs:            info.Created.UnixMilli(),
	}
	if len(s.FilterSubjects) == 0 && cfg.FilterSubject != "" {
		s.FilterSubjects = []string{cfg.FilterSubject}
	}
	s.LeaderMissing, s.UnhealthyReplicas, s.ReplicaCount = clusterHealth(info.Cluster)
	return s
}

// browserMsgBase fills the payload/timestamp fields shared by both header
// decoding branches (wire-block vs nats.Header).
func browserMsgBase(subject string, data []byte, seq uint64, ts time.Time) BrowserMsg {
	return BrowserMsg{
		Seq:         seq,
		Subject:     subject,
		PayloadB64:  base64.StdEncoding.EncodeToString(data),
		PayloadSize: len(data),
		TimestampMs: ts.UnixMilli(),
		IsUtf8:      utf8.Valid(data),
	}
}

func EncodeBrowserMsg(subject string, rawHeader, data []byte, seq uint64, ts time.Time) BrowserMsg {
	m := browserMsgBase(subject, data, seq, ts)
	if len(rawHeader) > 0 {
		if hdr, err := decodeHeaders(rawHeader); err == nil {
			m.Headers = hdr
		}
	}
	return m
}

// encodeFromHeader is the nats.Header-direct branch of EncodeBrowserMsg used
// by the jetstream browse path (Msg.Headers() already carries the parsed
// map). nats.Header IS map[string][]string, so the conversion is the identity
// cast — both decode paths feed the same BrowserMsg shape (两条路径测试同一期望).
func encodeFromHeader(subject string, h nats.Header, data []byte, seq uint64, ts time.Time) BrowserMsg {
	m := browserMsgBase(subject, data, seq, ts)
	if len(h) > 0 {
		m.Headers = map[string][]string(h)
	}
	return m
}

// decodeHeaders parses a stored NATS header block. api.StoredMsg.Header is
// the RAW wire block INCLUDING the "NATS/1.0\r\n" status preamble (server
// jetstream_api.go returns sm.hdr verbatim) — so the decoder must consume
// and validate the preamble line before MIME-reading the headers. This
// mirrors natscli internal/util.DecodeHeadersMsg. Malformed blocks yield
// nil (viewer shows payload only, mirroring M2 session behavior).
func decodeHeaders(raw []byte) (map[string][]string, error) {
	r := bufio.NewReader(bytes.NewReader(raw))
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(line, "NATS/1.0") {
		return nil, fmt.Errorf("unexpected header preamble %q", strings.TrimSpace(line))
	}
	mh, err := textproto.NewReader(r).ReadMIMEHeader()
	if err != nil {
		return nil, err
	}
	out := make(map[string][]string, len(mh))
	for k, v := range mh {
		out[k] = v
	}
	return out, nil
}
