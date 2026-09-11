# NATS 桌面客户端 M1 验收记录

- 日期：2026-09-11
- 分支 / HEAD：`desktop/m1` @ `75d1b57`
- 范围：M1 = 规格 §6.1（壳/更新检查/单实例）+ §6.2（连接与 Context）+ §6.12（确认策略）+ 测试基建（计划 `2026-09-11-nats-desktop-m1.md`）
- 结论先行：**自动化回归全绿；体积/冷启动达标；AC-003 实测双向互通通过；GUI 视觉走查项因本环境无法自动化，全部列为 PENDING-MANUAL 并附操作路径**。空载内存按两种口径记录，其中跨进程工作集求和口径超出 300MB 字面预算，判定留待 M6 统一口径后复测（见 §3.3）。

## 1. 测试环境

| 项 | 值 |
|---|---|
| 机器 | 13th Gen Intel Core i7-13700HX，16 核 24 线程，15.7GB RAM，SSD |
| 系统 | Windows 11 家庭版 中文版（build 26200），WebView2 Runtime 152.0.4191.66 |
| 工具链 | go1.26.0 windows/amd64，Node v24.11.1，wails3 |
| 参考档位 | 本机 ≥ 高配参考机（§12：8 核/16GB/NVMe/Win11），实测值按高配档判读 |

说明：**本机 `go test -race` 因工具链 cgo 缺陷不可用（预存在问题，Task 7 台账已记录），本地回归未带 `-race`；竞态覆盖由 CI（Task 13 `desktop-ci.yml`，含 `-race`）承接，Windows runner 首跑验证列入遗留项。**

## 2. 自动化回归（全部实跑，2026-09-11 晚）

| 命令 | 结果 | 明细 |
|---|---|---|
| `go test ./... -count=1`（desktop 模块） | **全绿** | 45 个顶层测试：connections 24、logging 8、version 6、settings 4、appdir 2、testutil 1；最慢包 connections 12.9s（内嵌 nats-server 用例） |
| `go vet ./...`（desktop 模块） | **exit 0** | 无告警 |
| `npx vitest run`（frontend） | **全绿** | 9 文件 / 39 测试，5.71s。分文件：connections-page 10、connstate-ui 9、shell 6、theme 4、command 3、settings-page 1、i18n 2、connstate 2、update 2 |
| `npm run build`（frontend） | **成功** | dist JS 507.93kB（gzip 161.80kB）+ CSS 39.33kB；有 >500kB chunk 警告（见 §5 遗留） |
| `wails3 build`（desktop） | **成功** | 产物 `desktop/bin/nats-desktop.exe` |

提交对应：功能代码 510aa6e..75d1b57（Task 1–13），CI 管线 75d1b57。

## 3. 性能冒烟（M1 基线，全部实跑）

### 3.1 体积

- `nats-desktop.exe` = **18,686,976 字节 ≈ 17.8 MiB** ≤ 30MB（§12 安装包体积）→ **PASS**
- 注：此为便携 exe（未打包安装器）；安装器打包在 M6 发布任务，体积只会略增（NSIS 压缩后通常更小）。

### 3.2 冷启动（5 次，取中位数）

方法（脚本化，PowerShell Stopwatch 毫秒级轮询；每轮杀进程树+清理 WebView2 残留）：main.go **没有**显式 "ready" 日志（记录为缺口，见 §5），采用日志文件三级代理标记：

- `create`：`%APPDATA%\nats-desktop\logs\nats-desktop.log` 文件出现（main() 早期 logging.New）
- `platform`：日志首行 `Platform Info`（Wails 框架初始化完成）
- `frontend`：日志出现 `[AssetFileServerFS] Handling request url=/`（**WebView2 窗口已创建、前端开始加载**——本环境无 GUI 自动化，以此为"接近可交互"的最近代理；JS/CSS 请求在其后 ~35ms 内出现，React 渲染完成时点未实测）

| 轮次 | create (ms) | platform (ms) | frontend (ms) |
|---|---:|---:|---:|
| 1 | 164 | 196 | 661 |
| 2 | 122 | 154 | 774 |
| 3 | 178 | 209 | 687 |
| 4 | 120 | 165 | 602 |
| 5 | 112 | 144 | 594 |
| **中位数** | **122** | **165** | **661** |

判定：高配档 ≤2s → **中位数 661ms，余量 >3 倍，PASS**（以 frontend 标记为口径）。到"人工确认可交互"的差值（JS 渲染收尾）留 PENDING-MANUAL（§4 表内附带操作）。注：5 轮均为同机连续运行（OS 文件缓存温热），非全新安装首启；首轮 661ms 与后续无显著差异。

单实例（附带验证）：主实例运行中二次启动 → **149ms 内退出，exit code 0，主实例存活**（进程级 PASS；二次启动应聚焦已有窗口的视觉确认 PENDING-MANUAL）。

### 3.3 空载内存（运行 ~61s，无连接空载）

方法：主进程 `Get-Process`；WebView2 子进程按 `Win32_Process` 中 `CommandLine` 含 `nats-desktop` 过滤（识别出 6 个：browser/crashpad/gpu/utility×2/renderer），逐 PID 取 WorkingSet64 与 PrivateMemorySize64 求和。

| 进程 | WorkingSet | Private(提交) |
|---|---:|---:|
| nats-desktop.exe（主） | 44.9 MB | 58.8 MB |
| WebView2 ×6（browser 134.0/39.2、gpu 96.1/78.9、renderer 73.4/32.1、utility 40.9/12.7 + 20.5/8.6、crashpad 15.2/3.5，格式 WS/Priv MB） | 380.1 MB | 175.1 MB |
| **合计** | **424.9 MB** | **233.9 MB** |

判定（诚实记录，两种口径）：

- Private 提交求和（跨进程不重复计数）= **233.9MB ≤ 300MB → PASS**
- WorkingSet 求和 = **424.9MB > 300MB → 字面超标**。但 WS 求和会把 Chromium 各进程共享页（映射代码/资源/GPU 共享内存）重复计入（如 browser 进程 WS 134MB 中 Private 仅 39MB），业界对多进程 WebView 应用通常按 private working set 口径。**最终判定留待 M6**：统一口径（建议 Process\Working Set - Private 求和）后按 §12 双档复测。
- 另：规格口径为"典型负载持续 30 分钟"；M1 无消息功能，此为空载 61s 基线（两次独立测量 431.2/424.9MB，一致）。两条 24 小时稳定性与典型负载验证均在 M6。

### 3.4 操作反馈时延 ≤100ms

无法无头测量 → **PENDING-MANUAL**：设置页逐控件点击（主题单选、语言下拉、日志级别、打开日志目录按钮），录屏逐帧或体感确认点击到视觉反馈 ≤100ms。

## 4. AC 走查表（规格 §19 对照）

状态定义：AUTOMATED-PASS（引用测试，本机实跑通过）/ LIVE-PASS（本记录实测）/ MEASURED（数字+方法）/ PENDING-MANUAL（附操作路径，人工执行后回填）。

| 规格 AC | 走查项 | 状态 | 证据 / 操作路径 |
|---|---|---|---|
| AC-001 | 全新目录启动进引导，八页可导航 | **LIVE-PASS**（GUI 冒烟）+ AUTOMATED-PASS | GUI 实测（2026-09-11 晚，computer-use + 本地 nats-server:4333）：首启引导卡片（Welcome/说明/New context 主按钮）、侧栏 8 入口全 SVG 线性图标无 emoji、非设置页未连接空态。测试：`shell.test.tsx` "renders all eight nav entries with svg icons"、`connstate-ui.test.tsx` guide card 用例。 |
| AC-002 | 建 context → 测试连接（RTT+落盘） | **LIVE-PASS**（GUI 冒烟）+ AUTOMATED-PASS | GUI 实测完整路径：引导卡 New context → 表单（认证五选一/TLS/JS/高级字段齐全）→ 填 local-test + nats://127.0.0.1:4333 → Test connection 返回 **"Connected, RTT 0ms, JetStream: no"**（回环 RTT=0 为已知语义；JS:no 正确——服务器未开 -js）→ Save → 列表出现该行 → Connect → **Active 徽标 + 状态脚绿点 "local-test · Connected"**。测试：`TestCheckConnection` 系列、`TestSaveThenList`、前端 test-result 用例。 |
| AC-003 | context 与 natscli 双向互通 | **LIVE-PASS**（本轮实测，三步）+ AUTOMATED-PASS | 实测（`$XDG_CONFIG_HOME` 重定向至临时目录，双方均走生产默认后端 `$XDG_CONFIG_HOME/nats`→`~/.config/nats`）：① 真 CLI（`go run ./nats context save cli-demo --server nats://cli.example.com:4222`）创建 → 应用生产路径 `connections.NewRegistry()`+`Store.List()` 列出 `cli-demo (url=…, auth=userpass)`；② 应用 `Store.Save("app-made")` → 真 CLI `nats context list` 同时列出 `app-made` 与 `cli-demo`；③ 应用 `Store.Save("app-live"→127.0.0.1:14222 真实 nats-server)` → CLI `nats --context app-live rtt` 连接成功 **315µs**。回归测试：`TestInteropRoundTrip`（应用写→CLI 等价 Registry 读，逐字段断言）。 |
| AC-019 | 错误密码 → failed，无重试循环 | **AUTOMATED-PASS** + PENDING-MANUAL（GUI） | 测试：`TestAuthFailureGoesFailedNoRetryLoop`（内嵌认证服务器+错误密码）、`TestConnectDialErrorGoesFailed`；前端 "failed banner shows reason and edit action"。手动：① 起认证服务器（内嵌助手等价：`docker run` nats 镜像 + `--user u --pass p`）；② 建错密码 context 点连接；③ 期望 failed 横幅展示服务器认证错误原文、无重试循环；改对密码重连成功。 |
| AC-020 | 主题三态+系统跟随+重启保持 | **LIVE-PASS**（GUI 冒烟：Dark 即时切换+重启保持）+ AUTOMATED-PASS | GUI 实测：Theme 切 Dark → 全界面即时深色（含表单/下拉），Indigo 选中态清晰无样式错乱；重启后深色保持。注意语义：**保存后即时生效**（非 onChange 即时）——规格 §6.12"变更→立即生效"的解读差异已记录（§5-18）。跟随系统模式的系统切换跟随仍 PENDING-MANUAL。测试：`theme.test.ts` 4 例、settings-page 持久化用例。 |
| AC-021 | zh-CN 全界面+重启保持 | **LIVE-PASS**（GUI 冒烟）+ AUTOMATED-PASS | GUI 实测：保存后全界面即时中文（导航 总览/消息/流/消费者/键值存储/对象存储/监控/设置、设置页全部标签、tabs、状态"已连接"、toast"设置已保存"）；重启后保持 zh-CN。测试：`i18n.test.ts` 键完整性 + CI 门禁。 |
| AC-027 | 更新检查通知 | **AUTOMATED-PASS** + PENDING-MANUAL（视觉） | 测试：Go `TestCompareVersions`/`TestCheckLatestParsesRelease`/`TestCheckLatestNoUpdateWhenNotNewer`；前端 update.test.tsx "shows the update toast once even if the event fires twice"、"ignores malformed payloads"。手动：仓库 Releases 存在 >0.1.0 版本时直接启动，否则临时将 `desktop/internal/version/version.go` 的 `appVersion` 调低重编译；期望一次可关闭通知附下载链接。注意 Task 12 遗留：启动 emit 竞态（前端未挂载时事件丢失）未接线兜底。 |
| §6.1 | 更新检查失败静默（断网启动） | **AUTOMATED-PASS** + PENDING-MANUAL（断网） | 测试：`TestCheckLatestTimeoutIsSilentError`（5s 超时→error 静默）、`TestCheckLatestNon200IsError`。手动：断网（或 hosts 屏蔽 api.github.com）启动 → 无任何干扰。 |
| §6.1 | 启动恢复（Task 10 台账：main.go wiring 无自动化测试） | **LIVE-PASS**（修复后实测）| **缺陷发现与修复记录**：GUI 冒烟发现启动恢复失效（CRITICAL-B1）——设置页整包保存冲掉后端持久化的 `last_active_context`（复现：Connect→设置页 Save→重启→未连接）。终审定位三层根因，修复于 `ab65f72`：`settings.Update` 串行化助手 + `SaveSettings` 服务端合并（仅 appearance/behavior/privacy，last_active_context 后端独占）+ persistActive 共用互斥 + 回归测试 `TestSaveSettingsDoesNotClobberLastActiveContext`。**修复后端到端实测**：settings.json 写入 last_active_context=local-test → 重启应用 → `netstat` 证实应用进程与 4333 服务器 **ESTABLISHED**（自动恢复连接成立），且设置未被冲掉。服务器离线场景（failed 一次不循环）仍由 `TestAuthFailureGoesFailedNoRetryLoop`/`TestConnectDialErrorGoesFailed` 覆盖 Manager 行为，GUI 离线走查 PENDING-MANUAL（①停服务器重启→failed 横幅一次、可导航、日志有 startup restore failed WARN）。 |
| §6.1 | 设置损坏 → .bak 回退（附带） | **AUTOMATED-PASS** | `TestCorruptFileFallsBack`（重命名 .bak+默认值启动）。 |

## 5. 已知简化与遗留（移交 M2/M6）

终审修复波（`ab65f72`，随 M1 合并）：CRITICAL-B1 设置覆盖缺陷（见 §4 启动恢复行）、设置保存失败 toast（I1）、desktop/README.md 模板替换（I3）、`String(err)` 统一（M6）、`@wailsio/runtime` 锁定版本（M4）。

性能与口径：
1. 空载内存判定口径未统一（§3.3），M6 需以 private working set 口径按 §12 双档复测；低配档（2 核/HDD/禁 GPU）整体留 M6（CI 限核环境 M2 搭建）。
2. main.go 无显式启动完成（ready）日志——本轮冷启动只能用框架日志代理标记；建议 M2 加一条应用级 ready 日志，利于自动化计时与诊断。
3. 前端主 chunk 507.93kB 超过 500kB 构建警告阈值；M2+ 按页面 code-split。
4. 反馈时延 ≤100ms 未无头测量，随 GUI 走查人工确认（§3.4）。

测试基建：
5. `-race` 本机工具链缺陷未解决；CI Windows runner `-race` 首跑验证（Task 13 遗留）。
6. main.go 启动恢复 wiring 无自动化测试（Task 10 遗留）——已列为走查重点（§4）。
7. `update:available` 启动 emit 竞态：前端未挂载时丢失，建议 mount 时调 CheckUpdate 兜底（未接线，Task 12 遗留）。
8. 版本比较对 pre-release 语义有偏差（beta≈正式），首个 pre-release tag 前修正（Task 12）。
9. 已建立连接上凭证撤销→failed 的 FIFO 强化路径未测（Task 8）。

功能细节（各任务 Minor，终审未阻断）：
10. 托盘图标用 png 非 .ico（Task 12）。
11. 字符串/凭证字段编辑语义不可清空（natscontext Option 机制限制，Task 6/10）。
12. RTT 0ms 语义=未测量，消费方 UI 需处理（Task 8）。
13. 日志 rotate() 双失败路径 writer 永久死亡（建议 stdout 兜底）等边缘（Task 5）；日志级别改动需重启生效。
14. main.go 吞 `settings.Path()` 错误；数字输入可存 0 无钳制；`{}` 部分 JSON 绕过默认值合并（Task 4）。
15. pins.go 空导入 nats-server 位于非测试文件（Task 1）；lint 仅 src 不含 tests、react-refresh 全局关闭、actions tag-pin 惯例（Task 13）。
16. context 外部修改的冲突检测 M1 不做（计划自检已记录的已知简化，移 M2 备忘）。
17. Ctrl+K 全局热键未测；palette 复用 placeholder 作 aria-label（Task 9/11）。

## 6. 回填区（人工走查后填写）

| 走查项 | 结果 | 执行人/日期 | 备注 |
|---|---|---|---|
| AC-001 全新目录引导 | 待执行 | | |
| AC-002 GUI 测试连接 | 待执行 | | |
| AC-019 GUI 错误密码 | 待执行 | | |
| AC-020 系统跟随+重启保持 | 待执行 | | |
| AC-021 zh-CN 走查 | 待执行 | | |
| AC-027 更新通知视觉 | 待执行 | | |
| §6.1 断网静默 | 待执行 | | |
| §6.1 启动恢复（在线/离线） | 待执行 | | |
| 反馈时延 ≤100ms | 待执行 | | |
| 单实例二次启动聚焦窗口 | 待执行 | | |
