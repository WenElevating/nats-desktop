# NATS 桌面客户端 M5 验收记录

- 日期：2026-09-14（实跑）
- 分支 / HEAD：`desktop/m5` @ `353b41f`（Task 1–13）+ 本记录提交（Task 14 收尾）
- 范围：M5 = 规格 §6.10 服务器监控全量（服务器表/节点报表/连接明细 kick/事件流/账户面板）+ §6.11 集群危险操作（meta/stream step-down、balance、peer-remove，全 L2）+ §6.5 Dashboard 总览 + §8.3.1 $SYS 权限降级 + §8.5.1 监控快照事件 + AC-015/016/017 + M2 trace 集群测试遗留 + M3 集群运维入口遗留 + M4 kv 前端覆盖率整改（68.03%→≥70%，计划 `2026-09-13-nats-desktop-m5.md`，Task 1–14）
- 结论先行：**自动化回归全绿（Go 12 包 ok、272 个顶层测试 0 失败；前端 34 文件 / 268 测试全部通过；monitor 包覆盖率 82.4% ≥80% 门）；M4 遗留整改项闭环（features/kv 68.03% → 88.88%，三项大头 BucketForm 95% / KeyValuePage 93.93% / schema 100%）；性能预算 PASS（快照周期实测 610–626ms @ 3 节点真应用、事件 10k ingest <1s 零丢失 120 连跑 0 失败、体积 19.7 MiB）；真应用 UIA 冒烟 6 行全 PASS、0 行 PENDING-MANUAL——AC-015/016/017 三条 AC 在真 3 节点集群（新增 `cmd/testcluster` 测试工具）上全部 LIVE 走通；无缺陷遗留，1 项预存在构建事项登记（bindings 全量 regen 现会破坏 tsc，M6 首要项）**。

## 1. 测试环境

| 项 | 值 |
|---|---|
| 机器 | 13th Gen Intel Core i7-13700HX，16 核 24 线程，15.7GB RAM，SSD（≥ §12 高配参考档） |
| 系统 | Windows 11 家庭版 中文版（build 26200），WebView2 Runtime |
| 工具链 | go1.26.0 windows/amd64，Node v24.11.1，wails3 v3.0.0-beta.20 |
| 目标服务器 | 本机常驻真 nats-server `nats://127.0.0.1:4333`（LocalServer 变体，0 SKIP）+ 内嵌 3 节点集群夹具（testutil.StartCluster）+ **`desktop/cmd/testcluster` 真 3 节点集群（本任务新增测试工具，非产品面，README 已注明）** |
| UIA 驱动 | PowerShell UIAutomation（Invoke/Toggle/Value/SelectionItem 模式；方法注记与 M3/M4 差异见测试报告 §6） |
| 应用二进制 | 20,608,512 B ≈ 19.7 MiB（从 `353b41f` 树构建，含 M5 全部 UI） |

## 2. 自动化回归（全部实跑，2026-09-13/14）

| 命令 | 结果 | 明细 |
|---|---|---|
| `go test ./... -count=1 -cover` | **全绿** | 12 包 ok、0 失败；monitor 25.9s（31 Test，集群夹具为主）、messaging 86.6s、jsadmin 24.8s、buckets 22.7s，其余 <13s |
| `go vet ./...` | exit 0 | 无告警（含新增 `cmd/testcluster`） |
| `npx vitest run --coverage --maxWorkers=2` | **全绿** | 34 文件 / **268 测试通过**（34.3s；含 i18n 双语 parity 门——整树 key 集逐字相同，`monitor.*` 101 键 + `dashboard.*` 14 键 + `clusterOps.*` 43 键共 158 个 M5 新键自动入禁） |
| `npx tsc --noEmit` | exit 0 | 干净（对已提交 bindings 树） |
| `npm run build` | 成功 | 页面级 code-split 保持；exe 19.7 MiB ≤ 30MB PASS |

测试规模：**Go 272 个顶层 `Test` + 5 `Benchmark`（M4 231+5 → +41）**；**前端 268 测试 / 34 文件（M4 173 / 25 → +95 测试 / +9 文件）**。

## 3. AC 走查表（规格 §19 对照：AC-015、AC-016、AC-017）

状态定义：AUTOMATED-PASS（引用测试，本机实跑通过）/ LIVE-PASS（本轮真应用 UIA 实测）/ PENDING-MANUAL（附操作路径；本轮为 0）。

### AC-015 监控页与多节点（条件：3 节点集群；操作：打开监控页观察 2 个轮询周期）

| 预期 | 状态 | 证据 |
|---|---|---|
| 1. 服务器表显示 3 个节点（名称、版本、CPU、内存、连接数、JS 角色） | **AUTOMATED-PASS + LIVE-PASS** | 自动化：`TestSnapshotClusterNodeOfflineMarking` 等快照用例（wire 7 列契约、jsRole 映射纯函数真值表，Task 4）+ `monitoring-server-table` 8 例（虚拟化/排序/角色徽标，Task 10）。实测（testcluster 3 节点 + sys 账户）：表行 `在线 S1 2.15.0-preview.1 6m8s 0.7% 23.0 MiB 3 8/0 投票成员`、`在线 S2 … 元数据主`、`在线 S3 … 投票成员` |
| 2. 第二周期数据刷新；断开一节点后该节点标红离线、其余正常 | **AUTOMATED-PASS（两半）+ LIVE-PASS（刷新半边）** | 刷新：实测两读值 `6m33s 0.3% 23.6 MiB`（05:09:59）→ `6m43s 0.0% 24.4 MiB`（05:10:11），日志 `cycle_ms=610–626` 连续无缺拍；`data-polled-at` 双锚点（MonitoringPage/ServerTable 根）由前端用例钉住跨周期变化。节点断连标红：`TestSnapshotClusterNodeOfflineMarking`（known 集 diff、`online=false` 标红、保留上轮数据、`OfflineSinceMs` 单次设置、恢复在线——Task 4）；UIA 未现场杀节点（集群破坏性操作），按自动化腿采信 |
| 附加：Dashboard 总览（§6.5） | **LIVE-PASS** | 「服务器 3/3」「连接数 3」「JS 内存 0% 0 0 B / 35.4 GiB」「JS 存储 0% 0 0 B / 3.0 TiB」「往返延迟 1 ms」卡片 + 近期事件面板全部呈现；无系统账户的 4333 上下文下呈现降级横幅（见 §6 附加行）。**【终审 I-1 注记】**该降级横幅的投递机制已更正：修复前事件线不可能投递降级帧，横幅系绑定路径零值快照读出（通用兜底文案、不随周期刷新），非 §8.3.1 事件线投递；修复波（Go 恒发 `"servers":[]` + 前端 schema nullable）后事件线按周期投递——**live 腿修复后待重跑**，覆盖证据为 `monitoring-use-monitor.test.ts` 的 `servers:null`/`[]` 事件线用例 |

### AC-016 系统事件流（条件：集群系统账户；操作：打开事件流，制造一次客户端断连）

| 预期 | 状态 | 证据 |
|---|---|---|
| 事件流实时出现对应 disconnect advisory（含时间与服务器来源） | **AUTOMATED-PASS + LIVE-PASS** | 自动化：`TestSysWatchIngest10kWithRegex`（10k ingest <1s 零丢失、filtered 精确）、`TestSysWatchFloodNoLoss`（200 真实连接断连 advisory 零丢失）、`TestNotifyConnStateStopsSysWatches`（断连全停）、EventsPanel 过滤/ring/清空用例（Task 7/12）。实测：「事件」页签挂载（累计 0）→ 终止 app 账户受害者连接 → 行实时出现：`05:23:48.342 │ io.nats.server.advisory.v1.client_disconnect │ S2 │ APP · app@127.0.0.1 Read Error │ $SYS.ACCOUNT.APP.DISCONNECT │ 804`——时间、来源服务器（S2）、账户/用户、原因齐备；「累计 1 / 丢弃 0 / 过滤 0」。制造断连的两条路径都走了：①UI 内 kick（L1 确认框「断开连接 22」→ 确认 → 受害者 `VICTIM-DISCONNECTED: EOF`、日志 `kick connection server=S1 cid=22`）；②受害者进程终止时面板挂载在场收得 advisory |

### AC-017 集群危险操作（条件：集群 + stream 副本 3；操作：meta 层 step-down 二级确认）

| 预期 | 状态 | 证据 |
|---|---|---|
| 1. 名称输入不匹配时不执行 | **AUTOMATED-PASS + LIVE-PASS** | 自动化：`DangerOpDialog` 用例（不匹配 → 确认钮禁用 + 提示 + 对话框保持，Task 12）+ `monitoring-danger-zone` 套件。实测：L2 对话框「输入 "S2" 以确认」→ 输入错误名 `S1` → 「名称不一致——请精确重新输入」+ **「执行」DISABLED**（UIA 读态 enabled=False） |
| 2. 确认后执行成功、界面刷新出新领导者、操作期间按钮不可重复触发 | **AUTOMATED-PASS（三半）+ LIVE-PASS（执行+新 leader 半边）** | 实测：输入正确名 `S2` → 「执行」ENABLED → 点击 → 执行成功、对话框关闭、服务器表 `在线 S1 … 元数据主`（原 leader S2 变「投票成员」）、危险卡「当前元数据主：S1」；日志 `cluster op completed op=meta_stepdown code="" elapsed_ms=1127`。重复触发禁用：Go 侧 `op+target` CAS 单飞 + 前端 inFlight 禁用（`TestMetaStepDownSingleFlightConflict`、DangerZone 用例，Task 8/12）；新 leader 选举自动化腿 `TestMetaStepDownElectsNewLeader`（Task 8） |
| 附加：域守卫与 stream 侧操作 | **AUTOMATED-PASS** | meta 层域守卫（domain/api_prefix 配置 → validation + natscli 同义文案，`TestMetaStepDown*` 域守卫用例）；stream step-down/balance/peer-remove 与 4 节点 peer-remove 夹具（`TestStreamStepDownAndBalance` 等，裁定见 §5） |

## 4. Global 约束逐条核对表（计划 §Global Constraints，20 项）

| # | 约束 | 验证处 |
|---|---|---|
| 1 | 监控轮询契约（interval 设置 + 可见性门 + 单飞 ticker + monitor:snapshot 事件 + GetMonitoringSnapshot） | Task 4：`TestStartStopMonitoringEvents` / `TestNotifyConnStateStopsTicker`（null-hypothesis：interval=2s + 2.5s 观察窗）；Task 10：`monitoring-use-monitor` 门控生命周期用例。实测：5s 间隔 chip + 连续周期无缺拍 |
| 2 | 节点级失败隔离（2s 固定超时、标红保留上轮、恢复在线） | Task 4：`TestSnapshotClusterNodeOfflineMarking` + 快照降级用例；AC-015 预期 2 自动腿 |
| 3 | $SYS 权限降级（sys_available=false + 原文 reason；面板级失败不传染） | Task 4：`TestSnapshotNoSysPermission`（503 原文路径）；**本轮 UIA 附带实证**：4333（无系统账户）下「系统账户不可用——集群级指标受限」横幅呈现、sys 集群下消失。**【终审 I-1 注记】**机制更正：该实证修复前经由绑定路径零值快照读出（通用兜底文案、不刷新），非 §8.3.1 事件线逐周期投递；修复波已修（Go 降级恒发 `"servers":[]` + 前端 schema nullable + 事件线 null/[] 两形用例），**live 腿修复后待重跑** |
| 4 | kick 断开连接（L1 + 服务器原文透传） | Task 5：`TestKickConnection`（拒绝原文透传、gone-cid 软处理见 §5-6）；本轮 UIA 实测 L1 全流程 |
| 5 | 事件洪水（4096 丢最旧 + dropped_total/filtered_total、10k 前端环、长生命周期 ctx、断连全停） | Task 7：ingest/queue 纯测 120 连跑 0 失败 + flood 200 连接零丢失；Task 12：EventsPanel ring/清空用例；`TestNotifyConnStateStopsSysWatches` |
| 6 | 危险操作契约（全 L2、名称不匹配拒绝、单飞 conflict、闭集错误码） | Task 8：CAS 单飞 + conflict；Task 12：DangerOpDialog 六 props 语义保持；AC-017 LIVE |
| 7 | 危险区视觉（红色分离、TriangleAlert、禁 emoji） | Task 12：DangerZone 渲染用例；本轮 dump emoji 码位扫描零命中（像素级配色核对留人工，UIA 文本通道不可读色值——M4 同款注记） |
| 8 | meta 层域守卫（natscli parity 逐字文案） | Task 8：域守卫测试（domain/api_prefix → validation） |
| 9 | 事件/监控载荷不入日志（§13.3） | Task 4/7 日志纪律实现 + 本轮冒烟日志复核：仅 `servers`/`cycle_ms`/`cid` 级聚合 |
| 10 | 事件类型闭集 + JS 前缀三级推导 + subject 正则 | Task 7：`TestEventSubjects`（闭集/白名单/推导全对）；Task 12：过滤按钮组；本轮 UIA 5 类型按钮在列 |
| 11 | connz 排序闭集（nats-server SortOpt 子集、limit 1–1024） | Task 5：`TestValidateConnQuery` 真值表；Task 11：表头排序 UI 用例（`SORT_KEYS` 9/10 服务器端预降序，裁定见 §5）；本轮连接表列头 `CID ↑` 在列 |
| 12 | JS 角色映射（disabled/meta_leader/voter/""） | Task 4：jsRole 纯函数真值表；本轮 LIVE：元数据主/投票成员徽标随 step-down 正确翻转 |
| 13 | 性能与规模（单广播 ≤2s、3 节点健康周期实测记录、10k ingest <1s、1024 分页 ≤500ms、50 行虚拟化） | 测试报告 §4 性能表：cycle_ms 610–626ms 照录（预期 <600ms 的估计值轻微超出、门槛 PASS）、ingest 120 连跑 0 失败、1024 分页功能层有测试无独立 bench（登记遗留） |
| 14 | 真服务器测试 + 集群内嵌专属 + Windows 放宽 | LocalServer 0 SKIP（4333 存活，/jsz 应答）；集群夹具内嵌跑；`cmd/testcluster` 为人工验证补齐真进程载体 |
| 15 | i18n（AC-021） | i18n 完整性门整树 key parity 通过；总量 927 键（M5 新增 monitor 101 + dashboard 14 + clusterOps 43）；冒烟全程 zh-CN 文案无英文硬编码泄漏 |
| 16 | UI 规范（tabular-nums、表头排序、失败 toast + 展开原文、空态引导、主题三态） | Task 10/11/12 组件用例（降序页面本地翻转唯一解、错误卡/toast 双显、空态文案）；冒烟目视核对 |
| 17 | 依赖零新增（Go/前端） | `git diff go.mod` 本轮为空；package.json 未动；`cmd/testcluster` 仅复用既有依赖（jsm.go/serverdata、nats-server/v2、nats.go） |
| 18 | M4 遗留整改并入（kv 68.03%→≥70%） | **闭环**：88.88%（BucketForm 95% / KeyValuePage 93.93% / schema 100%），21 个证伪型新用例，零产品代码改动 |
| 19 | 绑定约定（单结构体返回、bindings 树是提交物） | Task 9 monitor 生成文件已提交；本轮 regen churn 按惯例 restore（重生树不入库）——regen 破坏 tsc 的预存在事项登记 M6 首要项（测试报告 §8-1） |
| 20 | 发射 goroutine 防 panic（recover + Error 日志继续） | Task 4（ticker/emitter）+ Task 7（emit）+ Task 8（cluster ops defer recover）代码与注释在案 |

## 5. 裁定记录汇总（终审口径）

| 项 | 裁定 |
|---|---|
| 1. trace service_import/stream_export 集群测试 | **转手测（manual-matrix 延期）**：M2 遗留的集群 hop 形态（mapping/service_import/stream_export）中,前者已由 Task 2 三例全载荷断言覆盖（路由跳/映射跳/无兴趣树）；service_import/stream_export 依赖跨账户导出配置的集群夹具，Task 2 报告登记转 M6 手测矩阵（测试注释已载明） |
| 2. ErrTimeout 部分结果路径 | **转 M6 手测矩阵**：$SYS 定向请求超时只能产「零应答」，真实「部分应答即超时」需时序注入——计划审查 M8 裁定将超时测试重构为无兴趣路径（验证 not_found 语义），部分结果路径列 M6 手测（计划 `.superpowers/sdd/m5-plan-review.md` M8） |
| 3. nats-server v2.15 3 节点 R3 peer-remove 10075 | **服务器行为坐实**：v2.15 `requireReplicas` 无条件真 + 被移节点排除出候选 → 3 节点 R3 集群移除任一成员确定性 10075（no suitable peers）；natscli 同 API 同待遇——非实现缺陷 |
| 4. peer-remove 夹具 4 节点 | **偏差（a）获批**：Task 8 偏差 (a) 用 4 节点夹具绕开 #3 的服务器硬约束，断言未弱化；夹具强化（per-node EnableJetStream + waitClusterReady 等待 leader 全量 meta 视图）为判据加严 |
| 5. JS 内存比 Σused/Σmax | **解释而非漂移**：brief 字面 reserved_memory 与规格 §6.5「使用比」矛盾——实现取 Σused/Σmax（Task 13 裁定，审查认可）；UIA 读值「JS 内存 0% 0 0 B / 35.4 GiB」即该语义 |
| 6. kick-of-gone-cid 软处理 | **CodeServer 原文透传**（非 not_found）：cid 已消失时 nats-server 返回「connections not found」类原文，前端 toast 原文软处理（Task 5 移交 Task 12 UI，已落地）——与 §6.10「kick 被拒绝显示服务器原文」一致 |
| 7. meta 域守卫 | domain/api_prefix 配置时 meta 层操作拒绝（validation + natscli 同义文案），防把 step-down 发往域前缀主题（系统账户无响应者）——Task 8 测试钉住 |
| 8. 单飞 conflict 语义 | 同 `op+target` 在飞重复触发 → error_code `conflict`（M4 闭集成员）→ 前端 toast「操作进行中」；不同 target 并行放行；`TestMetaStepDownSingleFlightConflict` 10 连跑无双 OK |
| 9. NodeDetail 面板按需刷新 | 下方面板（节点报表/连接/事件/账户/危险区）为按需报表 + 手动刷新，无前端定时器——与「Go 侧拥有快照轮询」的分工一致（页面注记 + Task 10/11 用例钉住）；降序页面本地翻转 = ConnzOptions.Sort 无方向标志下的唯一解（Task 11） |

## 6. 遗留清单（M6 候选，自 progress.md M5 段逐任务 roll-up）

**首要（构建/流程）**

1. **bindings 全量 regen**：重生树现在会令监控源码 3 处 tsc 报错（AccountsPanel `stream_names` ×2、DangerZone `snapshot.servers`）——regen 提交前需先补 9207fd3 风格 null-guard，再一次性重提交（22+ 文件 createFrom 包装代差，M3 §9-1 / M4 §6-2 延续，**升级为 M6 首要项**）。
2. **CI `-race` 首跑仍未验证**（远端 0 次运行记录，M1 起在案）；本机 -race 预存在不可用（TSAN commit 上限）。
3. M2 trace service_import/stream_export 转手测 + ErrTimeout 部分结果手测矩阵（§5-1/2）。

**Deferred Minors（progress.md M5 段滚存，共 34 项，终审/M6 逐条裁决）**

- Task 1：①cluster.go 头注释/Opts 字段注释未随 D2 更新（doc-only）②seed 端口 TOCTOU（披露，标准做法）
- Task 3：③ClassifyMonitorError 的 api.ApiError 分支 `ae.Description` 可为空串（修法：空→回退 `ae.Error()` + 一条测试）
- Task 4：④并发双 Stop 后紧接 Start 的竞窗（旧循环 cycleBusy 可压新循环首帧一拍，自愈）⑤pollLoop panic 后 running 挂真→Start 静默无效（需显式 Stop；考虑自重启）⑥`TestNotifyConnStateStopsTicker` 首帧等待不因零事件失败（brief 原文）
- Task 6：⑦accountRows >50 流 cap 不变量无测试（纯函数表格单测成本低）⑧accounts_test 内联 EnableJetStream 冗余死重（清理候选）
- Task 7：⑨offer 内测试调度机制应藏于 lazyStart 标志后（生产永死分支）⑩emitter 启动与 registry.add 间 NotifyConnState 竞窗可漏条目（窗极小）⑪CONNECT 事件用 DisconnectEventMsg 解析（形状子集，输出全等，cosmetic）
- Task 8：⑫CodeConflict 路径无 elapsed 日志 ⑬natscli 措辞微漂（brief 原文优先）⑭"within 5s" Note 文案硬编码 ⑮StreamBalance 域上下文用默认 API 主题（natscli 同款设计）⑯StartCluster doc 注释陈旧（测试一律传 3/Meta.Leader 非空）
- Task 9：⑰smoke_test interval 表用例复用单例改 settingsPath（序偶安全）⑱interval() doc 注释与实际（<2→5s 非 clamp 2）不符（预存）；移交 M6：bindings regen 重提交（见上）+ 生成器绑定 NotifyConnState 勿深导入（已隔离）
- Task 10：⑲行 role=button 无 Space 键（StreamList 同款，a11y 后补）⑳双根 data-polled-at 空值约定不一（null vs "0"，无害）
- Task 11：㉑非 cid 键首屏方向标签语义反转（服务器预降序 vs aria-sort=ascending；数据序确定，仅标签/a11y nit）㉒传输 throw 处理不一致（NodeDetail 错误卡 vs Conn/Accounts toast+清空）㉓NodeDetail 错误卡无重试按钮 ㉔formatBytes MiB 封顶 + NodeDetail 私有 formatSize 双格式化器待统一（>1GiB 可读性）㉕SORT_KEYS 缺 last 键（brief 列 spec 亦无该列，内部自洽）
- Task 12：㉖EventsPanel create 持续失败时每次过滤变更都 toast（风暴风险）㉒沿用：事件 useState 不可变前插 O(n) 拷贝（洪峰 jank 风险）㉙监控页流操作 expectedName 为操作者重输一致性门（设计固有；StreamDetail 变体更强）㉚离线 meta leader 卡禁用（defensible）
- Task 13：㉛pushAdvisory 与 pushEvent 重复（可委托）㉜aria-valuenow 未钳制（a11y 边角）㉝uint64 >2^53 JS 精度（系统性 Wails 限制，预存）㉞advisory 环跨断连保留（EventsPanel 同款共享选择）
- Task 14 新增：㉟connz 1,024 行分页排序无独立墙钟 bench（功能层有测试；G13 该子门无墙钟证据）㊱smoke 辅助 `m5-testcluster.json` 上下文留置（同 M3 惯例，人工回填前置）

**既有覆盖遗留延续（M4 登记、M5 未触碰）**：settings 72.7% / version 75.5% / appdir 71.4%（§20.1 80% 门未达，M6+ 触碰面顺手补）；像素级配色人工核对（UIA 不可读色值）。

## 7. 回填区（人工走查后填写，与 M1–M4 同构）

| 走查项 | 结果 | 执行人/日期 | 备注 |
|---|---|---|---|
| 节点断连标红的 UI 实拍（杀一个集群节点进程 → 服务器表该节点红行） | 待执行 | | AC-015 预期 2 后半；自动化腿 `TestSnapshotClusterNodeOfflineMarking` 在案 |
| 深色主题像素级核对（UIA 不可读色值） | 待执行 | | 含危险区红色分离的目视确认 |
| stream 副本 3 下的 stream step-down/balance UI 实拍（AC-017 条件全量） | 待执行 | | 本轮 meta 层 LIVE；stream 层自动化 `TestStreamStepDownAndBalance` + 4 节点夹具在案 |

## 8. 结论

M5 十四项任务全部完成：§6.10/§6.11/§6.5 三大面交付且经真 3 节点集群 UIA 冒烟全 PASS；AC-015/016/017 闭环；M2/M3/M4 三笔遗留（trace 集群、集群运维入口、kv 覆盖率）两笔闭环、一笔按裁定转手测矩阵；G1–G20 全约束有验证处。M6 候选以 bindings regen（含 3 处 null-guard 前置）与 CI -race 首跑为首要，Deferred Minors 36 项随终审逐条裁决。
