# NATS 桌面客户端 M6 手测矩阵（M1–M6 汇总核销）

- 日期：2026-09-14（生成）
- 分支 / HEAD：`desktop/m6`（M6 Task 10）
- 来源方法：对五份验收记录（M1 `2026-09-11-m1`、M2 `2026-09-12-m2`、M3 `2026-09-12-m3`、M4 `2026-09-13-m4`、M5 `2026-09-13-m5` 各 acceptance.md；**实际文件为五份，非六份——以 `ls` 实际产出为准**）grep `PENDING-MANUAL|待执行|LIVE-待办|回填区` 逐行抽取，按 §4/§7 冒烟证据逐条重新裁定状态；外加 M6 已知新增三腿（AC-022 键盘全路径/IME、32 张截图基线、T9 安装/卸载冒烟）与 M5 终审 I-1 重裁的降级 live 腿。
- 状态三态：**EXECUTED**（已执行，附证据指针与执行人/日期）/ **LIVE-待办**（需解锁桌面用户在场，附精确步骤交还 post-soak 批次执行）/ **WAIVED**（附理由——本矩阵当前 0 行）。
- 执行环境注记：**24h 长稳（m6soak/soak.load）正在运行，应用被 soak UIA 驱动占用、单实例锁阻止二次启动**——本轮（Task 10 NOW）不执行任何需要应用 UI 的腿；全部 LIVE-待办行留待长稳结束后的 post-soak 批次按步骤逐行执行并回填「执行人/日期」。锁屏是 M1–M5 各 PENDING 腿的共性根因（原生对话框/录屏判读/IME/像素目视均不可驱动），解锁桌面是 post-soak 批次的前置条件。
- M6 自动化义务（双档性能/内存口径/24h 长稳/压力数据集/覆盖率）由 M6 Task 4–7 承接，不在本矩阵；长稳结果在 Task 11 验收时并入。

## 状态汇总

| 状态 | 行数 |
|---|---:|
| EXECUTED | 16 |
| LIVE-待办 | 24 |
| WAIVED | 0 |
| **合计** | **40** |

> **Post-soak 批次（2026-09-15，控制器 UIA，锁屏会话）**：长稳结束后按各行精确步骤执行。本次新增 EXECUTED 10 行：#3、#9、#19、#22、#25、#26、#33、#35、#36、#40；另 #6/#11/#15 补充实测证据后仍按剩余义务留 LIVE-待办。全记录见 `.superpowers/sdd/task-10-m6-report.md`「Post-soak execution」。AC-030 sweep 腿 3（`security-sweep.ps1 -UiaMaskCheck`）已补跑：password 掩码 PASS，**token 输入框 PLAINTEXT（IsPassword=False）→ 记缺陷 F-1（AC-030 规格「密码/token 默认掩码显示」偏离）**；源码扫/日志扫维持 0 命中。#22/#26 的破坏性操作均落在自建夹具流 M6SCRATCH（已删），未触碰 4333 的 LOAD 数据集。

## 矩阵

状态/证据裁定说明：M1 §4 与 M2 §7 的控制器 GUI 冒烟（UIA 驱动真应用）对回填区中相应行的核销按 EXECUTED 计（执行人=控制器(UIA)，日期=各冒烟当日）；混合腿（部分半边已测）按**剩余义务**记 LIVE-待办，已测半边在证据列注明。

### M1（2026-09-11-m1-acceptance §6 回填区，10 行拆并）

| # | 来源里程碑 | 条目 | 状态 | 证据 / 精确步骤 | 执行人/日期 |
|---|---|---|---|---|---|
| 1 | M1 | AC-001 全新目录引导（八页可导航） | **EXECUTED** | M1 §4 AC-001：GUI 冒烟 LIVE-PASS——首启引导卡片、侧栏 8 入口全 SVG 图标、空态正确；`shell.test.tsx`/`connstate-ui.test.tsx` 自动化在案 | 控制器(UIA) / 2026-09-11 |
| 2 | M1 | AC-002 GUI 建 context → 测试连接 → Connect | **EXECUTED** | M1 §4 AC-002：完整路径实测（Connected, RTT 0ms → Save → Active 徽标 + 状态脚绿点） | 控制器(UIA) / 2026-09-11 |
| 3 | M1 | AC-019 GUI 错误密码 → failed 无重试循环 | **EXECUTED** | post-soak 实测（2026-09-15）：真认证服务器（nats-server `--user u --pass p` :6201，headless）；GUI 表单打字半边仍受 IME 限制，context 以文件夹具注入后 UIA 切换该 context → failed 横幅展示服务器原文 **`nats: Authorization Violation`**、无重试循环（15s 日志零增长）；改对密码重选 → **已连接**。自动化：`TestAuthFailureGoesFailedNoRetryLoop` | 控制器(UIA post-soak) / 2026-09-15 |
| 4 | M1 | AC-020 跟随系统模式在系统主题切换时即时跟随 | LIVE-待办 | 已测半边：Dark 即时切换+重启保持（M1 §4 LIVE-PASS）。剩腿步骤：设置→外观→主题=跟随系统 → Windows 设置切换深/浅色 → 断言应用即时跟随且重启保持 | （待 post-soak 回填） |
| 5 | M1 | AC-021 zh-CN 全界面走查+重启保持 | **EXECUTED** | M1 §4 LIVE-PASS；M3 §7-j / M4 §7-i 冒烟全树 zh-CN 复验 + emoji 码位扫描零命中 | 控制器(UIA) / 2026-09-11（09-12/09-13 复验） |
| 6 | M1+M6 | AC-027 更新检查显式腿（一次可关闭的新版本通知含下载链接） | LIVE-待办（需远端 release） | M6 Task 1 版本注入后步骤：①`wails3 task windows:build VERSION=0.0.9`（远端无 >0.0.9 release，`CheckLatest` 必判 HasUpdate）；②启动；③断言出现一次可关闭的新版本通知含下载链接。**在案提示**：若通知偶发不出现，先按 M1 §5-7 已知缺陷「启动 emit 竞态（前端未挂载时事件丢失）未接线兜底」归因排查，而非误判回归。失败静默腿已有 M1 自动化（`TestCheckLatestTimeoutIsSilentError`）。**post-soak 发现（2026-09-15）**：现场多次启动均触发 update check 且远端返回 `update check: status 404`（远端无任何 release），日志 ERROR 两条、无通知出现（静默语义符合）——「远端无 >0.0.9 必判 HasUpdate」前提不成立，本腿需远端先发布一个 >当前版本的 release | （待远端 release 后回填） |
| 7 | M1 | §6.1 更新检查失败静默（断网启动无干扰） | LIVE-待办 | 步骤：断网（或 hosts 屏蔽 api.github.com）启动 → 断言无任何提示/横幅/toast 干扰 | （待 post-soak 回填） |
| 8 | M1 | §6.1 启动恢复——在线自动重连腿 | **EXECUTED** | M1 §4：B1 修复（`ab65f72`）后端到端实测——settings.json 写 last_active_context → 重启 → `netstat` ESTABLISHED 到 4333 且设置未被冲掉；M2 §7 冒烟「重启即 ESTABLISHED」复验 PASS | 控制器(UIA) / 2026-09-11 |
| 9 | M1 | §6.1 启动恢复——服务器离线 failed 一次腿 | **EXECUTED** | post-soak 实测（2026-09-15，不动 4333 以保护长稳数据集）：以死端口 context（nats://127.0.0.1:6299）为 last_active_context 启动 → 日志 `WARN msg="startup connection restore failed" context=dead error="dial tcp 127.0.0.1:6299: connectex: …"`；UI failed 横幅出现一次含服务器原文（`连接失败：dial tcp … actively refused it.`）、无重试循环（20s 日志 0 行增长）、页面可导航。Manager 行为自动化：`TestAuthFailureGoesFailedNoRetryLoop`/`TestConnectDialErrorGoesFailed` | 控制器(UIA post-soak) / 2026-09-15 |
| 10 | M1+M2 | 操作反馈时延 ≤100ms（设置页逐控件 + 会话页按钮） | LIVE-待办 | 步骤：解锁桌面，主题单选/语言下拉/日志级别/打开日志目录按钮 + 会话页暂停/恢复/清空/建会话逐个点击，录屏逐帧或体感确认点击到视觉反馈 ≤100ms | （待 post-soak 回填） |
| 11 | M1 | 单实例二次启动聚焦已有窗口（视觉确认） | LIVE-待办（仅聚焦半边） | 已测半边：进程级 149ms 内 exit 0、主实例存活（M1 §3.2）；post-soak 复验（2026-09-15）二次启动后进程数=1。剩腿步骤：主实例运行 → 二次启动 exe → 断言已有窗口被聚焦到前台。**锁屏限制**：GetForegroundWindow 前后不变（锁屏窗口持有前台），聚焦断言在锁屏会话不可判定，需解锁桌面 | （待解锁桌面回填） |

### M2（2026-09-12-m2-acceptance §8 回填区 + §5/§7 PENDING + §6-3 转手测）

| # | 来源里程碑 | 条目 | 状态 | 证据 / 精确步骤 | 执行人/日期 |
|---|---|---|---|---|---|
| 12 | M2 | AC-004 UI 请求响应面板 + 发布历史 | **EXECUTED** | M2 §7 冒烟 PASS：UIA 填表 → echo 请求 → `{"pong":true,…}` 耗时 **6ms**、响应面板语法高亮 + 历史/清空历史按钮在位 | 控制器(UIA) / 2026-09-12 |
| 13 | M2 | AC-005 上屏延迟 P95 ≤200ms 抽样（录屏逐帧） | LIVE-待办 | 已测半边：实时上屏/速率计/累计 PASS（143 msg/s chip，M2 §7）。剩腿步骤：①后台 `go run ./cmd/flood -rate 1000 -dur 60s -subject m2flood.ac5`；②Messages → Sessions 新建实时会话订阅该主题；③录屏逐帧比对消息时间戳 vs 上屏时刻，P95 ≤200ms | （待 post-soak 回填） |
| 14 | M2 | AC-006 UI 暂停/恢复/清空/批量切换语义 | **EXECUTED** | M2 §7 冒烟 PASS：暂停冻结 4393（暂停期 600 条不上涨）→ 恢复至真实总数 4990 无回补 | 控制器(UIA) / 2026-09-12 |
| 15 | M2 | AC-007 UI 洪峰响应性 + 视觉流畅度（丢帧判读） | LIVE-待办（仅录屏丢帧判读半边） | 已测半边：进程级+数据面 PASS（49,898 msg/s 注入、chip 41,753 msg/s、守恒精确、UIA 立即恢复，M2 §7）。**post-soak UIA 半边全过（2026-09-15）**：50k/s×10s 注入（实测 49,764 msg/s、497,650 条）期间 UIA 树即时应答（界面可响应）；丢弃角标 >0 且精确=总数−缓冲（487,650=497,650−10,000）；暂停立即冻结（3s 间隔两次采样同值）；结束后速率计归 0；恢复无回补（617,470 精确守恒）。剩腿仅 ⑥录屏逐帧丢帧判读（需解锁桌面） | （待解锁桌面回填） |
| 16 | M2+M3 | AC-029 2MB 大消息 hex/下载 UI（会话半边 M2 + 浏览器半边 M3） | LIVE-待办 | 步骤：①服务器 max_payload 调至 ≥2MB 并重启；②会话半边：`go run ./cmd/flood -rate 1 -size 2097152 -dur 1s` → 会话详情：元数据 + 十六进制预览 + 下载，界面不卡顿；③浏览器半边：>1MB 消息 64KiB 前缀 + truncated 标记 → 点开全量拉取 → hex + 下载。注：当前 4333 默认 1MB，应用呈现服务器错误原文即规格预期（900KB 可先行验证） | （待 post-soak 回填） |
| 17 | M2 | §12 持续吞吐 5k×60s 丢帧 <5% 录屏判读 | LIVE-待办 | 已测半边：发布端 4,995 msg/s×60s 无漂移（M2 §3）。剩腿步骤：`go run ./cmd/flood -rate 5000 -dur 60s` → 会话订阅 → 录屏判读丢帧 <5%（可随 AC-007 走查同批进行） | （待 post-soak 回填） |
| 18 | M2 | 冷启动「人工确认可交互」差值 | LIVE-待办 | 基线：ready 139ms / frontend 589ms（M2 §4.2 中位）。步骤：启动应用同时秒表 → 人工确认可交互时刻 → 与 ready/frontend 日志标记差值记录（M1/M2 同口径可比） | （待 post-soak 回填） |
| 19 | M2 | 50k 洪峰后清空按钮 UI（UIA 停答未回填） | **EXECUTED** | post-soak 实测（2026-09-15）：50k/s×10s 洪峰（497,650 条）结束后 UIA 点会话「清空」→ chip `0 msg/s 共 0 条`（丢弃角标同清）；UIA 全程未再停答（M2 §7 当年中止现象未复现）。语义自动化：ClearSession Go 测试在案 | 控制器(UIA post-soak) / 2026-09-15 |
| 20 | M2→M5 | trace 集群 hop 手测：service_import / stream_export 形态 | LIVE-待办 | 裁定链：M2 §6-3 → M5 §5-1（mapping 跳已由 M5 Task 2 三例全载荷断言覆盖，无需重测）。步骤：①配置跨账户 service_export/service_import 的集群夹具；②Messages → Trace 输入目标主题发起；③断言树呈现 service_import/export 跳形态、各跳载荷与主题改写正确 | （待 post-soak 回填） |
| 21 | M2→M5 | ErrTimeout 部分结果手测（trace 超时返回部分树） | LIVE-待办 | 裁定链：M2 §6-3 → M5 §5-2（真实「部分应答即超时」需时序注入；自动化已重构为无兴趣路径验证 not_found 语义）。步骤：按 m5-acceptance §5-2 精确路径——制造 $SYS 定向请求部分应答后超时 → 断言返回部分树而非全空 | （待 post-soak 回填） |

### M3（2026-09-12-m3-acceptance §8 回填区；AC-029 并 #16、像素核对并 #27）

| # | 来源里程碑 | 条目 | 状态 | 证据 / 精确步骤 | 执行人/日期 |
|---|---|---|---|---|---|
| 22 | M3 | AC-009 删除后空洞标记 UI 实拍 | **EXECUTED** | post-soak 实测（2026-09-15，自建夹具流 M6SCRATCH 2 条消息，已删）：消息浏览器点行 #1 → 详情「删除」→ L1 确认框（「删除消息 #1？/流 M6SCRATCH 中的消息 #1 将被永久删除。」）→ 确认 → 浏览器渲染 `已删除消息 #1` 标记、#2 保留。自动化 11 例覆盖含标记断言（M3 §7-c） | 控制器(UIA post-soak) / 2026-09-15 |
| 23 | M3 | AC-028 10k 流滚动帧率录屏判读（≥60fps/≥30fps 双档） | LIVE-待办 | 已测半边：10k 行虚拟化仅渲染 18 行、冷挂载 132 ops/s（M3 §3）。步骤：造 10k 流场景 → 列表滚动录屏 → 逐帧判读 ≥60fps（高配）/ ≥30fps（低配模拟） | （待 post-soak 回填） |
| 24 | M3 | 备份/恢复全链路 UI（含覆盖确认门） | LIVE-待办 | 步骤（M3 §7-g 原文）：流详情 → 备份 → 选择目录… → 选 %TEMP%\m3bk → 进度条 → 「备份完成」→ 删除流（名称匹配）→ 工具栏「恢复备份」→ 选同目录 →（目标已存在时勾选「删除并重建」）→ 分片进度 → 「恢复完成」→ 消息数一致。自动化：Go 6 例 + 面板 6 例 | （待 post-soak 回填） |
| 25 | M3 | JS 不可用指引面板 UI（探针 context 已备） | **EXECUTED** | post-soak 实测（2026-09-15）：chip 选 m3-nojs（连 4333，api_prefix=nonexistent_prefix_m3）→ 流页渲染指引面板而非空列表：「JetStream 数据不可用」标题 + no_responders 原文行（对流列表请求返回「无应答者」——$JS.API 主题无人响应）+ jsDomain/jsApiPrefix 两行检查项（M3 §7-i 全要素） | 控制器(UIA post-soak) / 2026-09-15 |
| 26 | M3 | relaxed confirm_level 下 purge 直执行 UI 抽查 | **EXECUTED** | post-soak 实测（2026-09-15，夹具流 M6SCRATCH）：设置→行为→确认级别=宽松（跳过确认）→ 保存（toast「设置已保存」、settings.json confirm_level=relaxed）→ 流详情「清空」→ **无 L1 确认框**、消息数 1→0 直执行；复查后已恢复 standard。standard 级全流程已 LIVE-PASS（M3 §7-d） | 控制器(UIA post-soak) / 2026-09-15 |

### M4（2026-09-13-m4-acceptance §8 回填区；像素核对并 #27）

| # | 来源里程碑 | 条目 | 状态 | 证据 / 精确步骤 | 执行人/日期 |
|---|---|---|---|---|---|
| 27 | M3+M4+M5 | 深色主题像素级配色核对（含危险区红色分离目视） | LIVE-待办 | 三处同项合并（M3 §8 / M4 §8 / M5 §7）。根因：UIA 文本通道不可读色值。步骤：解锁桌面目视核对深色主题全页配色 + 危险区红色分离；对比度脚本腿已完成（M6 T8：8/8 关键组合 ≥4.5:1） | （待 post-soak 回填） |
| 28 | M4 | AC-013 watch 时延 ≤1s 复核（解锁桌面） | LIVE-待办 | 已测半边：实时行+修订号 LIVE-PASS（锁屏下 UIA 可见链路 1.6–4.1s 为节流+MSAA 开销，非投递时延）。步骤：解锁桌面，watch 开启 → 注入 put → 秒表/录屏判读事件到上屏 ≤1s；自动化 `TestKvWatchFloodNoLoss` 零丢失在案 | （待 post-soak 回填） |
| 29 | M4 | 5MB 上传全链路 UI（原生选择器腿） | LIVE-待办 | 步骤（M4 §7-f）：对象存储 → 选桶 → 上传 → 选择文件… → 选 5MB 文件 → 队列重命名 → 开始上传 → 进度条（字节/速率）→ Complete ✓ → 列表自动刷新。锁屏下原生 Win32 对话框不可驱动为原始根因 | （待 post-soak 回填） |
| 30 | M4 | 下载全链路 UI（选目录 → 进度 → digest ✓ → 打开所在目录） | LIVE-待办 | 步骤（M4 §7-f）：对象行「下载」→ 选目录 → 进度 → digest ✓ chip → 「打开所在目录」。自动化：round-trip/100MB 字节精确+digest 在案 | （待 post-soak 回填） |
| 31 | M4 | 上传中断 UI 实拍（断连 → 红行 → 重试 → Complete） | LIVE-待办 | 步骤：上传中断连注入 → 断言 incomplete 红行 + 服务器原文 → 点重试 → Complete。自动化 3 例在案（`TestUploadIncompleteOnDisconnectLocalServer` + 前端 attempt=2 用例） | （待 post-soak 回填） |
| 32 | M4 | 磁盘不足下载阻止 UI 实拍 | LIVE-待办 | 步骤：小容量分区/介质（剩余空间 < 对象大小）→ 下载 → 断言开始前 toast 阻止、无残留行状态。自动化双分支在案（`TestDownloadDiskSpaceGate`） | （待 post-soak 回填） |
| 33 | M4 | workqueue 浏览报错 toast + 头部常驻提示 UI 实拍 | **EXECUTED** | post-soak 实测（2026-09-15，夹具流 M6WQ=WorkQueuePolicy 无 allow_direct，已删）：详情「消息」页签浏览报错 → UIA 捕获提示「workqueue 流浏览需服务器 allow_direct；nats stream edit 可开启」+ 错误行含服务器原文（`nats: API error: code=400 err_code=10084 description=consumer in pull mode requires explicit ack policy on workqueue stream`）。自动化：真值表 + toast 用例在案 | 控制器(UIA post-soak) / 2026-09-15 |
| 34 | M4 | 一次性应用退出复盘（§6-8，解锁桌面长时 watch 稳定性观察） | LIVE-待办 | 背景：M4 §7-e 一次无日志、无 WER 退出，受控复现未现，疑锁屏环境。步骤：解锁桌面长时间 watch 稳定性观察（24h 长稳的崩溃分类结果出来后交叉判读）；终审关注 watch/emit 路径 panic 缝隙 | （待 post-soak 回填） |

### M5（2026-09-13-m5-acceptance §7 回填区 + 终审 I-1 重裁腿）

| # | 来源里程碑 | 条目 | 状态 | 证据 / 精确步骤 | 执行人/日期 |
|---|---|---|---|---|---|
| 35 | M5 | §8.3.1 降级横幅 live 腿重跑（I-1 修复后真腿验证） | **EXECUTED** | post-soak 实测（2026-09-15）：①local-test（app-user，无 $SYS）连 4333；②监控页降级横幅展开显示**服务器原文** `$SYS.REQ.SERVER.PING: server request failed, ensure the account used has system privileges and appropriate permissions`（非通用兜底文案），且跨轮询周期持续刷新；③切 sys 集群 context（testcluster 3 节点）→ 横幅消失、S1/S2/S3 三行在线指标呈现（版本 2.15.0-preview.1/运行时长/CPU/内存/连接/路 8/0/JS 角色=元数据主·投票成员）。I-1 live 腿闭环。自动化：`monitoring-use-monitor.test.ts` 事件线 `servers:null`/`[]` 两形用例 | 控制器(UIA post-soak) / 2026-09-15 |
| 36 | M5 | AC-015 断节点标红离线实拍（杀 1 节点 → 红行） | **EXECUTED**（变体夹具） | post-soak 实测（2026-09-15）：`go run ./cmd/testcluster` 三节点同进程无法单杀其中 1 节点 → 改用等价 3 **进程**集群（仓库固定版本源编译 nats-server v2.15.0-preview.1，SYS 账户 sys/syspass，M6TEST 集群，语义同 testutil.StartCluster）。应用以 sys context 观察多个轮询周期三行在线 → 杀 S3 进程 → **S3 红行离线**（aria「离线」+ 行置暗、保留上轮数据：版本/运行时长冻结 9m47s、CPU/内存显示 —、连接 0），S1/S2 正常 → **同名重启 S3 → 同一行恢复在线**（Go 侧按 server_name 对齐合并，OfflineSinceMs 清零）。自动化 `TestSnapshotClusterNodeOfflineMarking` 在案 | 控制器(UIA post-soak) / 2026-09-15 |
| 37 | M5 | stream 副本 3 下 stream step-down/balance UI 实拍（AC-017 条件全量） | LIVE-待办 | 已测半边：meta 层 step-down 全流程 LIVE-PASS（M5 AC-017-2）。步骤：3 节点集群 + R3 流 → 集群面板 stream step-down / balance 全 L2 流程（名称匹配确认 → 执行 → leader/主副本刷新）→ 断言与日志 `cluster op completed` 一致。注：3 节点 R3 peer-remove 为服务器确定性 10075（M5 §5-3 坐实），不列入期望 | （待 post-soak 回填） |

### M6 新增（Task 8/9 在案 PENDING 腿）

| # | 来源里程碑 | 条目 | 状态 | 证据 / 精确步骤 | 执行人/日期 |
|---|---|---|---|---|---|
| 38 | M6 | AC-022 键盘全路径复验 + IME 中文输入走查 | LIVE-待办 | 已有：M1 Ctrl+K→Streams→浏览器键盘路径已过（复验记录在案）；M6 T8 对比度 8/8 ≥4.5:1。步骤：①Ctrl+K 面板 → Streams → 某流 → 消息浏览器全程键盘复验；②8 页面 Tab 顺序/焦点环/Escape 关闭抽查（T8 抽查结果核对）；③**IME 腿**：连接表单/键编辑器中文输入（中文名、中文值）→ 断言候选确认、无重复上屏、保存后回读正确——需解锁桌面 + IME 在场人工执行 | （待 post-soak 回填） |
| 39 | M6 | 32 张截图基线（AC-026 另半边，G11 参考集） | LIVE-待办 | 前置：M6 T8 脚本就绪未跑（锁屏在案）。步骤：**解锁桌面会话** → `desktop/scripts/screenshots.ps1` → 8 页 × 2 主题 × 2 语言 = 32 张落 `docs/screenshots/v1.0/` → 核对齐全性。裁定：基线=参考集非门禁，像素 diff 门禁列 v1.1 | （待 post-soak 回填） |
| 40 | M6 | T9 安装/卸载冒烟（NSIS /S → 启动 → 卸载 /S） | **EXECUTED** | post-soak 冒烟（2026-09-15）全部通过：①`nats-desktop-amd64-installer.exe /S` exit 0、无 UAC；②安装目录 `%LOCALAPPDATA%\Programs\NATS Desktop\`（exe 哈希=发布构建 `52cc2de9bbc2da3a…` 与 bin 一致 + uninstall.exe）+ 开始菜单 `NATS Desktop.lnk` + HKCU `Uninstall\WenElevatingNATS Desktop` 键；③启动 UIA 主窗 4s 激活、日志 `msg=ready version=1.0.0`、设置自 `%APPDATA%\nats-desktop\settings.json` 恢复并重连；④优雅关闭；⑤`uninstall.exe /S` exit 0 → 安装目录/快捷方式/注册表键全部清除、`%APPDATA%` 数据按设计保留。**注**：实际安装目录名为 `NATS Desktop`（含空格），非 T9 报告预估的 `nats-desktop` | 控制器(UIA post-soak) / 2026-09-15 |

## 回填约定

- post-soak 批次执行每行后：状态改 EXECUTED、填「执行人/日期」、结果/截图指针写入本表证据列（或 m6-test-report 对应节）。
- 执行发现缺陷：不改状态先记缺陷（编号+复现），按缺陷流程派发；缺陷阻断判定时该行保持 LIVE-待办并注明阻断编号。
- WAIVED 仅可用于有显式理由且经裁定认可的行（当前 0 行）。
