# NATS 桌面客户端 M2（Messages：发布/请求/订阅会话）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M2 里程碑：Messages 页——pub/req 调试（含 JetStream 发布 ACK、headers、大消息防护）、多订阅会话（**默认实时逐条推送**、批量可选、环形缓冲丢弃计数、暂停/恢复语义、JetStream 定位回放）、消息路径 trace、性能采样基建与低配 CI benchmark 环境。

**Architecture:** Go 侧新增 `internal/messaging` 包：纯逻辑管线（环形缓冲/批量器/速率计，100% 单测）+ NATS 集成（会话 goroutine、jetstream 定位消费者、tracing 复用 jsm.go），经既有 Wails 绑定与事件模式（`conn:state` 同款）暴露。前端新增 `features/messages/`：pub/req 面板 + 会话面板（@tanstack/react-virtual 虚拟列表 + 二进制 hex 预览）。设置项 `session_push_batching/session_buffer_size/request_timeout_seconds` 在本里程碑接线消费。

**Tech Stack:** 沿用 M1（Wails v3.0.0-beta.20、Go 1.26、React 18 + TS + Vite、Tailwind v4、shadcn、lucide、zod ^4.6.2、vitest ^5）；新增 `@tanstack/react-virtual`；jetstream 为 `nats.go v1.53.1` 内嵌子包（无需新依赖）；tracing 复用 `jsm.go v0.4.2-0.20260907110945-19fe165a004c` 的 `api/server/tracing`。

**规格依据:** `docs/superpowers/specs/2026-09-11-nats-desktop-v1-spec.md`（v1.1）§6.3/§6.4/§7.1.3/§7.3/§8.5.1/§11/§12/§18.4，AC-004~007、AC-029 会话半边。M1 遗留接线项（设置消费、pins 保洁、ready 日志、code-split、update 兜底、低配 CI）并入本计划。

## Global Constraints

来自规格与 M1 终审的硬约束（值逐字取自规格 v1.1）：

1. **推送模式（§6.4，用户 2026-09-11 修订）**：实时（默认，逐条到达即推）为新建会话默认（取全局设置，全局默认实时）；批量（每 100ms 或每 500 条，先到为准）为会话级可选项。
2. **会话缓冲与丢弃（§6.4）**：每会话环形缓冲保留最近 10,000 条（设置可调 1,000–100,000）；缓冲满丢最旧并累加丢弃计数；会话内序号 `seq` 单调递增（§7.1.3，§20.2 乱序检查项）。
3. **暂停/恢复语义（§6.4 + AC-006 的统一解读，写进测试）**：暂停期间——界面不新增、显示的速率归 0、**显示的累计/丢弃计数冻结**（AC-006 字面）；底层订阅继续接收、环形缓冲继续滚动（§6.4"继续计数"的内部面）；恢复——从当前最新消息继续，**不回补**暂停期间消息。
4. **洪峰（§6.4/§11/AC-007）**：50,000 msg/s（1KB 消息）注入 10s：界面保持可用与进程响应、丢帧不超 §12 门槛、丢弃计数准确、暂停立即停止推送、注入结束后速率回落 0。
5. **性能预算（§12，默认实时模式）**：高配 5,000 msg/s / 低配 1,000 msg/s 持续 60s 丢帧 <5%；会话消息上屏延迟 P95 ≤200ms（实时与批量分别验证）；操作视觉反馈 ≤100ms 双档。
6. **发布防护（§6.3）**：payload 1–8MB 警告确认后发送；>8MB 拒绝发送（前端拦 + Go 侧 `ErrPayloadTooLarge` 双保险）；连接非 connected 时禁用发布按钮。
7. **req（§6.3）**：无响应者/超时显示"无响应者/超时"及已等待时长；请求超时取设置 `request_timeout_seconds`（1–60s，默认 5）。
8. **JS 发布（§6.3，natscli 同款调用）**：`nc.RequestMsg(msg, timeout)` + `jsm.ParsePubAck` 展示 Stream/Sequence/Duplicate；去重头 `Nats-Msg-Id` 由用户经 headers 设置。
9. **事件契约（§7.1.3/§8.5.1）**：事件 `session:msgs` 载荷为**数组**（实时模式单元素数组，批量模式多元素）；元素字段 `session_id/seq/subject/headers/payload_b64/payload_size/timestamp/stream_seq/is_utf8`；`session:state` 载荷含 `id/subject/state(running|paused|closed)/push_mode/rate_msg_s/total/dropped/buffer_used`。事件不重传（实时流语义）。
10. **JetStream 定位（§6.4，闭集）**：none（纯核心订阅）/ all / new / start_sequence / start_time；元数据 `stream_seq` 经 `jetstream.Msg.Metadata()` 提取；JS 不可用给排查指引（§6.6 语义）不显示空列表误导。
11. **trace（§6.4）**：需服务器 ≥2.11（版本检查镜像 natscli `internal/util.ServerMinVersion`，本仓库 `internal/util/util.go:92` 有实现可参照）；结果呈现逐跳事件树。
12. **日志（§13）**：不得记录任何凭证内容；**消息 payload 内容同样不入日志**（只记 subject/size/seq/会话状态与丢弃计数）。
13. **主题/反馈（§18.2/§18.5）**：payload/JSON/subject 等宽字体；图标 lucide SVG 禁 emoji；点击到反馈 ≤100ms；失败 toast+可展开错误；空态引导。
14. **i18n（AC-021）**：新增 `messages.*` 命名空间 en/zh-CN 双侧同步（完整性门禁拦截）。
15. **依赖版本**：不新增 Go 模块依赖（jetstream 在 nats.go 内；tracing 在 jsm.go 内）；前端仅新增 `@tanstack/react-virtual`。
16. **M1 遗留接线（本计划 Task 1 消化）**：`Manager.Conn()` 访问器；pins.go 保洁；main.go ready 日志；update-toast mount 兜底（调一次 `CheckUpdate()`）；Messages 页 code-split（修 507kB chunk 警告）。
17. **提交纪律**：conventional commits，每任务红→绿→提交；`wails3 generate bindings -ts -clean=true` 后提交 bindings/。

## File Structure

```
desktop/
├── internal/
│   ├── connections/manager.go        # 修改：+Conn() 访问器（Task 1）
│   ├── deps/pins.go                  # 修改：保洁（Task 1）
│   ├── messaging/                    # 新包
│   │   ├── types.go                  # 契约类型与事件名（Task 2 定义、后续共用）
│   │   ├── pipeline.go               # 纯逻辑：ringBuffer + pusher(实时/批量) + rateMeter（Task 2）
│   │   ├── pubreq.go                 # Publish/Request（Task 3）
│   │   ├── sessions.go               # 核心订阅会话管理器（Task 4）
│   │   ├── jsposition.go             # JetStream 定位会话（Task 5）
│   │   ├── trace.go                  # trace 封装（Task 6）
│   │   ├── service.go                # Wails 绑定门面（Task 7）
│   │   └── *_test.go                 # 各任务测试（含内嵌服务器集成测试）
│   └── testutil/server.go            # 修改：+EchoService 助手（Task 3）
├── cmd/flood/main.go                 # 洪峰注入器（手工性能脚本用，Task 13）
├── main.go                           # 修改：ready 日志、注册 MessagingService（Task 1/7）
└── frontend/
    ├── src/
    │   ├── features/messages/
    │   │   ├── MessagesPage.tsx      # 页面骨架（tabs: Publish/Sessions/Trace）（Task 8）
    │   │   ├── PubPanel.tsx          # pub/req 面板（Task 8）
    │   │   ├── SessionsPanel.tsx     # 会话创建/列表/控制（Task 9）
    │   │   ├── SessionView.tsx       # 虚拟化消息列表 + 详情（Task 9）
    │   │   ├── TracePanel.tsx        # trace 面板（Task 10）
    │   │   ├── schema.ts             # zod（Task 8）
    │   │   └── useSessions.ts        # 会话事件订阅 hook（Task 9）
    │   ├── app/update.ts             # 修改：mount 兜底（Task 1）
    │   ├── lib/bindings.ts           # 修改：messaging 再导出（Task 7 后各前端任务）
    │   ├── locales/en.json, zh-CN.json # +messages.*/trace.* 双侧（Task 8 起持续）
    │   └── App.tsx                   # 修改：lazy MessagesPage 替换占位（Task 8）
    ├── tests/messages-*.test.tsx     # 组件测试（Task 8/9/10）
    ├── tests/bench/sessions.bench.ts # 前端基准（Task 11）
    └── vitest.config.ts              # 修改：bench 配置（Task 11）
.github/workflows/desktop-ci.yml      # 修改：+bench job（Task 11）
docs/superpowers/plans/2026-09-12-nats-desktop-m2-acceptance.md  # Task 13
```

职责边界：`pipeline.go` 纯逻辑零 NATS 依赖；`sessions.go` 只管核心订阅会话；`jsposition.go` 只管消费者回放会话（复用 pipeline 与事件发射）；`pubreq.go`/`trace.go` 无状态单发操作；`service.go` 只做绑定门面与参数搬运。

---

### Task 1: M1 遗留接线（Conn 访问器/保洁/ready 日志/update 兜底）

**Files:**
- Modify: `desktop/internal/connections/manager.go`（+Conn()）、`desktop/internal/connections/manager_test.go`（+测试）、`desktop/internal/deps/pins.go`（保洁）、`desktop/main.go`（ready 日志）、`desktop/frontend/src/app/update.ts`（mount 兜底）

**Interfaces:**
- Consumes: M1 既有 Manager（`NewManager(reg, log, emit)`，私有 `nc *nats.Conn`，互斥锁模型见 manager.go:25-29 注释）。
- Produces: `func (m *Manager) Conn() *nats.Conn`——锁内返回当前活跃连接（未连接返回 nil）；后续 messaging 任务经此取连接。`update.ts` 导出不变，行为加兜底。

- [ ] **Step 1: 写失败的测试（manager_test.go 追加）**

```go
func TestConnAccessor(t *testing.T) {
	url := testutil.StartJSServer(t)
	m, _ := newRecordingManager(t)
	saveContext(t, m, "demo", url)
	if m.Conn() != nil {
		t.Fatal("no conn before connect")
	}
	if err := m.Connect(context.Background(), "demo"); err != nil {
		t.Fatal(err)
	}
	waitForState(t, m.events, StateConnected, 5*time.Second)
	if c := m.Conn(); c == nil || c.Status() != nats.CONNECTED {
		t.Fatalf("expected live conn, got %v", c)
	}
	m.Disconnect()
	waitForState(t, m.events, StateDisconnected, 5*time.Second)
	if m.Conn() != nil {
		t.Fatal("conn must be nil after disconnect")
	}
}
```

- [ ] **Step 2: 红灯 → 实现 Conn()（锁内快照，绝不长期持有；注释说明返回的连接可能在下次状态变化后失效，调用方须容忍 ErrConnectionClosed）**

```go
// Conn returns the current live connection, or nil when not connected.
// The connection may be replaced by a later Connect/Disconnect; callers
// must tolerate nats.ErrConnectionClosed on stale references.
func (m *Manager) Conn() *nats.Conn {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state != StateConnected {
		return nil
	}
	return m.nc
}
```

- [ ] **Step 3: 绿灯后做三处保洁**
  - `internal/deps/pins.go`：connections（natscontext）与 testutil（nats-server）已真实导入，两个空导入可删——删除后 `go mod tidy` + `wails3 build` 验证 go.mod 中两个依赖仍为 direct require；文档注释改为通用语句（不引计划编号）。
  - `main.go`：应用启动完成处（窗口创建后、`app.Run()` 前）加 `logger.Info("ready", "version", version.Current())`——这就是 M1 验收记录缺口的 ready 标记。
  - `frontend/src/app/update.ts`：mount 时兜底调一次 `CheckUpdate()` 绑定（结果有更新且本次运行未提示过才 toast——复用既有 once-guard；注意避免与 Go 侧 emit 双提示：once-guard 已保证只显示一次）。

- [ ] **Step 4: 验证 + 提交**

```bash
go test ./internal/connections/ -run TestConnAccessor -v && go test ./... && cd frontend && npx vitest run
git add -A && git commit -m "feat(desktop): Manager.Conn accessor, pins cleanup, ready log, update-check fallback"
```

---

### Task 2: 消息管线（纯逻辑：环形缓冲 + 推送器 + 速率计）

**Files:**
- Create: `desktop/internal/messaging/types.go`、`desktop/internal/messaging/pipeline.go`、`desktop/internal/messaging/pipeline_test.go`

**Interfaces:**
- Consumes: 无（零 NATS 依赖）。
- Produces（Task 4/5 依赖，签名逐字）:
  - `type MsgOut struct { SessionID string \`json:"session_id"\`; Seq int64 \`json:"seq"\`; Subject string \`json:"subject"\`; Headers map[string][]string \`json:"headers,omitempty"\`; PayloadB64 string \`json:"payload_b64"\`; PayloadSize int \`json:"payload_size"\`; Timestamp string \`json:"timestamp"\`; StreamSeq int64 \`json:"stream_seq,omitempty"\`; IsUTF8 bool \`json:"is_utf8"\` }`（§7.1.3）
  - `type PushMode string`；`PushRealtime PushMode = "realtime"`；`PushBatch PushMode = "batch"`
  - `type pusher struct{...}`；`newPusher(mode PushMode, emit func(batch []MsgOut)) *pusher`；`(p *pusher) Add(m MsgOut)`；`(p *pusher) Flush()`；`(p *pusher) Stop()`——实时模式 Add 即 emit 单元素批；批量模式 100ms 定时器或攒 500 条先到为准（时间驱动由调用方的 ticker 调 Flush 实现或内部 goroutine——**内部自带 goroutine，Stop 必须收敛**）
  - `type ring struct{...}`；`newRing(capacity int) *ring`；`(r *ring) Add(m MsgOut)`（满则丢最旧，dropped++）；`(r *ring) Dropped() int64`；`(r *ring) Snapshot(n int) []MsgOut`（最新 n 条，旧→新）
  - `type rateMeter struct{...}`；`newRateMeter(window time.Duration) *rateMeter`；`(r *rateMeter) Inc()`；`(r *rateMeter) Rate() float64`（当前窗口 msg/s）
  - 纯函数 `isUTF8(b []byte) bool`（utf8.Valid）

- [ ] **Step 1: 写失败的测试（pipeline_test.go，覆盖规格规则的关键断言）**

```go
func TestRingDropsOldestAndCounts(t *testing.T) {
	r := newRing(3)
	for i := int64(1); i <= 5; i++ {
		r.Add(MsgOut{Seq: i})
	}
	if r.Dropped() != 2 { t.Fatalf("dropped = %d want 2", r.Dropped()) }
	got := r.Snapshot(10)
	if len(got) != 3 || got[0].Seq != 3 || got[2].Seq != 5 {
		t.Fatalf("ring contents: %+v", got)
	}
}

func TestPusherRealtimeEmitsImmediately(t *testing.T) {
	var mu sync.Mutex
	var batches [][]MsgOut
	p := newPusher(PushRealtime, func(b []MsgOut) { mu.Lock(); batches = append(batches, b); mu.Unlock() })
	defer p.Stop()
	p.Add(MsgOut{Seq: 1}); p.Add(MsgOut{Seq: 2})
	mu.Lock(); defer mu.Unlock()
	if len(batches) != 2 || len(batches[0]) != 1 || batches[0][0].Seq != 1 {
		t.Fatalf("realtime must emit per-message single-element batches: %+v", batches)
	}
}

func TestPusherBatchFlushesAt500OrTimer(t *testing.T) {
	// 攒 500 条立即成批；不足 500 由内部定时器(100ms)成批——两条断言分别覆盖
}

func TestRateMeterWindow(t *testing.T) {
	r := newRateMeter(time.Second)
	for i := 0; i < 50; i++ { r.Inc() }
	if got := int(r.Rate()); got < 40 || got > 60 { t.Fatalf("rate = %v", got) }
}
```

- [ ] **Step 2: 红灯 → 实现 types.go（MsgOut/PushMode）与 pipeline.go（ring：切片+头指针+计数；pusher：realtime 直发 / batch 带 `time.Ticker(100ms)` goroutine + 满 500 触发，互斥保护 emit；rateMeter：环形时间片桶）**

- [ ] **Step 3: 绿灯 + 并发稳定跑（`go test ./internal/messaging/ -race -count=3`，本机 -race 不可用则 `-count=5` 并注明 CI 承接）+ 提交 `feat(desktop): message pipeline - ring buffer, realtime/batch pusher, rate meter`**

---

### Task 3: 发布与请求（Go）

**Files:**
- Create: `desktop/internal/messaging/pubreq.go`、`desktop/internal/messaging/pubreq_test.go`
- Modify: `desktop/internal/testutil/server.go`（+EchoService 助手）

**Interfaces:**
- Consumes: `Manager.Conn()`（Task 1）；`settings.Behavior.RequestTimeoutSeconds` 由 service 层（Task 7）读取后传入，本层收参数。
- Produces:
  - `type PubForm struct { Subject string; Headers map[string][]string; Payload []byte; JetStream bool; TimeoutMs int }`
  - `type PubResult struct { OK bool; JetStream bool; Stream string; Sequence int64; Duplicate bool; ElapsedMs int64; Error string }`（json tag 小写蛇形）
  - `type ReqForm struct { Subject string; Headers map[string][]string; Payload []byte; TimeoutMs int }`
  - `type ReqResult struct { OK bool; Payload []byte; Headers map[string][]string; ElapsedMs int64; NoResponder bool; Error string }`
  - `const MaxPayload = 8 << 20`；`var ErrPayloadTooLarge = errors.New(...)`；`var ErrNotConnected = errors.New(...)`
  - `func Publish(nc *nats.Conn, f PubForm) PubResult`；`func Request(nc *nats.Conn, f ReqForm) ReqResult`（nc 为 nil → ErrNotConnected 结果；payload > 8MB → ErrPayloadTooLarge 结果，不发网络请求）

- [ ] **Step 1: testutil 加 EchoService 助手 + 写失败的测试**

```go
// server.go 追加：
// StartEcho echoes the request payload back with header "Echoed: true".
func StartEcho(t *testing.T, url string) {
	t.Helper()
	nc, err := nats.Connect(url)
	if err != nil { t.Fatal(err) }
	nc.Subscribe("echo", func(m *nats.Msg) {
		m.Respond(m.Data) // headers 透传由用例自行断言
	})
	nc.Flush()
	t.Cleanup(nc.Close)
}
```

测试场景（pubreq_test.go，全部真协议）：
1. `TestPublishCore`：发到临时 subject，另一订阅者收到，PubResult.OK 且 ElapsedMs≥0。
2. `TestPublishJetStreamAck`：StartJSServer + 建流（jsm 或 jetstream API 建一个 subjects=[test.*] 流）→ JetStream=true 发布 → Stream/Sequence 非零；同 `Nats-Msg-Id` 头重发 → Duplicate=true。
3. `TestPublishNotConnected`：nil conn → ErrNotConnected。
4. `TestPublishTooLarge`：>8MB payload → ErrPayloadTooLarge，且（关键）无网络副作用。
5. `TestRequestEcho`：echo 服务 → OK、payload 回来、ElapsedMs 记录。
6. `TestRequestNoResponders`：无人订阅的 subject + 500ms 超时 → NoResponder=true、Error 含 "no responders"（nats.ErrNoResponders 映射）。
7. `TestRequestTimeout`：订阅但不回应 → 超时结果、Error 含 "timeout"、ElapsedMs ≥ 超时值。

- [ ] **Step 2: 红灯 → 实现（调用序列逐字对齐 natscli 调查结论）**
  - 核心发布：`msg := nats.NewMsg(f.Subject)` → `msg.Data = f.Payload` → headers 直接 `msg.Header[k] = v` → `nc.PublishMsg(msg)` + `nc.Flush()` + `nc.LastError()` 三连。
  - JS 发布：`resp, err := nc.RequestMsg(msg, timeout)` → `ack, err := jsm.ParsePubAck(resp)` → Stream/Sequence/Duplicate。
  - req：`msg.Reply = nc.NewRespInbox()` → `sub, _ := nc.SubscribeSync(msg.Reply)` → `nc.PublishMsg(msg)` → `m, err := sub.NextMsg(timeout)`；`errors.Is(err, nats.ErrNoResponders)` → NoResponder；`nats.ErrTimeout` → 超时。
  - 超时下限钳制：`TimeoutMs <= 0 → 5000`。
  - **不记录 payload 到日志**（Global Constraint #12）。

- [ ] **Step 3: 绿灯 → 提交 `feat(desktop): publish and request over core NATS and JetStream`**

---

### Task 4: 核心订阅会话管理器（Go）

**Files:**
- Create: `desktop/internal/messaging/sessions.go`、`desktop/internal/messaging/sessions_test.go`
- Modify: `desktop/internal/messaging/types.go`（+SessionSpec/SessionState）

**Interfaces:**
- Consumes: Task 2 全部（pusher/ring/rateMeter/MsgOut）；`Manager.Conn()`；`EventConnState`（connections 包）。
- Produces:
  - `type SessionSpec struct { Subject string \`json:"subject"\`; PushMode PushMode \`json:"push_mode"\`; BufferSize int \`json:"buffer_size"\`; JSPosition *JSPosition \`json:"js_position,omitempty"\` }`（BufferSize<=0 → 取设置默认，由 service 层解析；本层只吃最终值）
  - `type JSPosition struct { Mode string \`json:"mode"\`; StartSeq uint64 \`json:"start_seq,omitempty"\`; StartTime string \`json:"start_time,omitempty"\` }`（mode 闭集 all/new/start_sequence/start_time）
  - `type SessionState struct { ID string \`json:"id"\`; Subject string \`json:"subject"\`; State string \`json:"state"\`; PushMode PushMode \`json:"push_mode"\`; RateMsgS float64 \`json:"rate_msg_s"\`; Total int64 \`json:"total"\`; Dropped int64 \`json:"dropped"\`; BufferUsed int \`json:"buffer_used"\`; Error string \`json:"error,omitempty"\` }`；state 闭集 running/paused/closed
  - 事件名：`EventSessionMsgs = "session:msgs"`；`EventSessionState = "session:state"`
  - `type SessionManager struct{...}`；`NewSessionManager(mgr *connections.Manager, log *slog.Logger, emit func(name string, data any), defaultBuf int, defaultPush PushMode) *SessionManager`
  - 方法：`CreateSession(ctx context.Context, spec SessionSpec) (SessionState, error)`；`Pause(id) error`；`Resume(id) error`；`Clear(id) error`（清列表+计数重置显示，订阅不动）；`Close(id) error`；`CloseAll()`；`List() []SessionState`
  - 内部：每会话一个 goroutine；`Manager` 断线重连后自动重订阅（监听 conn:state，connected 时对 running 会话重建订阅；恢复后**不回补**断线期间消息——纯核心订阅天然如此）；订阅非法（服务器拒绝）→ 会话 state=closed + Error 原文。

- [ ] **Step 1: 写失败的测试（内嵌服务器，覆盖 AC-005/006/007 的 Go 半边 + 断线恢复）**

关键用例（完整断言写进测试）：
1. `TestSessionRealtimeReceives`：发布器 100 msg/s 发 2s → List 中 Total≈200、RateMsgS>80；emit 收到的批为单元素数组（实时模式）。
2. `TestSessionPauseResumeSemantics`（Global Constraint #3 的两条文本都要断言）：
   - 暂停后继续发布 50 条：**显示 Total 冻结**（List 前后相等）、emit 无新批；
   - 底层缓冲在滚动：ring 内最新 Seq 已前移（经 List 的 BufferUsed/内部断言或导出测试钩子）；
   - 恢复后再发 10 条：emit 出现新批且第一条 Seq > 暂停期间全部 Seq（不回补）。
3. `TestSessionFloodDropCounting`：发布器全速 5,000 msg/s × 3s，buffer=1000 → Dropped>0 且满足不变式 `Total == Emitted + Dropped + InBuffer`（写清计数口径：Total=接收总数，Emitted=推送总数）。
4. `TestSessionBatchMode`：PushMode=batch → emit 批大小可 >1 且相邻批间隔 ≈100ms。
5. `TestSessionReconnectResubscribes`：可重启服务器夹具（M1 Task 8 同款 inline 夹具）→ 断线期间发布丢失不回补 → 重连后新消息继续到达、会话仍 running。
6. `TestSessionClear`：Clear 后 Total/Dropped/BufferUsed 归零、订阅继续收新消息。
7. `TestSessionInvalidSubject`：含空格 subject → CreateSession 错误（E-VALIDATION 语义）。
8. `TestSessionServerRejects`：无法直接制造服务器拒绝时不硬造——以 subject 合法性检查覆盖，并在报告中注明。

- [ ] **Step 2: 红灯 → 实现**
  - 会话结构：`session{id, spec, sub *nats.Subscription 或 jetstream ConsumeContext, ring, pusher, rate, total/emitCount, stateMu, paused}`。
  - 订阅回调：组装 MsgOut（`Seq` 会话内原子递增从 1；`IsUTF8: utf8.Valid(m.Data)`；`PayloadB64: base64.StdEncoding.EncodeToString`；`Timestamp: time.Now().UTC().Format(time.RFC3339Nano)`；headers 拷贝）→ rate.Inc/total++ → 若 !paused：ring.Add + pusher.Add（**暂停期间只 total/rate/滚动，不入 ring？——入 ring 但不 push**：ring 持续滚动保最新，pusher 不喂）。
  - 状态事件：每次状态/计数变化节流 250ms 发 `EventSessionState`（List 快照同源）。
  - 重连：`emit` 复用 conn 事件？——直接由 SessionManager 订阅 `Manager` 内部：增加 `mgr.OnState(func(s connections.StateEvent))`？**不扩 Manager**：SessionManager 自己 `Events.On`? Go 侧没有全局 Events 监听器……采用：`NewSessionManager` 接收 `stateCh <-chan connections.StateEvent`，main.go 里 Manager emit 时旁路一份（emit 闭包里同时 `select { case stateCh <- ev: default: }`）。测试里直接发 channel。文档注明非阻塞。
  - Clear：锁内重建 ring、清计数；pusher 不动。

- [ ] **Step 3: 绿灯（含并发稳定性 `-count=3`）→ 提交 `feat(desktop): subscribe session manager with realtime default and pause semantics`**

---

### Task 5: JetStream 定位回放会话（Go）

**Files:**
- Create: `desktop/internal/messaging/jsposition.go`、`desktop/internal/messaging/jsposition_test.go`
- Modify: `desktop/internal/messaging/sessions.go`（CreateSession 分支到 jsposition）

**Interfaces:**
- Consumes: Task 4 的 SessionManager/SessionSpec（JSPosition 字段）；jetstream 包（`jetstream.New(nc)`；`js.StreamNameBySubject(ctx, subj)`；`js.Stream(ctx, name)`；`stream.CreateConsumer(ctx, cfg)`；`cons.Consume(handler)` → ConsumeContext；`msg.Metadata()`）。
- Produces: 无新公开类型；`CreateSession` 支持 JSPosition 五模式（none 走 Task 4 路径）；MsgOut.StreamSeq 填 `meta.Sequence.Stream`。

- [ ] **Step 1: 写失败的测试（StartJSServer + jetstream 建流发布 100 条）**
  1. `TestJSReplayAll`：发布 100 → CreateSession(subject, JSPosition{all}) → 陆续收到 100 条，每条 StreamSeq 1..100 单调。
  2. `TestJSReplayFromSequence`：start_sequence=50 → 收到 50 条，首条 StreamSeq=50。
  3. `TestJSReplayNew`：先创建会话（new）再发布 → 只收新消息。
  4. `TestJSReplayStartTime`：发布 → 等 50ms → start_time=now → 收不到旧消息，新消息到达（时间精度敏感，断言放宽为"无旧消息"）。
  5. `TestJSNoStreamError`：无匹配流 → CreateSession 错误信息含 "no stream"（jetstream.ErrNoStream 映射，给 §6.6 式排查指引文案由前端负责）。
  6. `TestJSClosedStopsConsumer`：Close 后 ConsumeContext.Stop 被调（订阅清理，服务器侧无泄漏——以再次创建同 subject 会话可行为准）。

- [ ] **Step 2: 红灯 → 实现（cfg 构造对齐 natscli makeConsumerConfig）**

```go
cfg := jetstream.ConsumerConfig{
	AckPolicy:     jetstream.AckNonePolicy,
	FilterSubject: spec.Subject,
}
switch pos.Mode {
case "all":            cfg.DeliverPolicy = jetstream.DeliverAllPolicy
case "new":            cfg.DeliverPolicy = jetstream.DeliverNewPolicy
case "start_sequence": cfg.DeliverPolicy = jetstream.DeliverByStartSequencePolicy; cfg.OptStartSeq = pos.StartSeq
case "start_time":
	st := parseRFC3339(pos.StartTime)
	cfg.DeliverPolicy = jetstream.DeliverByStartTimePolicy; cfg.OptStartTime = &st
}
cons, err := stream.CreateConsumer(ctx, cfg)
cctx, err := cons.Consume(func(ctx context.Context, m jetstream.Msg) { /* 同 Task 4 的 MsgOut 组装，StreamSeq 取 m.Metadata().Sequence.Stream */ })
// Close(id) → cctx.Stop()；回放完成不自动关会话（继续实时收）
```

- [ ] **Step 3: 绿灯 → 提交 `feat(desktop): JetStream positioned replay sessions`**

---

### Task 6: Trace（Go）

**Files:**
- Create: `desktop/internal/messaging/trace.go`、`desktop/internal/messaging/trace_test.go`

**Interfaces:**
- Consumes: `jsm.go/api/server/tracing.TraceMsg(nc *nats.Msg, msg *nats.Msg, deliver bool, timeout time.Duration, rawTraces chan *nats.Msg) (*server.MsgTraceEvent, error)`（jsm.go 调查结论 #4）；服务器版本检查参照本仓库 `internal/util/util.go:92` 的 `ServerMinVersion` 实现镜像（**实现者先读该函数**）。
- Produces:
  - `type TraceForm struct { Subject string; Headers map[string][]string; Payload []byte; Deliver bool; TimeoutMs int }`
  - `type TraceHop struct { Kind string \`json:"kind"\`; Detail string \`json:"detail"\`; Children []TraceHop \`json:"children,omitempty"\` }`
  - `func Trace(nc *nats.Conn, f TraceForm) (TraceHop, error)`——递归展开 `event.Ingress()/SubjectMapping()/ServiceImports()/StreamExports()/JetStream()/Egresses()`（对齐 natscli renderTrace 的树结构：先读 cli/trace_command.go:171-205）；服务器 <2.11 → error "tracing requires NATS Server 2.11 or newer"（内嵌夹具 v2.15 满足，版本检查测试用 `StartAuthServer`？版本相同——以 ServerMinVersion 镜像函数的单测（注入假版本）覆盖判定逻辑）。

- [ ] **Step 1: 写失败的测试**：`TestTraceSingleServer`（StartJSServer + echo 订阅者 + Trace(deliver=false) → 返回树含 ingress/egress 节点、Kind 非空）；`TestTraceNotConnected`（nil conn）；版本判定函数单测（表驱动 2.10/2.11/2.15）。

- [ ] **Step 2: 红灯 → 实现 → 绿灯 → 提交 `feat(desktop): message path tracing over server tracing API`**

---

### Task 7: MessagingService 绑定装配（Go + bindings）

**Files:**
- Create: `desktop/internal/messaging/service.go`（+ service_test.go 小覆盖）
- Modify: `desktop/main.go`（构造 SessionManager + stateCh 旁路 + 注册服务）、`desktop/frontend/src/lib/bindings.ts`（再导出）、`desktop/frontend/bindings/`（regen，提交）

**Interfaces:**
- Consumes: Task 3/4/5/6 全部；settings（`GetSettings` 读默认 buffer/push/timeout）。
- Produces（绑定方法，前端 Task 8/9/10 消费，json tag 小写蛇形）:
  - `type MessagingService struct{...}`；`NewMessagingService(mgr *connections.Manager, log *slog.Logger, emit func(string, any), settingsPath string) *MessagingService`
  - `Publish(form PubForm) PubResult`（TimeoutMs 缺省取设置 request_timeout_seconds×1000；nc=nil → ErrNotConnected 结果）
  - `Request(form ReqForm) ReqResult`（同上缺省）
  - `CreateSession(spec SessionSpec) (SessionState, error)`（BufferSize<=0 → 设置 session_buffer_size；PushMode 空 → 设置 session_push_batching? batch:realtime）
  - `PauseSession(id string) error`；`ResumeSession(id string) error`；`ClearSession(id string) error`；`CloseSession(id string) error`
  - `ListSessions() []SessionState`
  - `Trace(form TraceForm) (TraceHop, error)`
- main.go 接线：

```go
stateCh := make(chan connections.StateEvent, 16)
emit := func(name string, data any) {
	if a := application.Get(); a != nil { a.Event.Emit(name, data) }
	if name == connections.EventConnState {
		if ev, ok := data.(connections.StateEvent); ok {
			select { case stateCh <- ev: default: }
		}
	}
}
// 既有 emit 闭包替换为上述；msgSvc := messaging.NewMessagingService(manager, logger, emit, settingsPath)
// Services 追加 application.NewService(msgSvc)；SessionManager 的重连监听吃 stateCh
```

- [ ] **Step 1: 写失败的服务级测试**（settings 写临时文件 → 默认值解析：BufferSize 空→10000、PushMode 空→realtime、TimeoutMs 0→5000；CreateSession→ListSessions→CloseSession 全链路，内嵌服务器）
- [ ] **Step 2: 红→绿→`wails3 generate bindings -ts -clean=true`→`wails3 build`（验证 go.mod 无新依赖）→bindings.ts 再导出（PubForm/PubResult/ReqForm/ReqResult/SessionSpec/SessionState/TraceForm/TraceHop + 全部方法）**
- [ ] **Step 3: 提交 `feat(desktop): messaging service bindings and wiring`**

---

### Task 8: Messages 页骨架 + 发布/请求面板（前端）

**Files:**
- Create: `desktop/frontend/src/features/messages/MessagesPage.tsx`、`PubPanel.tsx`、`schema.ts`、`tests/messages-pub.test.tsx`
- Modify: `App.tsx`（`const MessagesPage = lazy(() => import("./features/messages/MessagesPage"))` 替换占位，Suspense fallback 骨架屏——code-split 顺手修 chunk 警告）、`locales/{en,zh-CN}.json`（+`messages.*` 全量 key 双侧）、`package.json`（+`@tanstack/react-virtual`，本任务只装依赖不使用）
- Modify: shadcn `npx shadcn@2 add tabs switch scroll-area tooltip --yes`

**Interfaces:**
- Consumes: bindings（Publish/Request/GetSettings）、connstate（未连接时禁用按钮）。
- Produces: `<MessagesPage>`（三 tab：messages.tabPublish/tabSessions/tabTrace）；`schema.ts` 导出 `pubSchema`（subject 非空无空格、payload 长度上限校验放组件层因为有确认对话框语义）。

- [ ] **Step 1: i18n key 先行（双侧同步，节选关键 key 集写进任务）**：`messages.{tabPublish,tabSessions,tabTrace,subject,headers,addHeader,payload,formatJson,jsonInvalid,publish,publishJs,msgId,history,clearHistory,request,timeout,noResponder,elapsed,sizeWarn(size>1MB 确认文案),sizeReject,dup,stream,seq,published,pubFailed,reqFailed,response,duration,binaryPreview}` 等（en/zh 双语全量，实现者按 UI 文案清单完整写）。
- [ ] **Step 2: 写失败的组件测试**（mock bindings）：非法 subject（含空格）内联拦截不发；payload 5MB 时 Save→确认对话框出现、确认后才调 Publish；payload 9MB 直接拒绝并提示 sizeReject；req 返回展示 payload+duration；noResponder 展示 noResponder+已等待时长；历史列表新增一条；未连接（mock connstate disconnected）发布按钮 disabled。
- [ ] **Step 3: 红→绿实现**：PubPanel（subject input、headers 动态行、等宽 payload textarea + Format JSON 按钮（失败 toast jsonInvalid）、JS 开关（显示 Nats-Msg-Id 提示）、发布结果区（stream/seq/duplicate/elapsed）、req 模式开关（响应面板 JSON 高亮复用等宽 pre + 二进制 hex 分支）、发布历史最近 20 条内存态）；消息区所有 payload 用等宽字体类。
- [ ] **Step 4: `npx vitest run` + `npm run build`（确认 Messages chunk 独立、主 chunk 下降）+ 提交 `feat(desktop): messages page shell with publish and request panels`**

---

### Task 9: 订阅会话 UI（前端）

**Files:**
- Create: `SessionsPanel.tsx`、`SessionView.tsx`、`useSessions.ts`、`tests/messages-sessions.test.tsx`
- Modify: `MessagesPage.tsx`（接 Sessions tab）、`locales/*.json`（+会话 key）

**Interfaces:**
- Consumes: bindings（CreateSession/Pause/Resume/Clear/Close/ListSessions）、`Events.On(EventSessionMsgs/EventSessionState)`；`@tanstack/react-virtual`。
- Produces: `useSessions()` hook——`{ sessions: SessionState[]; messages: Record<sessionId, MsgOut[]>; subscribe-session:id 事件 → 写入对应列表（保留上限 = buffer_size，超限移除最旧）}`；组件 `<SessionsPanel>`、`<SessionView session msgs onPause onResume onClear onClose>`。

- [ ] **Step 1: 写失败的组件/hook 测试**（mock Events.On 捕获 + fake bindings）：
  1. 创建会话（表单：subject、push 模式开关默认实时、JS 定位折叠区五选一）→ ListSessions 出现 running。
  2. 捕获的 `session:msgs` 回调灌 3 条单元素批 → 列表渲染 3 行（虚拟列表 getItemCount=3）；灌 200 条 → 仅渲染窗口内行数（虚拟化生效断言：`document.querySelectorAll` 行数 < 200）。
  3. `session:state` 更新 → 速率/累计/丢弃/暂停标记刷新；丢弃>0 显示角标。
  4. Pause 点击 → 调用 PauseSession、状态条显示 paused；Clear → 本地列表清空。
  5. 二进制消息（is_utf8=false）→ 行内显示 hex 预览标记，详情面板 hex 视图 + 下载按钮（Blob URL）。
  6. 详情展开：headers 表 + 完整 payload（JSON 时格式化）。
- [ ] **Step 2: 红→绿实现**：SessionView 用 `useVirtualizer`（overscan 8，等宽行高固定 28px）；会话 tab 条（每会话一个 chip：subject+状态点+速率）；详情用 Dialog；速率显示 `{{rate}} msg/s`。
- [ ] **Step 3: `npx vitest run` → 提交 `feat(desktop): subscribe sessions UI with virtualized message list`**

---

### Task 10: Trace 面板（前端）

**Files:**
- Create: `TracePanel.tsx`、`tests/messages-trace.test.tsx`
- Modify: `MessagesPage.tsx`（Trace tab）、`locales/*.json`（+`trace.*`）

**Interfaces:**
- Consumes: bindings `Trace(form)`；Task 8 的表单组件模式复用（subject/headers/payload 输入）。
- Produces: 树形渲染 `TraceHop`（缩进列表 + Kind badge + Detail，lucide 图标），deliver 开关（"trace only" 默认 on = 不投递）。

- [ ] **Step 1: 写失败测试**：表单提交 → Trace 调用参数正确（deliver 开关映射）；返回两层树 → 渲染两层节点；错误（<2.11 文案）toast 展示。
- [ ] **Step 2: 红→绿 → 提交 `feat(desktop): message trace panel`**

---

### Task 11: 性能采样基建 + CI benchmark job

**Files:**
- Create: `desktop/internal/messaging/pipeline_bench_test.go`（Go 基准 + 门槛断言测试）、`desktop/frontend/tests/bench/sessions.bench.ts`、`.github/workflows/desktop-ci.yml` 追加 bench job
- Modify: `desktop/frontend/vitest.config.ts`（bench include）、`frontend/package.json`（`"bench": "vitest bench --run"`）

**Interfaces:**
- Consumes: Task 2 pipeline、Task 9 useSessions 逻辑。
- Produces: 可复跑的性能门槛（CI 门禁）与数字记录格式。

- [ ] **Step 1: Go 基准 + 门槛测试**

```go
// pipeline_bench_test.go
func BenchmarkPipelineThroughput(b *testing.B) {
	// 5 万条 1KB 消息过 ring+realtime pusher(emit 到 noop)，计 msg/s
}
func TestPipelineThroughputFloor(t *testing.T) {
	// 门槛：Go 侧管线吞吐 ≥ 50,000 msg/s（本机/CI 均应远超；规格洪峰注入 5 万/s 的管线容量底线）
}
```

- [ ] **Step 2: 前端 bench（vitest bench，jsdom 逻辑吞吐——注明不含绘制帧率，帧率验证走 Task 13 实测）**：`useSessions` 状态机灌 10,000 条事件（分批 500×20）的吞吐 ops + `SessionView` 列表状态更新耗时；门槛断言进普通 vitest（`tests/messages-perf.test.ts`：10,000 条灌入 < 2s）。
- [ ] **Step 3: CI bench job（低配档模拟：docker --cpus=2，对齐规格 §20「容器 CPU 限额模拟低配」）**：

```yaml
  bench:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - name: Go pipeline bench (2-core container)
        run: docker run --rm --cpus 2 -v ${{ github.workspace }}:/w -w /w/desktop golang:1.26 go test ./internal/messaging/ -run TestPipelineThroughputFloor -count=1 -v
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: desktop/frontend/package-lock.json }
      - run: npm ci
        working-directory: desktop/frontend
      - run: npx vitest run tests/messages-perf.test.ts
        working-directory: desktop/frontend
```

- [ ] **Step 4: 本地全跑一遍（docker 可用时）+ 提交 `perf(desktop): pipeline benchmarks and low-core CI bench job`**

---

### Task 12: context 外部修改冲突检测（M1 备忘回补）

**Files:**
- Modify: `desktop/internal/connections/service.go`（GetContextForm 返回 +mtime；SaveContext 带 knownMtime 校验）、`contexts.go`（Store 层 mtime 读取与校验）、`frontend/src/features/connections/ConnectionsPage.tsx`（保存前冲突对话框）、bindings regen、`locales/*.json`（+`connections.conflict*`）

**Interfaces:**
- Consumes: M1 GetContextForm/SaveContext。
- Produces: `GetContextForm(name) (ContextForm, error)` 改为 `(form ContextForm, modTimeMs int64, err error)`；`SaveContext(form ContextForm, knownModTimeMs int64) error`——knownModTimeMs>0 且文件 mtime 变化 → `ErrContextModified`（绑定错误字符串 `context modified externally`）；0 = 跳过检查（兼容）。

- [ ] **Step 1: Go 失败测试**（Store：save → 改 mtime（os.Chtimes）→ Save 带 known → ErrContextModified；不带 known(0) → 通过；service 层透传）
- [ ] **Step 2: 红→绿；bindings regen；前端：编辑打开时记录 modTime，保存遇 ErrContextModified → AlertDialog（connections.conflictTitle/body/keepMine/reload），keepMine=以 known=0 重存，reload=重新拉表单**
- [ ] **Step 3: 前端测试（mock 错误 → 对话框出现 → keepMine 走 known=0 路径）→ 提交 `feat(desktop): context external-modification conflict detection`**

---

### Task 13: M2 验收与报告

**Files:**
- Create: `desktop/cmd/flood/main.go`（洪峰注入器：`go run ./cmd/flood -url nats://... -subject bench.x -rate 5000 -size 1024 -dur 10s`）、`docs/superpowers/plans/2026-09-12-nats-desktop-m2-acceptance.md`

**Interfaces:**
- Consumes: 全部前置任务。
- Produces: M2 验收记录（自动化数字 + 实测走查），M3 计划输入。

- [ ] **Step 1: flood 注入器（发布端 nc.PublishMsg 循环 + 速率控制 + 结束打印实际 msg/s；单测可省，作为工具以 -c 校验参数）**
- [ ] **Step 2: 自动化全绿**：`go test ./... -count=1`（含门槛测试）、`npx vitest run`、`npm run build`、`wails3 build`（记录数字）。
- [ ] **Step 3: 实测走查（本机=高配档，服务器 `go run github.com/nats-io/nats-server/v2 -p 4333 -js`）**：
  - AC-004：req echo 往返 + 历史记录；
  - AC-005：flood -rate 1000 → 会话实时列表滚动、速率计 ≈1000、上屏延迟（会话消息时间戳 vs 到达时间戳抽样 P95，或录屏）≤200ms；
  - AC-006：暂停/恢复/清空三动作（对照 Task 4 测试同款口径）；
  - AC-007：flood -rate 50000 -dur 10 → 界面不卡死、丢弃角标数值合理、暂停立即生效、结束后速率归 0；
  - 5,000 msg/s × 60s 持续：录屏或 Performance 面板记录丢帧（人工/脚本，数字入报告）；
  - AC-029 会话半边：flood 发 2MB 二进制 → hex 预览 + 下载。
  - 全程记录 exe 内存与冷启动（对照 §12）。
- [ ] **Step 4: 验收记录写入（含实测数字表 + PENDING-MANUAL 清单 + 遗留移交）+ 提交 `docs(desktop): M2 acceptance record`**

---

## 计划自检记录

- **规格覆盖**：§6.3 全条（表单/JS 发布/去重头/大消息防护/无响应者/未连接禁用）→ Task 3+8；§6.4 全条（多会话/通配符/定位回放/暂停恢复清空/速率/洪峰/trace/watch 复用说明——KV watch 复用会话机制属 M4，计划不涉及实现）→ Task 2/4/5/9 + Task 13；§6.3/§6.4 异常表逐条：payload 超大→T3/T8、无响应者→T3/T8、JS 拒绝→T7 错误映射+T8 文案、断开禁用→T8、洪峰→T4/T11/T13、主题非法→T4、断线重连恢复订阅→T4、二进制→T2/T9；§7.1.3/§8.5.1 事件契约→T2/T4/T7；§12 实时模式预算→T11/T13；§13 不记 payload→T3/T4 实现约束；M1 遗留六项→T1（五项）+T12（冲突）+T8（code-split）。
- **占位符扫描**：T5 cfg switch、T8 i18n key 集、T10 表单复用为「要点+完整契约」结构，测试与签名完整代码；无 TBD/TODO/"适当处理"。
- **类型一致性**：MsgOut/SessionSpec/SessionState/PubForm/PubResult/ReqForm/ReqResult/TraceForm/TraceHop 在 T2/T3/T6 定义、T7 装配、T8/9/10 消费，字段名一致（json 小写蛇形）；事件名 `session:msgs`/`session:state` 跨任务一致；`stateCh` 旁路机制 T4 定义 T7 接线。
- **运营覆盖**：性能容量（§12 实时吞吐/上屏延迟）→ T11 门槛测试 + T13 实测；并发完整性（seq 单调/丢弃不变式/暂停语义双文本）→ T2/T4 专项测试；失败路径（断线重订阅/JS 无流/无响应者/超时/断开发布）→ T3/T4/T5 测试；可观测（不记 payload、丢弃计数）→ T3/T4/T13；低配 CI → T11 docker --cpus=2。
- **已知取舍**：前端 jsdom 无法测真实帧率——T9 虚拟化断言 + T11 逻辑吞吐门槛 + T13 实测录屏三层替代，T13 报告必须如实标注测量方法。
