# NATS 桌面客户端 M5 测试报告

- 日期：2026-09-14（实跑；自动化回归于 2026-09-13/14 交叉执行）
- 分支 / HEAD：`desktop/m5` @ `353b41f`（Task 1–13）+ 本报告提交（Task 14 收尾）
- 范围：计划 `2026-09-13-nats-desktop-m5.md` Task 1–14 的测试总量、性能实测、覆盖率终值、UIA 冒烟矩阵、LocalServer 探测与 CI 状态（配套《2026-09-13-nats-desktop-m5-acceptance.md》验收记录）

## 1. 测试环境

| 项 | 值 |
|---|---|
| 机器 | 13th Gen Intel Core i7-13700HX，16 核 24 线程，15.7GB RAM，SSD（≥ §12 高配参考档） |
| 系统 | Windows 11 家庭版 中文版（build 26200），WebView2 Runtime |
| 工具链 | go1.26.0 windows/amd64，Node v24.11.1，wails3 v3.0.0-beta.20 |
| 目标服务器 | **本机常驻真 nats-server `nats://127.0.0.1:4333`（2.15-preview，监控 `:8333/jsz`）**——全部 LocalServer 变体实跑；集群场景用内嵌 3 节点夹具（testutil.StartCluster）与本轮新增的 `desktop/cmd/testcluster`（测试工具，非产品面） |
| UIA 驱动 | PowerShell System.Windows.Automation（InvokePattern / TogglePattern / ValuePattern / SelectionItemPattern），窗口定位 `NATS Desktop`，树遍历用 `FindAll(Descendants, TrueCondition)` 扁平 dump |
| 桌面状态 | 物理桌面锁屏状态本轮未显式验证；**全程未使用任何合成鼠标/键盘**，全部交互经 UIA 可访问性模式完成（方法注记见 §6） |
| 应用二进制 | `bin/nats-desktop.exe`（**20,608,512 B ≈ 19.7 MiB**，本任务从 `353b41f` 树构建，含 M5 监控页/集群运维/Dashboard；构建方式见 §3 注记） |

## 2. 用例数（2026-09-13/14 新鲜实跑，非缓存汇总）

| 套件 | 命令 | 结果 |
|---|---|---|
| Go 全量 | `cd desktop && go test ./... -count=1 -cover` | **12 包全部 ok，0 失败**（appdir 0.5s / buckets 22.7s / connections 12.1s / jsadmin 24.8s / jsctx 1.1s / logging 0.7s / messaging 86.6s / **monitor 25.9s** / natsver 0.4s / settings 0.4s / testutil 3.2s / version 0.4s；deps 无测试文件）。输出头部可见预存在工具链噪声（`compile: version "go1.26.0" does not match go tool version "go1.25.6"`），不影响退出码 0 |
| Go 规模 | `grep -rE "^func Test" desktop/internal/` | **272 个顶层 `Test` 函数 + 5 个 `Benchmark`**（M4 基线 231+5 → 净增 41；monitor 包 31 个 Test 为 M5 业务主体） |
| 前端全量 | `cd frontend && npx vitest run --maxWorkers=2` | **34 文件 / 268 测试全部通过**（34.3s；含 i18n 双语 parity 门）。注：本机默认并行会 OOM（M5 Task 9 在案），`--maxWorkers=2` 为既定门禁口径 |
| 静态检查 | `go vet ./...`；`npx tsc --noEmit` | 全部干净（exit 0） |
| 构建 | `npm run build`（tsc + vite） | 成功，chunk 尺寸见 §3 |

与 M4 基线对比：Go 231 顶层（11 包）/ 前端 173（25 文件）→ **Go 272（12 包 ok）/ 前端 268（34 文件）**；净增主要在 monitor（31 Test）、monitoring/dashboard 前端 9 个套件（Task 10–13）与 kv 前端整改 21 例（Task 14，`kv-page.test.tsx` 6 → 27）。

## 3. 构建产物

- 前端 `vite build`（production）：`MonitoringPage 33.15 kB (gzip 7.46)`、`DashboardPage 9.86 kB (gzip 3.34)`、`EventsPanel 9.36 kB`、`KeyValuePage 39.62 kB`、`ObjectsPage 37.23 kB`、`ConsumersPage 44.05 kB`、`MessagesPage 59.09 kB`、`StreamsPage 59.10 kB`、入口 `index 104.00 kB (gzip 33.52)`、共享 vendor `input 464.82 kB (gzip 143.78)`；页面级 code-split 保持。
- `bin/nats-desktop.exe` = **20,608,512 B ≈ 19.7 MiB ≤ 30MB（§12）→ PASS**。
- 构建方式注记（M4 惯例延续）：`wails3 build` 内置 bindings 重生再次全量刷风格 churn，且重生后的 nullable 类型令 Task 9–13 的监控源码出现 3 处 tsc 报错（`AccountsPanel.tsx` 两处 `stream_names`、`DangerZone.tsx` 一处 `snapshot.servers`，TS18047）——**预存在**（M5 源码按已提交的旧风格编写，与 M3 Task 15 同类问题），非本任务引入。按 M4 惯例处理：`git restore frontend/bindings`（重生树不入库），前端 dist 以已提交 bindings 构建，exe 以 Taskfile 同款参数直接 `go build -tags production -trimpath -buildvcs=false -ldflags="-w -s -H windowsgui"` + `wails3 generate syso` 产出。全量 regen 决策遗留见 §6-2。

## 4. 性能实测表（G13 诚实口径；先前任务报告数字照录 + 本轮新鲜记录）

| 预算项 | 门槛/预期 | 实测 | 来源 |
|---|---|---|---|
| 监控快照周期（3 节点内嵌集群） | 单次 $SYS 广播 ≤2s；周期 ≤ poll_interval | 集群用例（夹具启动+选举+采集）**~1.6s**（10s 预算内） | Task 4 报告 |
| 监控快照周期（3 节点真应用，UIA 冒烟同期） | G13「健康 3 节点实测记录（预期 <600ms）；降级最坏 ~4.3s」 | **cycle_ms = 610–626ms**，25+ 个连续周期稳定（`nats-desktop.log`："monitor snapshot servers=3 cycle_ms=612/615/…/626"，5s 间隔无缺拍）——略高于 600ms 预期值、远低于 2s 单广播上限与 4.3s 降级最坏值，周期 ≤ interval 成立 | 本轮冒烟应用日志 |
| 事件洪峰 ingest | 10k 条（含正则过滤）<1s 且零丢失、dropped/filtered 精确 | `TestSysWatchIngest10kWithRegex` + `TestSysWatchQueueDropOldest` **120 次执行 0 失败**（时敏双用例稳定性扫描）；`TestSysWatchFloodNoLoss` 200 真实连接 ~0.3s 零丢失 | Task 7 报告 |
| 事件洪峰前端环 | 10,000 条环、界面可用 | `applyWatchEvent` 纯函数 10_005 → 保留最后 10_000（kv 同款）；EventsPanel 10k ring（Task 12） | Task 7/12 |
| connz 分页排序 | 1,024 行分页 ≤500ms（高配门） | 功能层：白名单排序键闭集 + offset/limit 边界 + 表头排序 UI 全有测试（Task 5/11）；**无独立墙钟 bench**——如实登记为 M6 候选（§6-8） | Task 5/11 |
| 应用体积 | ≤30MB | **19.7 MiB**（20,608,512 B） | 本轮构建 |

冒烟补充测量：AC-015 两轮周期观察在 UIA 可见链路完成（服务器表行 uptime 6m33s → 6m43s、CPU/内存同步变化，两读数间隔 11.7s ≈ 2× 5s 周期）；锁屏/后台节流的观察链路时延注记同 M3/M4（非投递时延）。

## 5. 覆盖率终值（§20.1 门槛：Go 业务逻辑 ≥80%、前端组件 ≥70%）

Go（`go test ./... -count=1 -cover`，2026-09-14 实测）：

| 包 | 覆盖率 | 门（§20.1） |
|---|---:|---|
| jsctx | 100.0% | 达标 |
| messaging | 86.5% | 达标 |
| natsver | 85.7% | 达标 |
| connections | 83.7% | 达标 |
| **monitor** | **82.4%** | **达标（M5 新业务包；目标 ≥80% PASS）** |
| jsadmin | 81.4% | 达标 |
| buckets | 81.1% | 达标 |
| version | 75.5% | 未达 → 遗留（M4 登记，M5 未触碰） |
| settings | 72.7% | 未达 → 遗留 |
| logging | 71.1% | 达标改善（reopen 臂跨平台不可达已在案） |
| appdir | 71.4% | 未达（薄封装）→ 遗留 |
| testutil | 70.2% | 测试辅助包，不计门槛（M5 集群夹具使其自 28.6% 大幅上升，说明性记录） |

前端（v8 provider，`npx vitest run --coverage --maxWorkers=2`，2026-09-14 实测）：

| 范围 | % Stmts | 判定 |
|---|---:|---|
| 全部（src/features + src/lib） | **83.45%** | ≥70% 总门 PASS（M4 基线 78.44% → 上升） |
| features/monitoring（M5 新） | 88.42% | 达标 |
| features/dashboard（M5 新） | 90.42% | 达标 |
| **features/kv** | **88.88%** | **达标（本任务整改：68.03% → 88.88%，+20.85pt）** |
| features/messages | 87.32% | 达标 |
| features/streams | 83.98% | 达标 |
| features/connections | 82.02% | 达标 |
| features/consumers | 79.24% | 达标 |
| features/settings | 76.74% | 达标 |
| features/objects | 71.19% | 达标（objects 页未在 M5 触碰面内，维持 M4 值） |
| lib | 93.02% | 达标 |

**M4 遗留整改项（G18）三项文件终值**（整改前 → 整改后）：`kv/BucketForm.tsx 35% → 95%`、`kv/KeyValuePage.tsx 60.6% → 93.93%`、`kv/schema.ts 56.52% → 100%`。整改以 `tests/kv-page.test.tsx` 既有文件扩展 21 个新用例实现（BucketForm 提交/校验/编辑回填/取消/挂起防重、KeyValuePage 选中流转/确认门操作/断连清空、schema 全规则边界值、useKv 失败路径），全部为证伪型——未改产品代码、未加 data-testid（既有 testid 足以到达全部目标元素）。

## 6. UIA 冒烟矩阵（2026-09-14 05:05–05:29，真应用 + `go run ./cmd/testcluster` 3 节点集群）

**运行载体**：`desktop/cmd/testcluster`（本任务新增的测试工具，~150 行，复用 testutil.StartCluster 的选项构造——SYS/APP 双账户、seed 路由、逐节点启用 APP 账户 JS、就绪等待（$SYS PING 应答数==3 且 meta leader 非空）——但不注册 t.Cleanup，Ctrl-C 退出；README 已注明非产品面）。三节点 `S1 nats://127.0.0.1:53869 / S2 :53872 / S3 :53878`，sys/syspass + app/apppass。

**准备**：① 上下文经 nats 上下文文件 `~/.config/nats/context/m5-testcluster.json`（sys 凭据指向 S1，同 M3 探针上下文惯例，留作人工回填前置）；② 应用内经 UIA 驱动头部上下文菜单切换到 m5-testcluster 并连接（应用首启按持久化的 last_active_context 自动恢复 local-test@4333）；③ 断连"受害者"为临时 `go run` 客户端（app 账户、进程外、不入库）。

| # | 冒烟项 | 结果 | 证据（UIA 读值 + 应用日志） |
|---|---|---|---|
| a | 上下文切换 + 连接集群 + Dashboard | **PASS** | 头部按钮 `local-test` → 菜单（local-test / m3-nojs / m5-testcluster）→ 选中 → 状态行「已连接 · m5-testcluster · 1ms」；Dashboard 卡片「服务器 3/3」「连接数 3」「JS 内存 0% 0 0 B / 35.4 GiB」「JS 存储 0% 0 0 B / 3.0 TiB」「往返延迟 1 ms」全数呈现（AC-015 的数据面前置） |
| b | 监控页服务器表 3 节点行（AC-015 预期 1） | **PASS** | 导航「监控」→ 服务器表行（UIA Button 角色）：`在线 S1 2.15.0-preview.1 6m8s 0.7% 23.0 MiB 3 8/0 投票成员`、`在线 S2 … 元数据主`、`在线 S3 … 投票成员`——名称/版本/CPU/内存/连接数/路网关/JS 角色 7 列齐备；工具条 interval chip「5s」+ 暂停/立即刷新可用；**无降级横幅**（sys 账户可用） |
| c | 两轮周期数据刷新（AC-015 预期 2 前半） | **PASS** | S1 行两次读值：`6m33s 0.3% 23.6 MiB`（05:09:59）→ `6m43s 0.0% 24.4 MiB`（05:10:11）——uptime/CPU/内存随周期刷新；`data-polled-at` DOM 属性为前端测试锚点（monitoring-server-table/use-monitor 用例钉住），UIA 可见等价物即行内容跨周期变化；应用日志 `monitor snapshot servers=3 cycle_ms=610–626` 连续 25+ 周期无缺拍 |
| d | 连接表 kick + 事件流 disconnect advisory（AC-016） | **PASS** | 选中 S1 → 「连接」页签 → 连接表（CID/IP/用户/账户/订阅/…/RTT 列头 + 行内「断开连接 {cid}」按钮 ×3）。UIA 点击 `断开连接 22`（cid 经 $SYS connz 请求预识别为受害者 m5-smoke-victim）→ **L1 确认框**「断开连接 22 / 连接 22 将在 S1 上被关闭，客户端可能会自行重连。」+ 取消/确认 → 确认 → 受害者进程立即打印 `VICTIM-DISCONNECTED: EOF`；应用日志 `kick connection server=S1 cid=22`。「事件」页签挂载（累计 0）→ 终止受害者进程 → **事件行实时出现**：`05:23:48.342 │ io.nats.server.advisory.v1.client_disconnect │ S2 │ APP · app@127.0.0.1 Read Error │ $SYS.ACCOUNT.APP.DISCONNECT │ 804`，计数「累计 1 / 丢弃 0 / 过滤 0」；5 个类型过滤按钮（account_connect/account_disconnect/auth_error/js_advisory/js_metric）+ 主题正则输入在列 |
| e | 危险区 meta step-down 对话框（AC-017） | **PASS** | 「危险操作」页签：红色分离区 + 4 卡（元数据主降级/流主降级/均衡流分布/移除节点），「当前元数据主：S2」。点「元数据主降级」→ **L2 对话框**「输入 "S2" 以确认」+ 影响列表（重新选举数秒 / JS API 短暂不可用）+ 输入框 + 「名称不一致——请精确重新输入」。**错误名 `S1` → 「执行」DISABLED**（预期 1 实证）；**正确名 `S2` → 「执行」ENABLED** → 点击 → 执行成功、对话框关闭、**新 leader 上屏**：服务器表 `在线 S1 … 元数据主`、S2 变「投票成员」、危险卡「当前元数据主：S1」（预期 2 实证）；应用日志 `cluster op completed op=meta_stepdown code="" elapsed_ms=1127`。「操作期间按钮不可重复触发」半边由自动化覆盖（DangerZone inFlight 禁用 + Go 侧 op+target CAS 单飞 conflict，Task 8/12 测试） |
| f | 附带观察：无系统账户降级面（§8.3.1）+ emoji 扫描 | **PASS（附带）** | 冒烟前应用以 local-test@4333（单节点无系统账户）自动恢复：Dashboard/监控呈现「系统账户不可用——集群级指标受限」+「其余功能不受影响——近期事件仍显示在下方」降级横幅（G3 的真应用实证）；切 sys 集群后横幅消失。对全部 UIA dump 做 emoji 码位扫描（U+1F300–1FAFF / 2600–27BF / 2B00–2BFF / FE0F）→ **零命中**（G7） |

冒烟小结：**6 行全 PASS（a–f），0 行 PENDING-MANUAL**——AC-015/016/017 三条 AC 的 UIA 腿全部走通，无锁屏不可驱动项残留（本轮冒烟页面无原生选择器/合成输入依赖）。

### 冒烟方法注记（对照 M3/M4 的差异）

1. WebView2 无障碍树惰性构建：首个 `FindAll(Descendants, TrueCondition)` 扁平 dump 激活整树；逐层 `Children` 递归遍历会提前截断——本轮全部改用扁平 dump。
2. 表格行（`div role=button` + `aria-pressed`）不暴露 InvokePattern，暴露 **TogglePattern**——行选中经 `Toggle()` 完成（M3/M4 用 MSAA `accDoDefaultAction`；PS 5.1 不暴露 LegacyIAccessiblePattern 类型，MSAA 通道本轮不可用也未必需）。
3. 文本输入经 ValuePattern `SetValue`（危险区确认框、上下文菜单无文本输入）；页签切换 TabItem 经 SelectionItemPattern `Select`。
4. 冒烟辅助：临时 `go run` 受害者客户端（app 账户长连）与 $SYS connz 探针（识别受害者 cid，等价于读取连接表"用户"列——UIA 单元格无可读名）均在 OS 临时目录，用后已删、不入库；受害者进程终止即 AC-016 的"制造断连"。
5. 收尾：应用与 testcluster 进程已停；`last_active_context` 恢复 local-test；`m5-testcluster.json` 上下文文件按 M3 惯例留作人工回填前置。

## 7. LocalServer 探测

- `nats://127.0.0.1:4333`：**存活**（TCP 4333 连通；`GET :8333/jsz` 返回正常 JSON：`accounts: 1`、`api.level: 5`、server_id `NBW775X…`）。buckets/jsadmin/messaging 的 LocalServer 变体随全量 `go test ./... -count=1` 实跑，0 SKIP、0 失败（buckets 22.7s 含洪峰/100MB/并发等重量级场景）。
- 冒烟对 4333 的使用：仅作为 local-test 上下文的启动恢复目标（连带取得 §8.3.1 降级横幅的实证）；未产生 m5 残留资产。

## 8. 缺陷记录（Task 14 新发现）

| # | 观察 | 处置 |
|---|---|---|
| 1 | `wails3 build` 内置 bindings 重生令监控源码 3 处 tsc 报错（TS18047，§3）——M5 源码按已提交旧风格编写，全量 regen 现在会**破坏构建**而非仅风格漂移 | 未在本任务修（产品代码不在本任务文件清单）；按 M4 惯例 restore + 直构 exe。**登记 M6 首要项**：全量 regen 前需先补 3 处 null-guard（9207fd3 风格）再提交重生树 |
| 2 | G13 的 3 节点健康周期「预期 <600ms」，实测 610–626ms | 非缺陷：预期值为计划估计，门槛本身是「单广播 ≤2s、周期 ≤ interval」——均 PASS。数字照录（§4） |
| 3 | connz 1,024 行分页排序无独立墙钟 bench | 登记遗留（§6-8）；功能正确性由 Task 5/11 测试覆盖 |

## 9. CI 状态

- `desktop-ci.yml`：go job（windows-latest）`go vet` + `go test ./... -race -count=1 -cover`；前端 job `npm ci` + `tsc --noEmit` + `eslint --max-warnings 0` + `vitest run --coverage`；构建 job `wails3 build`。**触发分支 main；远端运行记录仍为 0 次**（M1 起在案）——合并后首跑即 `-race` 于 Windows runner 的首次真实验证，回填点延续。
- 本机 `-race` 不可用（预存在：C 盘满 + TSAN commit 上限，Task 4 报告在案）→ 竞态覆盖由 CI 承接（现状 = 无执行记录，如实登记）。

## 10. 测试方法与证据链注记

1. **真服务器纪律**：LocalServer 变体全部实跑 4333（0 SKIP）；集群用例内嵌专属（G14）；UIA 冒烟打 `go run ./cmd/testcluster` 真 3 节点集群（测试工具进程，非夹具进程）。
2. **TDD**：Task 14 的 21 个 kv 新用例先红后绿（首轮 2 处断言与实现语义不符——schema 边界漏传 name、deleted-key 编辑器空稿前提错误——修正测试后 27/27；未改产品代码）；台账登记于 `.superpowers/sdd/task-14-m5-report.md`。
3. **确定性手段**：vitest `--maxWorkers=2`（OOM 规避）；kv 测试真 timer + flush 模式沿用既有套件；`-count=1` 全量新鲜执行。
4. **证据互证**：UIA 读值 × 应用日志（kick/cluster op/monitor snapshot 行）× 受害者进程输出三方互证；应用日志纪律（G9）在冒烟中复核——仅 servers/cycle_ms/cid 级聚合计数，无载荷无凭据。
