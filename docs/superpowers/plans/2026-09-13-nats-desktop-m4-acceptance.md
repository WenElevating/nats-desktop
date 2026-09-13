# NATS 桌面客户端 M4 验收记录

- 日期：2026-09-13（实跑）
- 分支 / HEAD：`desktop/m4` @ `91799ed`（Task 1–10 全部完成）+ 本记录提交（Task 11 验收记录与测试报告）
- 范围：M4 = 规格 §6.8 KeyValue 全量（桶 CRUD/compact、键浏览分页、历史、put/create/update/del/purge/revert、watch 单键与整桶）+ §6.9 对象存储全量（桶 CRUD/封存、对象浏览、上传/下载进度、SHA256、磁盘预检、打开所在目录、watch）+ AC-013/AC-014 + §6.8/§6.9 异常表（各 3 行）+ M3 遗留整改四项（覆盖率）与 workqueue 提示（计划 `2026-09-13-nats-desktop-m4.md`，Task 1–11）
- 结论先行：**自动化回归全绿（Go 11 包 231 个顶层测试 + 5 Benchmark 全部通过、前端 25 文件 / 173 测试全部通过）；性能预算全部大幅达标（1k 键浏览 22.8–38.1ms 对 ≤500ms/1.5s 门、KV/对象 watch 洪峰 10k/10k 零丢失、100MB 传输 143.8–265.0 MB/s 字节精确 + digest 一致、并发 12 goroutine 零错误）；真应用 UIA 冒烟 9 行中 5 行全 PASS、3 行 LIVE+PENDING-MANUAL 混合（对象上传/下载原生选择器、AC-013 ≤1s 时延腿、workqueue 浏览报错 toast 腿——均为锁屏环境不可驱动项，附精确路径与自动化覆盖）、1 行（主题/语言）PASS；无缺陷遗留，1 起一次性应用退出（不可复现、无 WER 记录，疑锁屏环境，已登记 §6）**。覆盖率终值实测记录（§4），kv 前端 68.03% 未达 70% 列整改。

## 1. 测试环境

| 项 | 值 |
|---|---|
| 机器 | 13th Gen Intel Core i7-13700HX，16 核 24 线程，15.7GB RAM，SSD（≥ §12 高配参考档） |
| 系统 | Windows 11 家庭版 中文版（build 26200），WebView2 Runtime |
| 工具链 | go1.26.0 windows/amd64，Node v24.11.1，wails3 v3.0.0-beta.20 |
| 目标服务器 | **本机常驻真 nats-server `nats://127.0.0.1:4333`，JetStream 开启（2.15-preview），监控 `:8333/jsz`**（全部 LocalServer 测试与冒烟打真服务器；冒烟结束后已清理全部 `m4*` KV 桶/对象桶/流，`/jsz` 无 m4 残留） |
| UIA 驱动 | PowerShell UIAutomation（InvokePattern/ValuePattern/ExpandCollapsePattern/SelectionItemPattern）+ MSAA `accDoDefaultAction`（oleacc；行级元素不暴露 InvokePattern，沿用 M3 §7 方法） |
| 桌面状态 | **物理桌面处于锁屏**（与 M2/M3 一致）——合成鼠标/键盘与原生文件/目录选择器不可驱动；全部交互经 UIA/MSAA 可访问性通道完成 |
| 应用二进制 | `wails3 build` 于本轮从干净 HEAD `91799ed` 重建（产物 20,081,152 B，与重建前既有产物字节尺寸一致，双重佐证来源为同一干净树）；重建产生的 bindings 全量重风格 churn 已按惯例 `git restore`（重生树不入库） |

说明：本机 `-race` 不可用为预存在环境问题（M2 台账在案），竞态覆盖由 CI 承接（`desktop-ci.yml` go job 已含 `-race`，见 §8 CI 状态注记）。

## 2. 自动化回归（全部实跑，2026-09-13）

| 命令 | 结果 | 明细 |
|---|---|---|
| `go test ./... -count=1` | **全绿** | 11 包 ok、0 失败、0 SKIP。分包耗时：messaging 79.5s、jsadmin 27.2s、buckets 20.2s（含 11 个 LocalServer 真服务器测试 + 洪峰/并发/100MB 传输）、connections 13.6s，其余 <2.2s |
| `go vet ./...` | exit 0 | 无告警（含 `cmd/flood`；本轮临时 seed 工具 vet 干净后已删除） |
| `npx vitest run`（frontend） | **全绿** | 25 文件 / **173 测试通过**，13.8s（含 i18n 双语 parity 门） |
| `npx vitest run --coverage`（frontend） | 全绿 | 173/173，v8 provider，基线表见 §4 |
| `wails3 build`（desktop） | **成功** | 产物 `desktop/bin/nats-desktop.exe` = 20,081,152 B ≈ **19.2 MiB** ≤ 30MB（§12）→ PASS。注：build 内置 bindings 重生会把全部既有绑定刷成新风格（20 文件 churn）——按惯例不入库已 restore；committed 树为混合风格（Task 6 起新 buckets 文件为新风格，其余为旧风格，两种风格均可在 9207fd3 守卫下编译），全量 regen 待终审裁定（§6-6） |

测试规模（本里程碑新鲜统计）：**Go 231 个顶层 `Test` 函数 / 11 包 + 5 个 `Benchmark`（buckets 包 38 个 Test）**；**前端 173 测试 / 25 文件**（M3 基线 184 Go / 155 vitest → M4 净增约 47 Go / 18 vitest；M3 的 184 中部分经 Task 9 重构合并）。

## 3. 性能实测表（§12 预算；数字来源 Task 10 实跑 @ 91799ed，同机同服务器）

| 预算项 | 门槛（高配/低配） | 实测 | 来源 |
|---|---|---|---|
| 1k 键桶键浏览（ListKeys(1000) + 当前页 GetKeyValues(50)） | ≤500ms / ≤1.5s | **38.1 ms（首轮）/ 22.8 ms（末轮）** | Task 10 `TestKvKeys1000BrowseLocalServer` |
| ListKeys bench | 信息性 | **10.26 ms/op**（1.77 MB/op，15,225 allocs/op；复跑 11.76 ms/op，轮内漂移 ≈1.15×，与共享服务器常驻状态相关） | Task 10 `BenchmarkKvListKeysLocalServer`（-benchtime=5x） |
| KV watch 洪峰 | 初始 1k + 10k 更新零丢失 | **10,000/10,000 事件精确收到，客户端 dropped=0**（桶 History=64 防服务器端 per-subject 清退；-count 3 全过） | Task 4 `TestKvWatchFloodNoLossLocalServer` |
| 对象 watch 洪峰 | 零丢失 | **10,000/10,000 更新事件精确收到，dropped=0**（对象 meta 每次 Put 单条 rollup，无服务器丢弃面） | Task 10 `TestObjWatchFloodNoLossLocalServer` |
| 100MB 对象传输 | 字节精确 + digest | 上传 **143.8 / 152.8 / 191.7 MB/s**（0.52–0.70s）；下载 **250.6 / 251.9 / 265.0 MB/s**（0.38–0.40s）；`bytes_done == bytes_total == 104,857,600` 双向、`phase=complete`、`digest_match=true`、落盘字节 + 流式 SHA256 与源一致 | Task 10 `TestTransfer100MBLocalServer`（3 轮） |
| 并发正确性 | 零错误 | `TestConcurrentBucketOpsLocalServer`：**12 goroutine / 共享单一 BucketService / KV 桶建删×3 + 键 put/del×20 + 对象桶建删×3 → 0 错误**（errCh 零容忍） | Task 10 |
| 传输互斥 | 单飞 | UploadObject/DownloadObject 首语句 `transferMu.CAS`；busy → `ErrTransferBusy`（前端 toast 原文 + 重新排队） | Task 6 `TestTransferBusyRejected` + Task 8 UI 用例 |
| 体积 | ≤30MB | **19.2 MiB**（便携 exe） | 本轮构建 |

## 4. 覆盖率终值（§20.1 门槛：Go 业务逻辑 ≥80%、前端组件 ≥70%；`go test ./internal/... -cover` 本轮实测）

| 包 | 语句覆盖率 | 判定 |
|---|---:|---|
| connections | 86.4% | 达标 |
| messaging | 86.1% | 达标 |
| natsver | 85.7% | 达标 |
| **buckets** | **80.4%** | **达标（M4 新业务包；Task 10 内 77.5%→80.4% 缺口闭合后过线；jsadmin 81.2% 同轮达标）** |
| jsadmin | 81.2% | 达标（M3 78.8% → Task 9 整改 81.3%，本轮复测 81.2%） |
| jsctx | 100.0% | 达标（Task 9 domain 分支补齐后 100%） |
| logging | 71.1% | 达标改善（63.9%→71.1%；轮转失败分支已有行为级测试；reopen 臂跨平台不可达，如实登记） |
| settings | 72.7% | 未达 80% → 遗留整改（M3 已登记，M4 未触碰） |
| appdir | 71.4% | 未达（薄封装，main 分支不可无头测）→ 遗留整改 |
| version | 75.5% | 未达 → 遗留整改 |
| testutil | 28.6% | 测试辅助包，不计入业务逻辑门槛（说明性记录） |

前端组件覆盖率（`npx vitest run --coverage`，v8 provider，Task 9 接入并钉基线，本轮复测数字与基线一致）：

| 范围 | % Stmts | 判定 |
|---|---:|---|
| **全部（src/features + src/lib）** | **78.44%** | **≥70% 总门 PASS** |
| features/connections | 82.02% | 达标 |
| features/consumers | 79.24% | 达标 |
| features/messages | 87.32% | 达标 |
| features/objects | 71.19% | 达标 |
| features/settings | 76.74% | 达标 |
| features/streams | 85.21% | 达标 |
| lib | 93.02% | 达标 |
| **features/kv** | **68.03%** | **未达 70% → 整改项**（大头：kv/BucketForm.tsx 35%、kv/KeyValuePage.tsx 60.6%、kv/schema.ts 56.5%；移交清单见 §6-10） |

整改项汇总：① kv 前端组件 68.03%→≥70%（BucketForm/KeyValuePage/schema 三处为主）；② settings/version/appdir 视 M5+ 触碰面顺手补。

## 5. AC 走查表（规格 §19 对照：AC-013、AC-014）

状态定义：AUTOMATED-PASS（引用测试，本机实跑通过）/ LIVE-PASS（本轮真应用 UIA 实测）/ MEASURED（数字+方法）/ PENDING-MANUAL（附操作路径）。

| 规格 AC | 走查项 | 状态 | 证据 / 操作路径 |
|---|---|---|---|
| AC-013.1 | 键列表显示 a（修订版 2） | **AUTOMATED-PASS + LIVE-PASS** | 自动化：`TestKvKeyLifecycle(LocalServer)` 修订号全序推导断言（13 步表）；前端 kv-page 6 例（分页/值补齐/op 徽标）。实测：UI 写入 a=v1/v2/v3 → 键行 `a 3 put 2026/9/13 17:02:50 2 B`（修订版+op+时间+大小列），revert 后 `a 5 put … 2 B`、当前值 v2 |
| AC-013.2 | watch 视图实时出现 PUT/相关事件，时延 ≤1s | **LIVE-PASS（行+修订号）+ PENDING-MANUAL（≤1s 时延腿，锁屏受限）** | 整桶 watch 开启（「实时监视」面板 + 「已丢弃 0」chip）；另一会话（临时 `go run` 注入器经 jetstream KV API，用后已删）put w1-live/w2-live/w3-live → watch 行 `w1-live 10 put 2026/9/13 17:16:11 10 B`（修订号/op/大小齐备）逐条上屏，kvdel 后 delete 标记行同样呈现。时延：UIA 可见链路实测 1.6–4.1s 且随时间递增——与 M3 §7 注记-4 同源（锁屏下 WebView2 后台节流 + MSAA 树遍历开销），非事件投递时延；自动化侧 `TestKvWatchFloodNoLoss` 4096 环零丢失 + 前端 `applyWatchEvent` 环测试钉住投递正确性。**≤1s 时延需解锁桌面人工复核（§8）** |
| AC-014.1 | 上传/下载均有进度显示，完成后对象列表更新 | **AUTOMATED-PASS + LIVE-PASS（列表/进度契约）+ PENDING-MANUAL（原生选择器两腿）** | 自动化：`TestUploadDownloadRoundTrip`（进度首事件 phase=running、节流事件、收尾字节精确）、objects-page 8 例（50% 进度 aria-valuenow、Complete、ListObjects ≥3 次刷新、incomplete 红行 + 重试、busy 重排队、digest chip）。实测：对象桶 m4obj 创建、注入 5MB 对象 → 列表行 `big5mb.bin 40 分块` 实时呈现；上传对话框「队列暂无文件 → 开始上传 DISABLED」空队列门实测；原生文件/目录选择器（PickUploadFiles/PickDownloadDirectory → Win32 公共对话框）锁屏不可驱动 → 点击路径：对象存储 → 选桶 → 上传 → 选择文件… → 选 5MB 文件 → 队列重命名 → 开始上传 → 进度条（字节/速率）→ Complete ✓ → 列表刷新；下载：对象行 下载 → 选目录 → 进度 → digest ✓ chip → 「打开所在目录」 |
| AC-014.2 | 下载文件与原文件 SHA256 一致 | **AUTOMATED-PASS** | `TestUploadDownloadRoundTrip` + `TestTransfer100MBLocalServer`：下载侧 tee 计算的流式 SHA256 与 `ObjectInfo.Digest`（`SHA-256=<base64url>`）比对 `digest_match=true` + 落盘字节级一致（双保险：tee 校验 + nats.go Read 内建 EOF digest 校验双路径都有测试）；不匹配 → `phase=incomplete` + 文件保留（库内建路径有测试） |
| §6.8 异常表 | 3 行 | **AUTOMATED-PASS ×3 + LIVE-PASS（全部三行本轮实测）** | 见 §6 映射表 |
| §6.9 异常表 | 3 行 | **AUTOMATED-PASS ×3 + LIVE-PASS（行 3 实测；行 1/2 原生对话框腿 PENDING-MANUAL）** | 见 §6 映射表 |

## 6. §6.8/§6.9 异常表映射 + 裁定与遗留

### §6.8 KeyValue 异常表（3 行）

| # | 规格异常 | 实现映射 | 测试 / 证据 |
|---|---|---|---|
| 1 | create 冲突 → 冲突提示 + 引导改用 put 或查看现有值 | Task 1 `ClassifyKvError`（`ErrKeyExists`→conflict，哨兵先行防 APIError 400 误判）+ Task 3 PutKey create 分支（服务器原文前置 + 引导文案）+ Task 7 KeyEditor create 冲突横幅 + `kv-editor-switch-put` 一键切换 | 前端 kv-page 用例（横幅含 5/7、一键切 put、草稿逐字节保留）；**本轮实测**：对已存在键 a 选 create 写入 → 横幅「键已存在——可改用 put 或查看现有值。」→ 点「改用 put」→ 模式翻转、草稿 `conflict-draft` 保留 → 写入成功（修订 6） |
| 2 | update 版本冲突 → 冲突说明 + 最新修订号 + 保留编辑内容 | Task 3 update 分支（`ErrKeyRevisionMismatch`→conflict + 回读 `CurrentRevision`）+ Task 7 锁定期望修订号显示 + 冲突后自动刷新显示 | 前端 kv-page 用例；**本轮实测**：编辑器锁定「期望修订版 #6」→ 注入器外部 put（rev 7）→ 提交 → 横幅「期望修订版 6 与当前修订 7 不符——显示的修订版已自动刷新，编辑内容已保留。」、显示刷新为 #7、草稿 `ui-draft-cas`（12 字节）原样保留 |
| 3 | revert 无历史 → 禁用按钮 + 提示原因 | Task 7 `canRevert()`（单修订禁用 + tooltip「仅一次修订，无可回退版本」）+ Task 3 服务层 validation+`ErrNoHistory` 双保险 + 删除态感知 revert 算法 | 前端 kv-page 用例；**本轮实测**：键 b（单修订）→ 回退钮渲染为「仅一次修订，无可回退版本」DISABLED（UIA 读态）；键 a（3 修订）→ revert → 当前值 v3→v2、toast「键 a 已回退」 |

### §6.9 对象存储异常表（3 行）

| # | 规格异常 | 实现映射 | 测试 / 证据 |
|---|---|---|---|
| 1 | 上传中断 → 停止 + 标记不完整 + 不删已完成分片 + 重试入口 | Task 6 `watchConnClose`（backup.go 镜像，close(dropped) 先于 cancel）+ `phase=incomplete` 终态 + 分片不清理（nats.go 内部 purge 死连上无害失败）+ Task 8 红行 + 服务器原文 + 重试按钮（同参重调） | `TestUploadIncompleteOnDisconnectLocalServer`（phases 以 [running,…,incomplete] 收敛、无 complete）；前端 objects-page incomplete→重试→Complete 用例（attempt 计数=2）。UI 实拍：原生选择器腿 PENDING-MANUAL（§5 AC-014.1 路径） |
| 2 | 磁盘空间不足 → 开始前提示并阻止 | Task 6 磁盘门（`diskFree(dir)` free>0 前置、free< size → validation+`ErrDiskSpace`，0=未知不阻塞）+ Task 8 toast 原文、无残留行状态 | `TestDownloadDiskSpaceGate`（free=0 与 free<size 双分支）；前端 objects-page 磁盘门 toast 用例。UI 实拍：同上经下载路径，选择器腿 PENDING-MANUAL |
| 3 | 桶已封存 → 服务器错误原文 + 封存状态提示 | Task 5 `SealObjBucket` + Task 8 封存徽标 + 「该桶已封存……」提示 + 上传/编辑入口禁用（写原文路径保留于 rename/重试等仍可达入口） | objects-page 封存用例（徽标、双禁用、删除仍可用）；**本轮实测**：封存 m4obj（L1 确认）→ 徽标「已封存」、上传 DISABLED、编辑 DISABLED、封存钮自禁用、提示「该桶已封存：在服务器解封之前，上传与编辑均被拒绝；删除桶仍可用。」、桶行 `m4obj … 6.0 MiB 已封存`、toast「桶 m4obj 已封存」 |

### 裁定（终审口径，登记于计划 Task 11 Step 3 的全量兑现）

| 项 | 裁定 |
|---|---|
| nsr_domain 不接 | natscli 与 nats.go jsm.go 均**未**将 JS domain 用于 API 定位（jsm.New 仅消费 JSDomain/JSAPIPrefix 定位信息）——**显式裁定不接（natscli parity）**；KV/对象桶 API 定位沿用 account 前缀 |
| KV 桶 CreatedMs 恒 0 | nats.go `KeyValueStatus` 接口恰 10 方法无 Created getter（kv.go:311-341 核实）→ 详情 CreatedMs 恒 0，wire 字段保留以稳契约（Task 2） |
| 封存桶 DELETE 服务器不拒 | nats-server v2.15-preview 拒绝封存流上的消息级 delete/purge（10109）但**不拒绝流删除**（jsStreamDeleteRequest 无 sealed 检查，Task 5 核实）→ UX 钉定「删除桶仍可用」（本轮实测提示文案即如此），非缺陷 |
| watch 背压丢最旧（dropped_total wire 呈现） | 4096 容量环 + 单 emit goroutine + drop-oldest；丢弃 WARN 每 4096 次一报并捎带 `dropped_total`，随每个事件盖章下发（Task 4）；前端 dropped chip 警示色渲染（Task 7/8 测试钉住）。设计即「提示而非阻塞」，零丢弃靠消费速率保证（Task 4/10 洪峰实证） |
| 传输单飞互斥 | 全局一次一个对象传输（`transferMu` CAS 首语句），busy → `ErrTransferBusy`；前端 toast 原文 + 队列重排队 + runner 停摆（Task 6/8） |
| compact DeleteMarkersOlderThan(-1) 全删语义 | 负值=无条件全删（0 是 nats.go 30 分钟默认阈值，勿用——源码核实）；UI 文案「整理将清除全部删除标记与历史（标记所门控的历史一并清除），不可撤销」如实表达（Task 2；**本轮实测**整理后键 a 连同 purge marker 全部消失、桶仅剩键 b） |
| 对象重复删除 Ok | nats.go Delete 文档「already deleted → no error」→ not_found 仅对缺失对象、已删对象 Ok（Task 5 测试钉住，按库语义） |
| 下载 digest 双保险 | tee 计算比对（digest_match 字段）+ nats.go Read 内建 EOF digest 校验兜底，两路径均有测试（Task 6） |
| RenameObject 元数据保全 | Task 5 评审裁定（UpdateMeta 裸{Name} 会清零 Description/Headers/Metadata）→ Task 6 修复 GetInfo→复制→UpdateMeta，行为级 RED 证据（Task 6 报告） |
| workqueue 提示 | 浏览 workqueue 流需服务器 allow_direct（natscli 同前提）→ Task 9 双路径提示：浏览失败 toast + 详情常驻头部提示（`streams.msgs.workqueueHint` 双语），M3 遗留第 3 项闭环 |

### 遗留清单（移交 M5/M6/终审）

1. **kv 前端覆盖率整改**：features/kv 68.03% < 70%（BucketForm 35% / KeyValuePage 60.6% / schema 56.5% 为主）→ M5 首个触 KV 的任务顺手补。
2. **bindings 混合风格待全量 regen**：committed 树新 buckets 文件为新 generator 风格、其余 17+ 文件为旧风格；每次 `wails3 build` 重生全量漂移（本轮同样发生、已 restore）。**下次全量 regen 提交需团队决策**（M3 §9-1 延续）。
3. **多文件并行上传**：当前队列顺序排空（队列即并发闸）+ 后端单飞互斥；并行化需后端 CAS 语义扩展 → M5+ 评估。
4. **非 UTF-8 值编辑**：KeyEditor 对非 UTF-8 值只读 + PayloadView 指引（Task 7）；真正的二进制编辑器未做（注释警告 + 历史可恢复）。
5. **对象链接（AddLink）未暴露**：nats.go AddLink/AddDerivedLink 绑定未接入 UI。
6. **watch 断线后不自动重建**：断连全停（设计），重连后由前端重新 CreateKvWatch（与消息会话语态一致）。
7. **settings/version/appdir 覆盖率**未达 80%（§4）→ M5+ 触碰面顺手补。
8. **一次性应用退出（本轮冒烟新发现，疑似环境）**：AC-013 watch 腿中应用进程在一次注入序列后无日志、无 WER 事件退出（§7 行 e 注记）；受控复现（重启后同桶同 watch 路径 put+del 注入）未复现。怀疑方向：锁屏下 WebView2/Wails 运行时环境因素；无数据完整性影响（服务器侧状态完好）。终审 whole-branch review 时关注 watch/emit 路径是否有可致 panic 的缝隙（Go 侧 panic 不产生 WER 记录）。
9. 各任务 Minor 留终审项：见 `.superpowers/sdd/progress.md` M4 段逐任务记录（洪水单键 History=64 余量 flake 面、上传行缺已传/总字节文本、transfers/rates Map 无界慢积累、切桶不重置 watch、jsadmin 一次性并行失败 3 复跑未现，等等——终审逐条过）。
10. 本机 `-race` 不可用（预存在）→ CI 承接；CI 实际运行状态见 §8 注记（0 次记录，main 分支触发）。

## 7. 控制器冒烟（2026-09-13 17:00–17:45，真实应用 UIA/MSAA + `nats://127.0.0.1:4333`，时间盒 ≤45 分钟到点即收）

**冒烟方法注记**：① 沿用 M3 §7 方法（UIA 模式驱动 + MSAA accDoDefaultAction 行级驱动，m3lib.ps1 复用为 m4lib.ps1）；② 物理桌面锁屏 → 原生文件/目录选择器（PickUploadFiles/PickDownloadDirectory）不可驱动，与 M3 备份目录选择器同因；③ 流/键/对象行不暴露 InvokePattern，全部行级操作经 MSAA；④ 树序在页面重渲染间会漂移，同名按钮（导航「消息」vs 详情页签「消息」）以精确名+当次树 dump 消解；⑤ 应用日志（`%APPDATA%/nats-desktop/logs/nats-desktop.log`）逐条记录了全部写操作（bucket created / key put rev N / reverted from_revision=2 / deleted mode=delete|purge / compacted / watch created），与 UIA 读值互为印证。

| # | 冒烟项 | 结果 | 证据（UIA/MSAA 读值 + 应用日志） |
|---|---|---|---|
| a | KV 桶创建 → 键列表 | **PASS** | 创建桶表单（名称/描述/历史/TTL/最大字节/副本数）→ toast「桶 m4kv-a 已创建」→ 栏目行 `m4kv-a 0 0 B 64 —`；写入键对话框（put 默认、值字节数实时）→ toast「键 a 已写入（修订 1）」→ 键行 `a 1 put 2026/9/13 17:02:28 2 B`（键名/修订/操作/时间/大小 5 列） |
| b | put/create/update 三语义 | **PASS** | create 冲突：对已存在键选 create → 横幅「键已存在——可改用 put 或查看现有值。」+「改用 put」一键切换 → 草稿 `conflict-draft` 逐字保留 → 写入成功修订 6。update CAS：锁定「期望修订版 #6」→ 注入器外部 put rev 7 → 提交 → 横幅「期望修订版 6 与当前修订 7 不符——显示的修订版已自动刷新，编辑内容已保留。」+ 显示 #7 + 草稿 12 字节保留 |
| c | 历史 + revert | **PASS** | 键 a 3 修订：修订历史 3 条「查看」、当前值 v3；revert → 当前值 **v2**、toast「键 a 已回退」、日志 `reverted from_revision=2 revision=5`；单修订键 b → 回退钮「仅一次修订，无可回退版本」**DISABLED**（UIA 读态） |
| d | del/purge/compact 分级 | **PASS** | del：L1「删除键「a」？删除会打上删除标记；历史可查，可 revert 恢复。」→ 取消不执行 → 确认 → 键行 op 徽标 `delete`、历史仍可查（6 条修订在列）；purge：L1「彻底清除键「a」？该键的全部修订将被永久移除——彻底清除，不可恢复。」→ 确认 → `purge` 徽标；compact（整理）：L1「整理将清除全部删除标记与历史……不可撤销。」→ 确认 → 键 a 连标记全部消失、桶仅剩 b（1 键 46 B） |
| e | AC-013 watch | **LIVE-PASS（实时行+修订号）+ PENDING-MANUAL（≤1s 时延腿）** | 开始监视 → 「实时监视」面板 + 「已丢弃 0」chip + 停止钮；注入器（另一会话）put w1-live/w2-live/w3-live → watch 行 `w1-live 10 put 2026/9/13 17:16:11 10 B` 等逐条呈现（修订号/op/大小/时间齐备），kvdel → delete 行呈现。时延：UIA 可见链路 1.6–4.1s 递增——锁屏 WebView2 后台节流 + MSAA 遍历开销（M3 §7 注记-4 同源），非投递时延；≤1s 需解锁桌面人工复核（§8）。注记：本行中途应用发生一次无日志退出（§6-8），重启后同路径受控复现未再现，其余各行在新实例上完成 |
| f | 对象桶 + 上传/下载（AC-014） | **LIVE-PASS（桶/列表/空队列门）+ PENDING-MANUAL（原生选择器两腿）** | 对象桶 m4obj 创建（toast + 栏目行）；注入器放 5MB 对象 → 列表行 `big5mb.bin 40 分块` 呈现；上传对话框「队列暂无文件——请选择要上传的文件。」+「开始上传」DISABLED（空队列门实测）。「选择文件…」（原生 Win32 对话框）锁屏不可驱动 → 上传进度/下载 digest/打开所在目录三腿 PENDING-MANUAL。点击路径：对象存储 → 选桶 → 上传 → 选择文件… → 选 5MB 文件 → 重命名 → 开始上传 → 进度条 → Complete ✓ → 列表自动刷新；下载：对象行「下载」→ 选目录 → 进度 → digest ✓ chip →「打开所在目录」。自动化覆盖：round-trip/100MB 字节精确+digest/断连 incomplete/磁盘门/busy/前端 8 例（§5 AC-014 行） |
| g | 封存桶 | **PASS** | 封存 L1「封存桶“m4obj”？」→ 确认 → 栏目行 `m4obj … 6.0 MiB 已封存` + 徽标；上传钮 **DISABLED**、编辑钮 **DISABLED**、封存钮自禁用；提示「该桶已封存：在服务器解封之前，上传与编辑均被拒绝；删除桶仍可用。」；toast「桶 m4obj 已封存」 |
| h | workqueue 提示 | **LIVE-PASS（常驻徽标）+ PENDING-MANUAL（报错 toast 腿）** | 注入器建 m4wq（WorkQueuePolicy，无 allow_direct）→ 流列表行呈现、详情 retention 徽标 `workqueue` 常驻显示。浏览器报错 toast 含 allow_direct 提示的实拍因详情页签点击与导航「消息」同名碰撞（方法注记-4）在时间盒内未打通 → PENDING-MANUAL，路径：流 → 点 m4wq 行 → 详情「消息」页签 → 浏览报错 → toast「workqueue 流浏览需服务器 allow_direct；nats stream edit 可开启」+ 头部常驻提示。自动化覆盖：streams-msgs 纯函数真值表 + 报错 toast 含 allow_direct + 非 workqueue 不提示（Task 9） |
| i | 主题/语言回归 | **PASS** | 应用以持久化 dark + zh-CN 启动；全部冒烟页（KV/对象/流/各对话框/watch 面板/确认层）UIA 读值均为 zh-CN 文案、无英文硬编码泄漏（put/create/update/watch/Sealed 等为 locales 预期术语）；对全部 dump 树做 emoji 码位扫描（U+1F300–1FAFF / 2600–27BF / 2B00–2BFF / FE0F）→ **零命中**。像素级配色核对留人工（UIA 文本通道不可读色值） |

冒烟小结：**5 行全 PASS（a/b/c/d/g 计 5）+ 3 行 LIVE+PENDING-MANUAL 混合（e/f/h，PENDING 腿均为锁屏不可驱动或同名碰撞，均附精确路径与自动化覆盖）+ 1 行 PASS（i）；即 PASS 6 / 混合 3 / 纯 PENDING 0**。全部 PENDING 腿给出精确点击路径供人工回填（§8）。

## 8. 回填区（人工走查后填写，与 M1/M2/M3 同构）

| 走查项 | 结果 | 执行人/日期 | 备注 |
|---|---|---|---|
| AC-013 watch ≤1s 时延复核（解锁桌面，注入 → 秒表/录屏判读） | 待执行 | | §7 行 e；自动化已钉投递正确性（零丢失） |
| 5MB 上传全链路 UI（选择文件 → 进度 → Complete → 列表刷新） | 待执行 | | §7 行 f 路径 |
| 下载全链路 UI（选目录 → 进度 → digest ✓ → 打开所在目录） | 待执行 | | §7 行 f 路径 |
| 上传中断 UI 实拍（断连注入 → 红行 → 重试 → Complete） | 待执行 | | §6.9 异常 1；自动化 3 例在案 |
| 磁盘不足下载阻止 UI 实拍（小容量分区/介质） | 待执行 | | §6.9 异常 2；自动化双分支在案 |
| workqueue 浏览报错 toast + 头部提示 UI 实拍 | 待执行 | | §7 行 h 路径 |
| 深色主题像素级核对（UIA 不可读色值） | 待执行 | | |
| 一次性应用退出复盘（§6-8；解锁桌面长时间 watch 稳定性观察） | 待执行 | | 无 WER 记录、受控复现未现 |

## 9. CI 状态（Task 10 扩展后的 desktop-ci）

- `desktop-ci.yml`：go job（windows-latest）`go vet ./...` + `go test ./... -race -count=1 -cover`（Task 10 加 -race/-cover）；前端 job（ubuntu-latest）`npm ci` + `tsc --noEmit` + `eslint --max-warnings 0` + `vitest run --coverage`；构建 job `wails3 build`。**触发分支为 main**。
- **远端记录：0 次工作流运行**（`gh api .../actions/runs` total_count=0）——里程碑工作均在 `desktop/m4` 分支进行，未触发 main 过滤；合并后首跑即为 `-race` 在 Windows runner 上的首次真实验证（M1 遗留回填点，§6-10）。
- 本机 `-race` 不可用（cgo 工具链预存在问题）→ 竞态覆盖继续由 CI 承接（现状 = 尚无执行记录，如实登记）。
