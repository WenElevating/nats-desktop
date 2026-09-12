# NATS 桌面客户端 M3 验收记录

- 日期：2026-09-12（深夜实跑）
- 分支 / HEAD：`desktop/m3` @ `54497bf`（Task 1–14 全部合并）+ 本记录提交（含 Task 15 冒烟辅助修复 `9207fd3`，见 §7「冒烟方法注记」与 §6 遗留清单第 12 项）
- 范围：M3 = 规格 §6.6 Streams 全量（列表/详情/速率/CRUD/purge/seal/浏览器/备份恢复）+ §6.7 Consumers 全量 + §6.4 header 过滤（M2 终审强制项）+ confirm_level 确认策略（§6.12）+ §12 相关性能预算（计划 `2026-09-12-nats-desktop-m3.md`，Task 1–15）
- 结论先行：**自动化回归全绿（Go 11 包 184 个顶层测试 + 子测试全部通过、前端 155 测试 / 23 文件）；性能预算全部大幅达标（500 流列表 20.9–37.7ms、1M 消息尾页 32ms / 跳转 52ms、header 过滤管线 562k msg/s、洪峰注入 59,968 msg/s 守恒精确、并发 12 goroutine 零错误）；真应用 UIA 冒烟 10 行中 8 行 PASS（AC-008~012 逐条走通）、2 行 PENDING-MANUAL（备份恢复原生目录选择器、JS 不可用指引——桌面锁屏环境无法驱动，附精确路径与自动化覆盖）**。覆盖率首次实测记录（§4），未达 §20.1 门槛的包已列整改项。

## 1. 测试环境

| 项 | 值 |
|---|---|
| 机器 | 13th Gen Intel Core i7-13700HX，16 核 24 线程，15.7GB RAM，SSD（≥ §12 高配参考档） |
| 系统 | Windows 11 家庭版 中文版（build 26200），WebView2 Runtime |
| 工具链 | go1.26.0 windows/amd64，Node v24.11.1，wails3 v3.0.0-beta.20 |
| 目标服务器 | **本机常驻真 nats-server `nats://127.0.0.1:4333`，JetStream 开启（2.15-preview），监控 `:8333/jsz`**（全部 LocalServer 测试与冒烟打真服务器；冒烟结束后已清理全部 `m3*` 流，`/jsz` streams=0 无残留） |
| UIA 驱动 | PowerShell UIAutomation（InvokePattern/ValuePattern/SelectionItemPattern/ExpandCollapsePattern）+ MSAA `accDoDefaultAction`（行级元素不暴露 InvokePattern，见 §7 注记） |
| 桌面状态 | **物理桌面处于锁屏**（前台窗口为锁屏界面）——与 M2 一致，合成鼠标/键盘注入不可用；全部交互经 UIA/MSAA 可访问性通道完成 |

说明：本机 `-race` 不可用为预存在环境问题（M2 台账在案），竞态覆盖由 CI 承接。

## 2. 自动化回归（全部实跑，2026-09-12 深夜）

| 命令 | 结果 | 明细 |
|---|---|---|
| `go test ./internal/... -count=1` | **全绿** | 11 包 ok、0 失败、**无 SKIP（jsadmin 44 个 LocalServer 变体全部实跑真服务器）**。分包耗时：messaging 78.9s（含真服务器场景与压力门槛）、jsadmin 29.5s（含 1M 消息 AC-028 夹具）、connections 12.0s，其余包 <1.2s |
| `go vet ./...`（internal 范围） | exit 0 | 无告警 |
| `npx vitest run`（frontend） | **全绿** | 23 文件 / **155 测试通过**，9.9–13.5s |
| `npm run build` + `tsc --noEmit` | 成功 | 页面级 code-split 保持（StreamsPage/ConsumersPage/MessagesPage 各自独立 chunk） |
| `wails3 build`（desktop） | **成功** | 产物 `desktop/bin/nats-desktop.exe` = **19,839,488 B ≈ 18.9 MiB** ≤ 30MB（§12）→ PASS。注：`wails3 build` 内置 bindings 重生会把生成物刷成 interface+nullable 风格，6 处 nullability 触发 tsc 失败——已以防御性空值守卫修复（`9207fd3`，对两种生成风格均兼容），重生后的 bindings 树按惯例不入库（§6-12） |

测试规模（本里程碑新鲜统计）：**Go 184 个顶层 `Test` 函数 / 11 包，含子测试共 193 个用例、0 失败（另 4 个 `Benchmark`）；前端 155 个测试 / 23 文件**（M2 基线 125 Go + 96 vitest → M3 净增约 59 Go + 59 vitest）。

## 3. 性能实测表（§12 预算，数字来源见「来源」列；均为本里程碑实跑）

| 预算项 | 门槛（高配/低配） | 实测 | 来源 |
|---|---|---|---|
| 列表加载（500 streams） | ≤500ms / ≤1500ms | **20.9 ms / 37.7 ms**（真服务器 500 条新建流 ListStreams，两轮） | Task 14 `TestStreamList500LocalServer` |
| 大数据集浏览器（AC-028） | 尾页/跳转 ≤1s（高配） | 1M 消息流：**尾页 32ms / 中段跳转 52ms**（夹具 25.7s 注入）；100k 流尾页 bench **1.63ms/op**（含一次性消费者的建删开销） | Task 4 `TestBrowseLargeDatasetLocalServer`；Task 14 `BenchmarkBrowseTailPageLocalServer` |
| 前端大列表渲染（AC-028 帧率半边） | 滚动 ≥60fps / ≥30fps | 10k 流虚拟化仅渲染 **18 行**（1024×280 视口）；冷挂载 **132 ops/s**（≈8.7ms/commit）、排序切换 180–192 ops/s | Task 9 虚拟化测试；Task 14 `streams.bench.ts` |
| StreamList Go 渲染 bench | 信息性 | **381µs/op**（2,467 B/op, 40 allocs/op） | Task 14 `BenchmarkStreamListLocalServer` |
| header 过滤洪峰（§6.4 / M2 终审强制） | 50k msg/s 硬门槛 | flood 注入 **59,968 msg/s**（1.2× 门槛，by-design 无余量测量），守恒 **Total+Filtered==200,000、Dropped==0**；deliver 全管线带过滤 bench **1,778ns/op ≈ 562k msg/s/核** | Task 7 真机实测；Task 14 `BenchmarkHeaderFilterPipeline` |
| 冒烟实时守恒（真应用 UIA） | 守恒 | 会话订阅 + Env=prod 过滤：注入 4×199 条（半数带头）→ **缓冲区 398 / 已过滤 398**，`received == total + filtered`（796 = 398+398）精确成立（§7 行 h） | 本轮 UIA 冒烟 |
| 并发正确性 | — | `TestConcurrentStreamOpsLocalServer`：**12 goroutine / 60 ops（建改删 + 并发列表）零错误**；备份互斥 busy 路径有测试 | Task 14；Task 6 |
| 体积 | ≤30MB | **18.9 MiB**（便携 exe） | 本轮构建 |

## 4. 覆盖率实测（§20.1 门槛：业务逻辑（Go 侧）≥80%、前端组件 ≥70%；M1/M2 未实测，本次必须记录）

`go test ./internal/... -cover -count=1`（2026-09-12 实测）：

| 包 | 语句覆盖率 | 判定 |
|---|---:|---|
| connections | 86.1% | 达标 |
| messaging | 86.1% | 达标 |
| natsver | 85.7% | 达标 |
| settings | 72.7% | 未达 80% → 整改项 |
| appdir | 71.4% | 未达（薄封装包，7 行中 main 分支不可头lessly 测）→ 整改项 |
| jsadmin | 78.8% | **距门槛 1.2pt → 整改项（M4 首个任务补：PickBackupDirectory 无头分支、JSParams load-error、domain 分支等台账 Minor 的测试化）** |
| version | 75.5% | 未达 → 整改项 |
| jsctx | 66.7% | 未达（domain>prefix 优先级分支无测试，Task 1 台账在案）→ 整改项 |
| logging | 63.9% | 未达（rotate 双失败路径等 M1 遗留 Minor）→ 整改项 |
| testutil | 28.6% | 测试辅助包，不计入业务逻辑门槛（说明性记录） |

前端组件覆盖率：vitest 155/155 全绿，但 **未配置 coverage provider（@vitest/coverage-v8 未安装）→ 本次未能产出数字**，列为整改项（M4：安装 provider 并在 CI 输出覆盖率，门槛 ≥70%）。

整改项汇总（移交 M4）：① jsadmin 78.8→≥80%；② jsctx domain 分支补测；③ logging 轮转失败路径补测；④ settings/version/appdir 视 M4 触碰面顺手补；⑤ 前端接入 coverage provider 并记录基线。

## 5. AC 走查表（规格 §19 对照：AC-008~012、AC-028、AC-029-浏览器半边）

状态定义：AUTOMATED-PASS（引用测试，本机实跑通过）/ LIVE-PASS（本轮真应用 UIA 实测）/ MEASURED（数字+方法）/ PENDING-MANUAL（附操作路径）。

| 规格 AC | 走查项 | 状态 | 证据 / 操作路径 |
|---|---|---|---|
| AC-008 | 创建 stream 并发布 | **AUTOMATED-PASS + LIVE-PASS** | 自动化：streams-form/danger 前端 8 例（14 字段 wire 断言、内联拦截）、jsadmin CRUD 真服务器变体。实测：新建流表单空 subjects 提交 → 内联文案「除非设置镜像，至少需要一个主题」且不发起请求；填 `m3b-orders`/`orders.*` 提交 → 对话框关闭；向 `orders.received` 发布 3 条 → 列表行 `m3b-orders orders.* 3`（UIA 读值） |
| AC-009 | 消息浏览器与单条删除 | **AUTOMATED-PASS + LIVE-PASS（删除后空洞标记子项 PENDING-MANUAL）** | 自动化：streams-msgs 11 例（翻页参数链、页大小 20/50/100/200、`detectHoles`、删除 L1 → `RemoveStreamMessage` → 「已删除 seq N」标记、二进制 hex+下载、截断行全载荷拉取）。实测：m3c-browser（120 条）浏览器面板打开，默认每页 50；下一页/尾页/首页可用，尾页时「下一页」呈 DISABLED；页大小切 20 生效；行详情（载荷/头/删除）打开。删除后空洞标记的 UI 实拍因锁屏节流未回填（§7 注记-2），点击路径：消息浏览器 → 点行 → 详情「删除」→ 确认 |
| AC-010 | purge 与删除的分级确认 | **AUTOMATED-PASS + LIVE-PASS** | 自动化：confirm 原语 5 例 + streams-danger 5 例。实测（standard 级）：purge 弹 L1「清空流"m3d-purge"？」→ 取消不执行 → 确认后 toast「已从 m3d-purge 清空 7 条消息」且详情消息数归 0、流仍在；删除弹名称匹配框「输入 "m3d-del" 以确认」→ 错名时确认键 DISABLED → 正名启用 → 确认后 toast「流 m3d-del 已删除」、列表移除。relaxed 直执行半边由自动化覆盖（settings 切换即可复现），未做 UI 实拍 |
| AC-011 | 消费者创建与拉取预览 | **AUTOMATED-PASS + LIVE-PASS** | 自动化：consumers-page 8 例 + jsadmin 消费者生命周期真服务器变体。实测：消费者页选 m3e-consumer 流 → 新建 durable pull（m3e-dur，filter m3e.events）→ toast「消费者 m3e-dur 已创建」、列表行「m3e-dur 拉取 30 0 …」；拉取预览批量 10 → 10 张消息卡（m3e.events）；关闭后列表/详情「未确认」= **10**（NumAckPending 上升可见） |
| AC-012 | 消费者暂停与恢复 | **AUTOMATED-PASS + LIVE-PASS** | 自动化：暂停三层强制（hook/Go/服务器）+ 竞态回归。实测：时长 60s → 暂停 → 详情「已暂停——剩余 1m」+ toast「消费者 m3e-dur 已暂停」→ 「拉取预览」按钮 DISABLED（UIA 读态）→ 恢复 → 徽标消失、按钮恢复，再次拉取实收消息 |
| AC-028 | 大数据集 | **MEASURED（自动化半边）+ PENDING-MANUAL（10k 流滚动帧率 UI 观察腿）** | 500 流列表 20.9–37.7ms（§3）、1M 消息尾页 32ms/跳转 52ms、10k 行前端虚拟化 18 行/132 ops/s。10k 流滚动帧率需 GUI 在场录屏判读；10k 流夹具按计划以「500 流断言 + 10k 行前端虚拟化 + 1M 消息浏览器」组合覆盖 |
| AC-029 | 大消息与二进制（浏览器半边） | **AUTOMATED-PASS（自动化半边）+ PENDING-MANUAL（2MB 实发视觉走查）** | 浏览器半边：>1MB 消息仅 64KiB 前缀 + truncated 标记（Go，Task 4，`f49660c` 对齐规格），truncated 行点开走 `GetStreamMessage` 全量 + hex 预览 + 下载（前端 11 例中的行查看器用例）。2MB 实发受服务器 max_payload=1MB 限制（应用呈现服务器错误原文即规格预期，同 M2 结论）；2MB 注入需调服务器参数后人工走查 |
| §6.6 异常表 | 5 行 | **AUTOMATED-PASS ×5**（行 1 另列 PENDING-MANUAL） | 见 §6 映射表 |
| §6.7 异常表 | 3 行 | **AUTOMATED-PASS ×3**（行 2 另有 LIVE-PASS） | 见 §6 映射表 |

## 6. §6.6/§6.7 异常表映射 + 裁定

### §6.6 Streams 异常表（5 行）

| # | 规格异常 | 实现映射 | 测试 / 证据 |
|---|---|---|---|
| 1 | JetStream 不可用 → 显示说明与排查建议，不得空列表 | Task 3 `ListStreams` 分类（10059→unavailable_reason：no_responders/timeout/server）+ Task 9 StreamsPage 不可用指引面板（含 checkDomain/checkPrefix 排查两行），替代表格渲染 | 前端 streams-page 测试「never an empty table」；UI 实拍列 §7 行 i（PENDING-MANUAL，探针 context 已备） |
| 2 | 消息体超大（>1MB）→ 仅元数据+hex 预览+下载 | Task 4 浏览器：严格 >1MB 截断（64KiB 前缀上限，`f49660c` 裁定对齐 §6.6 权威）+ Task 11 truncated 行 → 单条全量拉取、hex、下载 | Go 截断钉住测试 + 前端行查看器用例（hex `00ff80`、Blob 下载、全载荷替换） |
| 3 | 删除二级确认不匹配 → 拒绝执行并保持对话框 | Task 8 `confirmNameMatch`（恒弹层；错名时确认键禁用、promise 挂起） | confirm 测试 5 例；本轮 UIA 实测错名 DISABLED / 对名启用（§7 行 d） |
| 4 | 备份中断 → 停止、保留分片、标记不完整、绝不声称完整 | Task 6 `watchConnClose` 断线取消（brief 原文会永久挂死的修正）+ `close(dropped)` 先于 cancel 的顺序守卫 + incomplete 先于错误码 | `TestBackupDisconnectMarksIncompleteLocalServer` 3 轮稳定（`[running, incomplete]`，无 complete）；事件契约断言 |
| 5 | 恢复目标已存在 → 先确认覆盖语义 | Task 6 `ErrRestoreTargetExists`（"already exists (confirm delete-and-recreate)"）+ Task 13 覆盖确认门（勾选「删除并重建」→「覆盖恢复」才调 `RestoreBackup(dir,true)`） | `TestRestoreTargetExists` + 前端 streams-backup 覆盖门用例 |

### §6.7 Consumers 异常表（3 行）

| # | 规格异常 | 实现映射 | 测试 / 证据 |
|---|---|---|---|
| 1 | 消费者被外部删除 → 刷新列表并提示不存在 | Task 5 服务层 not_found 分类 + Task 12 hook：detail `not_found` 丢弃失效选中并刷新；列表 `not_found`（流已删）静默空列表不误导 | consumers-page 用例（reset/delete 的 not_found → toast「资源不存在」+ 刷新） |
| 2 | 暂停中的消费者拉取 → 禁用拉取 + 原因 + 剩余时长 | Task 5 pauseGate（fail-closed）+ Task 12 详情暂停卡（格式化剩余时长倒计时）+ NextPreview 禁用并显示 pausedHint | AC-012 自动化三层 + 本轮 UIA 实测（DISABLED 读态 + 「已暂停——剩余 1m」） |
| 3 | 表单参数越界 → 表单内联范围说明，不发起请求 | Task 2 `ValidateConsumerForm` 15 规则 + Task 12 zod 逐条镜像（越界即内联文案、零 binding 调用） | consumers-page「越界数值被内联拦截且无任何 binding 调用」用例 |

### 裁定与延期（终审口径）

| 项 | 裁定 |
|---|---|
| §6.7 列表「丢失数」列 | NATS 无消费者级丢失计数器 → **以 NumRedelivered（红位/重投数）承载**，列表列名「重投数」，已文档化（Task 12） |
| §6.6「集群运维入口」 | leader 迁移/RAFT 操作按钮依赖 §6.11 集群页 → **归 M5 集群里程碑**（Task 15 遗留显式记录） |
| trace 集群测试 | M2 验收记录原文「M3 集群功能时补」→ 随集群入口一并归 M5 |
| workqueue 流浏览 | 需服务器 allow_direct 前提（natscli 同前提），Task 4 测试已按此前提标注；默认配置下的行为提示留 M4/M5 评估 |
| RESET / PriorityPrioritized 对旧服务器 | 服务器不支持时以错误原文兜底呈现（Task 5 注）；2.15-preview 首次 RESET 陈旧游标 quirk 已实测并文档化（Task 14，幂等重试兜底） |
| §18.4 列显隐/列宽拖动持久化 | 归 M6（计划评审延期裁定，维持） |
| 备份无取消按钮 | 本轮未做（中断=断线/失败路径已覆盖；主动取消入口留 M4+ 评估） |
| 恢复不改名 | 恢复沿用 backup.json 内流名，不提供改名（如需改名走「恢复后复制」路径，M4+ 评估） |
| nsr_domain 未接 | 消费者 domain 参数未接入 UI（jsadmin 绑定未暴露），归 M4 消费者增强 |
| CopyStream / CopyConsumer 直接复制 | 绑定已暴露、UI 走表单预填流（可改字段），直通复制按钮未接（streams/consumers 两处同裁定） |
| purge 选项对话框（keep/subject 过滤） | 延期；当前 purge 为全量 `PurgeStream(name,0,0,"")` |
| PubPanel/TracePanel index key | M2 裁定当前追加/删除模式下正确，维持 M6 观察项 |

## 7. 控制器冒烟（2026-09-12 深夜，真实应用 UIA/MSAA + `nats://127.0.0.1:4333`）

**冒烟辅助修复 `9207fd3`**：`wails3 build` 内置 bindings 重生后 tsc 对新生成 nullable 类型报 6 处错误（Task 7/14 台账的「生成器漂移」实际落地为构建阻塞）。以防御性空值守卫修复（对已提交风格与重生风格均编译通过，vitest 155/155 复绿），构建产物 18.9MiB 用于本轮冒烟。重生 bindings 树本身按惯例不入库。

**冒烟方法注记**：① 物理桌面锁屏（前台窗口为锁屏界面）→ 合成鼠标/键盘不可用，与 M2「物理点击不可用」同因；② 流/浏览器行等元素为 role=button 但**不暴露 UIA InvokePattern**——通过 MSAA `accDoDefaultAction`（oleacc）驱动，全部行级操作由此完成；③ 命名碰撞（导航「消息」vs 详情页签「消息」vs「消息数」）以精确名+树序消解；④ 锁屏下 WebView2 后台节流：注入停止后前端 chip 停留在最后一批事件（新一轮注入不实时上屏），交互仍可执行——M2「50k 洪峰后 UIA 提供方停答」现象与此同源，收敛建议见 §6-8/遗留清单。

| # | 冒烟项 | 结果 | 证据（UIA/MSAA 读值） |
|---|---|---|---|
| a | Streams 列表加载 + 筛选 | **PASS** | 8 条种子流全列渲染（名称/主题/消息数/速率/字节/消费者/最近时间/副本 8 列）；速率列出现（0 msg/s）；搜索「beta」→ 仅 m3a-beta、「alpha」→ 仅 m3a-alpha |
| b | AC-008 创建流 + 发布 3 条 | **PASS** | 空 subjects 提交被内联拦截（「除非设置镜像，至少需要一个主题」、对话框保持）；创建 m3b-orders（orders.*）成功；发布 3 条后列表行 `m3b-orders orders.* 3` |
| c | AC-009 浏览器分页 + 删单条空洞 | **PASS（空洞标记子项 PENDING-MANUAL）** | 浏览器面板：每页 50（默认）、下一页/尾页/首页、尾页时「下一页」DISABLED、页大小切 20 生效、行详情（载荷）打开。删除单条后的「已删除 seq N」标记未在 UI 实拍（点击路径已附于 §5 AC-009 行）——该链路自动化 11 例覆盖（含标记渲染断言） |
| d | AC-010 purge L1 + delete 名称匹配 | **PASS** | purge：L1 对话框「清空流"m3d-purge"？」→ 取消不执行 → 确认 → toast「已从 m3d-purge 清空 7 条消息」+ 消息数 0；删除：「输入 "m3d-del" 以确认」错名确认键 DISABLED、正名启用、toast「流 m3d-del 已删除」、列表移除 |
| e | AC-011 消费者创建 + 拉取预览 | **PASS** | m3e-dur（durable pull，filter m3e.events）创建 toast + 列表「m3e-dur 拉取 30 0 …」；预览批量 10 → 10 张消息卡；关闭后「未确认」= 10 |
| f | AC-012 暂停/恢复 | **PASS** | 暂停 60s →「已暂停——剩余 1m」+ toast；「拉取预览」DISABLED；恢复 → 徽标消失、按钮恢复、再次拉取实收消息 |
| g | 备份/恢复全链路 | **PENDING-MANUAL** | 原生目录选择器（PickBackupDirectory → Win32 公共对话框）在锁屏桌面无法可靠驱动。点击路径：流详情 → 备份 → 选择目录… → 选 %TEMP%\m3bk → 进度条 → 「流 m3g-backup 备份完成」→ 删除流（名称匹配）→ 工具栏「恢复备份」→ 选同目录 → （目标已存在时勾选「删除并重建」）→ 分片进度 →「恢复完成」→ 消息数一致。自动化覆盖：round-trip/target-exists/断连 incomplete/内存流拒绝（Go 6 例）+ 面板 6 例（进度 50%、incomplete 无成功 toast、覆盖门、busy、picker 取消） |
| h | header 过滤 chip | **PASS** | 会话（m3h.data）配 Header 过滤 Env=prod 创建成功（「已过滤 0」chip 在位）；混合注入 4×199（半带 Env=prod 头）→ **缓冲区 398 = 恰为带头消息数、已过滤 398 = 恰为无头消息数**，`received(796) == total(398) + filtered(398)` 守恒精确；cmd/flood 实测两轮 199 msg/s（99.4–99.5% 精度）。注：注入停止后新事件因后台节流不实时上屏（见方法注记-4），守恒数字取自节流前的实时窗口 |
| i | JS 不可用指引 | **PENDING-MANUAL** | 探针 context 已写入 `~/.config/nats/context/m3-nojs.json`（api_prefix=nonexistent_prefix_m3）。点击路径：左上角 context chip → 选择 m3-nojs 连接 → 流页应显示「JetStream 数据不可用」指引面板（no_responders 文案 + 检查 domain/api_prefix 两行）而非空列表。自动化覆盖：Go 分类测试 + 前端「不可用面板替代表格（never an empty table）」用例。chip 菜单交互在本轮时间盒内未打通（菜单项展开依赖未验证），诚实记 PENDING-MANUAL |
| j | 主题/语言回归（M1/M2） | **PASS** | 应用以持久化 dark + zh-CN 启动（settings.json）；全部冒烟页（列表/详情/浏览器/消费者/预览/会话/各对话框）UIA 读值均为 zh-CN 文案、无英文硬编码泄漏（JetStream/Leader/limits 等术语为 locales 预期译文）；对全部 dump 树做 emoji 码位扫描（U+1F300–1FAFF / 2600–27BF / 2B00–2BFF / FE0F）→ **零命中**。像素级配色核对留人工（UIA 文本通道不可读色值） |

冒烟小结：**8 PASS / 2 PENDING-MANUAL（行 g、i），另 1 子项 PENDING-MANUAL（行 c 空洞标记实拍）**。全部行均给出精确点击路径供人工回填（§8）。

## 8. 回填区（人工走查后填写，与 M1/M2 同构）

| 走查项 | 结果 | 执行人/日期 | 备注 |
|---|---|---|---|
| AC-009 删除后空洞标记 UI 实拍 | 待执行 | | 消息浏览器 → 行详情 → 删除 → 确认 → 「已删除 seq N」 |
| AC-028 10k 流滚动帧率（录屏判读 ≥60fps） | 待执行 | | |
| AC-029 2MB 二进制 hex/下载 UI（需调服务器 max_payload） | 待执行 | | |
| 备份/恢复全链路 UI（含覆盖确认） | 待执行 | | §7 行 g 路径 |
| JS 不可用指引面板 UI（m3-nojs context 已备） | 待执行 | | §7 行 i 路径 |
| relaxed confirm_level 下 purge 直执行 UI 抽查 | 待执行 | | 设置 → 行为 → 确认级别 |
| 深色主题像素级核对（UIA 不可读色值） | 待执行 | | |

## 9. 遗留清单（移交 M4/M5/M6；含本轮新发现）

1. **bindings 重生漂移（本轮落地为构建阻塞）**：`wails3 build` 每次重生 bindings（当前产出 interface+nullable 风格，已提交树为另一风格）。已加 3 文件空值守卫（`9207fd3`）使两种风格均可编译；**下次全量 regen 提交仍需团队决策**（M3 台账 Task 7/14 在案）。
2. **集群运维入口归 M5**（§6.6 输出表；依赖 §6.11 集群页）；trace 集群测试同批。
3. **workqueue 浏览需 allow_direct**（natscli 同前提）；默认服务器下的提示文案待评估。
4. **RESET/PriorityPrioritized 旧服务器兜底**：错误原文直呈；2.15-preview RESET 陈旧游标 quirk 已文档化（幂等重试在测试侧，产品侧遇错原文）。
5. **§6.7「丢失数」= 红位数裁定**：NumRedelivered 承载（§6 裁定表）。
6. **备份无取消按钮**；**恢复不改名**；**nsr_domain 未接**；**CopyStream/CopyConsumer 直通复制未接 UI**；**purge 全量选项对话框延期**（§6 裁定表）。
7. **§18.4 列显隐/列宽拖动持久化 → M6**。
8. **UIA/可访问性收敛建议（本轮实测）**：流/浏览器/消费者列表行与 context chip 为 role=button 但不暴露 UIA InvokePattern（本轮以 MSAA accDoDefaultAction 通道完成全部行级驱动，脚本可复用）；锁屏/遮挡下 WebView2 后台节流使高频 chip 停更——建议 M4+ 为行元素补 `InvokePattern` 友好性（如真 `<button>` 或 aria-explicit）并为高频更新区提供可访问性静态摘要节点。
9. **覆盖率整改项**（§4）：jsadmin ≥80%、jsctx domain 分支、logging 轮转失败路径、前端 coverage provider 接入。
10. 各任务 Minor 留终审项：见 `.superpowers/sdd/progress.md` M3 段逐任务记录（jsctx domain 分支无测试、ValidateStreamForm 原地改 Replicas、consume 列表非虚拟化、名称列 440px 栏饿边、purge 负速率一周期、reset/pause 竞态回归测试已加但 UI 顺序流并发确认、等等——终审 whole-branch review 时逐条过）。
11. 主 chunk 拆分延续（M2 遗留 §6-13）：本轮 Streams/Consumers/Messages 已各自 code-split，label 包 447.93kB 为 i18n 主体，M6 安装器口径复核时一并评估。
12. 本机 `-race` 不可用（预存在）→ CI 承接；CI Windows runner `-race` 首跑验证（M1 遗留）仍未回填。
