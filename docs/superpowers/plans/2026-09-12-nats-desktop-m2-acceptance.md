# NATS 桌面客户端 M2 验收记录

- 日期：2026-09-12（凌晨实跑）
- 分支 / HEAD：`desktop/m2` @ `adb41c8`（遗留清单经终审补全于后续提交）（Task 1–12 全部合并）+ 本记录与 flood 工具提交（Task 13）
- 范围：M2 = 规格 §6.3（发布与请求-应答）+ §6.4（订阅会话）+ §7.1.3/§8.5.1 事件契约 + §12 实时模式性能 + M1 遗留接线（计划 `2026-09-11-nats-desktop-m2.md`，Task 1–13）
- 结论先行：**自动化回归全绿（125 Go 测试 + 95 前端测试）；性能门槛全部大幅达标（管线 14.1M msg/s、真机会话持续 628k msg/s、前端 1 万条 136ms）；flood 注入器实测 1k/5k/50k msg/s 节流精度 99.6–99.9%（真服务器 4333）；体积/冷启动/内存与 M1 基线一致且达标**。所有需要 GUI 在场的观察项（滚动流畅度、上屏延迟、暂停立即生效的视觉面等）如实列为 PENDING-MANUAL 并附精确点击路径；控制器将按 M1 惯例补一轮真服务器 GUI 冒烟（§7 占位）。

## 1. 测试环境

| 项 | 值 |
|---|---|
| 机器 | 13th Gen Intel Core i7-13700HX，16 核 24 线程，15.7GB RAM，SSD（≥ §12 高配参考档） |
| 系统 | Windows 11 家庭版 中文版（build 26200），WebView2 Runtime 152.0.4191.66 |
| 工具链 | go1.26.0 windows/amd64，Node v24.11.1，wails3（v3.0.0-beta.20） |
| 目标服务器 | **本机常驻真 nats-server `nats://127.0.0.1:4333`，JetStream 开启，监控 `:8333/jsz`**（用户指令：性能/压力实测必须打真服务器；全程存活，实测前后 `/jsz` 均正常应答、流数为 0 无残留） |
| 参考档位 | 本机 ≥ 高配档（8 核/16GB/NVMe/Win11），实测值按高配档判读；低配档由 CI `--cpus=2` bench job（Task 11）部分承接，双档复测留 M6 |

说明：本机 `-race` 因环境问题暂不可用（C 盘空间 + msys2 gcc 损坏，Task 5 台账在案，先于 M2 存在）；竞态覆盖由 CI Windows runner `-race` 承接（其首跑验证仍在遗留清单 §6-3）。

## 2. 自动化回归（全部实跑，2026-09-12 凌晨）

| 命令 | 结果 | 明细 |
|---|---|---|
| `go test ./... -count=1`（desktop 模块） | **全绿** | 7 包 / **125 个顶层测试 + 6 子测试，0 失败**。分包：messaging 74（68.9s，含真服务器场景与压力门槛）、connections 31（12.1s，内嵌服务器用例）、version 6、logging 6、settings 5、appdir 2、testutil 1 |
| `go vet ./...`（desktop 模块，含 cmd/flood） | **exit 0** | 无告警 |
| `npx vitest run`（frontend） | **全绿** | 14 文件 / **95 测试**，7.90s（M1 时 39 测试 → M2 新增 sessions/perf/pub/trace 等 56 个）。perf 文件单独复跑：10,000 条消息摄入 **136ms**（门槛 2s，Task 11 为 105–111ms，同量级） |
| `npm run build`（frontend） | **成功** | 主 chunk 522.47kB（gzip 166.88kB）+ **MessagesPage 已按页面 code-split（83.85kB / gzip 23.50kB，M1 遗留项落地）** + CSS 50.65kB（gzip 9.42kB）；构建 558ms。主 chunk 仍 >500kB，进一步拆分留 M3+（§6-4） |
| `wails3 build`（desktop） | **成功** | 产物 `desktop/bin/nats-desktop.exe`（bindings 重生属正常，Task 9 台账在案） |

关键门槛测试实跑数字（本次新鲜输出，非引用）：

| 门槛 | 实测 | 门槛要求 | 余量 |
|---|---:|---:|---:|
| `TestPipelineThroughputFloor`（ring+pusher 管线，1KB） | **14,149,334 msg/s**（250.9ms 采样 355 万条） | ≥ 50,000 msg/s（§12 洪峰 5 万/s 管线底线） | **283×** |
| `TestPipelineThroughputSanity` | 14,078,955 msg/s（10 万条 / 7.10ms） | 一致性交叉验证 | — |
| `TestSessionRealServerStress`（真服务器 4333，真实会话端到端） | **628,370 msg/s** 持续 10.0005s（收到 6,284,021 条 / 发布 6,305,949 条），守恒不变式全过 | ≥ 5,000 msg/s | **126×** |
| `TestSessionFloodSmoke`（会话洪峰守恒） | published=3000 received=3000 dropped=2000 buffer_used=1000, achieved=5000 msg/s（target 5000） | 精确守恒 | 精确相等 |
| `TestSessionFloodDropCountingLocalServer`（真服务器暂停注入中间洪峰） | wave1 14600/14600/13600/1000；wave2 暂停中 + 恢复后 10 条，final total=29310 dropped=28310 | 丢弃计数/暂停语义精确 | 精确相等 |

## 3. flood 注入器与实测（本次新增工具，全部实跑真服务器 4333）

工具：`desktop/cmd/flood/main.go`（`go build ./cmd/flood` 通过）。会话无关的核心 NATS 发布节流器：`nc.PublishMsg` 循环 + 令牌累加器节流（1ms 批量 tick，高速率下不依赖每条消息的定时器精度）+ 周期 Flush（250ms，防异步缓冲无界并约束尾部投递）；结束打印实际达到速率（发布数 / 墙钟）。`-c` 仅校验参数（rate ∈ [1,1e7]、size ∈ [1,8MB=服务器默认 max_payload]、dur>0、subject/url 非空），实测非法参数均以 exit 2 拒绝。定位：**测发布端+服务器腿**；会话/管线腿由 §2 的 Go 测试门槛覆盖。

| 轮次（1KB 载荷，subject 隔离） | 目标 | 实发布 | 达到速率 | 节流精度 |
|---|---:|---:|---:|---:|
| 冒烟 1s | 1,000 msg/s | 999 | 999 msg/s | 99.9% |
| AC-005 节拍 10s | 1,000 msg/s | 9,963 | 996 msg/s | 99.6% |
| 高配持续 10s | 5,000 msg/s | 49,805 | 4,980 msg/s | 99.6% |
| **AC-007 洪峰 10s** | **50,000 msg/s** | **499,650** | **49,963 msg/s** | **99.9%** |
| §12 持续窗口 60s | 5,000 msg/s | 299,680 | 4,995 msg/s | 99.9%（60s 无节流漂移） |

- 发布端+服务器腿判定：**各速率节流精度 99.6–99.9%，50k 洪峰 10s 全部送达，5k×60s 持续窗口无漂移 → MEASURED-PASS**。
- 会话腿（同一真服务器）：§2 压力门槛 628k msg/s 持续 + 洪峰守恒精确（发布=接收，丢弃=溢出，Total==Dropped+BufferUsed，seq 连续）→ **AUTOMATED-PASS**。
- 发布器历史口径补充：Task 4 真机洪峰（4,833/5,000 achieved，守恒精确）与 Task 11 压力（613,924–627,835 msg/s）与本轮数字同带，无回归。
- 服务器健康：全部洪峰后 `:8333/jsz` 正常应答，streams/messages 计数为 0（无流残留），API errors 计数无新增异常。

## 4. 体积 / 冷启动 / 内存（M1 同口径对比，全部实跑）

### 4.1 体积

- `bin/nats-desktop.exe` = **19,566,592 字节 ≈ 18.7 MiB** ≤ 30MB（§12）→ **PASS**（M1 基线 17.8 MiB，M2 新增会话/发布/trace 功能 +0.9 MiB）。便携 exe 口径；安装器打包 M6。

### 4.2 冷启动（5 轮，PowerShell Stopwatch 毫秒轮询，每轮杀进程树）

M2 Task 1 的应用级 ready 日志已落地（M1 遗留 §5-2 解决），本轮用双标记：

- **ready**：日志 `msg=ready`（settings/logger/窗口/tray/服务全部就绪、事件循环启动前——应用级显式标记）
- **frontend**：`[AssetFileServerFS] Handling request url=/`（WebView2 窗口已创建、前端开始加载——与 M1 口径可比）

| 轮次 | ready (ms) | frontend (ms) |
|---|---:|---:|
| 1 | 462 | 2,860 |
| 2 | 173 | 640 |
| 3 | 123 | 557 |
| 4 | 124 | 540 |
| 5 | 139 | 589 |
| **中位数** | **139** | **589** |

判定：高配档 ≤2s → **双口径均 PASS（余量 >3 倍）**。轮次 1 的 frontend 2,860ms 为**重建后首启**的离群值（新二进制首次执行，Defender 扫描 + WebView2 冷缓存）；§12 条件本身即"安装后首次**以外**启动"，轮次 2–5 稳定在 540–640ms。"到人工确认可交互"的渲染收尾差值仍留 PENDING-MANUAL（与 M1 相同）。

### 4.3 空载内存（启动后 60s，无连接空载，M1 方法）

主进程 + WebView2 子进程（`Win32_Process` CommandLine 含 `nats-desktop` 过滤，识别 6 个）逐 PID 求和：

| 进程 | WorkingSet | Private(提交) |
|---|---:|---:|
| nats-desktop.exe（主） | 46.1 MB | 59.1 MB |
| WebView2 ×6 | 385.0 MB | 179.4 MB |
| **合计** | **431.1 MB** | **238.4 MB** |

判定（与 M1 §3.3 完全同口径，诚实记录）：

- Private 提交求和 = **238.4MB ≤ 300MB → PASS**（M1：233.9MB，一致）
- WorkingSet 求和 = 431.1MB > 300MB → 沿用 M1 判定：WS 求和重复计入 Chromium 共享页，**口径统一（private working set）与 §12 双档复测留 M6**（M1 遗留 §5-1 维持）。
- 规格口径"典型负载（1 连接+1 会话+监控轮询）持续 30 分钟"需 GUI 在场 + 长时运行，**M2 无法无头执行 → PENDING-MANUAL/M6**（本轮为空载 60s 基线，与 M1 可比）。

## 5. AC 走查表（规格 §19 对照）

状态定义（沿用 M1）：AUTOMATED-PASS（引用测试，本机实跑通过）/ LIVE-PASS（本记录实测）/ MEASURED（数字+方法）/ PENDING-MANUAL（附操作路径，人工执行后回填）。

| 规格 AC | 走查项 | 状态 | 证据 / 操作路径 |
|---|---|---|---|
| AC-004 | req echo 往返 + 发布历史 | **AUTOMATED-PASS**（Go+前端自动化半边）+ PENDING-MANUAL（UI 视觉半边） | Go：`TestRequestEchoLocalServer`（真服务器 echo 往返）、`TestRequestNoRespondersLocalServer`、`TestRequestTimeoutLocalServer`、`TestServiceFullChainLocalServer`。前端：`messages-pub.test.tsx`（17 例：payload/headers/超时映射、"records each send in the in-memory history"、历史上限 20 条 newest-first、清空）。手动半边：Messages 页 → Request 表单填 echo 主题 + JSON payload → Send → **响应面板语法高亮 + 耗时显示 → 发布历史新增一条**。 |
| AC-005 | 1,000 msg/s 实时接收：逐条上屏 P95≤200ms、速率计≈1000 | **MEASURED**（发布端+服务器腿）+ AUTOMATED-PASS（会话腿）+ PENDING-MANUAL（UI 观察腿） | 发布端：flood 1k×10s 实测 996 msg/s（§3）。会话腿：`TestSessionRealtimeReceivesLocalServer`（逐条实时推送）、压力门槛 628k msg/s（§2）。UI 腿：**PENDING-MANUAL**——① 后台运行 `go run ./cmd/flood -rate 1000 -dur 60s -subject m2flood.ac5`；② Messages → Sessions 新建会话订阅 `m2flood.ac5`（实时模式）；③ 观察逐条上屏与速率计 ≈1000、累计递增；④ 上屏延迟抽样：录屏逐帧比对消息时间戳 vs 上屏时刻，P95 ≤200ms。 |
| AC-006 | 暂停/恢复/清空/批量切换语义 | **AUTOMATED-PASS**（双半边）+ PENDING-MANUAL（UI 视觉走查） | Go：`TestSessionPauseResumeSemanticsLocalServer`（暂停冻结/恢复不回补/清空重置，真服务器）、`TestSessionFloodDropCountingLocalServer`（洪峰中暂停）。前端：`messages-sessions.test.tsx` "pauses, resumes, clears and closes with immediate local feedback"、"refreshes rate/total/dropped from session:state and marks the paused state"。手动：AC-005 会话运行中 → 暂停（5s：列表不新增、速率归 0、计数冻结）→ 恢复（从最新继续）→ 清空（列表空、计数重置）→ 切批量（同批时间戳接近、状态条「批量」）→ 切回实时（状态条「实时」）。 |
| AC-007 | 50,000 msg/s 洪峰背压正确性 | **MEASURED**（发布端+服务器+管线三腿）+ AUTOMATED-PASS（会话洪峰腿）+ PENDING-MANUAL（UI 响应性腿） | 发布端：flood 50k×10s 达 **49,963 msg/s**、499,650 条全部送达（§3）。管线：14.15M msg/s（§2）。会话：`TestSessionFloodSmoke` 守恒精确（§2）。UI 腿：**PENDING-MANUAL**——① `go run ./cmd/flood -rate 50000 -dur 10s -size 1024`；② 会话订阅同主题；③ 注入期间界面可响应（无白屏/未响应）、丢弃角标 >0 且数值与缓冲规则一致（预期 ≈ 总量−缓冲上限）；④ 点暂停 → 推送立即停止；⑤ 注入结束后速率计归 0。另按 §12 做丢帧 <5% 判读（录屏/Performance 面板）。 |
| AC-029（会话半边） | 大消息与二进制：hex 预览 + 下载 | **AUTOMATED-PASS**（自动化半边）+ PENDING-MANUAL（2MB 实发视觉走查） | 前端：`messages-sessions.test.tsx` "shows binary rows as hex and offers the hex/text toggle plus a download"、详情对话框 headers 表 + JSON pretty-print 用例、10000 缓冲上限 + 虚拟窗口用例。Go：`TestSessionTypesJSONContract`（payload_b64 契约）、`TestPublishTooLargeLocalServer`（超大防护）。手动：`go run ./cmd/flood -rate 1 -size 2097152 -dur 1s`（或会话发 2MB 随机字节）→ 会话接收 → 详情：元数据 + 十六进制预览 + 下载入口，界面不卡顿。 |
| §12 冷启动 | ≤2s（高配） | **MEASURED-PASS** | §4.2：ready 139ms / frontend 589ms（中位）。 |
| §12 常驻内存 | ≤300MB | **MEASURED**（口径同 M1，最终判定 M6） | §4.3：Private 238.4MB PASS / WS 求和 431.1MB（共享页重复计入，M6 统一口径复测）。 |
| §12 持续吞吐 | 5,000 msg/s 丢帧 <5% | **MEASURED**（管线+会话+发布端三腿 PASS）+ PENDING-MANUAL（丢帧率） | 管线 14.1M、会话 628k 持续 10s、发布端 5k×60s 无漂移（§2/§3）。丢帧率需 GUI 在场 → 随 AC-007 走查录屏判读。 |
| §12 上屏延迟 | P95 ≤200ms | **PENDING-MANUAL** | 实时/批量分别抽样（随 AC-005/AC-006 走查）。 |
| §12 操作反馈 | ≤100ms | **PENDING-MANUAL** | M1 遗留通用项：会话页按钮（暂停/恢复/清空/建会话）点击到视觉反馈录屏判读。 |
| §6.3/§6.4 异常表 | 无响应者/超大/非法主题/断开禁用/JS 拒绝/断线重订阅 | **AUTOMATED-PASS** | Go：`TestRequestNoRespondersLocalServer`、`TestPublishTooLargeLocalServer`、`TestSessionInvalidSubject`、`TestServiceDisconnectedGating`、`TestSessionReconnectResubscribes`（按位重放，Task 5）；JS 错误映射：`pubreq_test.go` + 前端文案（Task 7/8）。 |
| §13 日志不记 payload/凭证 | — | **AUTOMATED-PASS**（M1 AC-030 同源机制 + M2 会话路径不落 payload） | 会话事件只经 Wails 事件通道进前端，不经文件日志；日志洁净测试 `logging_test.go`（M1 遗产）维持全绿。 |

## 6. M2 遗留清单（按任务 Minor 整理，移交 M3/M6；终审后补全版）

### 移交 M3（功能/前端细化，多为后续任务须知）

1. **Task 4**：断连时 `CreateSession` fail-closed 无法自动复活——前端须在 disconnected 时 gate 会话创建（已实现"未连接禁用"，复活路径仍缺）；批量+暂停边缘：批量缓冲内的暂停前消息 ≤100ms 后仍会推出（暂停语义文档已注明双文本）。
2. **Task 5**：`mode new` 走 JS 路径 + 空 mode 拒绝——前端表单需知晓；失败 resubscribe 双重 fireNow（收敛项）；`cctxNC` 死字段（JS 路径无 same-conn 跳过对应物，读者会寻找不存在的比较）。
3. **Task 6**：集群 hop 形态（mapping/service_import/stream_export）与 egress.Link 递归多节点未测——**M3 集群功能时补**；trace 超时部分结果路径（ErrTimeout 时返回部分树）未测；ingress-less 防御根为死路径（GetMsgTrace 已拒）。
4. **Task 7**：生成代码 `PushMode` 枚举含 `$zero=""`（前端勿发送）；`ListSessions` 生成 nullability 需 null guard。
5. **Task 8**：`Nats-Msg-Id` 头合并大小写敏感（`nats-msg-id` 手填行与 msgId 输入会产生两个 wire key）；feature 代码混合导入风格（`@/` vs 相对路径）；测试头残留 "(9.0 MB)" 陈旧注释；异步 seed effect 产生 act() 警告（不影响行为）。
6. **Task 9**：start_seq/时间非法输入目前靠服务端拒（可改前端禁用提升体验）；挂载前水合会话固定用 DEFAULT_BUFFER=10000（Go 持真实 cap，当前表单恒发 buffer_size=0 故无实害）；closed 会话消息保留策略未显式断言；未知 state 字符串回落 running/绿。
7. **Task 10**：开关默认态断言写法冗余（aria-checked ?? data-state 恒真——实际契约已另行硬断言，属测试卫生）；header 行/HopNode 用 index key（当前追加删除模式正确，重排场景需换）。
8. **Task 12**：同毫秒外部写入可能漏检（mtime 毫秒精度，已接受）；负 knownModTimeMs 走 fail-closed 检查（对 ">0" 契约的措辞偏差，安全方向）；编辑预填异步完成前保存会静默跳过检查（小窗口，可改阻塞保存直至预填完成）。
9. **Task 3**：超时映射依赖 error 串匹配（宜改 errors.Is）；失败的 JS 发布 `res.JetStream=true` 残留（装饰性）。
10. **Task 11**：前端 perf 载荷 6B vs Go 侧 1KB（口径统一后更有说服力）；bench 未挂 build needs、无 Go 模块缓存（CI 延迟优化）；应力测试 quiescent 快照与计数器读取间有理论 straggler 窗口。
11. **Task 2**：emit 并发顺序契约未写进 pusher doc（emit 可能并发调用，跨批顺序不保证——MsgOut.Seq 为重排序键，M3 消费方须知晓）；Stop 后尾批可能 emit（文档"Once Stop returns"措辞过强，下一句的正确指引为准）；NumGoroutine 泄漏检测模式随套件增长偏脆。
12. **Task 1**：设置中途开启 update_check 需 remount 才生效 mount 兜底；语言切换会重跑一次 mount 兜底（多一次静默检查）。
13. **主 chunk 522.47kB**：MessagesPage 已拆出，其余页面继续按需 code-split。

### 移交 M6（性能口径/发布/稳定性）

14. **内存口径统一**：以 private working set 求和口径按 §12 双档（高配/低配）复测，含"典型负载 30 分钟"条件（本轮与 M1 同为空载 60s 基线）；内存表 59.1+179.4=238.5 与合计 238.4 有舍入漂移（底层值舍入产物）。
15. **24 小时稳定性**（§12.1）：连续运行、内存增长 ≤10%、线程/连接/队列不泄漏——M2 无长时实测。
16. **安装器打包与体积**：NSIS/便携双包，30MB 口径在安装器上复核。
17. **低配档（2 核/4GB/HDD/禁 GPU）全项复测**：CI `--cpus=2` bench job 已部分承接（Task 11），真机双档走查留 M6。
18. **5k×60s 丢帧 <5% 判读**：Go 侧 4,995 msg/s 无漂移已测；UI 丢帧需录屏判读（§7 占位）。

### 环境注记（先于 M2 存在/本轮确认）

19. `-race` 本机不可用（C 盘空间 + msys2 gcc 损坏，Task 5 台账）→ CI 承接；**CI Windows runner `-race` 首跑验证仍未完成**（M1 Task 13 遗留）。
20. `TestAuthFailureGoesFailedNoRetryLoop` 在 Windows 有预存在 flake（wsarecv reset 竞态，Task 1 台账，待清理任务）——本轮实跑未触发（connections 31 例全绿）。
21. 主 chunk 超 500kB 警告阈值但构建未报警（rolldown-vite 行为差异）；以 §6-13 的 code-split 路线消化。

## 7. 控制器冒烟待补（占位，M1 惯例）

控制器将于本任务后执行真服务器 GUI 冒烟（参照 M1：computer-use + `nats://127.0.0.1:4333`），覆盖 AC-004/005/006/007/029 的 UI 腿与 §6 PENDING-MANUAL 项。结果回填下表：

| 冒烟项 | 结果 | 日期 | 备注 |
|---|---|---|---|
| AC-004 req echo 响应面板 + 历史 | 待执行 | | |
| AC-005 1k 实时上屏/速率计/延迟抽样 | 待执行 | | |
| AC-006 暂停/恢复/清空/批量切换 | 待执行 | | |
| AC-007 50k 洪峰 UI 响应性/丢弃角标 | 待执行 | | |
| AC-029 2MB 二进制 hex 预览 + 下载 | 待执行 | | |
| 5k×60s 丢帧 <5% 判读（录屏） | 待执行 | | |

## 8. 回填区（人工走查后填写，与 M1 §6 同构）

| 走查项 | 结果 | 执行人/日期 | 备注 |
|---|---|---|---|
| AC-004 UI 响应面板 | 待执行 | | |
| AC-005 UI 上屏延迟 P95 | 待执行 | | |
| AC-006 UI 三动作+模式切换 | 待执行 | | |
| AC-007 UI 洪峰响应性 | 待执行 | | |
| AC-029 UI 2MB hex/下载 | 待执行 | | |
| §12 丢帧率（5k×60s） | 待执行 | | |
| §12 操作反馈 ≤100ms | 待执行 | | |
| 冷启动"人工确认可交互" | 待执行 | | |
