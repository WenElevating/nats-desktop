# NATS 桌面客户端 M3（Streams + Consumers 管理）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M3 里程碑：Streams 页（列表/详情/统计/速率采样、创建/编辑/复制/删除/封存/purge、消息浏览器分页+单条查看/删除/十六进制预览、备份/恢复含进度）+ Consumers 页（列表/详情/统计、创建/编辑/复制/删除/重置、暂停/恢复、拉取预览），外加 M2 终审强制遗留项——订阅会话 header 过滤（Go 侧过滤 + 洪峰守恒验证）与 confirm_level 危险操作确认策略。

**Architecture:** Go 侧新增 `internal/jsadmin` 包：以 **jsm.go（natscli 同款工具箱）为主库**承担 stream/consumer 管理面（Lost 数据、purge 计数、Seal、Pause/Resume、快照备份/恢复均只在此库可用），`jetstream`（nats.go 内嵌）仅承担批量拉取类操作（消息浏览器分页、拉取预览的 Fetch）；句柄按 context 的 `js_domain`/`js_api_prefix` 构造（新增 `internal/jsctx`）。前端新增 `features/streams/` 与 `features/consumers/`，`lib/confirm.tsx` 提供分级确认原语；速率图为纯前端采样 + 手写 SVG sparkline（不新增图表库）。消息浏览器为**无状态按页拉取**：每页创建临时 ephemeral pull 消费者、`FetchNoWait(count+1)`（多取 1 条判定 has_more）、取完即删，前翻/后翻/跳转同一代码路径。

**Tech Stack:** 沿用 M1/M2（Wails v3.0.0-beta.20、Go 1.26、React 18 + TS + Vite、Tailwind v4、shadcn、lucide、zod ^4.6.2、vitest ^5、@tanstack/react-virtual）。**不新增任何依赖**：jsm.go 与 nats.go 均已在 go.mod。前端仅新增 shadcn 组件（table/progress/checkbox，本地生成不引入包）。

**规格依据:** `docs/superpowers/specs/2026-09-11-nats-desktop-v1-spec.md`（v1.1）§6.6/§6.7/§6.12（确认策略）/§7/§8.2（JetStream API 错误码与超时）/§8.5/§11/§12/§18，AC-008~012、AC-028、AC-029（浏览器半边）。M2 验收记录 §6 遗留清单按下方处置表并入（header 过滤为终审裁定强制项；集群 hop trace 测试按 M2 记录原文「M3 集群功能时补」归入集群里程碑 M5，非本里程碑范围——已在此显式记录裁定）。

**M2 遗留处置表（验收记录 §6 逐项）：**

| M2 遗留项 | 处置 |
|---|---|
| 规格偏差表：会话 header 过滤 | **本计划 Task 7 实现 + 洪峰验证（强制）** |
| §6-1 CreateSession 复活路径 | Task 7（前端 gate + 断连禁用/重连恢复） |
| §6-4 PushMode $zero 枚举 | Global 11 + Task 10 测试 1「0 值字段显式发送」 |
| §6-7 header 行/HopNode index key | Task 7 过滤行用 `useId()`；**既有 PubPanel/TracePanel 的 index key 迁移不在本里程碑**（M2 已裁定当前追加/删除模式正确，重排场景才需换）→ 归 M6 保洁 |
| §6-9 start_seq 前端下限 | Task 7（`min={1}`） |
| §6-13 code-split | Task 9/12 lazy 页延续 |
| §6-3 trace 集群测试 / §6.11 集群功能 | 归 M5 集群里程碑（显式裁定） |
| §6-2/6/8/10/11/12 及其余子项（mode new 前端知晓已实现、fireNow 收敛、cctxNC 死字段注释、DEFAULT_BUFFER 水合、closed 保留断言、context mtime 竞态、超时映射 errors.Is、bench CI 缓存、emit 顺序文档、update_check remount） | 均为 Minor 保洁/文档项，**归 M6 清理任务**（不在本计划伪装覆盖） |

## Global Constraints

来自规格 v1.1 与 M2 终审的硬约束（值逐字取自规格/验收记录）：

1. **JetStream 不可用指引（§6.6 异常 + §8.2.1）**：账户无 JetStream 或域配置错误时，必须显示 JetStream 不可用说明与排查建议（检查 domain/api_prefix），**不得显示空列表误导用户**。实现：列表结果带 `unavailable_reason`（闭集：`no_responders`/`timeout`/`server`），前端渲染指引面板。
2. **JS API 错误处理（§8.2.1）**：404 资源不存在 → 刷新列表并提示资源不存在（`not_found`）；400 参数无效 → 表单内联展示服务器描述；500 → 展示原文可重试。所有失败调用的错误经 `error_code` 闭集（`not_connected`/`js_unavailable`/`not_found`/`validation`/`server`/`cancelled`）+ 服务器错误原文返回。
3. **超时与重试（§8.2.2）**：请求超时默认 5,000ms（设置 `request_timeout_seconds` 可调 1,000–60,000ms）；**管理操作重试 0 次**（变更操作不自动重试，避免重复生效）；查询类请求重试 1 次（仅超时类失败）。jsm 句柄以 `jsm.WithTimeout(设置值)` 构造（本里程碑 List/Detail 查询超时类失败由前端手动刷新承接「重试 1 次」，Go 侧不内置重试循环）。
4. **危险操作分级（§6.6 处理逻辑 + AC-010）**：删除 stream = 二级确认（输入名称，名称不匹配拒绝执行且对话框保持打开）；purge / 删单条 / 封存 / 消费者删除与重置 = 一级确认。`confirm_level`（§6.12，`standard|relaxed`）：`relaxed` 时一级确认直接执行；**二级名称匹配确认任何级别都强制**。
5. **消息浏览器（§6.6 + AC-009/AC-028/AC-029）**：按序列区间分页拉取；每页条数默认 50（可选 20/50/100/200）；点击单条展示 headers/payload 完整内容；单条 >1MB 仅展示元数据与十六进制预览并提供下载；删除后消息数减 1、删除处序列出现空洞标记（前端按页内 seq 空洞渲染）；500 streams 列表 ≤500ms（高配）/≤1.5s（低配）；10,000 streams 虚拟列表滚动 ≥60fps/≥30fps；含 1,000,000 消息的 stream 尾页加载 ≤1s（高配）。
6. **消费者管理（§6.7）**：投递模式 pull/push、确认模式 explicit/none/all、回放策略 all/last/start_sequence/start_time/new 均为闭集；拉取预览批量 1–256、默认不自动 ack；暂停中的消费者必须禁用拉取按钮并显示暂停原因与剩余暂停时长（`PauseRemaining`）；表单参数越界须内联显示范围说明、不发起请求（前端 zod + Go 双保险）；消费者被外部删除 → 刷新列表并提示不存在。暂停/恢复与优先级组需服务器 ≥2.11（`internal/natsver` 门，Go 侧发请求前拦截）。§6.7 列表列「丢失数」裁定：NATS 服务器无消费者级丢失计数器，该列由 NumRedelivered（红位数/重投）承载并在 UI 文档化（Task 15 验收记录记裁定）。
7. **备份/恢复（§6.6 异常 + §20.1）**：备份到用户选择的本地目录（原生目录选择对话框），有确认进度与完成提示；备份中连接断开 → 停止备份、保留已完成分片、标记**不完整**，不得声称完整；恢复目标已存在 → 必须先确认覆盖语义（删除重建）后才继续。备份产物为 jsm 目录格式（`stream.tar.s2` + `backup.json`）。
8. **会话 header 过滤（M2 验收记录 §6 规格偏差表，终审强制）**：「M3 计划须含实现与洪峰下过滤性能验证」。Go 侧过滤（靠近源头）：可选 `header_filters`（key→value 精确匹配，AND 语义，≤8 组），不匹配消息计入 `filtered` 计数，**不进环形缓冲、不推送、不计速率**；守恒不变式扩展为 `received == delivered_total + filtered`（M2 原不变式 `Total==Emitted ∧ Total==Dropped+BufferUsed` 对 delivered 部分原样保留）；洪峰下过滤性能验证 = 50k msg/s 量级注入 + 过滤开启时守恒与速率不塌陷（Task 7/14）。
9. **性能预算（§12）**：列表加载 500 streams ≤500ms/≤1.5s；大列表滚动 10k streams ≥60fps/≥30fps；操作视觉反馈 ≤100ms 双档；尾页加载 ≤1s（高配）。
10. **推送/事件契约（§8.5）**：新增事件仅 `stream:backup`（载荷 `{stream, direction: backup|restore, phase: running|complete|incomplete, bytes_done, bytes_total, chunks_done}`，单 goroutine 顺序发射，无跨事件顺序问题）；既有 `session:msgs`/`session:state` 契约仅做**加法扩展**（`session:state` 增加 `filtered` 字段；`session:msgs` 不变）。跨边界全部 wire 类型小写蛇形 json 标签（既有 M2 契约）。
11. **枚举零值（M2 遗留 §6-4）**：前端**绝不发送**空字符串枚举值（`PushMode $zero=""` 教训同样适用于 storage/retention/ack_policy/deliver_policy 等——表单默认显式值）。
12. **消息与凭证不入日志（§13.3 + M2 延续）**：浏览器/备份路径日志只记 subject/size/seq/字节数/分片数，**payload 内容与凭证内容一律不入日志**。
13. **UI 规范（§18.2/§18.5）**：图标一律 lucide SVG，禁 emoji；payload/JSON/subject 等宽字体；点击到加载态/反馈 ≤100ms；失败 toast + 可展开服务器原文；空态引导；主题三态适配（浅/深/跟随系统）。
14. **i18n（AC-021）**：新增 `streams.*`、`consumers.*`、`settings.confirmLevel*`、`messages.sessions.filter*` 命名空间及 `common.nameMatchTitle`（二级确认标题，Task 8）en/zh-CN 双侧同步（完整性门禁缺失即构建失败）。
15. **JS 句柄定位**：context 的 `jetstream_domain` 非空 → `jsm.WithDomain` / `jetstream.NewWithDomain`；否则 `jetstream_api_prefix` 非空 → `jsm.WithAPIPrefix` / `jetstream.NewWithAPIPrefix`；两者都空用默认。经 `connections.Manager.JSParams()` 从活跃 context 读取。
16. **依赖版本**：不新增 Go 模块依赖、不新增前端 npm 依赖（shadcn 组件本地生成）。jsm.go v0.4.2-0.20260907110945、nats.go v1.53.1 不变。
17. **真服务器测试（用户 2026-09-11 指令）**：单元/性能/压力/并发测试必须连接本地 nats 服务（`nats://127.0.0.1:4333`，`requireLocalServer` 2s 探测 + skip 模式）与内嵌服务器双路径；命名沿用 `<Area><Behavior>LocalServer` 后缀。
18. **提交纪律**：conventional commits，每任务红→绿→提交；Go 侧任务完成后 `wails3 generate bindings -ts -clean=true` 并提交 bindings/（CRLF 噪声 `git restore` 处理，不提交虚假 churn）。
19. **分支**：`desktop/m3`（自 main 切出）。

## File Structure

```
desktop/
├── internal/
│   ├── natsver/natsver.go            # 新包：服务器版本比较（自 messaging/trace.go 抽取）（Task 1）
│   ├── jsctx/jsctx.go                # 新包：JS 句柄构造（jsm.Manager + jetstream.JetStream，按 domain/prefix）（Task 1）
│   ├── connections/manager.go        # 修改：+JSParams()（Task 1）
│   ├── testutil/server.go            # 修改：+ConnectLocalServer(t) 助手（Task 1）
│   ├── messaging/
│   │   ├── pipeline.go               # 修改：+HeadersMatchFilters（纯逻辑）（Task 7）
│   │   ├── sessions.go               # 修改：过滤接入收流路径 + SessionState.Filtered（Task 7）
│   │   ├── service.go                # 修改：CreateSession 表单 +header_filters（Task 7）
│   │   └── trace.go                  # 修改：版本比较改用 natsver（Task 1）
│   └── jsadmin/                      # 新包：JetStream 管理面
│       ├── types.go                  # wire 契约 + 错误码闭集（Task 2 定义、后续共用）
│       ├── forms.go                  # 表单校验/映射/摘要组装（纯逻辑）（Task 2）
│       ├── streams.go                # stream 列表/详情/创建/更新/复制/删除/purge/封存（Task 3）
│       ├── browser.go                # 消息浏览器分页/单条/删单条（Task 4）
│       ├── consumers.go              # consumer 全生命周期 + 暂停/恢复/重置（Task 5）
│       ├── backup.go                 # 备份/恢复 + 进度事件 + 目录选择（Task 6）
│       ├── service.go                # Wails 绑定门面（Task 3 起逐任务扩展）
│       └── *_test.go                 # 内嵌 + LocalServer 双路径测试
├── main.go                           # 修改：注册 JetAdminService（Task 3）
└── frontend/
    ├── src/
    │   ├── lib/
    │   │   ├── confirm.tsx           # ConfirmProvider + useConfirm（一级/二级名称匹配）（Task 8）
    │   │   └── bindings.ts           # 修改：jsadmin 再导出（Task 9 起随任务）
    │   ├── features/
    │   │   ├── streams/
    │   │   │   ├── StreamsPage.tsx   # 工具栏+列表+详情布局（Task 9）
    │   │   │   ├── StreamList.tsx    # 虚拟化表格（Task 9）
    │   │   │   ├── StreamDetail.tsx  # 统计/配置/镜像/集群 + 速率 sparkline + 操作入口（Task 9）
    │   │   │   ├── Sparkline.tsx     # SVG 折线（Task 9）
    │   │   │   ├── rates.ts          # 纯逻辑采样器（Task 9）
    │   │   │   ├── useStreams.ts     # 列表/详情轮询 + 操作 hook（Task 9）
    │   │   │   ├── StreamForm.tsx    # 创建/编辑/复制表单（Task 10）
    │   │   │   ├── StreamMsgs.tsx    # 消息浏览器面板（Task 11）
    │   │   │   └── schema.ts         # zod（Task 10）
    │   │   ├── consumers/
    │   │   │   ├── ConsumersPage.tsx # stream 选择 + 列表 + 详情（Task 12）
    │   │   │   ├── ConsumerForm.tsx  # 创建/编辑/复制表单（Task 12）
    │   │   │   ├── NextPreview.tsx   # 拉取预览面板（Task 12）
    │   │   │   ├── schema.ts         # zod（Task 12）
    │   │   │   └── useConsumers.ts   # 数据 hook（Task 12）
    │   │   └── messages/             # 修改：SessionsPanel 过滤行/稳定 key/创建再门控（Task 7）
    │   ├── features/settings/SettingsPage.tsx  # 修改：+confirm_level 控件（Task 8）
    │   ├── App.tsx                   # 修改：streams/consumers 占位换 lazy 页（Task 9/12）
    │   └── locales/en.json, zh-CN.json # 双侧新增 key（Task 7 起）
    ├── components/ui/{table,progress,checkbox}.tsx  # shadcn add（Task 9）
    ├── tests/{confirm,streams-*,consumers-*}.test.tsx  # 组件测试
    └── tests/bench/streams.bench.ts  # 10k 行渲染基准（Task 14）
.github/workflows/desktop-ci.yml      # 修改：bench job 增 streams 基准（Task 14）
docs/superpowers/plans/2026-09-12-nats-desktop-m3-acceptance.md  # Task 15
docs/superpowers/plans/2026-09-12-nats-desktop-m3-test-report.md # Task 15
```

职责边界：`natsver`/`jsctx` 零业务状态；`jsadmin/forms.go` 纯逻辑零 NATS 依赖（100% 单测）；`streams.go`/`consumers.go`/`backup.go` 各管一个资源面；`browser.go` 只管分页拉取；`service.go` 只做绑定门面与参数搬运。`rates.ts`/`confirm.tsx` 前端纯逻辑同样独立可测。

---

### Task 1: 共享基建（natsver 抽取 / jsctx 句柄 / Manager.JSParams / LocalServer 助手）

**Files:**
- Create: `desktop/internal/natsver/natsver.go`、`desktop/internal/natsver/natsver_test.go`、`desktop/internal/jsctx/jsctx.go`、`desktop/internal/jsctx/jsctx_test.go`
- Modify: `desktop/internal/messaging/trace.go`（版本比较改用 natsver）、`desktop/internal/messaging/trace_test.go`（对应断言迁移）、`desktop/internal/connections/manager.go`（+JSParams）、`desktop/internal/connections/manager_test.go`（+测试）、`desktop/internal/testutil/server.go`（+ConnectLocalServer）

**Interfaces:**
- Consumes: M2 既有 `internal/messaging/trace.go` 的 `versionComponents`/`serverVersionAtLeast`/`semVerRe`（trace.go:61-95）；`connections.Manager` 的 `mu/active/reg/state` 字段与 `StateConnected`；`natscontext.Registry.Load(ctx, name) (*Context, error)`。
- Produces（后续所有任务依赖，签名逐字）:
  - `natsver.ServerAtLeast(version string, major, minor, patch int) (bool, error)`——version 形如 "2.15.0-preview.1"；解析失败返回错误。
  - `jsctx.New(nc *nats.Conn, domain, apiPrefix string) (jetstream.JetStream, error)` 与 `jsctx.NewManager(nc *nats.Conn, domain, apiPrefix string, timeout time.Duration) (*jsm.Manager, error)`——domain 非空走 WithDomain，否则 prefix 非空走 WithAPIPrefix，都空走默认。
  - `(*connections.Manager).JSParams() (domain, apiPrefix string, ok bool)`——未连接返回 ok=false。
  - `testutil.ConnectLocalServer(t *testing.T) *nats.Conn`——连接 `nats://127.0.0.1:4333`，2s 探测失败 `t.Skipf`（jsadmin 系测试的统一入口；messaging 既有 requireLocalServer 不动，避免 M2 churn）。

- [ ] **Step 1: 写失败的测试（natsver_test.go）**

```go
package natsver

import "testing"

func TestServerAtLeast(t *testing.T) {
	cases := []struct {
		version string
		maj     int
		min     int
		pat     int
		want    bool
	}{
		{"2.15.0-preview.1", 2, 11, 0, true},
		{"2.11.0", 2, 11, 0, true},
		{"2.10.24", 2, 11, 0, false},
		{"2.11.0", 2, 11, 1, false},
		{"v2.9.1", 2, 10, 0, false},
	}
	for _, c := range cases {
		got, err := ServerAtLeast(c.version, c.maj, c.min, c.pat)
		if err != nil {
			t.Fatalf("%s: %v", c.version, err)
		}
		if got != c.want {
			t.Fatalf("%s >= %d.%d.%d: got %v want %v", c.version, c.maj, c.min, c.pat, got, c.want)
		}
	}
}

func TestServerAtLeastInvalid(t *testing.T) {
	if _, err := ServerAtLeast("not-a-version", 2, 11, 0); err == nil {
		t.Fatal("expected error for unparseable version")
	}
}
```

- [ ] **Step 2: 红灯 → 从 trace.go 抽取实现**

把 `messaging/trace.go` 的 `semVerRe`、`versionComponents`、`serverVersionAtLeast` 整体移入新包并导出为 `ServerAtLeast`（内部保留 `versionComponents` 小写）；`messaging/trace.go` 删除原实现、改调 `natsver.ServerAtLeast`（trace.go 的调用点 `serverVersionAtLeast(v, 2, 11, 0)` → `natsver.ServerAtLeast(v, 2, 11, 0)`）。`messaging/trace_test.go` 中 `TestTraceVersionCheck` 的版本表断言迁移到 `natsver_test.go`（上表即其超集），messaging 侧仅保留「trace 对旧版本返回 ErrTraceOldServer」的行为测试。

- [ ] **Step 3: jsctx 测试 + 实现（jsctx_test.go 先行）**

```go
package jsctx

import (
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"desktop/internal/testutil"
)

func TestNewManagerDefaults(t *testing.T) {
	nc, err := nats.Connect(testutil.StartJSServer(t))
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	mgr, err := NewManager(nc, "", "", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !mgr.IsJetStreamEnabled() {
		t.Fatal("expected JetStream enabled on test server")
	}
}

func TestNewRespectsPrefix(t *testing.T) {
	nc, err := nats.Connect(testutil.StartJSServer(t))
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	// 错误前缀：JS API 不可达 → 账户信息报 no responders
	mgr, err := NewManager(nc, "", "$WRONG.API", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if mgr.IsJetStreamEnabled() {
		t.Fatal("expected unavailable with wrong prefix")
	}
	js, err := New(nc, "", "$WRONG.API")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.AccountInfo(t.Context()); err == nil {
		t.Fatal("expected account info failure with wrong prefix")
	}
}
```

实现（`jsctx.go`）：

```go
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
```

- [ ] **Step 4: JSParams 测试 + 实现（manager_test.go 追加）**

```go
func TestJSParams(t *testing.T) {
	url := testutil.StartJSServer(t)
	m, rec, store := newRecordingManager(t) // connections 既有助手（manager_test.go:67）：(*Manager, *eventRecorder, *Store)
	if _, _, ok := m.JSParams(); ok {
		t.Fatal("no params before connect")
	}
	saveContext(t, store, "demo", url, func(f *ContextForm) { f.JSDomain = "HUB" })
	if err := m.Connect(context.Background(), "demo"); err != nil {
		t.Fatal(err)
	}
	waitForState(t, rec, StateConnected, 5*time.Second)
	domain, prefix, ok := m.JSParams()
	if !ok || domain != "HUB" || prefix != "" {
		t.Fatalf("got (%q,%q,%v)", domain, prefix, ok)
	}
	m.Disconnect()
	waitForState(t, rec, StateDisconnected, 5*time.Second)
	if _, _, ok := m.JSParams(); ok {
		t.Fatal("params must be unavailable after disconnect")
	}
}
```

实现（追加到 manager.go）：

```go
// JSParams returns the JetStream domain and API prefix configured on the
// active context ("" when unset). ok is false when not connected.
func (m *Manager) JSParams() (domain, apiPrefix string, ok bool) {
	m.mu.Lock()
	name := m.active
	connected := m.state == StateConnected
	m.mu.Unlock()
	if !connected || name == "" {
		return "", "", false
	}
	c, err := m.reg.Load(context.Background(), name)
	if err != nil {
		return "", "", true // connected: fall back to defaults, load errors surface in ops
	}
	return c.JSDomain(), c.JSAPIPrefix(), true
}
```

- [ ] **Step 5: testutil.ConnectLocalServer（server.go 追加）**

```go
// LocalServerURL is the long-lived local test server (user-mandated real
// server for unit/perf/stress tests; monitor endpoint :8333/jsz).
const LocalServerURL = "nats://127.0.0.1:4333"

// ConnectLocalServer connects to the local server or skips the test when
// it is not running (2s probe), mirroring messaging's requireLocalServer.
func ConnectLocalServer(t *testing.T) *nats.Conn {
	t.Helper()
	nc, err := nats.Connect(LocalServerURL, nats.Timeout(2*time.Second), nats.MaxReconnects(0))
	if err != nil {
		t.Skipf("local server %s not running: %v", LocalServerURL, err)
	}
	t.Cleanup(func() { nc.Close() })
	return nc
}
```

- [ ] **Step 6: 验证 + 提交**

```bash
go test ./internal/natsver/ ./internal/jsctx/ ./internal/connections/ ./internal/messaging/ -v && go vet ./...
git add -A && git commit -m "feat(desktop): natsver + jsctx shared helpers, Manager.JSParams, LocalServer test util"
```

---

### Task 2: jsadmin 契约类型与表单映射（纯逻辑）

**Files:**
- Create: `desktop/internal/jsadmin/types.go`、`desktop/internal/jsadmin/forms.go`、`desktop/internal/jsadmin/forms_test.go`

**Interfaces:**
- Consumes: `jsm.go/api` 类型（`api.StreamInfo/StreamConfig/StreamState/ConsumerInfo/ConsumerConfig/ClusterInfo/PeerInfo/StreamSourceInfo`，字段名见下述映射代码）。
- Produces（Task 3–13 全部依赖，签名逐字）:
  - `CallResult{ErrorCode, Error string}`（错误码闭集常量 `CodeNotConnected/CodeJSUnavailable/CodeNotFound/CodeValidation/CodeServer/CodeCancelled`）；`ClassifyError(err error) CallResult`。
  - `StreamSummary`、`StreamDetail{Summary, Form, CreatedMs, State StreamStateOut, Mirror *SourceInfo, Sources []SourceInfo, Cluster *ClusterOut}`、`StreamForm`、`StreamSourceForm`。
  - `ValidateStreamForm(f *StreamForm) error`、`StreamFormToConfig(f *StreamForm) api.StreamConfig`、`MergeStreamUpdate(existing api.StreamConfig, f *StreamForm) api.StreamConfig`。
  - `BuildStreamSummary(name string, cfg api.StreamConfig, st api.StreamState, cluster *api.ClusterInfo) StreamSummary`、`BuildStreamDetail(info api.StreamInfo) StreamDetail`。
  - `BrowserMsg`、`BrowserPageRequest`、`BrowserPageResult`、`GetMsgResult`；`EncodeBrowserMsg(subject string, hdr []byte, data []byte, seq uint64, ts time.Time) BrowserMsg`（headers 解码 + is_utf8 + b64）。
  - `ConsumerSummary`、`ConsumerDetail`、`ConsumerForm`、`NextMsg`、`PauseResult`；sentinel `ErrNeedsServer211 = errors.New("requires NATS Server 2.11 or newer")`（forms.go 定义；Task 5 服务层与 `pauseGate` 复用）；`ValidateConsumerForm(f *ConsumerForm, editing bool) error`（PriorityGroups 非空 → 返回 ErrNeedsServer211）、`ConsumerFormToConfig(f *ConsumerForm) api.ConsumerConfig`、`BuildConsumerSummary(info api.ConsumerInfo) ConsumerSummary`。

- [ ] **Step 1: 写失败的测试（forms_test.go 核心用例）**

```go
package jsadmin

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/nats-io/jsm.go/api"
)

func TestValidateStreamForm(t *testing.T) {
	valid := StreamForm{Name: "ORDERS", Subjects: []string{"orders.>"}, Storage: "file", Retention: "limits", Replicas: 1}
	if err := ValidateStreamForm(&valid); err != nil {
		t.Fatalf("valid form rejected: %v", err)
	}
	bad := []StreamForm{
		{Name: "", Subjects: []string{"a"}, Storage: "file", Retention: "limits"},                // 空名
		{Name: "has space", Subjects: []string{"a"}, Storage: "file", Retention: "limits"},        // 名称含空格
		{Name: "S", Subjects: nil, Storage: "file", Retention: "limits"},                          // 非 mirror 无 subjects
		{Name: "S", Subjects: []string{"a"}, Storage: "redis", Retention: "limits"},               // storage 闭集
		{Name: "S", Subjects: []string{"a"}, Storage: "file", Retention: "forever"},               // retention 闭集
		{Name: "S", Subjects: []string{"a"}, Storage: "file", Retention: "limits", Replicas: 9},   // 副本 1–5
		{Name: "S", Subjects: []string{"a"}, Storage: "file", Retention: "limits", MaxMsgs: -2},   // 数值 < -1
		{Name: "S", Subjects: []string{"a"}, Storage: "file", Retention: "limits", MaxAgeSeconds: -1},
	}
	for i := range bad {
		if err := ValidateStreamForm(&bad[i]); err == nil {
			t.Fatalf("case %d accepted invalid form", i)
		}
	}
	mirror := StreamForm{Name: "M", Storage: "file", Retention: "limits", Replicas: 1,
		Mirror: &StreamSourceForm{Name: "upstream"}}
	if err := ValidateStreamForm(&mirror); err != nil {
		t.Fatalf("mirror without subjects must be allowed: %v", err)
	}
}

func TestStreamFormToConfigRoundTrip(t *testing.T) {
	f := StreamForm{Name: "ORDERS", Description: "d", Subjects: []string{"orders.>"},
		Storage: "file", Retention: "workqueue", MaxMsgs: -1, MaxBytes: 1024,
		MaxAgeSeconds: 3600, MaxMsgsPerSubject: 10, Replicas: 2,
		PlacementCluster: "cl-a", PlacementTags: []string{"tier"}} // 0 值字段留在服务端默认
	cfg := StreamFormToConfig(&f)
	if cfg.Name != "ORDERS" || cfg.Storage != api.FileStorage || cfg.Retention != api.WorkQueuePolicy {
		t.Fatalf("mapping wrong: %+v", cfg)
	}
	if cfg.MaxMsgs != -1 || cfg.MaxBytes != 1024 || cfg.MaxAge != time.Hour || cfg.MaxMsgsPer != 10 {
		t.Fatalf("limits mapping wrong: %+v", cfg)
	}
	if cfg.Placement == nil || cfg.Placement.Cluster != "cl-a" || len(cfg.Placement.Tags) != 1 {
		t.Fatalf("placement mapping wrong")
	}
	if cfg.MaxConsumers != 0 || cfg.Duplicates != 0 {
		t.Fatalf("unmanaged fields must stay zero on create")
	}
}

func TestMergeStreamUpdatePreservesServerSide(t *testing.T) {
	existing := api.StreamConfig{Name: "ORDERS", Subjects: []string{"orders.>"},
		Storage: api.FileStorage, Retention: api.LimitsPolicy, Replicas: 1,
		MaxConsumers: 7, Duplicates: 2 * time.Minute, Sealed: false}
	form := StreamForm{Name: "ORDERS", Description: "edited", Subjects: []string{"orders.>", "orders2.>"},
		Storage: "file", Retention: "limits", MaxMsgs: 5, Replicas: 1}
	merged := MergeStreamUpdate(existing, &form)
	if merged.Description != "edited" || merged.MaxMsgs != 5 {
		t.Fatalf("form fields must apply: %+v", merged)
	}
	if merged.MaxConsumers != 7 || merged.Duplicates != 2*time.Minute {
		t.Fatalf("server-managed fields must survive: %+v", merged)
	}
	if merged.Sealed {
		t.Fatal("form path must never seal")
	}
}

func TestBuildStreamSummary(t *testing.T) {
	st := api.StreamState{Msgs: 10, Bytes: 100, FirstSeq: 1, LastSeq: 12, NumDeleted: 2,
		LastTime: time.Unix(1700000000, 0), Lost: &api.LostStreamData{Msgs: []uint64{3}, Bytes: 30}}
	cfg := api.StreamConfig{Name: "KV_bucket", Subjects: []string{"$KV.bucket.>"}, Storage: api.FileStorage, Retention: api.LimitsPolicy}
	cluster := &api.ClusterInfo{Leader: "n1", Replicas: []*api.PeerInfo{
		{Name: "n2", Current: true}, {Name: "n3", Current: false, Offline: true}}}
	s := BuildStreamSummary("KV_bucket", cfg, st, cluster)
	if s.InternalKind != "kv" || s.Messages != 10 || s.NumDeleted != 2 || s.LostMsgs != 1 || s.LostBytes != 30 {
		t.Fatalf("summary wrong: %+v", s)
	}
	if s.UnhealthyReplicas != 1 || s.LeaderMissing || s.ReplicaCount != 3 {
		t.Fatalf("cluster wrong: %+v", s)
	}
	if s.LastTimeMs != 1700000000000 {
		t.Fatalf("ms epoch wrong: %d", s.LastTimeMs)
	}
}

func TestWireTagsAreSnakeCase(t *testing.T) {
	b, _ := json.Marshal(StreamSummary{Name: "x"})
	if string(b) != `{"name":"x","description":"","internal_kind":"","subjects":null,"storage":"","retention":"","messages":0,"bytes":0,"consumers":0,"first_seq":0,"last_seq":0,"last_time_ms":0,"lost_msgs":0,"lost_bytes":0,"num_deleted":0,"is_mirror":false,"is_source":false,"leader_missing":false,"unhealthy_replicas":0,"replica_count":0}` {
		t.Fatalf("wire contract drifted: %s", b)
	}
}

func TestClassifyError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"no responders", nats.ErrNoResponders, CodeJSUnavailable},
		{"deadline", context.DeadlineExceeded, CodeServer},
		{"api 404", api.ApiError{Code: 404, Description: "not found"}, CodeNotFound},
		{"api 400", api.ApiError{Code: 400, Description: "bad config"}, CodeValidation},
		{"api 500", api.ApiError{Code: 500, Description: "boom"}, CodeServer},
		{"jetstream 404 consumer", jetstream.ErrConsumerNotFound, CodeNotFound},
		{"jetstream 404 stream", jetstream.ErrStreamNotFound, CodeNotFound},
		{"jetstream not pull", jetstream.ErrNotPullConsumer, CodeValidation},
		{"other", errors.New("whatever"), CodeServer},
	}
	for _, c := range cases {
		if got := ClassifyError(c.err).ErrorCode; got != c.want {
			t.Fatalf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}
```

（`jetstream.ErrConsumerNotFound` 等为 nats.go jetstream 包自带 sentinel（errors.go:281 邻域，均实现 `JetStreamError` 接口且 APIError Code 404/400）——注意它们**不是** `api.ApiError`，这正是 ClassifyError 必须双分支的原因：jsm 路径抛 `api.ApiError`，jetstream 路径（浏览器/预览）抛 `jetstream.JetStreamError`。）

- [ ] **Step 2: 红灯 → 实现 types.go**

`types.go` 完整内容（错误码常量 + 全部 wire 类型，全蛇形标签）：

```go
// Package jsadmin implements the JetStream management surface (spec
// §6.6/§6.7): streams, message browsing, consumers, backup/restore.
package jsadmin

import "time"

// Error codes crossing the IPC boundary (spec §8.5.2 / §8.2.1 closed set).
const (
	CodeOK            = ""
	CodeNotConnected  = "not_connected"
	CodeJSUnavailable = "js_unavailable"
	CodeNotFound      = "not_found"
	CodeValidation    = "validation"
	CodeServer        = "server"
	CodeCancelled     = "cancelled"
)

// CallResult is embedded in every bound-call result; Ok is true iff
// ErrorCode is empty.
type CallResult struct {
	ErrorCode string `json:"error_code"`
	Error     string `json:"error"` // server原文 for server/validation errors
}

func (r CallResult) Ok() bool { return r.ErrorCode == CodeOK }

func fail(code, msg string) CallResult { return CallResult{ErrorCode: code, Error: msg} }

// UnavailableReason tokens for list endpoints (guidance panel, spec §6.6).
const (
	ReasonNoResponders = "no_responders"
	ReasonTimeout      = "timeout"
	ReasonServer       = "server"
)

type StreamSummary struct {
	Name              string   `json:"name"`
	Description       string   `json:"description"`
	InternalKind      string   `json:"internal_kind"` // "" | "kv" | "object" (KV_/O_ 前缀)
	Subjects          []string `json:"subjects"`
	Storage           string   `json:"storage"`    // file | memory
	Retention         string   `json:"retention"` // limits | interest | workqueue
	Messages          uint64   `json:"messages"`
	Bytes             uint64   `json:"bytes"`
	Consumers         int      `json:"consumers"`
	FirstSeq          uint64   `json:"first_seq"`
	LastSeq           uint64   `json:"last_seq"`
	LastTimeMs        int64    `json:"last_time_ms"`
	LostMsgs          int      `json:"lost_msgs"`
	LostBytes         uint64   `json:"lost_bytes"`
	NumDeleted        int      `json:"num_deleted"`
	IsMirror          bool     `json:"is_mirror"`
	IsSource          bool     `json:"is_source"`
	LeaderMissing     bool     `json:"leader_missing"`
	UnhealthyReplicas int      `json:"unhealthy_replicas"`
	ReplicaCount      int      `json:"replica_count"`
}

type StreamStateOut struct {
	FirstTimeMs int64  `json:"first_time_ms"`
	LastTimeMs  int64  `json:"last_time_ms"`
	NumSubjects uint64 `json:"num_subjects"`
}

type SourceInfo struct {
	Name          string `json:"name"`
	Lag           uint64 `json:"lag"`
	ActiveMs      int64  `json:"active_ms"` // -1 = 无活动（jsm 语义映射）
	FilterSubject string `json:"filter_subject"`
	OptStartSeq   uint64 `json:"opt_start_seq"`
	Error         string `json:"error,omitempty"`
}

type PeerOut struct {
	Name      string `json:"name"`
	Current   bool   `json:"current"`
	Offline   bool   `json:"offline"`
	ActiveMs  int64  `json:"active_ms"`
	Lag       uint64 `json:"lag"`
}

type ClusterOut struct {
	Name        string   `json:"name"`
	RaftGroup   string   `json:"raft_group"`
	Leader      string   `json:"leader"`
	LeaderSinceMs int64  `json:"leader_since_ms"` // 0 = unknown
	Peers       []PeerOut `json:"peers"`
}

type StreamDetail struct {
	CallResult
	Summary   StreamSummary  `json:"summary"`
	Form      StreamForm     `json:"form"` // 编辑/复制的表单回显
	CreatedMs int64          `json:"created_ms"`
	State     StreamStateOut `json:"state"`
	Mirror    *SourceInfo    `json:"mirror"`
	Sources   []SourceInfo   `json:"sources"`
	Cluster   *ClusterOut    `json:"cluster"`
}

// StreamForm: 数值字段 0 = 不设置（服务器默认），-1 = 无限制（max_age_seconds 除外，仅 ≥0）。
type StreamForm struct {
	Name              string             `json:"name"`
	Description       string             `json:"description"`
	Subjects          []string           `json:"subjects"`
	Storage           string             `json:"storage"`   // file | memory
	Retention         string             `json:"retention"` // limits | interest | workqueue
	MaxMsgs           int64              `json:"max_msgs"`
	MaxBytes          int64              `json:"max_bytes"`
	MaxAgeSeconds     int64              `json:"max_age_seconds"`
	MaxMsgsPerSubject int64              `json:"max_msgs_per_subject"`
	Replicas          int                `json:"replicas"` // 1–5，0 视为 1
	PlacementCluster  string             `json:"placement_cluster"`
	PlacementTags     []string           `json:"placement_tags"`
	Mirror            *StreamSourceForm  `json:"mirror"`
	Sources           []StreamSourceForm `json:"sources"`
}

type StreamSourceForm struct {
	Name          string `json:"name"`
	FilterSubject string `json:"filter_subject"`
	OptStartSeq   uint64 `json:"opt_start_seq"`
}

type ListStreamsResult struct {
	CallResult
	Streams           []StreamSummary `json:"streams"`            // 失败时 nil
	UnavailableReason string          `json:"unavailable_reason"` // 非空 → 前端渲染指引面板
}

type PurgeResult struct {
	CallResult
	Purged uint64 `json:"purged"`
}

type BrowserPageRequest struct {
	Stream        string `json:"stream"`
	StartSeq      uint64 `json:"start_seq"`      // 页首序列（含）
	Count         int    `json:"count"`          // 20/50/100/200
	SubjectFilter string `json:"subject_filter"` // 可选；非空时前端禁用"上一页"
}

type BrowserMsg struct {
	Seq         uint64              `json:"seq"`
	Subject     string              `json:"subject"`
	Headers     map[string][]string `json:"headers"`
	PayloadB64  string              `json:"payload_b64"`
	PayloadSize int                 `json:"payload_size"`
	TimestampMs int64               `json:"timestamp_ms"`
	IsUtf8      bool                `json:"is_utf8"`
	// Truncated=true 时 PayloadB64 仅携带前 64KB（行级预览上限），
	// PayloadSize 仍为完整大小；完整内容经 GetStreamMessage / 下载获取。
	// 防止大消息页（如 50×2MB）把单页载荷推到百 MB 级（§6.6「仅展示
	// 元数据与十六进制预览」的 wire 半边）。
	Truncated bool `json:"truncated"`
}

type BrowserPageResult struct {
	CallResult
	Messages    []BrowserMsg `json:"messages"`
	NextStartSeq uint64      `json:"next_start_seq"` // 下一页请求起点（最后一条 seq+1；空页 = StartSeq）
	HasMore     bool         `json:"has_more"`
}

type GetMsgResult struct {
	CallResult
	Msg *BrowserMsg `json:"msg"`
}

type NextMsg struct {
	BrowserMsg
	NumDelivered uint64 `json:"num_delivered"`
	NumPending   uint64 `json:"num_pending"`
}

type PreviewNextResult struct {
	CallResult
	Messages []NextMsg `json:"messages"`
}

type PauseResult struct {
	CallResult
	Paused       bool  `json:"paused"`
	UntilMs      int64 `json:"until_ms"`
	RemainingMs  int64 `json:"remaining_ms"`
}

type ConsumerSummary struct {
	Name                string   `json:"name"`
	Stream              string   `json:"stream"`
	IsPull              bool     `json:"is_pull"`
	IsEphemeral         bool     `json:"is_ephemeral"`
	AckPolicy           string   `json:"ack_policy"`
	DeliverPolicy       string   `json:"deliver_policy"`
	FilterSubjects      []string `json:"filter_subjects"`
	NumPending          uint64   `json:"num_pending"`
	NumAckPending       int      `json:"num_ack_pending"`
	AckFloorConsumer    uint64   `json:"ack_floor_consumer"`
	NumRedelivered      int      `json:"num_redelivered"`
	NumWaiting          int      `json:"num_waiting"`
	DeliveredConsumerSeq uint64  `json:"delivered_consumer_seq"`
	Paused              bool     `json:"paused"`
	PauseRemainingMs    int64    `json:"pause_remaining_ms"`
	CreatedMs           int64    `json:"created_ms"`
	LeaderMissing       bool     `json:"leader_missing"`
	UnhealthyReplicas   int      `json:"unhealthy_replicas"`
	ReplicaCount        int      `json:"replica_count"`
}

type ConsumerDetail struct {
	CallResult
	Summary ConsumerSummary `json:"summary"`
	Form    ConsumerForm    `json:"form"`
	Cluster *ClusterOut     `json:"cluster"`
}

// ConsumerForm: 编辑时 deliver_policy/opt_start_* 由服务端原值回填、UI 禁改。
type ConsumerForm struct {
	Stream                    string   `json:"stream"`
	Durable                   string   `json:"durable"`
	Description               string   `json:"description"`
	DeliverMode               string   `json:"deliver_mode"` // pull | push
	DeliverSubject            string   `json:"deliver_subject"`
	DeliverGroup              string   `json:"deliver_group"`
	FilterSubjects            []string `json:"filter_subjects"`
	AckPolicy                 string   `json:"ack_policy"` // explicit | none | all
	AckWaitSeconds            int64    `json:"ack_wait_seconds"`
	MaxDeliver                int      `json:"max_deliver"`
	MaxWaiting                int      `json:"max_waiting"`
	MaxAckPending             int      `json:"max_ack_pending"`
	MaxRequestBatch           int      `json:"max_request_batch"`
	MaxRequestExpiresSeconds  int64    `json:"max_request_expires_seconds"`
	MaxRequestMaxBytes        int64    `json:"max_request_max_bytes"`
	BackoffSeconds            []int64  `json:"backoff_seconds"`
	ReplayPolicy              string   `json:"replay_policy"` // instant | original
	DeliverPolicy             string   `json:"deliver_policy"` // all | last | new | start_sequence | start_time
	OptStartSeq               uint64   `json:"opt_start_seq"`
	OptStartTimeMs            int64    `json:"opt_start_time_ms"`
	PriorityGroups            []string `json:"priority_groups"`
	HeadersOnly               bool     `json:"headers_only"`
	Replicas                  int      `json:"replicas"`
	MemoryStorage             bool     `json:"memory_storage"`
	InactiveThresholdSeconds  int64    `json:"inactive_threshold_seconds"`
}

type ListConsumersResult struct {
	CallResult
	Consumers         []ConsumerSummary `json:"consumers"`
	UnavailableReason string            `json:"unavailable_reason"`
}

type BackupProgress struct {
	Stream     string `json:"stream"`
	Direction  string `json:"direction"` // backup | restore
	Phase      string `json:"phase"`     // running | complete | incomplete
	BytesDone  uint64 `json:"bytes_done"`
	BytesTotal uint64 `json:"bytes_total"`
	ChunksDone uint32 `json:"chunks_done"`
}
```

- [ ] **Step 3: 实现 forms.go（校验 + 映射 + 摘要 + ClassifyError）**

```go
package jsadmin

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/nats-io/jsm.go/api"
	"github.com/nats-io/nats.go"
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
		Name:          f.Name,
		Description:   f.Description,
		Subjects:      f.Subjects,
		Storage:       storageToAPI(f.Storage),
		Retention:     retentionToAPI(f.Retention),
		MaxMsgs:       f.MaxMsgs,
		MaxBytes:      f.MaxBytes,
		MaxAge:        time.Duration(f.MaxAgeSeconds) * time.Second,
		MaxMsgsPer:    f.MaxMsgsPerSubject,
		Replicas:      replicas,
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
		Name:         name,
		Description:  cfg.Description,
		Subjects:     cfg.Subjects,
		Storage:      storageFromAPI(cfg.Storage),
		Retention:    retentionFromAPI(cfg.Retention),
		Messages:     st.Msgs,
		Bytes:        st.Bytes,
		Consumers:    st.Consumers,
		FirstSeq:     st.FirstSeq,
		LastSeq:      st.LastSeq,
		LastTimeMs:   st.LastTime.UnixMilli(),
		NumDeleted:   st.NumDeleted,
		IsMirror:     cfg.Mirror != nil,
		IsSource:     len(cfg.Sources) > 0,
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
	if cluster != nil {
		s.LeaderMissing = cluster.Leader == ""
		for _, p := range cluster.Replicas {
			if p == nil {
				continue
			}
			s.ReplicaCount++
			if p.Offline || !p.Current {
				s.UnhealthyReplicas++
			}
		}
		if cluster.Leader != "" {
			s.ReplicaCount++ // leader 自身（natscli renderCluster 同口径）
		}
	}
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
```

（`forms.go` 还包含 consumer 侧三个函数，签名见 Interfaces；`ValidateConsumerForm` 规则与 `ConsumerFormToConfig`/`BuildConsumerSummary` 映射按下表实现——本步代码块省略重复样板的枚举转换，但规则为完整闭集：
- 校验：`stream` 非空；`durable` 非空且不含 `. * >`（编辑时空 = 现有名）；`deliver_mode ∈ {pull,push}`，push 要求 `deliver_subject` 非空、pull 禁止 heartbeat 类字段（表单未暴露，天然满足）；`ack_policy ∈ {explicit,none,all}`；`replay_policy ∈ {instant,original}`；`deliver_policy ∈ {all,last,new,start_sequence,start_time}` 且 start_sequence 要求 `opt_start_seq ≥ 1`、start_time 要求 `opt_start_time_ms > 0`；`ack_wait_seconds/max_request_expires_seconds ≥ 0`；`max_deliver/max_waiting/max_ack_pending/max_request_batch ≥ 0`；`backoff_seconds` 每项 ≥1 且 ≤100 项；`priority_groups` 非空 → 返回 `ErrNeedsServer211`（sentinel，服务层映射 validation + "requires server ≥ 2.11"）；`filter_subjects` 每项非空、≤10 项。
- 映射：`deliver_mode=push → DeliverSubject/DeliverGroup`；`deliver_policy → api.DeliverAll/DeliverLast/DeliverNew/DeliverByStartSequence+OptStartSeq/DeliverByStartTime+OptStartTime(*time.Time)`；`ack_policy → api.AckNone/AckAll/AckExplicit`（none 时 MaxDeliver 置 -1，natscli 同款规避）；`replay_policy → api.ReplayInstant/ReplayOriginal`；seconds → time.Duration；`BuildConsumerSummary` 由 `api.ConsumerInfo` 填充全部展示列（`IsPull=IsPullMode()`, `NumPending/NumAckPending/AckFloor.Consumer/NumRedelivered/NumWaiting/Delivered.Consumer`, `Paused/PauseRemaining.Milliseconds()`, 集群同 stream 口径）。
**实现者须为上述每条规则写表驱动断言**（并入 forms_test.go，`TestValidateConsumerForm`/`TestConsumerFormRoundTrip`/`TestBuildConsumerSummary` 三个测试函数，覆盖每条闭集与边界值）。）

- [ ] **Step 4: EncodeBrowserMsg 实现 + 测试**

```go
func EncodeBrowserMsg(subject string, rawHeader, data []byte, seq uint64, ts time.Time) BrowserMsg {
	m := BrowserMsg{
		Seq:         seq,
		Subject:     subject,
		PayloadB64:  base64.StdEncoding.EncodeToString(data),
		PayloadSize: len(data),
		TimestampMs: ts.UnixMilli(),
		IsUtf8:      utf8.Valid(data),
	}
	if len(rawHeader) > 0 {
		if hdr, err := decodeHeaders(rawHeader); err == nil {
			m.Headers = hdr
		}
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
```

测试 `TestEncodeBrowserMsg`：**必须使用带 `NATS/1.0` 前导的真实存储块**（`"NATS/1.0\r\nHdr: v\r\n\r\n"`——api.StoredMsg.Header 即此格式）+ UTF-8 payload → Headers 解析 1 key（`Hdr`，textproto 规范化大小写）、IsUtf8=true、b64 往返；二进制 payload `[]byte{0xff,0xfe}` → IsUtf8=false；空 header 块 → Headers nil；**畸形块**（无前导，如 `"Hdr: v\r\n"`）→ decodeHeaders 返回错误、Headers 为 nil（不 panic）。另补 `TestDecodeHeaders` 直测：状态行带错误码（`"NATS/1.0 503\r\n\r\n"`）→ 空 map 无错误；多值头（`"NATS/1.0\r\nK: a\r\nK: b\r\n\r\n"`）→ `{"K": ["a","b"]}`。

- [ ] **Step 5: 绿灯 + 提交**

```bash
go test ./internal/jsadmin/ -run "TestValidate|TestBuild|TestWire|TestClassify|TestEncode|TestMerge|TestStreamForm" -v
go test ./... && go vet ./...
git add -A && git commit -m "feat(desktop): jsadmin wire types, form validation/mapping, error classification"
```

---

### Task 3: streams 管理服务（列表/详情/创建/更新/复制/删除/purge/封存）

**Files:**
- Create: `desktop/internal/jsadmin/streams.go`、`desktop/internal/jsadmin/service.go`、`desktop/internal/jsadmin/streams_test.go`
- Modify: `desktop/main.go`（注册 JetAdminService）

**Interfaces:**
- Consumes: Task 1 `jsctx.NewManager`/`Manager.JSParams`、Task 2 全部类型与函数；`settings.Load`（`request_timeout_seconds`）。
- Produces（绑定方法，Task 9/10/11/13 前端依赖）: `(s *JetAdminService)` 的 `ListStreams() ListStreamsResult`、`GetStreamDetail(name string) StreamDetail`、`CreateStream(form StreamForm) CallResult`、`UpdateStream(form StreamForm) CallResult`、`CopyStream(src, newName string) CallResult`、`DeleteStream(name string) CallResult`、`PurgeStream(name string, keep, upToSeq uint64, subject string) PurgeResult`、`SealStream(name string) CallResult`。构造器 `NewJetAdminService(mgr *connections.Manager, log *slog.Logger, emit func(name string, data any), settingsPath string) *JetAdminService`。

- [ ] **Step 1: 写失败的测试（streams_test.go 核心链路）**

```go
package jsadmin

import (
	"testing"

	"github.com/nats-io/nats.go"

	"desktop/internal/testutil"
)

func newAdmin(t *testing.T, url string) *JetAdminService // 定义见 Step 3 助手族

func TestStreamLifecycle(t *testing.T) {
	svc := newAdmin(t, testutil.StartJSServer(t))
	form := StreamForm{Name: "ORDERS", Subjects: []string{"orders.>"}, Storage: "file", Retention: "limits", Replicas: 1}
	if res := svc.CreateStream(form); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	list := svc.ListStreams()
	if !list.Ok() || len(list.Streams) != 1 || list.Streams[0].Name != "ORDERS" {
		t.Fatalf("list: %+v", list)
	}
	// 发布 3 条 → 列表计数
	publishN(t, svc, "orders.a", 3)
	list = svc.ListStreams()
	if list.Streams[0].Messages != 3 {
		t.Fatalf("expected 3 messages, got %d", list.Streams[0].Messages)
	}
	// 更新（改动 limits + description）
	form.Description = "edited"
	form.MaxMsgs = 100
	if res := svc.UpdateStream(form); !res.Ok() {
		t.Fatalf("update: %+v", res)
	}
	detail := svc.GetStreamDetail("ORDERS")
	if !detail.Ok() || detail.Form.Description != "edited" || detail.Form.MaxMsgs != 100 {
		t.Fatalf("detail after update: %+v", detail.Form)
	}
	// 复制
	if res := svc.CopyStream("ORDERS", "ORDERS_COPY"); !res.Ok() {
		t.Fatalf("copy: %+v", res)
	}
	// purge（带计数）
	p := svc.PurgeStream("ORDERS", 0, 0, "")
	if !p.Ok() || p.Purged != 3 {
		t.Fatalf("purge: %+v", p)
	}
	if d := svc.GetStreamDetail("ORDERS"); d.Summary.Messages != 0 {
		t.Fatalf("purge must empty stream, got %d", d.Summary.Messages)
	}
	// 封存：sealed 流仍可读取（写路径被服务器拒绝的完整断言属 Task 10 服务器错误透传测试）
	if res := svc.SealStream("ORDERS"); !res.Ok() {
		t.Fatalf("seal: %+v", res)
	}
	if d := svc.GetStreamDetail("ORDERS"); !d.Ok() {
		t.Fatalf("sealed stream must still be readable: %+v", d)
	}
	// 删除（二级确认在 UI 层；服务端一层）
	if res := svc.DeleteStream("ORDERS_COPY"); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	list = svc.ListStreams()
	if len(list.Streams) != 1 { // 只剩 ORDERS
		t.Fatalf("expected 1 stream after delete, got %d", len(list.Streams))
	}
}

func TestListStreamsNotFoundAndUnavailable(t *testing.T) {
	svc := newAdmin(t, testutil.StartJSServer(t))
	if d := svc.GetStreamDetail("NOPE"); d.ErrorCode != CodeNotFound {
		t.Fatalf("expected not_found, got %+v", d.CallResult)
	}
	svc2 := newAdminWithPrefix(t, testutil.StartJSServer(t), "$WRONG.API") // JSParams 替身返回错误前缀
	list := svc2.ListStreams()
	if list.UnavailableReason != ReasonNoResponders || len(list.Streams) != 0 {
		t.Fatalf("expected unavailable guidance, got %+v", list)
	}
}

func TestStreamValidationGates(t *testing.T) {
	svc := newAdmin(t, testutil.StartJSServer(t))
	if res := svc.CreateStream(StreamForm{Name: "", Subjects: nil, Storage: "file", Retention: "limits"}); res.ErrorCode != CodeValidation {
		t.Fatalf("expected validation gate, got %+v", res)
	}
}
```

（再补三个 LocalServer 变体：`TestStreamLifecycleLocalServer`、`TestListStreamsUnavailableLocalServer`（错误前缀）、`TestPurgeKeepAndSubjectLocalServer`（keep=2 / subject 过滤的 Purged 计数）——结构同上，连接改 `testutil.ConnectLocalServer(t)`，流名带 `uniqueSuffix` 防串扰。）

- [ ] **Step 2: 红灯 → 实现 service.go 骨架 + streams.go**

`service.go`：

```go
package jsadmin

import (
	"io"
	"log/slog"
	"sync/atomic"
	"time"

	"desktop/internal/connections"
	"desktop/internal/settings"
)

// JetAdminService is the Wails-bound facade for stream/consumer
// administration (spec §6.6/§6.7). Settings are read per call; every
// method returns a CallResult-embedding struct, never a bare error, so
// the frontend can branch on error_code (spec §8.5.2).
type JetAdminService struct {
	mgr          *connections.Manager
	log          *slog.Logger
	emit         func(name string, data any)
	settingsPath string
	backupMu     atomic.Uint64 // 备份/恢复互斥锁（同一时刻只允许一个，Task 6 以 CompareAndSwap 使用）
}

func NewJetAdminService(mgr *connections.Manager, log *slog.Logger, emit func(name string, data any), settingsPath string) *JetAdminService {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if emit == nil {
		emit = func(string, any) {}
	}
	return &JetAdminService{mgr: mgr, log: log, emit: emit, settingsPath: settingsPath}
}
```

（句柄助手不放在 service.go——见 streams.go 的 `handles()`/`handlesWithJet()`。`mgr` 字段类型为包内接口 `connSource interface { Conn() *nats.Conn; JSParams() (domain, apiPrefix string, ok bool) }`，`connections.Manager` 天然满足，测试用桩实现（Step 3）；绑定的公开方法签名不受影响。）

`streams.go` 头部的句柄助手（放 streams.go 顶部，backup/consumers 复用）：

```go
func (s *JetAdminService) timeout() time.Duration {
	st, err := settings.Load(s.settingsPath)
	if err != nil || st.Behavior.RequestTimeoutSeconds <= 0 {
		return 5 * time.Second
	}
	return time.Duration(st.Behavior.RequestTimeoutSeconds) * time.Second
}

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
```

（`jetstream` 句柄仅在 browser/preview 用到时按需构造，方法内 `js, err := jsctx.New(nc, domain, prefix)`。）

`streams.go` 操作实现（全部走 CallResult；变更操作日志只记 name/耗时/错误，不记内容）：

```go
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
	cur, err := st.Configuration()
	if err != nil {
		return ClassifyError(err)
	}
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
	cfg, err := st.Configuration()
	if err != nil {
		return ClassifyError(err)
	}
	cfg.Name = newName // Created 等时间戳字段由服务器在创建时设置（api.StreamConfig 无此字段，无需清理）
	if _, err := mgr.NewStreamFromDefault(newName, cfg); err != nil {
		return ClassifyError(err)
	}
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
```

`isNoResponders`/`isTimeout` 两个小判定放 streams.go（`errors.Is(err, nats.ErrNoResponders)`；`errors.Is(err, context.DeadlineExceeded)`——不沿用字符串匹配，规避 M2 遗留 §6-9 已记的坏味道）；ListStreams 的 not_connected → 空 reason 语义见上方代码注释。

- [ ] **Step 3: 测试栈助手族（streams_test.go 顶部，全包共用）+ main.go 注册**

```go
// connStub 满足 JetAdminService 的 connSource 接口（Step 2 说明），
// 恒返回给定连接与 domain/prefix——省去拉起完整 connections.Manager。
type connStub struct {
	nc     *nats.Conn
	domain string
	prefix string
}

func (c *connStub) Conn() *nats.Conn                        { return c.nc }
func (c *connStub) JSParams() (string, string, bool)        { return c.domain, c.prefix, true }

func newAdmin(t *testing.T, url string) *JetAdminService {
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { nc.Close() })
	return NewJetAdminService(&connStub{nc: nc}, nil, nil, "")
}

func newAdminWithPrefix(t *testing.T, url, prefix string) *JetAdminService {
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { nc.Close() })
	return NewJetAdminService(&connStub{nc: nc, prefix: prefix}, nil, nil, "")
}

// svcRawConn 取回桩持有的连接，供测试直接注入/发布消息。
func svcRawConn(t *testing.T, svc *JetAdminService) *nats.Conn {
	t.Helper()
	return svc.mgr.(interface{ Conn() *nats.Conn }).Conn()
}

func uniqueSuffix() string { return fmt.Sprintf("%d", time.Now().UnixNano()) }

func publishN(t *testing.T, svc *JetAdminService, subject string, n int) {
	t.Helper()
	nc := svcRawConn(t, svc)
	for i := 0; i < n; i++ {
		if err := nc.Publish(subject, []byte{byte('0' + i%10)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}
}
```

（Task 4 起直接使用以上助手；Step 1 示例中的 `newTestStack` 即上述 connStub 族的统称，落地时以本 Step 代码为准。）`main.go`：在 `msgSvc` 之后注册 `jsadmin.NewJetAdminService(manager, logger, emit, settingsPath)`（`manager` 为 main.go 现有的 connections.Manager 变量名；settingsPath 现有变量同 msgSvc）。

- [ ] **Step 4: 绿灯 + bindings + 提交**

```bash
go test ./internal/jsadmin/ -v && go test ./... && go vet ./...
wails3 generate bindings -ts -clean=true   # CRLF churn 用 git restore 规避，仅保留真实变更
git add -A && git commit -m "feat(desktop): jsadmin stream management service (list/detail/crud/purge/seal)"
```

---

### Task 4: 消息浏览器 Go 侧（无状态分页 / 单条 / 删单条）

**Files:**
- Create: `desktop/internal/jsadmin/browser.go`、`desktop/internal/jsadmin/browser_test.go`

**Interfaces:**
- Consumes: Task 2 `BrowserPageRequest/BrowserMsg/EncodeBrowserMsg`；`jetstream`（`jsctx.New`）的 `CreateConsumer`（ephemeral：无 Durable/Name）+ `Consumer.FetchNoWait` + `DeleteConsumer`；jsm `ReadMessage`/`DeleteStreamMessage`。
- Produces: `(s *JetAdminService) BrowseStream(req BrowserPageRequest) BrowserPageResult`、`GetStreamMessage(stream string, seq uint64) GetMsgResult`、`DeleteStreamMessage(stream string, seq uint64) CallResult`（jsm.Manager 同名方法存在，绑定方法命名 `RemoveStreamMessage` 避免撞名：`(s *JetAdminService) RemoveStreamMessage(stream string, seq uint64) CallResult`）。

- [ ] **Step 1: 写失败的测试（browser_test.go）**

```go
package jsadmin

import (
	"testing"

	"desktop/internal/testutil"
)

func seedStream(t *testing.T, url, name string, n int) *JetAdminService {
	svc := newAdmin(t, url)
	if res := svc.CreateStream(StreamForm{Name: name, Subjects: []string{name + ".>"}, Storage: "file", Retention: "limits", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	nc := svcRawConn(t, svc)
	for i := 1; i <= n; i++ {
		if err := nc.Publish(name+".a", []byte{byte('0' + i%10)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}
	return svc
}

func TestBrowsePaging(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "PAGE", 120)
	// 第一页：1..50，has_more=true（fetch 51 判定）
	p1 := svc.BrowseStream(BrowserPageRequest{Stream: "PAGE", StartSeq: 1, Count: 50})
	if !p1.Ok() || len(p1.Messages) != 50 || p1.Messages[0].Seq != 1 || p1.Messages[49].Seq != 50 || !p1.HasMore {
		t.Fatalf("page1: %+v", p1)
	}
	if p1.NextStartSeq != 51 {
		t.Fatalf("next start: %d", p1.NextStartSeq)
	}
	// 尾页：101..120，has_more=false
	p3 := svc.BrowseStream(BrowserPageRequest{Stream: "PAGE", StartSeq: 101, Count: 50})
	if !p3.Ok() || len(p3.Messages) != 20 || p3.HasMore {
		t.Fatalf("page3: %+v", p3)
	}
	// 起点越过 last_seq → 空页
	pOver := svc.BrowseStream(BrowserPageRequest{Stream: "PAGE", StartSeq: 999, Count: 50})
	if !pOver.Ok() || len(pOver.Messages) != 0 || pOver.HasMore {
		t.Fatalf("over: %+v", pOver)
	}
	// count 闭集校验
	if res := svc.BrowseStream(BrowserPageRequest{Stream: "PAGE", StartSeq: 1, Count: 33}); res.ErrorCode != CodeValidation {
		t.Fatalf("count gate: %+v", res)
	}
}

func TestBrowseSubjectFilter(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "FILT", 0)
	nc := svcRawConn(t, svc)
	for i := 0; i < 30; i++ {
		if err := nc.Publish("FILT.a", []byte("a")); err != nil {
			t.Fatal(err)
		}
		if err := nc.Publish("FILT.b", []byte("b")); err != nil {
			t.Fatal(err)
		}
	}
	if err := nc.Flush(); err != nil {
		t.Fatal(err)
	}
	p := svc.BrowseStream(BrowserPageRequest{Stream: "FILT", StartSeq: 1, Count: 100, SubjectFilter: "FILT.b"})
	if !p.Ok() || len(p.Messages) != 30 || p.HasMore {
		t.Fatalf("filter: %+v", p)
	}
	for _, m := range p.Messages {
		if m.Subject != "FILT.b" {
			t.Fatalf("foreign subject leaked: %s", m.Subject)
		}
	}
}

func TestGetAndRemoveMessage(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "ONE", 5)
	g := svc.GetStreamMessage("ONE", 3)
	if !g.Ok() || g.Msg.Seq != 3 || g.Msg.PayloadSize != 1 || !g.Msg.IsUtf8 {
		t.Fatalf("get: %+v", g)
	}
	if res := svc.RemoveStreamMessage("ONE", 3); !res.Ok() {
		t.Fatalf("remove: %+v", res)
	}
	d := svc.GetStreamDetail("ONE")
	if d.Summary.Messages != 4 || d.Summary.NumDeleted != 1 {
		t.Fatalf("after delete: %+v", d.Summary)
	}
	if g := svc.GetStreamMessage("ONE", 3); g.ErrorCode != CodeNotFound {
		t.Fatalf("deleted seq must 404: %+v", g)
	}
	// 删除后分页出现 seq 空洞（前端按缺口渲染标记）
	p := svc.BrowseStream(BrowserPageRequest{Stream: "ONE", StartSeq: 1, Count: 50})
	if len(p.Messages) != 4 || p.Messages[1].Seq != 2 || p.Messages[2].Seq != 4 {
		t.Fatalf("hole paging: %+v", p.Messages)
	}
}
```

（再补 `TestBrowsePagingLocalServer`、`TestBrowseLargeDatasetLocalServer`——后者为 **AC-028 全口径**：`PublishAsync` 注入 **1,000,000** 条（8B payload；M2 实测进程内发布 628k msg/s，夹具约 2s）后断言 ①尾页 `BrowseStream{StartSeq: 999_951, Count: 50}` 返回 50 条且耗时 **≤1s**；②任意位置跳转 `BrowseStream{StartSeq: 500_000, Count: 50}` 同样 **≤1s** 出现内容（AC-028 第 1 条的 Go 侧半边）；③首页正常。以及 `TestBrowseWorkqueueSurfacesError`——workqueue 流上浏览返回非空服务器错误原文而非空列表。）

- [ ] **Step 2: 红灯 → 实现 browser.go**

```go
// browsePageSizeAllowed is the closed page-size set (spec §6.6).
func browsePageSizeAllowed(n int) bool { return n == 20 || n == 50 || n == 100 || n == 200 }

// browsePayloadPreviewLimit caps the per-row payload carried by a browse
// page; full content of oversized messages comes via GetStreamMessage
// (single message) or download (BrowserMsg.Truncated contract).
const browsePayloadPreviewLimit = 64 * 1024

func (s *JetAdminService) BrowseStream(req BrowserPageRequest) BrowserPageResult {
	if !browsePageSizeAllowed(req.Count) {
		return BrowserPageResult{CallResult: fail(CodeValidation, "page size must be one of 20/50/100/200")}
	}
	if req.StartSeq == 0 {
		req.StartSeq = 1
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
		DeliverPolicy: jetstream.DeliverByStartSequencePolicy,
		OptStartSeq:   req.StartSeq,
		AckPolicy:     jetstream.AckNonePolicy,
		InactiveThreshold: 2 * time.Minute,
		FilterSubject: req.SubjectFilter, // "" = 不过滤（jetstream 语义）
	})
	if err != nil {
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
		if len(m.Data()) > browsePayloadPreviewLimit { // >1MB 行载荷截断（wire 半边，见 BrowserMsg.Truncated 注释）
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

func (s *JetAdminService) RemoveStreamMessage(stream string, seq uint64) CallResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	if err := mgr.DeleteStreamMessage(stream, seq, false); err != nil {
		return ClassifyError(err)
	}
	s.log.Info("message removed", "stream", stream, "seq", seq)
	return CallResult{}
}
```

`handlesWithJet()` 在 streams.go 追加：同 `handles()` 但同时返回 `jsctx.New(nc, domain, prefix)` 句柄。`encodeFromHeader(subject string, h nats.Header, data []byte, seq uint64, ts time.Time) BrowserMsg` 为 `EncodeBrowserMsg` 的 nats.Header 直取分支（headers map 转换复用同一 helper；`GetMsg` 路径仍走 `EncodeBrowserMsg` 的 wire-block 解码——两条路径测试同一期望）。补截断测试 `TestBrowseOversizePayloadTruncated`：发布 1 条 1.5MB 消息 → 页行 `Truncated=true`、`PayloadSize==1.5MB`、`PayloadB64` 解码后恰为 64KB 前缀；`GetStreamMessage` 返回完整载荷 `Truncated=false`。workqueue 流上 `CreateConsumer` 返回服务器 400/500 → `ClassifyError` 带原文（预期行为，测试钉住非空错误）。

- [ ] **Step 3: 绿灯 + bindings + 提交**

```bash
go test ./internal/jsadmin/ -run "TestBrowse|TestGetAndRemove" -v
go test ./... && go vet ./...
wails3 generate bindings -ts -clean=true
git add -A && git commit -m "feat(desktop): stateless stream message browser (paged fetch, get, remove)"
```

---

### Task 5: consumers 管理服务（CRUD/重置/暂停恢复/拉取预览）

**Files:**
- Create: `desktop/internal/jsadmin/consumers.go`、`desktop/internal/jsadmin/consumers_test.go`

**Interfaces:**
- Consumes: Task 2 consumer 类型与 `ValidateConsumerForm/ConsumerFormToConfig/BuildConsumerSummary`；jsm `NewConsumerFromDefault/LoadConsumer/DeleteConsumer/ResetConsumerState/Pause/Resume`、`Stream.EachConsumer`；jetstream `Consumer.Fetch`（预览）；`natsver.ServerAtLeast`（暂停/优先级组 ≥2.11 门）。
- Produces（绑定方法）: `ListConsumers(stream string) ListConsumersResult`、`GetConsumerDetail(stream, name string) ConsumerDetail`、`CreateConsumer(form ConsumerForm) CallResult`、`UpdateConsumer(form ConsumerForm) CallResult`、`CopyConsumer(stream, name, newName string) CallResult`、`DeleteConsumer(stream, name string) CallResult`、`ResetConsumer(stream, name string, toSeq uint64) CallResult`、`PauseConsumer(stream, name string, seconds int64) PauseResult`、`ResumeConsumer(stream, name string) CallResult`、`PreviewNext(stream, name string, batch int, autoAck bool) PreviewNextResult`（sentinel `ErrNeedsServer211` 已在 Task 2 forms.go 定义，本任务直接引用）。

- [ ] **Step 1: 写失败的测试（consumers_test.go 核心链路）**

```go
package jsadmin

import (
	"testing"

	"desktop/internal/testutil"
)

func consumerForm(stream, durable string) ConsumerForm {
	return ConsumerForm{Stream: stream, Durable: durable, DeliverMode: "pull",
		AckPolicy: "explicit", DeliverPolicy: "all", ReplayPolicy: "instant",
		FilterSubjects: []string{stream + ".a"}}
}

func TestConsumerLifecycle(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "CSTR", 10)
	if res := svc.CreateConsumer(consumerForm("CSTR", "worker")); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	list := svc.ListConsumers("CSTR")
	if !list.Ok() || len(list.Consumers) != 1 || list.Consumers[0].Name != "worker" || !list.Consumers[0].IsPull {
		t.Fatalf("list: %+v", list)
	}
	// 拉取预览：批量 5、默认不 ack → NumAckPending 上升
	prev := svc.PreviewNext("CSTR", "worker", 5, false)
	if !prev.Ok() || len(prev.Messages) != 5 || prev.Messages[0].NumDelivered != 1 {
		t.Fatalf("preview: %+v", prev)
	}
	d := svc.GetConsumerDetail("CSTR", "worker")
	if !d.Ok() || d.Summary.NumAckPending != 5 {
		t.Fatalf("pending after no-ack preview: %+v", d.Summary)
	}
	// 自动 ack 预览 → ack floor 前进
	if res := svc.PreviewNext("CSTR", "worker", 5, true); !res.Ok() {
		t.Fatalf("ack preview: %+v", res)
	}
	d = svc.GetConsumerDetail("CSTR", "worker")
	if d.Summary.AckFloorConsumer != 5 {
		t.Fatalf("ack floor: %+v", d.Summary)
	}
	// 更新（改 ack_wait/description）
	f := consumerForm("CSTR", "worker")
	f.Description = "edited"
	f.AckWaitSeconds = 30
	if res := svc.UpdateConsumer(f); !res.Ok() {
		t.Fatalf("update: %+v", res)
	}
	if d = svc.GetConsumerDetail("CSTR", "worker"); !d.Ok() || d.Form.AckWaitSeconds != 30 {
		t.Fatalf("after update: %+v", d.Form)
	}
	// 复制 / 重置 / 删除
	if res := svc.CopyConsumer("CSTR", "worker", "worker2"); !res.Ok() {
		t.Fatalf("copy: %+v", res)
	}
	if res := svc.ResetConsumer("CSTR", "worker", 0); !res.Ok() {
		t.Fatalf("reset: %+v", res)
	}
	if d = svc.GetConsumerDetail("CSTR", "worker"); d.Summary.DeliveredConsumerSeq != 0 {
		t.Fatalf("reset must clear delivery: %+v", d.Summary)
	}
	if res := svc.DeleteConsumer("CSTR", "worker2"); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
}

func TestPauseResumeAndGates(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "CSTR", 10) // 内嵌 2.15-preview：支持 pause
	if res := svc.CreateConsumer(consumerForm("CSTR", "pw")); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	p := svc.PauseConsumer("CSTR", "pw", 60)
	if !p.Ok() || !p.Paused || p.RemainingMs <= 0 {
		t.Fatalf("pause: %+v", p)
	}
	// 暂停中拉取被拒（§6.7 异常表）
	if res := svc.PreviewNext("CSTR", "pw", 1, false); res.ErrorCode != CodeValidation {
		t.Fatalf("paused fetch gate: %+v", res)
	}
	if res := svc.ResumeConsumer("CSTR", "pw"); !res.Ok() {
		t.Fatalf("resume: %+v", res)
	}
	if res := svc.PreviewNext("CSTR", "pw", 1, false); !res.Ok() {
		t.Fatalf("fetch after resume: %+v", res)
	}
	// 批量闭集 1–256
	if res := svc.PreviewNext("CSTR", "pw", 999, false); res.ErrorCode != CodeValidation {
		t.Fatalf("batch gate: %+v", res)
	}
	// 旧服务器版本门（桩注入 serverVersion）
	if _, err := pauseGate("2.10.24"); err == nil {
		t.Fatal("pause must be gated on 2.11")
	}
	if _, err := pauseGate("2.15.0-preview.1"); err != nil {
		t.Fatalf("2.15 must pass: %v", err)
	}
}
```

（再补 LocalServer 变体 `TestConsumerLifecycleLocalServer`、`TestPauseResumeLocalServer`；`TestPushConsumerFetchRejected`——push 消费者（DeliverMode=push + deliver_subject）`PreviewNext` 返回 validation 错误"not a pull consumer"；`TestConsumerNotFoundRefresh`——外部删除后 GetConsumerDetail/PreviewNext 返回 `not_found`（§6.7 异常表第 1 行）；`TestConsumerEditImmutableRejected`——编辑改 deliver_policy 时服务器 400 原文透传 validation。）

- [ ] **Step 2: 红灯 → 实现 consumers.go**

要点（结构与 streams.go 同构，完整实现按 Interfaces 签名）：

```go
// pauseGate guards 2.11-only consumer features (PauseUntil/PriorityGroups)
// before any request leaves the client (natscli RequireAPILevel(1) 同款)。
// ErrNeedsServer211 定义于 forms.go（Task 2）。
func pauseGate(serverVersion string) (bool, error) {
	return natsver.ServerAtLeast(serverVersion, 2, 11, 0)
}

func (s *JetAdminService) serverVersion() string {
	if nc := s.mgr.Conn(); nc != nil {
		return nc.ConnectedServerVersion()
	}
	return ""
}
```

- `ListConsumers`：`mgr.LoadStream(stream)` → `st.EachConsumer(func(c *jsm.Consumer))` 内 `c.LatestState()` → `BuildConsumerSummary`；错误分类同 ListStreams（unavailable_reason）。外部删除竞态：`LatestState` 出错的消费者跳过（不拖垮列表）。
- `CreateConsumer`：`ValidateConsumerForm(&form, false)`；`form.PriorityGroups` 非空 → `pauseGate(serverVersion())` 失败返回 `fail(CodeValidation, ErrNeedsServer211.Error())`；`mgr.NewConsumerFromDefault(form.Stream, ConsumerFormToConfig(&form))`（api.ConsumerConfig 的 `Durable` 字段承载名称；ephemeral 留 Durable 空 → 服务器生成 Name——v1 表单恒为 durable）。400 → validation 原文。
- `UpdateConsumer`：`ValidateConsumerForm(&form, true)`；加载现有 config，**回填不可编辑字段原值**（DeliverPolicy/OptStartSeq/OptStartTime/FilterSubject(s) 以服务器现值为准，防止表单旧值意外变更），再 `NewConsumerFromDefault`（jsm/natscli 的"编辑=重建提交"语义）；BackOff 与 AckWait 同时变更被服务器拒绝时原文透传。
- `CopyConsumer`：加载现 config → `Durable=newName` → 提交；同 stream 校验。
- `DeleteConsumer`：`mgr.DeleteConsumer(stream, name)`——经 `LoadStream+EachConsumer` 找到目标或用 `mgr.LoadConsumer(stream, name)`（存在即用，返回 not_found 分类）。
- `ResetConsumer`：`mgr.LoadConsumer(stream, name)` → `toSeq==0 ? c.ResetConsumerState(0) : c.ResetConsumerState(toSeq)`；返回后 `LatestState` 回读校验 delivered 清零（测试断言）。注：RESET 主题为 2.15 系 API，natscli 同样不加版本门（parity）——对 2.10–2.14 服务器将以服务器错误原文呈现，验收记录注明。
- `PauseConsumer`：`pauseGate`（§6.7 需 2.11）→ `c.Pause(time.Now().Add(time.Duration(seconds)*time.Second))` → `PauseResult{Paused: resp.Paused, UntilMs: resp.PauseUntil.UnixMilli(), RemainingMs: resp.PauseRemaining.Milliseconds()}`；`seconds<=0` → validation。注：natscli 将 **prioritized** 优先级策略（PriorityPolicy=PriorityPrioritized）额外门在 API level 2（2.12）——本表单不设置 PriorityPolicy（仅 PriorityGroups，2.11 门足够），仅发起 prioritize 变更时由服务器 400 原文兜底，验收记录注明。
- `ResumeConsumer`：`pauseGate` → `c.Resume()`。
- `PreviewNext`：`batch ∈ [1,256]` 否则 validation；`js.Stream(ctx, stream)` → `str.Consumer(ctx, name)`（push → `ErrNotPullConsumer` 映射 validation「not a pull consumer」）；`cons.Info(ctx)` → `Paused` → validation「consumer is paused; resume first」（§6.7 异常表第 2 行）；`cons.Fetch(batch, jetstream.FetchMaxWait(s.timeout()))` → range `batch.Messages()`：`meta.NumDelivered/NumPending`、`encodeFromHeader(m.Headers())`、payload b64；`autoAck` → `m.Ack()`（收集后统一 ack，失败计入日志不影响返回）。返回空批 = 消息耗尽（Ok + 空数组）。

- [ ] **Step 3: 绿灯 + bindings + 提交**

```bash
go test ./internal/jsadmin/ -run "TestConsumer|TestPause|TestPush|TestPreview" -v
go test ./... && go vet ./...
wails3 generate bindings -ts -clean=true
git add -A && git commit -m "feat(desktop): consumer lifecycle service (crud/reset/pause/next-preview)"
```

---

### Task 6: 备份/恢复（进度事件 + 原生目录选择）

**Files:**
- Create: `desktop/internal/jsadmin/backup.go`、`desktop/internal/jsadmin/backup_test.go`

**Interfaces:**
- Consumes: jsm `Stream.SnapshotToDirectory(ctx, dir, SnapshotNotify(cb), SnapshotConsumers())`、`Manager.RestoreSnapshotFromDirectory(ctx, name, dir, RestoreNotify(cb))`、`Manager.IsKnownStream`；Wails `application.Get().Dialog.OpenFile()`（beta.20 API：`CanChooseDirectories(true).CanChooseFiles(false).PromptForSingleSelection() (string, error)`）。- Produces（绑定方法 + 事件）: `PickBackupDirectory() string`（取消返回 ""，见下）、`BackupStream(stream, dir string, includeConsumers bool) CallResult`、`RestoreBackup(dir string, overwrite bool) CallResult`；事件 `EventStreamBackup = "stream:backup"`，载荷 `BackupProgress`。sentinel `ErrRestoreTargetExists = errors.New("restore target stream already exists")`、`ErrBackupBusy`。`readBackupName(dir string) (string, error)`（读 `dir/backup.json` 的 `.Config.Name`）。

- [ ] **Step 1: 写失败的测试（backup_test.go）**

```go
package jsadmin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"desktop/internal/testutil"
)

func TestBackupRestoreRoundTrip(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "BK", 50)
	dir := t.TempDir()
	events := captureEmits(t, svc) // 助手：包装 emit 收集 stream:backup 事件
	if res := svc.BackupStream("BK", dir, false); !res.Ok() {
		t.Fatalf("backup: %+v", res)
	}
	if _, err := os.Stat(filepath.Join(dir, "backup.json")); err != nil {
		t.Fatalf("backup.json missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "stream.tar.s2")); err != nil {
		t.Fatalf("stream.tar.s2 missing: %v", err)
	}
	// 进度事件：至少一条 running + 一条 complete，含 bytes 计数
	phases := eventPhases(events, "BK", "backup")
	if len(phases) == 0 || phases[len(phases)-1] != "complete" {
		t.Fatalf("phases: %v", phases)
	}
	// 恢复到已删除的流：先删后恢复 → 消息数一致
	if res := svc.DeleteStream("BK"); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	if res := svc.RestoreBackup(dir, false); !res.Ok() {
		t.Fatalf("restore: %+v", res)
	}
	d := svc.GetStreamDetail("BK")
	if !d.Ok() || d.Summary.Messages != 50 {
		t.Fatalf("restored stream content: %+v", d.Summary)
	}
	rphases := eventPhases(events, "BK", "restore")
	if len(rphases) == 0 || rphases[len(rphases)-1] != "complete" {
		t.Fatalf("restore phases: %v", rphases)
	}
}

func TestRestoreTargetExists(t *testing.T) {
	svc := seedStream(t, testutil.StartJSServer(t), "EX", 5)
	dir := t.TempDir()
	if res := svc.BackupStream("EX", dir, false); !res.Ok() {
		t.Fatalf("backup: %+v", res)
	}
	// 目标仍在且未确认覆盖 → 拒绝
	res := svc.RestoreBackup(dir, false)
	if res.ErrorCode != CodeValidation || !strings.Contains(res.Error, ErrRestoreTargetExists.Error()) {
		t.Fatalf("exists gate: %+v", res)
	}
	// 覆盖语义 = 删除重建
	if res := svc.RestoreBackup(dir, true); !res.Ok() {
		t.Fatalf("overwrite restore: %+v", res)
	}
}

func TestBackupFailsCleanlyForMissingStream(t *testing.T) {
	svc := newAdmin(t, testutil.StartJSServer(t))
	events := captureEmits(t, svc)
	res := svc.BackupStream("NOSUCH", filepath.Join(t.TempDir(), "sub"), false)
	if res.Ok() {
		t.Fatal("backup of missing stream must fail")
	}
	// 失败路径不得发出 complete
	for _, ph := range eventPhases(events, "NOSUCH", "backup") {
		if ph == "complete" {
			t.Fatal("missing-stream backup must never emit complete")
		}
	}
}

func TestReadBackupName(t *testing.T) {
	dir := t.TempDir()
	blob := `{"config":{"name":"NAMED","subjects":["a"]}}`
	if err := os.WriteFile(filepath.Join(dir, "backup.json"), []byte(blob), 0o600); err != nil {
		t.Fatal(err)
	}
	name, err := readBackupName(dir)
	if err != nil || name != "NAMED" {
		t.Fatalf("got (%q,%v)", name, err)
	}
}
```

（测试助手：`captureEmits(t, svc)` 将 svc 的 emit 替换为收集器并注册 t.Cleanup 恢复——构造 svc 时传 nil emit，本助手以 `svc.emit = fn` 直接注入（同包测试可达）；`eventPhases(events, stream, direction) []string` 过滤 `stream:backup` 事件中 stream/direction 匹配的载荷并按序返回 Phase 列表。再补 `TestBackupMemoryStreamRejected`——memory 存储流备份返回 server 错误原文（jsm `ErrMemoryStreamNotSupported`）；`TestBackupDisconnectMarksIncompleteLocalServer`——LocalServer 上对大流（200k 条）备份中途 `nc.Close()` → 返回非 Ok 且最后一条事件 `phase=incomplete`（§6.6 异常表第 4 行的自动化；若时序不稳定允许轮询放宽重试 3 次，仍不稳定则在验收记录标注 PENDING-MANUAL 并保留断言 `phase != complete`）。）

- [ ] **Step 2: 红灯 → 实现 backup.go**

```go
var ErrRestoreTargetExists = errors.New("restore target stream already exists")
var ErrBackupBusy = errors.New("another backup or restore is already running")

const EventStreamBackup = "stream:backup"

// PickBackupDirectory opens the native directory chooser. "" means the
// user cancelled (no error surfaced to the UI).
func (s *JetAdminService) PickBackupDirectory() string {
	app := application.Get()
	if app == nil {
		return "" // tests / headless
	}
	dir, err := app.Dialog.OpenFile().
		CanChooseDirectories(true).CanChooseFiles(false).CanCreateDirectories(true).
		SetTitle("Select backup directory").
		PromptForSingleSelection()
	if err != nil || dir == "" {
		return ""
	}
	return dir
}

func readBackupName(dir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "backup.json"))
	if err != nil {
		return "", err
	}
	var req struct {
		Config api.StreamConfig `json:"config"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return "", err
	}
	if req.Config.Name == "" {
		return "", errors.New("backup.json has no stream name")
	}
	return req.Config.Name, nil
}

func (s *JetAdminService) emitProgress(p BackupProgress) { s.emit(EventStreamBackup, p) }

func (s *JetAdminService) BackupStream(stream, dir string, includeConsumers bool) CallResult {
	if !s.backupMu.CompareAndSwap(0, 1) {
		return fail(CodeValidation, ErrBackupBusy.Error())
	}
	defer s.backupMu.Store(0)
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	st, err := mgr.LoadStream(stream)
	if err != nil {
		return ClassifyError(err)
	}
	opts := []jsm.SnapshotOption{
		jsm.SnapshotNotify(func(p jsm.SnapshotProgress) {
			s.emitProgress(BackupProgress{Stream: stream, Direction: "backup", Phase: "running",
				BytesDone: p.BytesReceived(), BytesTotal: p.BytesExpected(), ChunksDone: p.ChunksReceived()})
		}),
	}
	if includeConsumers {
		opts = append(opts, jsm.SnapshotConsumers())
	}
	s.emitProgress(BackupProgress{Stream: stream, Direction: "backup", Phase: "running"})
	if _, err := st.SnapshotToDirectory(context.Background(), dir, opts...); err != nil {
		// 连接断开/中断：保留已完成分片（jsm 行为），显式标记不完整（§6.6）
		s.emitProgress(BackupProgress{Stream: stream, Direction: "backup", Phase: "incomplete"})
		s.log.Warn("backup incomplete", "stream", stream, "err", err)
		return ClassifyError(err)
	}
	s.emitProgress(BackupProgress{Stream: stream, Direction: "backup", Phase: "complete"})
	s.log.Info("backup complete", "stream", stream)
	return CallResult{}
}

func (s *JetAdminService) RestoreBackup(dir string, overwrite bool) CallResult {
	if !s.backupMu.CompareAndSwap(0, 1) {
		return fail(CodeValidation, ErrBackupBusy.Error())
	}
	defer s.backupMu.Store(0)
	name, err := readBackupName(dir)
	if err != nil {
		return fail(CodeValidation, "invalid backup directory: "+err.Error())
	}
	mgr, _, res := s.handles()
	if !res.Ok() {
		return res
	}
	known, err := mgr.IsKnownStream(name)
	if err != nil {
		return ClassifyError(err)
	}
	if known {
		if !overwrite {
			return fail(CodeValidation, ErrRestoreTargetExists.Error()+" (confirm delete-and-recreate)")
		}
		if err := mgr.DeleteStream(name); err != nil { // 覆盖语义 = 删除重建（§6.6）
			return ClassifyError(err)
		}
	}
	s.emitProgress(BackupProgress{Stream: name, Direction: "restore", Phase: "running"})
	_, _, err = mgr.RestoreSnapshotFromDirectory(context.Background(), name, dir,
		jsm.RestoreNotify(func(p jsm.RestoreProgress) {
			s.emitProgress(BackupProgress{Stream: name, Direction: "restore", Phase: "running", ChunksDone: p.ChunksSent()})
		}))
	if err != nil {
		s.emitProgress(BackupProgress{Stream: name, Direction: "restore", Phase: "incomplete"})
		s.log.Warn("restore incomplete", "stream", name, "err", err)
		return ClassifyError(err)
	}
	s.emitProgress(BackupProgress{Stream: name, Direction: "restore", Phase: "complete"})
	s.log.Info("restore complete", "stream", name)
	return CallResult{}
}
```

（`backupMu atomic.Uint64` 已在 Task 3 的 service 结构声明；`jetstream`/`jsm`/`api` 导入按需补齐；`application` 导入 `github.com/wailsapp/wails/v3/pkg/application`。注意 `forms.go` 顶部 import 中的 `strings` 在 ClassifyError 重写后仍被 `validStreamName`/`BuildStreamSummary` 使用，无需清理。）

- [ ] **Step 3: 绿灯 + bindings + 提交**

```bash
go test ./internal/jsadmin/ -run "TestBackup|TestRestore|TestReadBackup" -v
go test ./... && go vet ./...
wails3 generate bindings -ts -clean=true
git add -A && git commit -m "feat(desktop): stream backup/restore with progress events and native dir picker"
```

---

### Task 7: 会话 header 过滤（Go 侧 + 洪峰守恒 + 前端接线 + M2 遗留小项）

**Files:**
- Modify: `desktop/internal/messaging/pipeline.go`（+HeadersMatchFilters）、`desktop/internal/messaging/pipeline_test.go`、`desktop/internal/messaging/sessions.go`（过滤接入 + Filtered 计数）、`desktop/internal/messaging/sessions_test.go`、`desktop/internal/messaging/types.go`（SessionState+filtered）、`desktop/internal/messaging/service.go`（CreateSession 表单 +header_filters）
- Modify: `desktop/frontend/src/features/messages/SessionsPanel.tsx`（过滤行 + 稳定 key + 创建再门控 + start_seq 下限）、`SessionView.tsx`（已过滤 chip）、`src/lib/bindings.ts`、`src/locales/{en,zh-CN}.json`

**Interfaces:**
- Consumes: M2 既有 `SessionManager`/`session` 收流路径（`deliver()` 之前的核心与 JS 两条 receive 路径）、`SessionSpec`（messaging/types.go:52——CreateSession 的既有 wire 表单类型，本任务在其上**加法扩展** `HeaderFilters` 字段）、`useConnState`（ConnStateProvider 已存在）、messaging 测试既有夹具 `newSessionStack(t, url, defaultBuf, defaultPush)`（sessions_test.go:155，返回 `(*connections.Manager, *SessionManager, *emitRecorder)`；recorder 提供 `msgCount(id)`/`lastState(id)`/`emittedPayloads(id)`）、`uniqueSuffix()`（pubreq_test.go:35，messaging 包内已有）。
- Produces: `pipeline.HeadersMatchFilters(h nats.Header, filters map[string]string) bool`（AND 精确匹配，任一 key 缺失或不等 → false；空 filters → true）；`SessionSpec` 新字段 `HeaderFilters map[string]string \`json:"header_filters,omitempty"\``；`SessionState` 新字段 `Filtered int64 \`json:"filtered"\``；前端 `SessionsApi` 不变。

- [ ] **Step 1: 写失败的测试（pipeline_test.go 追加）**

```go
func TestHeadersMatchFilters(t *testing.T) {
	h := nats.Header{"Env": {"prod"}, "X-B": {"2"}}
	if !HeadersMatchFilters(h, nil) || !HeadersMatchFilters(h, map[string]string{}) {
		t.Fatal("empty filters must match everything")
	}
	if !HeadersMatchFilters(h, map[string]string{"Env": "prod"}) {
		t.Fatal("single exact match")
	}
	if !HeadersMatchFilters(h, map[string]string{"Env": "prod", "X-B": "2"}) {
		t.Fatal("AND match")
	}
	for _, f := range []map[string]string{
		{"Env": "dev"}, {"env": "prod"}, {"Missing": "x"}, {"Env": "prod", "Missing": "x"},
	} {
		if HeadersMatchFilters(h, f) {
			t.Fatalf("must not match %v", f)
		}
	}
}

func TestHeaderMatchPerformance(t *testing.T) {
	h := nats.Header{"Env": {"prod"}, "Svc": {"orders"}, "Ver": {"3"}}
	filters := map[string]string{"Env": "prod", "Svc": "orders"}
	start := time.Now()
	const n = 1_000_000
	for i := 0; i < n; i++ {
		HeadersMatchFilters(h, filters)
	}
	per := time.Since(start) / n
	if per > 500*time.Nanosecond { // 洪峰 50k/s 时占预算 <2.5%（预算 20µs/msg）
		t.Fatalf("filter too slow: %v/match", per)
	}
}
```

- [ ] **Step 2: 红灯 → 实现纯函数 + 接入收流路径**

```go
// HeadersMatchFilters reports whether every filter key is present with an
// exactly equal value (AND semantics; spec §6.4 optional header filter,
// Go-side so flood-rate streams are filtered near the source).
func HeadersMatchFilters(h nats.Header, filters map[string]string) bool {
	if len(filters) == 0 {
		return true
	}
	for k, want := range filters {
		got, ok := h[k]
		if !ok {
			return false
		}
		for _, v := range got {
			if v == want {
				goto next
			}
		}
		return false
	next:
	}
	return true
}
```

接入（sessions.go）：`session` 结构加 `headerFilters map[string]string`（构造时来自表单，≤8 组、key/value ≤256 字节校验放 service CreateSession）；核心订阅与 JS 消费者两条 receive 路径在调用 `deliver()` 之前：

```go
if !HeadersMatchFilters(msg.Header, s.headerFilters) {
	s.filtered.Add(1) // 仅计数：不进 ring、不推送、不计速率
	return
}
```

`SessionState` 快照增加 `Filtered: s.filtered.Load()`。守恒语义写入 types.go 注释：`received == delivered_total + filtered`（delivered 侧 M2 不变式原样）。

- [ ] **Step 3: 写失败的会话级测试（sessions_test.go 追加）**

```go
func TestSessionHeaderFiltering(t *testing.T) {
	url := testutil.StartJSServer(t)
	_, sm, rec := newSessionStack(t, url, 10000, PushRealtime) // sessions_test.go:155 既有夹具
	nc := smTestConn(t, url)                                   // 新增小助手（见本块末）
	subj := "filter.e2e." + uniqueSuffix()                     // pubreq_test.go:35 既有
	st, err := sm.CreateSession(SessionSpec{Subject: subj, HeaderFilters: map[string]string{"Env": "prod"}})
	if err != nil {
		t.Fatal(err)
	}
	sid := st.ID // CreateSession 返回 SessionState；id 字段名以 types.go 为准
	for i := 0; i < 20; i++ {
		var msg *nats.Msg
		if i%2 == 0 {
			msg = &nats.Msg{Subject: subj, Data: []byte("hit"), Header: nats.Header{"Env": {"prod"}}}
		} else {
			msg = &nats.Msg{Subject: subj, Data: []byte("miss"), Header: nats.Header{"Env": {"dev"}}}
		}
		if err := nc.PublishMsg(msg); err != nil {
			t.Fatal(err)
		}
	}
	nc.Flush()
	waitForCond(t, 2*time.Second, func() bool { // 新增小助手（见本块末）
		st, ok := rec.lastState(sid)
		return ok && st.Total == 10 && st.Filtered == 10
	})
	// 推送消息只含命中消息（recorder 既有 msgCount）
	if got := rec.msgCount(sid); got != 10 {
		t.Fatalf("emitted messages: %d", got)
	}
}

// 本步随测试新增两个 ≤10 行助手（sessions_test.go）：
// smTestConn: nats.Connect(url) + t.Cleanup(nc.Close)
// waitForCond: 20ms 轮询 cond 直至为真或 timeout 后 Fatal
```

```go
func TestSessionHeaderFilterFloodConservationLocalServer(t *testing.T) {
	// Global Constraint 8：50k msg/s 量级注入 + 过滤开启守恒与速率不塌陷。
	// M2 实测本机进程内注入 628k msg/s——200k 条（50% 命中）远超 50k 门槛，注入约 0.3–4s。
	requireLocalServer(t) // messaging 既有探针（pubreq_test.go：LocalServer URL、2s 探测、缺失即 Skip）
	_, sm, rec := newSessionStack(t, LocalServerURL, 10000, PushRealtime)
	inj := smTestConn(t, LocalServerURL)
	subj := "filter.flood." + uniqueSuffix()
	st, err := sm.CreateSession(SessionSpec{Subject: subj, HeaderFilters: map[string]string{"Env": "prod"}})
	if err != nil {
		t.Fatal(err)
	}
	sid := st.ID
	const total = 200_000
	start := time.Now()
	for i := 0; i < total; i++ {
		msg := &nats.Msg{Subject: subj, Data: []byte("x")}
		if i%2 == 0 {
			msg.Header = nats.Header{"Env": {"prod"}}
		} else {
			msg.Header = nats.Header{"Env": {"dev"}}
		}
		if err := inj.PublishMsg(msg); err != nil {
			t.Fatal(err)
		}
	}
	inj.Flush()
	achieved := float64(total) / time.Since(start).Seconds()
	if achieved < 50_000 {
		t.Fatalf("flood level not reached: %.0f msg/s (mandate: 50k)", achieved)
	}
	waitForCond(t, 10*time.Second, func() bool {
		st, ok := rec.lastState(sid)
		return ok && st.Total+st.Filtered == total
	})
	final, _ := rec.lastState(sid)
	if final.Total != total/2 || final.Filtered != total/2 {
		t.Fatalf("conservation: total=%d filtered=%d", final.Total, final.Filtered)
	}
	if final.Dropped != 0 {
		t.Fatalf("unexpected drops at this rate: %d", final.Dropped)
	}
	if final.RateMsgS <= 0 {
		t.Fatal("rate must stay live under filtered flood")
	}
}
```

（`st.ID`/`final.RateMsgS`/`final.Dropped`/`final.Total` 等字段名以 messaging/types.go 的 `SessionState` 导出名为准——实现时按实际名对齐，断言语义不变。**注入速率硬门槛 50k msg/s**：LocalServer 测试只在本地跑（CI 无本地服务器自动 Skip），本机 M2 实测 628k/s，门槛有 12 倍余量。`cmd/flood` 同步增加可重复 `-header k=v` 旗标（≤8 组，追加到现有 `-subject/-rate/-size/-dur` 参数族，Task 15 UIA 冒烟「flood 混合 headers」依赖它），实现约 15 行：解析为 `nats.Header` 挂到现有 `nats.NewMsg(subject)` 上。另外随本任务补 `TestSessionStateFilteredFieldPins`——`SessionState` JSON 序列化钉住 `filtered` 字段（对齐 M2 的 types 钉住测试风格）。）

- [ ] **Step 4: 红灯→绿灯：service.go 表单校验（≤8 组、key/value ≤256）+ 前端接线**

Go：`CreateSession` 解析 `SessionSpec.HeaderFilters`（nil 允许；>8 组或 key/value 超 256 字节 → 校验错误，错误风格对齐 messaging 既有表单校验路径）。
前端（红→绿，tests/messages-sessions-filter.test.tsx 新增）：
- `SessionsPanel`：「Header 过滤」可折叠区，行式 key/value 输入（≤8 行，添加/删除行），行 key 用 `useId()` 稳定标识（M2 遗留 §6-7：弃 index key）；提交时组装 `header_filters`（空行剔除）。
- 创建按钮经 `useConnState()` 在 disconnected 时禁用、reconnected/connected 恢复（M2 遗留 §6-1 复活路径）。
- `start_sequence` 输入 `min={1}`（M2 遗留 §6-9）。
- `SessionView` chip 增加「已过滤 N」（`filtered` 字段，未知字段容忍默认 0）。
- i18n：`messages.sessions.filterTitle/filterAdd/filterKey/filterValue/filteredCount` 双侧。
组件测试：过滤行渲染与提交载荷断言（mock 绑定捕获 `header_filters`）、8 行上限、chip 渲染、断连禁用创建按钮。

- [ ] **Step 5: 全量验证 + bindings + 提交**

```bash
go test ./internal/messaging/ -run "TestHeadersMatch|TestSessionHeader" -v
cd frontend && npx vitest run tests/messages-sessions-filter.test.tsx && cd ..
go test ./... && go vet ./... && cd frontend && npx vitest run && cd ..
wails3 generate bindings -ts -clean=true
git add -A && git commit -m "feat(desktop): session header filters (go-side match, flood conservation) + m2 legacy wiring"
```

---

### Task 8: confirm_level 确认原语 + 设置控件

**Files:**
- Create: `desktop/frontend/src/lib/confirm.tsx`、`desktop/frontend/tests/confirm.test.tsx`
- Modify: `desktop/frontend/src/features/settings/SettingsPage.tsx`（+confirm_level Select）、`src/App.tsx`（ConfirmProvider 包裹）、`src/locales/{en,zh-CN}.json`

**Interfaces:**
- Consumes: `GetSettings`/`SaveSettings` 绑定（既有）；`AlertDialog`/`Dialog`/`Input`（既有 shadcn）。
- Produces（Task 10/11/12 依赖，签名逐字）:
  - `ConfirmProvider({children}: {children: ReactNode})`——挂载在 Toaster 内侧。
  - `useConfirm(): { confirmL1(opts: L1Options): Promise<boolean>; confirmNameMatch(name: string): Promise<boolean> }`；`L1Options = { titleKey: string; bodyKey?: string; confirmKey?: string; data?: Record<string, string> }`（key 为 i18n key，组件内 `t()`）。
  - 语义（Global Constraint 4）：`confirmL1` 在 `confirm_level=relaxed` 时**不弹窗直接 resolve(true)**；`confirmNameMatch` 任何级别都弹名称输入对话框，输入 !== 目标名 → 拒绝且对话框保持打开（AC-010）。

- [ ] **Step 1: 写失败的测试（confirm.test.tsx）**

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const getSettings = vi.fn();
vi.mock("@/lib/bindings", () => ({
  GetSettings: () => getSettings(),
  SaveSettings: () => Promise.resolve(),
}));

import { ConfirmProvider, useConfirm } from "@/lib/confirm";

function Probe({ onResult }: { onResult: (v: boolean) => void }) {
  const { confirmL1 } = useConfirm();
  return <button onClick={() => confirmL1({ titleKey: "streams.purgeTitle" }).then(onResult)}>go</button>;
}

describe("confirm primitives", () => {
  beforeEach(() => getSettings.mockReset());

  it("standard level shows the dialog and honors confirm", async () => {
    getSettings.mockResolvedValue({ behavior: { confirm_level: "standard" } });
    const onResult = vi.fn();
    render(<ConfirmProvider><Probe onResult={onResult} /></ConfirmProvider>);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true)); // 必须断言 resolve 值，不只是对话框关闭
  });

  it("relaxed level skips level-1 dialogs entirely", async () => {
    getSettings.mockResolvedValue({ behavior: { confirm_level: "relaxed" } });
    const onResult = vi.fn();
    render(<ConfirmProvider><Probe onResult={onResult} /></ConfirmProvider>);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
```

（另加 `confirmNameMatch` 两条：错误名称 → 点确认后对话框仍在且 Promise 未 resolve；正确名称 → 关闭并 resolve(true)。i18n 测试环境按既有测试的 i18n 初始化方式取 key。）

- [ ] **Step 2: 红灯 → 实现 confirm.tsx**

```tsx
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { GetSettings } from "@/lib/bindings";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type L1Options = { titleKey: string; bodyKey?: string; confirmKey?: string; data?: Record<string, string> };

type ConfirmApi = {
  confirmL1: (opts: L1Options) => Promise<boolean>;
  confirmNameMatch: (name: string) => Promise<boolean>;
};

const Ctx = createContext<ConfirmApi | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const levelRef = useRef<"standard" | "relaxed">("standard");
  const [l1, setL1] = useState<(L1Options & { resolve: (v: boolean) => void }) | null>(null);
  const [nm, setNm] = useState<{ name: string; input: string; resolve: (v: boolean) => void } | null>(null);

  const confirmL1 = useCallback(async (opts: L1Options) => {
    try {
      const st = await GetSettings();
      levelRef.current = st.behavior?.confirm_level === "relaxed" ? "relaxed" : "standard";
    } catch { /* 读取失败按 standard 兜底（fail-closed） */ }
    if (levelRef.current === "relaxed") return true;
    return new Promise<boolean>((resolve) => setL1({ ...opts, resolve }));
  }, []);

  const confirmNameMatch = useCallback((name: string) => new Promise<boolean>((resolve) => setNm({ name, input: "", resolve })), []);

  const api = useMemo(() => ({ confirmL1, confirmNameMatch }), [confirmL1, confirmNameMatch]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <AlertDialog open={!!l1} onOpenChange={(o) => { if (!o) { l1?.resolve(false); setL1(null); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(l1?.titleKey ?? "", l1?.data)}</AlertDialogTitle>
            {l1?.bodyKey ? <AlertDialogDescription>{t(l1.bodyKey, l1.data)}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { l1?.resolve(false); setL1(null); }}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { l1?.resolve(true); setL1(null); }}>{t(l1?.confirmKey ?? "common.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={!!nm} onOpenChange={(o) => { if (!o) { nm?.resolve(false); setNm(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("common.nameMatchTitle", { name: nm?.name ?? "" })}</DialogTitle></DialogHeader>
          <Input value={nm?.input ?? ""} onChange={(e) => setNm((p) => (p ? { ...p, input: e.target.value } : p))} placeholder={nm?.name} aria-label="name-match-input" />
          <DialogFooter>
            <Button variant="outline" onClick={() => { nm?.resolve(false); setNm(null); }}>{t("common.cancel")}</Button>
            <Button variant="destructive" disabled={(nm?.input ?? "") !== (nm?.name ?? "\u0000")}
              onClick={() => { if (nm && nm.input === nm.name) { nm.resolve(true); setNm(null); } }}>
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useConfirm requires ConfirmProvider");
  return v;
}
```

- [ ] **Step 3: SettingsPage +confirm_level 控件（standard|relaxed Select，i18n `settings.confirmLevel.*`），App.tsx 包 Provider；测试：控件渲染 + SaveSettings 携带变更值**

- [ ] **Step 4: 验证 + 提交**

```bash
cd frontend && npx vitest run tests/confirm.test.tsx && npx vitest run && npm run build
git add -A && git commit -m "feat(desktop): confirm_level primitives (L1/L2 name-match) and settings control"
```

---

### Task 9: Streams 页前端（列表/筛选/详情/速率采样/虚拟化）

**Files:**
- Create: `desktop/frontend/src/features/streams/{StreamsPage,StreamList,StreamDetail,Sparkline}.tsx`、`rates.ts`、`useStreams.ts`
- Modify: `src/App.tsx`（streams 占位换 `lazy(() => import("./features/streams/StreamsPage"))`）、`src/lib/bindings.ts`（jsadmin 再导出：`ListStreams/GetStreamDetail` + 类型）
- Create: `desktop/frontend/tests/rates.test.ts`、`desktop/frontend/tests/streams-page.test.tsx`
- Generate: `desktop/frontend/src/components/ui/{table,progress,checkbox}.tsx`（`npx shadcn@latest add table progress checkbox`）

**Interfaces:**
- Consumes: 绑定 `ListStreams(): Promise<ListStreamsResult>`、`GetStreamDetail(name): Promise<StreamDetail>`（Task 3 bindings）；`GetSettings`（poll_interval_seconds）；`useConnState`。
- Produces（Task 10/11/13 依赖）:
  - `useStreams(): { list: StreamSummary[]; unavailableReason: string; loading: boolean; refresh(): void; selected: string | null; select(name: string | null): void; detail: StreamDetail | null; detailLoading: boolean; rate: number }`。
  - `rates.ts`: `type Sample = { t: number; lastSeq: number; firstSeq: number }`；`class RateSampler { push(s: Sample): void; rate(now: number): number; series(windowMs: number, now: number, buckets: number): number[]; count(): number }`；`computeListRates(prev: Map<string, StreamSummary>, cur: StreamSummary[], dtMs: number): Map<string, number>`（列表级速率列：ΔLastSeq/Δt，首帧/缺历史 → NaN，调用方渲染 "—"；spec §6.6 列表展示列含「速率」）。
  - `Sparkline({ values, width, height, ariaLabel }: { values: number[]; width?: number; height?: number; ariaLabel: string })`——纯 SVG polyline，无库。
  - `StreamList({ streams, selected, onSelect }: { streams: StreamSummary[]; selected: string | null; onSelect(name: string): void })`——@tanstack/react-virtual 虚拟滚动（10k 行）。
  - `StreamDetail` 暴露操作按钮槽位回调 props：`onEdit/onCopy/onDelete/onPurge/onSeal/onMessages/onBackup`（Task 10/11/13 注入）。

- [ ] **Step 1: 写失败的测试（rates.test.ts）**

```ts
import { describe, expect, it } from "vitest";
import { RateSampler, computeListRates } from "@/features/streams/rates";

describe("RateSampler", () => {
  it("computes msg/s from lastSeq deltas (natscli calculateRate parity: hold-last on zero)", () => {
    const s = new RateSampler();
    s.push({ t: 0, lastSeq: 100, firstSeq: 1 });
    s.push({ t: 5_000, lastSeq: 350, firstSeq: 1 }); // Δ250 / 5s = 50/s
    expect(s.rate(5_000)).toBe(50);
    s.push({ t: 10_000, lastSeq: 350, firstSeq: 1 }); // 无新增 → 保持上一值不抖动
    expect(s.rate(10_000)).toBe(50);
  });

  it("prunes samples outside the largest window", () => {
    const s = new RateSampler();
    for (let i = 0; i < 100; i++) s.push({ t: i * 1_000, lastSeq: i, firstSeq: 0 });
    s.push({ t: 3_700_000, lastSeq: 5_000, firstSeq: 0 }); // 1h 窗口外样本应被清理
    expect(s.count()).toBeLessThan(100);
  });

  it("series buckets a window into points", () => {
    const s = new RateSampler();
    for (let i = 0; i <= 60; i++) s.push({ t: i * 1_000, lastSeq: i * 10, firstSeq: 0 });
    const ser = s.series(60_000, 60_000, 12);
    expect(ser).toHaveLength(12);
    expect(ser.every((v) => v >= 0)).toBe(true);
  });

  it("computeListRates derives per-stream rates from list snapshots", () => {
    const prev = new Map([["A", { last_seq: 100 }], ["B", { last_seq: 50 }]]);
    const cur = [
      { name: "A", last_seq: 350 },
      { name: "B", last_seq: 50 },
      { name: "C", last_seq: 9 },
    ];
    const rates = computeListRates(prev, cur as never, 5_000);
    expect(rates.get("A")).toBe(50);
    expect(rates.get("B")).toBe(0);
    expect(rates.has("C")).toBe(false); // 无历史 → 缺席，渲染 "—"
  });
});
```

- [ ] **Step 2: 红灯 → 实现 rates.ts + Sparkline.tsx**

`rates.ts`（纯逻辑：环形样本数组、`rate = (last.lastSeq - prev.lastSeq) / seconds`，seconds≤0 或 Δ<0（purge/删除回绕）时保持上一值；窗口保留 `maxWindowMs`（3,700s）+ 容量上限 4,000 样本防泄漏；`series(windowMs, now, buckets)` 按桶取区间平均速率）。`Sparkline.tsx`：SVG `<polyline>` 归一化到 viewBox，`values` 空 → 占位线 + aria-label（lucide `Activity` 图标 + 文本）。

- [ ] **Step 3: 写失败的组件测试（streams-page.test.tsx）**

mock `@/lib/bindings` 的 `ListStreams`/`GetStreamDetail`/`GetSettings`：
1. 列表渲染：3 条流（名称/subjects/消息数/字节数格式化 `formatBytes` 复用 M2）/**速率列**（第二次刷新后显示 msg/s，首帧 "—"——`computeListRates` 注入）/KV 徽标（`internal_kind=kv`）/unhealthy 副本红色标记。
2. `unavailable_reason="no_responders"` → 渲染指引面板（含 domain/api_prefix 排查文案 key `streams.unavailable.*`），**不渲染空表格**（Global Constraint 1）。
3. 筛选：输入名称/subject 模糊串 → 列表过滤（前端过滤，500 条内即时）。
4. 详情选中：`GetStreamDetail` 轮询（`vi.useFakeTimers` 推进 poll 间隔二次调用断言），统计区（msgs/bytes/first/last/lost/consumers/num_deleted）+ Sparkline（`rate>0` 时 title 含 msg/s）+ 窗口切换 5m/15m/1h。
5. 未连接（`useConnState` 返回 disconnected）→ 列表区显示引导连接横幅、自动停止轮询。
6. `document.visibilityState` hidden（jsdom 手动 defineProperty）→ 轮询暂停，visible 恢复（§20.2 失焦暂停轮询）。

- [ ] **Step 4: 红灯→绿灯实现 StreamsPage/StreamList/StreamDetail/useStreams**

- `useStreams`：挂载 + 可见时按 `poll_interval_seconds`（默认 5s）轮询 `ListStreams`；选中流时并行轮询 `GetStreamDetail`；`RateSampler` 逐次 `push`；每次列表刷新后 `computeListRates(prevSnapshot, cur, dtMs)` 计算逐流速率（prev 快照留存于 ref）；断连（connState ≠ connected）停止并置空。错误 toast（`sonner`）带 `error` 原文可展开。
- `StreamsPage` 布局（§18.1 区域级）：左侧列表（搜索框 + 刷新 + Create/Restore 按钮槽）+ 右侧详情面板（无选中 → 空态引导）。操作按钮（Task 10/11/13）预留 props 注入位。
- `StreamList`：shadcn Table 表头（name/subjects/messages/**rate**/bytes/consumers/last time/replicas）+ `useVirtualizer` 行渲染（10k 行 O(视口)）；排序点击表头（name/msgs/bytes/last_time 客户端排序）。列显隐/列宽拖动持久化（§18.4）**延期至 M6 保洁**（M3 只做排序 + 固定列集，裁定记录于 Task 15 验收记录）。
- i18n `streams.*` 全量双侧（列表列名、筛选占位、指引面板、详情统计标签、窗口切换、空态）。

- [ ] **Step 5: 验证 + 提交**

```bash
cd frontend && npx vitest run tests/rates.test.ts tests/streams-page.test.tsx && npx vitest run && npm run build
git add -A && git commit -m "feat(desktop): streams page (virtualized list, detail, rate sampling, unavailable guidance)"
```

---

### Task 10: Stream 表单与危险操作前端

**Files:**
- Create: `desktop/frontend/src/features/streams/StreamForm.tsx`、`schema.ts`
- Modify: `StreamDetail.tsx`（操作按钮接 `useConfirm` + 绑定调用）、`useStreams.ts`（操作后刷新）、`src/lib/bindings.ts`（Create/Update/Copy/Delete/Purge/Seal 再导出）
- Create: `desktop/frontend/tests/streams-form.test.tsx`、`desktop/frontend/tests/streams-danger.test.tsx`

**Interfaces:**
- Consumes: `useConfirm()`（Task 8）；绑定 `CreateStream/UpdateStream/CopyStream/DeleteStream/PurgeStream/SealStream`（Task 3）；zod schema。
- Produces: `<StreamForm open mode={"create"|"edit"|"copy"} initial? onDone()>`（edit/copy 预填 `detail.form`，copy 清空 name）；`schema.ts` 导出 `streamFormSchema`（zod：name 非空+字符集、subjects min 1（mirror 例外）、storage/retention 枚举、limits ≥ -1、max_age ≥ 0、replicas 1–5 —— 与 Go `ValidateStreamForm` 同规则双侧对齐）、`StreamFormValues` 类型。

- [ ] **Step 1: 写失败的测试**

`streams-form.test.tsx`：
1. 创建：空 subjects 提交 → 内联错误（zod，不调 `CreateStream`，§6.6/§8.5.2 E-VALIDATION）；合法提交 → 绑定载荷含全部字段（0 值字段显式发送——枚举零值约束）。
2. copy 模式预填 + name 空待填；edit 模式 name 输入禁用。
3. 服务器 400（mock 拒绝 `error_code=validation`，error="subjects overlap"）→ 表单顶部内联展示服务器原文（§8.2.1）。

`streams-danger.test.tsx`：
1. purge：standard 弹一级确认 → 确认后调用 `PurgeStream`，toast 显示 `purged` 计数；取消不调用（AC-010 第 1 半）。
2. relaxed：purge 直接执行不弹窗。
3. delete：名称匹配对话框输入错误名 → 确认按钮 disabled/点击不调用；正确名 → 调用且列表刷新（AC-010 第 2 半；Global Constraint 4）。
4. seal / 删单条（按钮在 Task 11 浏览器内，本任务先测 seal）：一级确认。
5. `not_found` 错误 → toast「资源不存在」+ 自动 `refresh()`（§6.7 异常同款语义在 stream 侧）。

- [ ] **Step 2: 红灯→绿灯实现**

- `StreamForm`：Dialog 表单（name/description/subjects 多值输入（textarea 按行拆分或 chips 输入，用现有 Input + 行列表，不新增组件依赖）/storage/retention Select/limits 四输入（占位符注明「空=默认，-1=无限」）/replicas/placement/mirror+sources 折叠区）；错误内联（zod 字段级 + 服务器原文横幅）。
- `StreamDetail` 操作区：Edit/Copy/Backup(Task 13)/Messages(Task 11) 入口 + Purge/Seal（`confirmL1`）+ Delete（`confirmNameMatch(name)`）；全部操作乐观 loading（≤100ms 反馈：立即 spinner，Global Constraint 9/13）。
- `useStreams` 增加 `create/update/copy/remove/purge/seal` 动作方法（调绑定 → 成功 toast + `refresh()` + 失败 toast 原文 + `not_found` 触发 refresh）。
- i18n `streams.form.*`、`streams.op.*`、`streams.error.*` 双侧。

- [ ] **Step 3: 验证 + 提交**

```bash
cd frontend && npx vitest run tests/streams-form.test.tsx tests/streams-danger.test.tsx && npx vitest run && npm run build
git add -A && git commit -m "feat(desktop): stream form (create/edit/copy) and tiered danger operations"
```

---

### Task 11: 消息浏览器前端

**Files:**
- Create: `desktop/frontend/src/features/streams/StreamMsgs.tsx`
- Modify: `StreamDetail.tsx`（Messages 按钮打开面板）、`src/lib/bindings.ts`（BrowseStream/GetStreamMessage/RemoveStreamMessage 再导出）
- Create: `desktop/frontend/tests/streams-msgs.test.tsx`

**Interfaces:**
- Consumes: 绑定 `BrowseStream(BrowserPageRequest)/GetStreamMessage/RemoveStreamMessage`（Task 4）；`useConfirm`；`formatBytes`、base64 工具（M2 既有 `src/lib/base64.ts`）。
- Produces: `<StreamMsgs stream={name} summary={{firstSeq, lastSeq}} onClose()>`——自包含分页状态机：`{ pageStart, pageSize(20|50|100|200), subjectFilter, msgs, hasMore, loading }`；导出 `computePrevStart(msgs, pageSize, firstSeq): number`（纯函数：`max(firstSeq, msgs[0].seq - pageSize)`）与 `detectHoles(msgs): number[]`（纯函数：页内 seq 缺口）供测试。

- [ ] **Step 1: 写失败的测试（streams-msgs.test.tsx）**

1. 分页请求参数：打开面板（默认 StartSeq=1/Count=50）→ `BrowseStream` 以 `{stream, start_seq:1, count:50}` 调用；下一页用返回的 `next_start_seq`；上一页用 `computePrevStart`（mock 返回页断言）。
2. 页大小切换 20/50/100/200（Select 闭集）→ 重新请求。
3. subject 过滤输入 → 请求带 `subject_filter` 且**上一页按钮禁用**（无状态分页在过滤下不可逆，Go 侧同因）。
4. 单条查看：点击行 → `GetStreamMessage` → 详情视图 headers 表 + payload（UTF-8 → `<pre>` 等宽渲染；非 UTF-8 → 十六进制预览首 4KB + 下载按钮（b64→Blob URL，断言按钮存在且 aria-label）——AC-029 浏览器半边；`truncated=true` 的行（>1MB，Go 侧只送 64KB 预览）→ 详情经 `GetStreamMessage` 取**完整载荷**后再渲染/下载（断言截断行走 GetStreamMessage，非截断行直接渲染页内 b64）。
5. 删单条：一级确认 → `RemoveStreamMessage` → 当前页刷新出现空洞行（`detectHoles` 渲染「已删除 seq」标记，AC-009 第 2 条）。
6. 空流/空页空态 + loading 态（骨架行）。

纯函数单测：`computePrevStart`（首页钳制、跨删除空洞）、`detectHoles`（[1,2,4,7] → [3,5,6]）。

- [ ] **Step 2: 红灯→绿灯实现 StreamMsgs**

布局：页头（流名 + 首/上一页/下一页/尾页 + 跳转 seq 输入 + 页大小 + subject 过滤）+ 虚拟化行表（seq/subject/size/time/utf8 徽标）+ 行点击右侧详情。尾页 = `max(firstSeq, lastSeq - pageSize + 1)`（由 summary 计算）。hex 预览复用 SessionView 的等宽渲染模式（不复制组件——若 M2 SessionView 内联实现，则提取公共 `PayloadView` 到 `src/lib/payload.tsx`（红→绿测试随迁，M2 测试引用同步更新），一处实现两处使用）。i18n `streams.msgs.*` 双侧。

- [ ] **Step 3: 验证 + 提交**

```bash
cd frontend && npx vitest run tests/streams-msgs.test.tsx && npx vitest run && npm run build
git add -A && git commit -m "feat(desktop): stream message browser UI (paging, viewer, hex preview, delete)"
```

---

### Task 12: Consumers 页前端

**Files:**
- Create: `desktop/frontend/src/features/consumers/{ConsumersPage,ConsumerForm,NextPreview}.tsx`、`schema.ts`、`useConsumers.ts`
- Modify: `src/App.tsx`（consumers 占位换 lazy 页）、`src/lib/bindings.ts`（consumer 系绑定再导出）
- Create: `desktop/frontend/tests/consumers-page.test.tsx`

**Interfaces:**
- Consumes: 绑定 `ListStreams`（stream 选择器）/`ListConsumers/GetConsumerDetail/CreateConsumer/UpdateConsumer/CopyConsumer/DeleteConsumer/ResetConsumer/PauseConsumer/ResumeConsumer/PreviewNext`（Task 5）；`useConfirm`；Task 9 的 `RateSampler`/`Sparkline`（消费者速率 = `Delivered.Consumer` 序列增量，natscli consumer graph 同口径）。
- Produces: `useConsumers(stream): { consumers, unavailableReason, detail, refresh, actions... }`；`NextPreview({stream, name, paused, onDone})`。

- [ ] **Step 1: 写失败的测试（consumers-page.test.tsx）**

1. stream 选择器（来自 ListStreams）→ `ListConsumers` 调用正确；**名称筛选框**（§6.7「列表筛选」，客户端模糊过滤）+ 列表列（名称/类型 pull-push/待处理/未确认/已确认/红位数(重投)/等待/暂停徽标/副本）渲染。
2. 详情：统计 + 配置回显 + **速率 sparkline**（`RateSampler.push({t, lastSeq: detail.summary.delivered_consumer_seq})`，5m/15m/1h 窗口切换，§6.7 输出「详情面板（含统计与速率图）」）+ 暂停卡片——`paused=true` 时显示剩余时长（`pause_remaining_ms` 倒计时格式化）且**拉取按钮禁用**（AC-012 第 1 条）；`Resume` 后恢复可拉取。
3. 创建表单：mode=pull/push 切换（push 显示 deliver_subject 必填）；deliver_policy 闭集 Select（start_sequence 选中显示 seq 输入 min=1、start_time 显示 datetime-local）；ack_wait 等数值越界（0 以下）→ 内联拦截不调绑定（§6.7 异常表第 3 行前端半边）；batch 输入 1–256 闭集。
4. 拉取预览：批量 10、ack 开关默认 off → `PreviewNext(stream, name, 10, false)`；消息卡片显示 headers/payload/seq/`num_delivered`；开 ack → `autoAck=true` 载荷。
5. 重置/删除：一级确认（delete 走 L1）；`not_found` → toast + 刷新（§6.7 异常表第 1 行）。
6. 旧服务器 pause 门：`PauseConsumer` 返回 validation「requires NATS Server 2.11」→ 内联/ toast 原文。

- [ ] **Step 2: 红灯→绿灯实现**

结构与 streams 页同构（左列表右详情 + 表单 Dialog + 预览面板）；`schema.ts` zod 与 Go `ValidateConsumerForm` 同规则；i18n `consumers.*` 双侧。`ConsumersPage` 同样 lazy 挂载（code-split 延续，M2 遗留 §6-13 路线）。

- [ ] **Step 3: 验证 + 提交**

```bash
cd frontend && npx vitest run tests/consumers-page.test.tsx && npx vitest run && npm run build
git add -A && git commit -m "feat(desktop): consumers page (list, detail, form, pause card, pull preview)"
```

---

### Task 13: 备份/恢复前端

**Files:**
- Create: `desktop/frontend/src/features/streams/BackupPanel.tsx`
- Modify: `StreamDetail.tsx`（Backup 按钮）、`StreamsPage.tsx`（工具栏 Restore 按钮）、`src/lib/bindings.ts`（PickBackupDirectory/BackupStream/RestoreBackup 再导出）
- Create: `desktop/frontend/tests/streams-backup.test.tsx`

**Interfaces:**
- Consumes: 绑定 `PickBackupDirectory/BackupStream/RestoreBackup`（Task 6）；事件 `stream:backup`（`Events.On`，模式对齐 useSessions.ts:61-67）；`Checkbox`（Task 9 生成）+ `Progress`。
- Produces: `BackupPanel`（对话框 + 进度条组件合一）；`useBackupProgress(stream, direction)` hook 返回最近进度。

- [ ] **Step 1: 写失败的测试（streams-backup.test.tsx）**

1. 备份流程：点 Backup → include-consumers 复选（默认 off）→ 「选择目录」（mock `PickBackupDirectory` 返回 `/tmp/bk`）→ `BackupStream("S","/tmp/bk",false)` 调用；期间 `Events.On("stream:backup")` mock 推送 `{stream:"S",direction:"backup",phase:"running",bytes_done:50,bytes_total:100}` → 进度条 50%；`phase=complete` → 完成态 + toast + 详情刷新。
2. `phase=incomplete` → 警告态（「备份不完整」+ 服务器错误原文），不显示成功 toast（§6.6 异常表第 4 行 UI 半边）。
3. 恢复流程：Restore → 选目录（mock 读到流名 "S"——前端调 `RestoreBackup(dir,false)` 首次返回 `error_code=validation` + target exists 原文）→ 弹覆盖确认对话框（checkbox「删除并重建」）→ 确认后 `RestoreBackup(dir,true)` → 进度 → 完成 toast + 列表刷新（§6.6 异常表第 5 行）。
4. 取消目录选择（`PickBackupDirectory` 返回 ""）→ 不发请求、面板关闭。
5. `ErrBackupBusy`（validation 原文）→ toast。

- [ ] **Step 2: 红灯→绿灯实现**

- `useBackupProgress`：`Events.On("stream:backup")` 订阅 + 卸载退订；载荷按字段白名单解析（对齐 connstate.tsx 的 parseEvent 风格，未知容忍）。
- `BackupPanel`：Dialog（备份选项/恢复覆盖确认两个阶段态机）+ Progress 条（`value = bytes_total>0 ? bytes_done/bytes_total*100 : indeterminate`）+ phase 三态渲染；操作绑定调用全走 `useStreams().refresh()` 收尾。
- i18n `streams.backup.*` 双侧。

- [ ] **Step 3: 验证 + 提交**

```bash
cd frontend && npx vitest run tests/streams-backup.test.tsx && npx vitest run && npm run build
git add -A && git commit -m "feat(desktop): backup/restore UI with progress events and overwrite confirm"
```

---

### Task 14: 性能/压力/并发验证 + CI 扩展

**Files:**
- Create: `desktop/internal/jsadmin/perf_test.go`、`desktop/internal/jsadmin/stress_test.go`、`desktop/frontend/tests/bench/streams.bench.ts`
- Modify: `.github/workflows/desktop-ci.yml`（bench job 增加 streams bench 目标）

**Interfaces:**
- Consumes: Task 3/4/5 服务方法；`testutil.ConnectLocalServer`；M2 bench 配置（vitest bench）。
- Produces: 性能与守恒证据（M3 测试报告 §性能 数据源）。

- [ ] **Step 1: Go 性能测试（perf_test.go，全部经 `testutil.ConnectLocalServer` 门控——无本地服务器时 skip，无需 build tag）**

助手（perf_test.go 顶部）：`adminOver(t, nc) *JetAdminService` = `NewJetAdminService(&connStub{nc: nc}, nil, nil, "")`（connStub 见 Task 3）；`cleanupStreams(t, svc, suffix)` = 列出并删除所有 `strings.Contains(name, suffix)` 的流（t.Cleanup 注册，夹具自愈）。

```go
func TestStreamList500LocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	suffix := uniqueSuffix()
	svc := adminOver(t, nc)
	defer cleanupStreams(t, svc, suffix)
	// 建流 500 条（带唯一后缀，测试结束清理；单次建流约 20–40s，可接受的一次性夹具）
	for i := 0; i < 500; i++ {
		if res := svc.CreateStream(StreamForm{Name: fmt.Sprintf("PERF%s_%04d", suffix, i),
			Subjects: []string{fmt.Sprintf("perf%s.%04d.>", suffix, i)},
			Storage: "memory", Retention: "limits", Replicas: 1}); !res.Ok() {
			t.Fatalf("setup %d: %+v", i, res)
		}
	}
	start := time.Now()
	list := svc.ListStreams()
	elapsed := time.Since(start)
	if !list.Ok() || len(list.Streams) < 500 {
		t.Fatalf("list: n=%d err=%v", len(list.Streams), list.Error)
	}
	// 低配回归门（§12 低配 1.5s；高配 500ms 在报告中记录实测值）
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("list of %d streams took %v (budget 1.5s)", len(list.Streams), elapsed)
	}
	t.Logf("list 500 streams: %v", elapsed)
}
```

（另含 `BenchmarkStreamListLocalServer`（-benchtime=5x 记录稳定值）、`BenchmarkBrowseTailPageLocalServer`（10 万条流尾页）、`BenchmarkHeaderFilterPipeline`（pipeline.deliver + 过滤 10 万次纯逻辑）。）

- [ ] **Step 2: 并发/压力测试（stress_test.go）**

```go
func TestConcurrentStreamOpsLocalServer(t *testing.T) {
	nc := testutil.ConnectLocalServer(t)
	svc := adminOver(t, nc)
	suffix := uniqueSuffix()
	var wg sync.WaitGroup
	errCh := make(chan error, 60)
	// 10 goroutine 各自 create→update→delete 生命周期，同时 2 goroutine 持续 ListStreams
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			name := fmt.Sprintf("CON%s_%02d", suffix, i)
			if res := svc.CreateStream(StreamForm{Name: name, Subjects: []string{name + ".>"}, Storage: "memory", Retention: "limits", Replicas: 1}); !res.Ok() {
				errCh <- fmt.Errorf("create %s: %s", name, res.Error)
				return
			}
			if res := svc.UpdateStream(StreamForm{Name: name, Subjects: []string{name + ".>"}, Storage: "memory", Retention: "limits", Replicas: 1, Description: "c"}); !res.Ok() {
				errCh <- fmt.Errorf("update %s: %s", name, res.Error)
				return
			}
			if res := svc.DeleteStream(name); !res.Ok() {
				errCh <- fmt.Errorf("delete %s: %s", name, res.Error)
			}
		}(i)
	}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				if list := svc.ListStreams(); !list.Ok() && list.ErrorCode != CodeServer {
					errCh <- fmt.Errorf("list: %s", list.Error)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
}
```

（`svc` 并发安全说明写入文件头注释：`handles()` 每调用独立构造 jsm/jetstream 句柄、`JetAdminService` 无共享可变状态（backupMu 除外）；本测试即其证明，CI `-race` 复核。另含 `TestBrowseSubjectFilterFloodLocalServer`——10 万条注入 + 过滤浏览 5 页数据正确性。）

- [ ] **Step 3: 前端基准（streams.bench.ts，对齐 M2 sessions.bench.ts 结构）**

10,000 行 `StreamList` 渲染 + 排序切换基准；vitest 5 的 bench 注册沿 M2 文件模式（`test("...", async (ctx) => { ctx.bench(...) })`，顶层 `bench()` 不可用）；虚拟化窗口断言（DOM 行数 < 100）。

- [ ] **Step 4: CI 修改 + 全量验证 + 提交**

`desktop-ci.yml` bench job：现状只跑 `npx vitest run tests/messages-perf.test.ts`（未用 `vitest bench`）——本步**新增**一步 `npx vitest bench --run tests/bench/` 使 sessions/streams 两个基准文件都被执行（保留既有 perf 测试步不动）。全量：

```bash
go test ./... && go vet ./... && cd frontend && npx vitest run && npx vitest bench --run && npm run build && cd ..
git add -A && git commit -m "test(desktop): m3 perf/stress/concurrency suites and CI bench coverage"
```

---

### Task 15: 验收记录 + 测试报告 + UIA 冒烟（控制器任务）

**Files:**
- Create: `docs/superpowers/plans/2026-09-12-nats-desktop-m3-acceptance.md`、`docs/superpowers/plans/2026-09-12-nats-desktop-m3-test-report.md`

**Interfaces:** 无代码；产出两份文档 + 冒烟记录。

- [ ] **Step 1: 构建真实应用并连接本地服务器**

```bash
cd desktop && wails3 build && ./build/bin/nats-desktop.exe &   # 本地服务器 nats://127.0.0.1:4333 必须在跑（-js -m 8333）
```

- [ ] **Step 2: UIA 冒烟清单（PowerShell UIAutomation，沿用 M2 §7 方法）**

| 冒烟项 | 断言 |
|---|---|
| Streams 列表加载 + 筛选 | 真服务器建 3 流 → 列表渲染、搜索过滤 |
| AC-008 创建流 + 发布 3 条 | 表单提交 → toast → 列表 messages=3（发布经 Messages 页或 `nats pub`） |
| AC-009 浏览器分页 + 删单条空洞 | 翻页/页大小/单条详情/删除后空洞标记 |
| AC-010 purge L1 + delete 名称匹配 | 错误名拒绝保持对话框；正确名删除（standard）；relaxed 下 purge 直执行 |
| AC-011 消费者创建 + 拉取预览 | durable pull + filter → 预览 10 条未 ack（NumAckPending 上升可见） |
| AC-012 暂停/恢复 | 暂停 60s → 剩余时长 + 拉取禁用；恢复可拉取 |
| 备份/恢复全链路 | 备份到目录 → 进度 → 删除流 → 恢复 → 消息数一致；目标存在覆盖确认 |
| header 过滤 chip | 会话开过滤 → flood 混合 headers → 已过滤计数实时上涨 |
| JS 不可用指引 | 连接前缀错误 context（或断开 JetStream）→ 指引面板而非空列表 |
| 主题/语言回归（M1/M2） | 深色 + zh-CN 下全页无英文硬编码/无 emoji 图标 |

- [ ] **Step 3: 写验收记录**（AC-008/009/010/011/012/028/029-浏览器半边逐条：条件/操作/预期/结果/证据；§6.6 异常表 5 行 + §6.7 异常表 3 行的映射表；§6.7「丢失数」列裁定——NATS 无消费者级丢失计数器，以 NumRedelivered（红位/重投）承载并文档化；延期裁定：§18.4 列显隐/列宽拖动持久化归 M6、RESET/PriorityPrioritized 对旧服务器的错误原文兜底（Task 5 注）、备份无取消按钮、恢复不改名、nsr_domain 未接；遗留清单：§6.6「集群运维入口」（leader 迁移/RAFT 操作按钮，依赖 §6.11 集群页）归 M5 集群里程碑、workqueue 流浏览需 allow_direct（natscli 同前提）、trace 集群测试归 M5（M2 验收记录原文「M3 集群功能时补」裁定）、UIA 高频更新场景树暴露收敛建议）
- [ ] **Step 4: 写测试报告**（Go/前端用例数与结果 + **覆盖率实测**（§20.1 门槛 Go ≥80%/前端 ≥70%——M1/M2 未达门槛未记录，本次必须实测并记录，未达标则列整改项）；性能实测表：500 流列表 ms、10k 行 bench、1M 尾页/跳转 ms、header 过滤洪峰守恒数据（含实测速率）、并发测试结果、CI 状态、缺陷记录与修复 SHA）
- [ ] **Step 5: 提交 + 终审交接（whole-branch review → 修复波 → 合并选项）**

```bash
git add -A && git commit -m "docs(desktop): m3 acceptance record and test report"
```

---

## 自审记录（含独立评审后修复）

**独立计划评审**：`reviewing-plans` 只读子代理报告存于 `.superpowers/sdd/m3-plan-review.md`（4 Critical / 10 Important / 14 Minor）。全部 Critical 与 Important 已修复（C1 `api.StreamConfig.Created` 不存在、C2 `*api.ApiError`→string、C3 ClassifyError 补 jetstream 错误分支、C4 header 块 `NATS/1.0` 前导解码、I1 backupMu 命名、I2/I3/I4 测试助手实名与 SessionSpec、I5 遗留处置表、I6 洪峰 50k 硬门槛、I7 1M 数据集+跳转、I8 列表速率列、M12 >1MB 行载荷截断）。Minor 已修模板类（M1/M3/M5/M6/M11/M13/M14）；**延期裁定**：§18.4 列显隐/列宽（M6）、PubPanel/TracePanel 既有 index key 迁移（M6，M2 已裁定当前模式正确）、§20.1 覆盖率门槛改为 M3 测试报告实测记录（Task 15 Step 4）。

1. **Spec 覆盖**：§6.6 全部输入/处理/输出/异常 5 行 → Task 2/3/4/9/10/11/13/15（列表速率列在 Task 9；「集群运维入口」依赖 §6.11 集群页，归 M5，Task 15 遗留清单显式记录）；§6.7 全部（含详情速率图、列表筛选、「丢失数」裁定）→ Task 2/5/12/15；§6.12 确认策略 → Task 8/10/11/12；§8.2 错误码/超时 → Task 2（ClassifyError 双分支覆盖 jsm 与 jetstream 路径）/Global 3；§12 四项相关预算 → Task 14（500 流/10k 行/尾页+跳转 Task 4 按 1M 全口径）+ Task 10 乐观 loading；AC-008~012 → Task 3-5/9-12/15；AC-028 → Task 4/9/14；AC-029 浏览器半边 → Task 4/11。M2 遗留按「M2 遗留处置表」逐项处置（覆盖项见该表，其余显式归 M5/M6）。
2. **占位符扫描**：无 TBD/TODO/"适当处理"；Task 2 consumer 侧校验/映射为逐值枚举的规则清单 + 逐条断言要求（枚举值均具名映射到 api 常量）。
3. **类型一致性**：`BrowserPageRequest/BrowserMsg(含 Truncated)` Task 2 定义、Task 4/11 消费一致；`useConfirm` Task 8 → 10/11/12；`handles()/handlesWithJet()` Task 3 → 4/5/6；`ErrNeedsServer211` Task 2 forms.go → Task 5；测试助手族 Task 3 定义（connStub/newAdmin/newAdminWithPrefix/svcRawConn/publishN/uniqueSuffix）→ Task 4/6/14；Task 6/7 备份与 messaging 助手（captureEmits/eventPhases、waitForCond/smTestConn）在各自任务定义；`RateSampler/Sparkline/computeListRates` Task 9 → 12。
4. **运维覆盖**：性能（§12 → Task 4（1M 尾页+跳转 ≤1s）/14（500 流断言 + 10k bench）/7（洪峰 50k 硬门槛））；并发/完整性（Task 14 并发 + Task 7 守恒不变式）；失败路径（§6.6/§6.7 异常表逐行有测试）；可观测（日志只记 name/seq/bytes，凭证与 payload 不入日志 Global 12）。
