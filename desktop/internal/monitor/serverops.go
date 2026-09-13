package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/jsm.go/serverdata"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"

	"github.com/WenElevating/nats-desktop/desktop/internal/settings"
)

// serverops.go 实现节点级绑定面（Task 5）：节点报表（varz+healthz）、连接
// 明细（connz 分页）、kick。nats-server 的定向端点按 **server ID** 订阅
// （serverDirectReqSubj = "$SYS.REQ.SERVER.%s.%s"），绑定面一律收服务器名
// （UI 展示名），Go 侧先经 resolveServerID 解析为 ID 再拼主题——用名称寻址
// 永远无响应者，且报错文案会误导为权限问题。

// timeout 从设置读取请求超时（§7.1.2 行为变更即时生效；文件缺失/损坏/值
// 非正回退默认 5s）。与 jsadmin 同 idioms；与快照的固定 2s（snapshotTimeout）
// 刻意区分——快照超时不随设置变，节点级请求随设置变。
func (s *MonitorService) timeout() time.Duration {
	st, err := settings.Load(s.settingsPath)
	if err != nil || st.Behavior.RequestTimeoutSeconds <= 0 {
		return 5 * time.Second
	}
	return time.Duration(st.Behavior.RequestTimeoutSeconds) * time.Second
}

// knownID 在 runMu 下扫跨周期已知集合，取服务器名 → ID。
func (s *MonitorService) knownID(name string) string {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	for _, row := range s.known {
		if row.Name == name {
			return row.ID
		}
	}
	return ""
}

// resolveServerID 名称→ID：优先用缓存快照的 known 行；未命中时跑一次
// statsz 广播刷新（覆盖「从未启动监控就打开节点报表」的冷启动路径）再查；
// 仍无 → not_found（而非误导性的 server/权限错误）。
func (s *MonitorService) resolveServerID(name string) (string, CallResult) {
	if id := s.knownID(name); id != "" {
		return id, CallResult{}
	}
	snap := s.collectSnapshot()
	if !snap.SysAvailable {
		return "", fail(CodeServer, snap.SysReason)
	}
	if id := s.knownID(name); id != "" {
		return id, CallResult{}
	}
	return "", fail(CodeNotFound, fmt.Sprintf("server %q not found", name))
}

// directedReq 发一次定向单应答请求（waitFor=1），超时取 s.timeout()。
// 返回原始应答字节（$SYS 应答带 ServerAPI 错误信封，由调用方按各自响应
// 类型解码）；零应答按 server 失败处理（waitFor>0 在无响应者应答 Interest
// 存在但不回包时静默等满超时，DoReq 不报错）。
func (s *MonitorService) directedReq(nc *nats.Conn, req any, subj string) ([][]byte, CallResult) {
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout())
	defer cancel()
	resps, err := serverdata.DoReq(ctx, req, subj, 1, nc, s.timeout(), api.NewDiscardLogger())
	if err != nil {
		return nil, ClassifyMonitorError(err)
	}
	if len(resps) == 0 {
		return nil, fail(CodeServer, fmt.Sprintf("no response from %s", subj))
	}
	return resps, CallResult{}
}

// apiErrOf 解码 $SYS 应答信封里的 *ApiError（无错误时返回 nil）。
func apiErrOf(raw []byte) *server.ApiError {
	var probe struct {
		Error *server.ApiError `json:"error,omitempty"`
	}
	if json.Unmarshal(raw, &probe) != nil {
		return nil
	}
	return probe.Error
}

// GetServerDetail 节点报表：定向 VARZ + HEALTHZ。varz 失败 → server 原文
// （部分主题无权限时该面板显示原文，其余面板不受影响，Global 3 的失败面）；
// healthz 失败容忍 → HealthStatus="" + HealthError 原文。
func (s *MonitorService) GetServerDetail(name string) ServerDetailResult {
	id, res := s.resolveServerID(name)
	if !res.Ok() {
		return ServerDetailResult{CallResult: res}
	}
	nc := s.mgr.Conn()
	if nc == nil || !nc.IsConnected() {
		return ServerDetailResult{CallResult: fail(CodeNotConnected, "not connected")}
	}

	// VARZ：失败即整次调用失败（原文透传，Global 4）。
	resps, res := s.directedReq(nc, server.VarzEventOptions{}, "$SYS.REQ.SERVER."+id+".VARZ")
	if !res.Ok() {
		return ServerDetailResult{CallResult: res}
	}
	if e := apiErrOf(resps[0]); e != nil {
		return ServerDetailResult{CallResult: ClassifyMonitorError(e)}
	}
	var vz server.ServerAPIVarzResponse
	if err := json.Unmarshal(resps[0], &vz); err != nil {
		return ServerDetailResult{CallResult: fail(CodeServer, err.Error())}
	}
	if vz.Data == nil || vz.Server == nil {
		return ServerDetailResult{CallResult: fail(CodeServer, "varz: empty data")}
	}
	detail := &ServerDetail{Row: varzRow(vz.Server, vz.Data)}
	detail.StartMs = vz.Data.Start.UnixMilli()
	detail.LeafNodes = vz.Data.Leafs
	detail.NumSubs = vz.Data.Subscriptions
	detail.SentMsgs = uint64(vz.Data.OutMsgs)
	detail.SentBytes = uint64(vz.Data.OutBytes)
	detail.RecvMsgs = uint64(vz.Data.InMsgs)
	detail.RecvBytes = uint64(vz.Data.InBytes)

	// HEALTHZ：失败容忍（面板显示原文，其余不受影响，Global 3）。
	resps, res = s.directedReq(nc, server.HealthzEventOptions{}, "$SYS.REQ.SERVER."+id+".HEALTHZ")
	if !res.Ok() {
		detail.HealthError = res.Error
		return ServerDetailResult{Detail: detail}
	}
	if e := apiErrOf(resps[0]); e != nil {
		detail.HealthError = ClassifyMonitorError(e).Error
		return ServerDetailResult{Detail: detail}
	}
	var hz server.ServerAPIHealthzResponse
	if err := json.Unmarshal(resps[0], &hz); err != nil {
		detail.HealthError = err.Error()
		return ServerDetailResult{Detail: detail}
	}
	if hz.Data != nil {
		detail.HealthStatus = hz.Data.Status
		detail.HealthError = hz.Data.Error
		var parts []string
		for _, he := range hz.Data.Errors {
			if he.Error != "" {
				parts = append(parts, he.Error)
			}
		}
		detail.HealthDetail = strings.Join(parts, "; ")
	}
	return ServerDetailResult{Detail: detail}
}

// varzRow 把 VARZ 应答折叠成 MonitorServerRow（与 mergeStatszJsz 同口径：
// 身份取 ServerInfo，运行时统计取 Varz）。
func varzRow(si *server.ServerInfo, vz *server.Varz) MonitorServerRow {
	now := time.Now()
	row := MonitorServerRow{
		Name:             si.Name,
		ID:               si.ID,
		Host:             si.Host,
		Cluster:          si.Cluster,
		Domain:           si.Domain,
		Version:          si.Version,
		Online:           true,
		UptimeSeconds:    int64(now.Sub(vz.Start).Seconds()),
		Cpu:              vz.CPU,
		MemBytes:         vz.Mem,
		Cores:            vz.Cores,
		Connections:      vz.Connections,
		TotalConnections: vz.TotalConnections,
		Routes:           vz.Routes,
		Gateways:         len(vz.Gateway.Gateways),
		SlowConsumers:    vz.SlowConsumers,
		JsEnabled:        si.JetStreamEnabled(),
	}
	// JS 角色映射（Global 12，与 jsRole 同语义；varz 侧元信息在 JetStream.Meta）。
	switch {
	case vz.JetStream.Config == nil:
		row.JsRole = "disabled"
	case vz.JetStream.Meta != nil:
		if vz.JetStream.Meta.Leader == si.Name {
			row.JsRole = "meta_leader"
		} else {
			row.JsRole = "voter"
		}
	}
	return row
}

// ListServerConnections 连接明细：ValidateConnQuery 先行 → resolveServerID →
// 定向 CONNZ（Username:true 才有 user 字段；Sort/Offset/Limit 服务端分页）。
// Total 取 data.Total；行映射显式字段白名单（JWT/TLS 证书/Tags 不上 wire，
// Global 9 的 wire 半边）。
func (s *MonitorService) ListServerConnections(name, sort string, offset, limit int) ConnPageResult {
	if err := ValidateConnQuery(sort, offset, limit); err != nil {
		return ConnPageResult{CallResult: fail(CodeValidation, err.Error())}
	}
	id, res := s.resolveServerID(name)
	if !res.Ok() {
		return ConnPageResult{CallResult: res}
	}
	nc := s.mgr.Conn()
	if nc == nil || !nc.IsConnected() {
		return ConnPageResult{CallResult: fail(CodeNotConnected, "not connected")}
	}

	resps, res := s.directedReq(nc, server.ConnzEventOptions{ConnzOptions: server.ConnzOptions{
		Sort:     server.SortOpt(sort),
		Username: true,
		Offset:   offset,
		Limit:    limit,
	}}, "$SYS.REQ.SERVER."+id+".CONNZ")
	if !res.Ok() {
		return ConnPageResult{CallResult: res}
	}
	if e := apiErrOf(resps[0]); e != nil {
		return ConnPageResult{CallResult: ClassifyMonitorError(e)}
	}
	var cz server.ServerAPIConnzResponse
	if err := json.Unmarshal(resps[0], &cz); err != nil {
		return ConnPageResult{CallResult: fail(CodeServer, err.Error())}
	}
	if cz.Data == nil {
		return ConnPageResult{CallResult: fail(CodeServer, "connz: empty data")}
	}
	out := ConnPageResult{
		Rows:   make([]ConnRow, 0, len(cz.Data.Conns)),
		Offset: offset,
		Limit:  limit,
		Total:  cz.Data.Total,
	}
	for _, ci := range cz.Data.Conns {
		if ci == nil {
			continue
		}
		out.Rows = append(out.Rows, connRow(ci))
	}
	return out
}

// connRow 映射 ConnInfo → ConnRow，显式字段白名单——刻意不含 JWT、
// TLSPeerCerts、Tags、Subs 等敏感/大载荷字段（§13.3 wire 半边）。
// User 对应 ConnInfo.AuthorizedUser（仅 connz opts Username:true 时非空）。
func connRow(ci *server.ConnInfo) ConnRow {
	return ConnRow{
		Cid:      ci.Cid,
		Kind:     ci.Kind,
		Ip:       ci.IP,
		Port:     ci.Port,
		Account:  ci.Account,
		User:     ci.AuthorizedUser,
		Name:     ci.Name,
		Lang:     ci.Lang,
		Version:  ci.Version,
		StartMs:  ci.Start.UnixMilli(),
		Uptime:   ci.Uptime,
		Idle:     ci.Idle,
		Rtt:      ci.RTT,
		InMsgs:   ci.InMsgs,
		OutMsgs:  ci.OutMsgs,
		InBytes:  ci.InBytes,
		OutBytes: ci.OutBytes,
		NumSubs:  ci.NumSubs,
		Pending:  ci.Pending,
	}
}

// KickConnection 断开指定连接：resolveServerID → 定向 KICK。拒绝/失败原文
// 透传（Global 4）。日志只记服务器名与 cid，不记用户身份（§13.3）。
func (s *MonitorService) KickConnection(name string, cid uint64) CallResult {
	id, res := s.resolveServerID(name)
	if !res.Ok() {
		return res
	}
	nc := s.mgr.Conn()
	if nc == nil || !nc.IsConnected() {
		return fail(CodeNotConnected, "not connected")
	}

	resps, res := s.directedReq(nc, server.KickClientReq{CID: cid}, "$SYS.REQ.SERVER."+id+".KICK")
	if !res.Ok() {
		return res
	}
	if e := apiErrOf(resps[0]); e != nil {
		return ClassifyMonitorError(e)
	}
	s.log.Info("kick connection", "server", name, "cid", cid)
	return CallResult{}
}
