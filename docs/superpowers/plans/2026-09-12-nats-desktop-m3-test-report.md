# NATS 桌面客户端 M3 测试报告

- 日期：2026-09-12
- 分支 / HEAD：`desktop/m3` @ `54497bf` + 文档/冒烟辅助提交（`9207fd3`）
- 计划：`docs/superpowers/plans/2026-09-12-nats-desktop-m3.md`（Task 1–15）；验收记录：`docs/superpowers/plans/2026-09-12-nats-desktop-m3-acceptance.md`
- 测试环境：i7-13700HX（16C24T / 15.7GB / SSD，≥ §12 高配档），Windows 11 build 26200，go1.26.0，Node v24.11.1，wails3 v3.0.0-beta.20；真服务器 `nats://127.0.0.1:4333`（JetStream，2.15-preview，监控 `:8333/jsz`，全程存活，测试后无残留）

## 1. 用例规模与结果（全部本机实跑，2026-09-12）

| 套件 | 规模 | 结果 |
|---|---|---|
| Go（`go test ./internal/... -count=1`） | 11 包 / **184 顶层 Test（含子测试 193 用例）**，其中 jsadmin 44 个 LocalServer 变体**全部实跑真服务器、无 SKIP** | **全绿，0 失败**（messaging 78.9s、jsadmin 29.5s、connections 12.0s） |
| Go 基准（`go test -bench`，Task 14 新增） | 3 个：StreamList、BrowseTailPage、HeaderFilterPipeline（另有 M2 管线吞吐 bench 延续） | 全部执行并记录数字（§3） |
| 前端（`npx vitest run`） | 23 文件 / **155 测试** | **全绿，155/155**，9.9–13.5s |
| 前端基准（`npx vitest bench --run tests/bench/`） | 2 文件：sessions（M2 延续）+ streams（Task 14 新增） | 全部执行并记录数字（§3） |
| 构建（`npm run build` / `wails3 build` / `go vet`） | — | 全部通过；exe 18.9 MiB |
| CI | `.github/workflows/desktop-ci.yml`：lint + go test + `-race` job + 前端 vitest + bench job（Task 14 扩展 `npx vitest bench --run tests/bench/`）；LocalServer 系测试遵循既有门控模式（无服务器环境自动 skip，本地/带服务器 runner 全量执行） | 本轮为本地全量实跑；CI 侧 `-race` 首跑验证仍为 M1 遗留未回填项 |

对比基线：M2 收官 125 Go + 96 vitest → **M3 收官 184 Go（193 用例）+ 155 vitest**，净增约 59 Go + 59 vitest，增量集中在 jsadmin（新包 44）与 streams/consumers/backup 前端套件。

## 2. 覆盖率实测（§20.1 首次实测记录；门槛：业务逻辑 ≥80%、前端组件 ≥70%）

| 包 | 覆盖率 | 判定 |
|---|---:|---|
| connections | 86.1% | 达标 |
| messaging | 86.1% | 达标 |
| natsver | 85.7% | 达标 |
| settings | 72.7% | 未达 → 整改 |
| version | 75.5% | 未达 → 整改 |
| appdir | 71.4% | 未达 → 整改 |
| **jsadmin（M3 核心新包）** | **78.8%** | **距门槛 1.2pt → 整改（M4 首任务）** |
| jsctx | 66.7% | 未达 → 整改（domain 分支无测试） |
| logging | 63.9% | 未达 → 整改 |
| testutil | 28.6% | 测试辅助包，不计门槛（记录性） |

前端：155/155 全绿，但 coverage provider 未安装，**本轮无覆盖率数字**（整改：M4 安装 @vitest/coverage-v8 并入 CI）。

**整改项**（移交 M4）：① jsadmin 78.8→≥80%（PickBackupDirectory 无头分支、JSParams load-error、domain 分支等台账 Minor 测试化）；② jsctx domain>prefix 优先级补测；③ logging 轮转双失败路径补测；④ settings/version/appdir 顺手补；⑤ 前端 coverage provider 接入并记录基线。

## 3. 性能实测表（运行条件：本机高配档 + 真服务器 4333；来源任务注明）

| 指标 | 门槛 | 实测数字 | 条件 / 来源 |
|---|---|---|---|
| 500 流列表加载 | ≤500ms / ≤1500ms（§12） | **20.9 / 37.7 ms** | 真服务器 500 条新建内存流 `ListStreams`；Task 14 `TestStreamList500LocalServer`（两轮） |
| 1M 消息流：尾页 / 跳转 | ≤1s（高配，AC-028） | **尾页 32ms / 中段跳转 52ms**（1M 夹具注入 25.7s） | Task 4 `TestBrowseLargeDatasetLocalServer`；Task 14 复测口径 100k 尾页 bench **1.63ms/op**（含一次性消费者建删） |
| 前端大列表（10k 行） | 滚动 ≥60fps / ≥30fps（帧率半边） | 虚拟窗口 **18 行**（1024×280、28px 行、overscan 8）；冷挂载 **132 ops/s**（≈8.67ms/commit）；排序切换 **180–192 ops/s** | Task 9 虚拟化测试；Task 14 `streams.bench.ts`（jsdom/React-commit 层，帧率视觉判定仍留人工） |
| Go StreamList 渲染 bench | 信息性 | **381µs/op**（2,467 B/op，40 allocs/op；服务器带夹具残留首跑 1,011µs/op——绝对值随共享服务器状态波动，按同状态对比） | Task 14 `BenchmarkStreamListLocalServer`（benchtime=5x） |
| header 过滤洪峰（注入端） | 50,000 msg/s 硬门槛 | **59,968 msg/s**（-paced 60k；1.2× 门槛 by-design），守恒 **Total+Filtered==200,000、Dropped==0** | Task 7 真机 flood（cmd/flood -paced） |
| header 过滤管线（deliver 全路径） | 50k msg/s 底线 | **1,778ns/op ≈ 562k msg/s/核**（1KB 载荷、2 键活动过滤） | Task 14 `BenchmarkHeaderFilterPipeline`（messaging，纯逻辑无服务器） |
| 冒烟实时守恒（真应用端到端） | 守恒精确 | 会话 Env=prod 过滤：**796 收 = 398 缓冲 + 398 已过滤**；flood 199 msg/s × 4 轮（99.4–99.5% 节流精度） | Task 15 UIA 冒烟（cmd/flood 注入） |
| 并发操作 | — | **12 goroutine / 60 ops 零错误**（每 goroutine 建改删自有流 + 2×20 并发列表） | Task 14 `TestConcurrentStreamOpsLocalServer`（真服务器） |
| 浏览器主题过滤分页 | — | 100k 条 5 个过滤页共 **42.3ms（≈8.45ms/页）**、零外泄、序号连续 | Task 14 `TestBrowseSubjectFilterFloodLocalServer` |
| 体积 | ≤30MB | **18.9 MiB**（19,839,488 B） | Task 15 构建（M2 18.7 MiB 基线 +0.2） |

## 4. 缺陷记录（本里程碑发现并修复，全部带修复 SHA）

| # | 缺陷 | 严重度 | 发现/修复 |
|---|---|---|---|
| 1 | **Streams 列表 grid 布局缺失**：虚拟行漏 `grid` 类导致 8 列单元格塌缩重叠；表头（shadcn table）与行（自定义 grid）几何不一致且固定轨超宽溢出（评审 Critical+Important） | Critical | Task 9 修复波 `54a7cc1`：共享 `GRID_COLS` 常量（388px 固定轨 ≤400px 预算）+ 布局回归测试 |
| 2 | **progress.tsx a11y 缺陷**：`value` 未透传 Radix Root，进度条恒 indeterminate、无 `aria-valuenow`（Task 13 备份进度测试红出） | Important | Task 13 内顺手修复（并入 `4a969d0`），单消费者零视觉变化 |
| 3 | **中断恢复（备份/恢复断线）**：brief 原文 `context.Background()` 会在断连后永久挂死（jsm 快照纯接收端静默停摆），违反 §6.6「停止备份、标记不完整」 | Critical | Task 6 `bf483e2`：可取消 ctx + `watchConnClose` 轮询 + `close(dropped)` 先于 cancel 的顺序守卫；`01ad1aa` 补 watchdog drop 路径/busy 互斥/坏 backup.json 测试；Task 7 在 `0e091b1` 落地中断恢复的前台重派收尾 |
| 4 | **浏览器截断阈值**：64KB 截断与规格 §6.6「>1MB 仅元数据+hex 预览」冲突 | Important | Task 4 修复波 `f49660c`：严格 >1MB 截断、64KB 仅为前缀上限（==1MB 不截断） |
| 5 | **消费者编辑往返丢 MaxDeliver**：服务器回显 -1 导致编辑表单校验拒绝 | Minor | Task 5 修复波 `70f9ebb`：回显归一为 0，往返保持 |
| 6 | **预存测试 flake**：`TestConsumerLifecycleLocalServer` 在 1M 夹具后触发 2.15-preview 服务器「首次 RESET 陈旧 delivered 游标」quirk（专项探针证实：游标卡 5 达 30s/576 轮，重复 RESET 即清） | Minor（测试稳定性） | Task 14 `54497bf`：`resetUntilCleared`（≤3 次幂等重试 + 200ms settle），hermetic 变体保留单发断言；jsadmin 套件 3/3 连续绿 |
| 7 | **`wails3 build` 在 bindings 重生后 tsc 失败**：新生成 nullable 绑定类型使 3 文件 6 处 TS18047（Task 7/14 台账「生成器漂移」实际落地为构建阻塞） | Minor（工程性） | Task 15 `9207fd3`：`(x ?? [])` 防御性空值守卫（两种生成风格均兼容），vitest 155/155 复绿；重生树不入库（团队决策遗留） |

非缺陷性偏差（已在各任务报告裁定并记录）：CopyStream/CopyConsumer 走表单预填流、采样窗 1h（brief 测试强制）、镜像式复制（服务器 10065 subjects overlap 无条件拒绝同 subjects）、conn-close watchdog 必要偏差、sampler 保留窗与虚拟化字面偏差等——见 `.superpowers/sdd/progress.md` M3 段与各任务报告。

## 5. UIA 冒烟（控制器，Task 15 §7 详表；此处摘要）

真实应用（`wails3 build` 产物）+ 真服务器 4333：**10 行冒烟 = 8 PASS / 2 PENDING-MANUAL（备份恢复原生目录选择器、JS 不可用指引），另 1 子项 PENDING-MANUAL（浏览器删除后空洞标记的 UI 实拍；链路自动化已覆盖）**。

方法与环境注记（影响后续里程碑的实测结论）：
- 物理桌面锁屏 → 合成鼠标/键盘不可用（与 M2 同因）；
- 列表行/context chip 等 role=button 元素**不暴露 UIA InvokePattern** → 以 MSAA `accDoDefaultAction`（oleacc，PowerShell + Accessibility interop）完成全部行级驱动（脚本可复用）；
- 锁屏/遮挡下 WebView2 后台节流：注入停止后前端 chip 停留在最后一批事件——M2「50k 洪峰后 UIA 提供方停答」现象与此同源；
- 命名碰撞（导航/操作/列名同源文案）需精确名 + 树序消解。

## 6. 结论

- 自动化回归：**全绿**（193 Go 用例 + 155 前端用例，0 失败，真服务器路径无 SKIP）。
- 性能预算：**全部达标且余量大**（最小余量项为 header 过滤洪峰 59,968 vs 50,000 门槛 = 1.2×，by-design 按构造速率；其余余量 40–280×）。
- 覆盖率：**首次实测**，messaging/connections/natsver 达标，jsadmin 78.8% 差 1.2pt，其余小包未达标——整改项已列（M4）。
- 遗留：见验收记录 §6/§9（集群入口与 trace 集群归 M5、bindings regen 团队决策、备份取消按钮、nsr_domain、UIA 可访问性收敛等）。
