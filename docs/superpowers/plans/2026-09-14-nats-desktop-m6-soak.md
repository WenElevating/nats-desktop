# M6 24h 长稳挂机（AC-025）——soak 脚本说明、跑法与收数报告

- 任务：M6 Task 7；分支 `desktop/m6`；harness `desktop/scripts/soak.ps1`（新增）。
- 应用二进制：`desktop/bin/nats-desktop.exe`（VERSION=1.0.0 production 构建，含全部 M6 修复，含 Task 8 实时推送合并）；注入器 `desktop/bin/flood.exe`（脚本每次运行先 `go build -o bin\flood.exe .\cmd\flood` 重建）。
- 目标服务器：本机常驻真 nats-server `nats://127.0.0.1:4333`（JetStream 开启，无系统账户；监控为 §8.3.1 降级面），载有 Task 6 压力数据集（10,002 流 / 1M×256B 消息 / 100k KV 键，**收数期间不得清理**）。
- 执行环境：物理桌面锁屏状态可用（M3–M5 既证 UIA 链路锁屏可驱动）；挂机期间不接受其他重负载（brief G8）。

## 0. 服务器基线注记（判读前必读）

**4333 服务器进程自身空载即 ~1.16GB private**——这是 Task 6 数据集的常驻成本（10k 流元数据 + 1M 消息 + 100k KV，见 m6-perf.md §6.0）。**长稳判定只看应用进程树**（`perf-sample.ps1` 口径：`nats-desktop.exe` 主进程 + 其全部 WebView2 子进程逐 PID `PrivateMemorySize64` 求和），与服务器进程无关。两套数字勿混。

另：绝对 300MB 常驻内存门禁已在 m6-perf.md §7 判 FAIL（Task 8 复测后稳态 ~1.3GB 量级，V8/PartitionAlloc 已提交页不归还 OS；批量模式杠杆 -52% 在案）。**本挂机的内存判据是 §12.1 增长率口径：1h 点 vs 末点 private 增长 ≤10%（应用树）**，非绝对门禁。

## 1. 24h 完整跑法（精确命令）

前置检查（一次性）：

1. `desktop/bin/nats-desktop.exe` 在位（本次 M6 构建）。
2. 4333 存活：`netstat -ano | findstr :4333`（LISTENING 在案）；数据集在位（流页可见 `LOAD_S%05d`）。
3. `%APPDATA%\nats-desktop\settings.json`：`last_active_context` = `local-test`（启动即自动重连 4333）；`behavior.session_push_batching` = `false`（§12 典型负载 = 实时推送会话）。
4. 无其他 `nats-desktop.exe` / `flood.exe` 实例（脚本 preflight 会杀残留实例并留痕，但最好人工保证）。
5. **电源计划 = 从不睡眠**（挂机期间系统不得睡眠/休眠，否则 UIA 链路与采样全部冻结，跑不满 24h）。

启动（挂机 24h，命令窗保持开着；锁屏无碍）：

```powershell
cd D:\GithubProject\nats-desktop\desktop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\soak.ps1
```

默认参数即 24h 档：`-Hours 24 -Subject soak.load -Rate 1000 -Size 1024 -NavIntervalSec 60`。可选 `-OutDir <dir>` 指定输出目录（默认 `desktop\bin\soak-<启动时刻>\`）。

启动后约 1 分钟内应看到日志序列：`UIA tree active` → `SESSION-CREATED chip='soak.load'` → `nav loop: every 60s ...`。**若出现 `FATAL harness error` / 退出码 2，是环境问题（窗口/UIA/连接），不是数据**：按 soak.log 修正后重跑（flood/app/采样器会被清理，无残留）。

## 2. 脚本行为清单（编排内容）

| 步 | 行为 | 实现 |
|---|---|---|
| 0 | preflight：app exe 在位、4333 可连、杀残留实例、WER 基线、读取界面语言（zh-CN/en 两套 UIA 定位表） | `settings.json` `appearance.language` |
| 1 | 重建 flood | `go build -o bin\flood.exe .\cmd\flood` |
| 2 | 启动采样器（独立 PowerShell 进程） | `perf-sample.ps1 -ProcName nats-desktop -IntervalSec 60`，CSV 列 `timestamp,private_mb,ws_mb,cpu_s,handles,threads` |
| 3 | 启动 flood | `-url nats://127.0.0.1:4333 -subject soak.load -rate 1000 -size 1024 -dur 1440m`，`AboveNormal` 优先级（hold 1k msg/s 目标），stdout/stderr 落盘 |
| 4 | 启动应用 | 自动恢复 `local-test`@4333（连接成立的隐含证明：会话创建按钮以 `connected` 为门禁） |
| 5 | UIA 创建 1 条实时订阅会话（M5 冒烟同款定位） | 侧栏「消息」→ 页签「订阅会话」→ `AutomationId=session-subject` 填 `soak.load` →「订阅」→ 会话 chip（名为 subject 的元素）可见即成功；失败=环境故障，退出码 2 |
| 6 | 导航循环 | 每 60s UIA Invoke 依次点击 8 个侧栏导航钮（总览→消息→流→消费者→键值存储→对象存储→监控→设置），每轮重试窗口 30s（Chromium a11y 树在两次 UIA 客户端之间会自然去激活，轮询即重新激活，M5 法）；单轮 MISS 只记日志不清场（UIA 抖动不允许杀死 24h 挂机） |
| 7 | 崩溃检测 | 主循环每 2s `Get-Process` 探活；应用进程消失 → 停 flood、**保留 CSV**、写 `CRASH.txt`（检测时刻 + 末采样行 + WER 增量）、退出码 3。崩溃是数据，不是执行失败 |
| 8 | 结束收尾（到期） | 截止前 40s 读会话证据 t0（flood 仍在发，速率读数非零）→ 停 flood → 优雅关闭应用（`CloseMainWindow`，8s 后强制）→ 等采样器自退（应用进程消失即自停，宽限 90s）→ 写 `verdict.txt` |

## 3. 判定三件套（verdict.txt 判读标准，AC-025 / §12.1）

| # | 判据 | 口径 | 判定 |
|---|---|---|---|
| 1 | 无崩溃 | 应用进程全程存活（正常收尾）+ 运行期 WER `ReportArchive`/`ReportQueue` 无新增 nats-desktop 报告 | PASS / FAIL |
| 2 | 内存增长 ≤10% | **1h 点 vs 末点** private（应用树求和）；`<1h` 的验证跑自动降级为「中位点仅供参考」注记 | ≤10% PASS |
| 3 | 句柄/线程平稳 | 首末对比 + 全程线性回归斜率（/h）+ **ref 点（1h 采样）vs 末点**对比（首采样点含 WebView2 子进程孵化期的爬坡，判读以 ref 点为准）；ref 相对变化 ≤20% 记 STABLE | 斜率≈0 / 目测平稳 |

第 [5] 项会话管线证据（flood 停止前后两次 UIA 读会话计数）：计数增长 = Go 侧会话管线全程存活（导航轮换离开消息页期间会话不中断）。

T7 review 守卫（verdict.txt 新增行，收数必读）：`flood ran full duration: yes/no`——no = 注入器提前退出（flood 用 `nats.NoReconnect`，4333 抖动即自杀退出），此时负载相关的判读（[5] 计数、保留/丢弃数）口径失效，按 soak.log 首检 WARN 时刻复核；`nav_misses_total` = 全程导航 MISS 累计（区别于末轮连续 MISS）；末采样距今 >3× 采样间隔时在 [2][3][4] 前附 `csv-freshness` 注记（采样器疑似停摆，末态数字保守判读）。

## 4. 输出文件布局（`desktop\bin\soak-<yyyyMMdd-HHmmss>\`）

| 文件 | 内容 |
|---|---|
| `samples.csv` | 采样序列（60s 一行，全程；崩溃时保留到崩溃点） |
| `verdict.txt` | 判定三件套 + 会话证据 + flood 尾行（§3） |
| `soak.log` | 全程编排日志（含每轮导航结果、MISS 计数） |
| `flood.out.log` / `flood.err.log` | 注入器 stdout/stderr（配置行 + 发布总数与达成率） |
| `sampler.out.log` | 采样器 stdout（结束时的 samples 路径行） |
| `applog-tail.log` | 应用日志末 200 行（G9 口径：仅聚合计数，无载荷无凭据） |
| `CRASH.txt` | 仅崩溃时：检测时刻、末采样、WER 增量 |
| `app.pid` / `flood.pid` / `sampler.pid` | 中断后人工清理用 |

## 5. 验证跑记录（harness 有效性，非 24h 判定）

harness 用缩时档验证了全部编排路径：`-Hours 0.1`（≈6min）与 `-Hours 0.5`（30min）。验证跑的内存/句柄数字**只证明脚本正确**（1h 判据在 <1h 跑中自动注记为仅供参考），24h 判定以 §6 回填为准。

### 5.1 六分钟档（-Hours 0.1，2026-09-14 20:54:59–21:02:13，OutDir `desktop/bin/soak-20260914-205459`）

- 启动→会话创建 11.6s（`SESSION-CREATED chip='soak.load'`）；5 轮导航全部命中（0 MISS）。
- flood：999 msg/s（99.9% 达成）；会话侧证据 t0（截止前）`976 msg/s 共 315260 条` → t1 `共 352148 条`：**计数增长 +36,888 = 管线存活**；保留恰 10,000（cap）丢弃计数精确。
- 内存：首点 262.2MB → 末点 1,437MB（与 Task 8 稳态 ~1.3GB 同量级，爬坡属正常加载）；中位点 1,167MB（仅供参考注记）。
- 句柄/线程：ref 点 vs 末点 3,878→3,899（+0.54%）/ 159→170（+6.92%）——首采样爬坡偏差被 ref 点口径消除。
- 崩溃判据 PASS（WER 0）；退出码 0；清理完整。

### 5.2 三十分钟档（-Hours 0.5，2026-09-14 21:02:42–21:33:15，OutDir `desktop/bin/soak-20260914-210241`）

- 29 轮导航全部命中（0 MISS；8 页 × 3.6 圈全覆盖，含监控/设置页）。
- flood：1,798,277 条 @999 msg/s（99.9%）；会话收 1,792,723 条（会话创建晚于注入起点 ~8s），**保留恰 10,000**（丢弃 = 总量−10,000 整）；证据计数 t0→t1 `1,755,135 → 1,792,723`（+37,588）= **管线存活**。
- 内存（30 采样）：首采样 82.1MB（WebView2 孵化前的主进程，爬坡偏差口径）→ ~4min 进入 **~1.5GB 稳态锯齿（1.40–1.69GB，GC 周期）**；15min 点 1,517.7MB → 末点 1,656.9MB（+9.17%，中位点口径仅供参考注记）。锯齿无单调上行趋势，与 Task 8 稳态 ~1.3GB（同负载、无导航轮换）同量级（导航轮换含 10k 流页反复挂载取数，属更高应力剖面）。
- 句柄/线程：爬坡后全程 3,886–3,930 / 159–174 平稳；**ref 点 vs 末点 -0.13% / -0.62%**（斜率口径 917 /h 与 20 /h 均被爬坡段主导，判读以 ref 点为准）。
- 崩溃判据 PASS（WER 0）；退出码 0；清理完整。

**两条验证跑结论**：harness 的启动、UIA 会话腿、导航循环、采样、flood 起停、崩溃路径（迭代 3 前的两次失败即环境故障路径，退出码 2、清理完整）、判定输出全部按设计工作；24h 判据（1h 点 vs 末点 ≤10%）在 <1h 跑中自动注记为仅供参考，待 §6 回填。

## 6. 24h 收数判定（跑完后回填本节）

（PENDING：24h 挂机完成后回填）

- 五点表（首 / 1h / 6h / 12h / 24h，private / handles / threads）：
- 三件套判定（§3 表逐项）：
- 异常事件（若有：时间点 + soak.log / applog-tail 摘录）：
- 会话证据（verdict.txt [5] 原文）：
- flood 达成率（flood.out.log 尾行）：

## 7. 已知偏差与注意事项（24h 操作员必读）

1. **锁屏可见性偏差（§S2 沿袭，m6-perf.md 已登记）**：锁屏下 `document.visibilityState=hidden`，监控轮询被 `useMonitor` 生命周期门禁暂停——§12 典型负载的第三成分（监控轮询）退化为「每轮导航到监控页 + 首次取数」。方向保守（负载偏低）；解锁补全路径见 m6-perf.md §S2。
2. **UIA 导航 MISS 容忍**：单轮 30s 重试窗口内找不到导航钮只记日志（`nav cycle N: MISS`），不终止挂机；连续 MISS 需在收数时人工判读（应用假死会以 2s 级进程探活 + WER 为准，UIA 失联≠崩溃）。
3. **flood 达成率环境敏感**：flood 的令牌节流器在 tick 丢失时不补偿（ticker 无缓冲），此前未提优先级的验证跑曾录得 878 msg/s（87.8%）；提 `AboveNormal` 后 99.9%。24h 跑以 flood.out.log 尾行为准，达成率显著低于目标时在收数报告注记。
4. **导航轮换每 60s 经过的页面有重负载页**（流页 10k 数据集每次挂载真实取数，~0.6–1.2s 首帧）——这是有意压力，勿误判为异常尖峰；采样 CSV 中 CPU 列的周期性抬升与之对应。
5. **勿在挂机机上手工启动第二个应用实例**（perf-sample 按 exe 名匹配进程树，双实例会污染采样）；同理勿手工清理 4333 数据集。
6. **绝对内存门禁 FAIL 已裁定**（§0）：verdict.txt [2] 的 PASS/FAIL 只对 §12.1 增长率判据负责；稳态 ~1.3GB 的绝对值不构成新的 FAIL。
7. 退出码语义：0=正常收尾（verdict.txt 已写）；3=应用崩溃（CRASH.txt 已写、CSV 保留，**属于收数数据**）；2=环境/编排故障（清理完整，修正后重跑即可）。


## §8 实跑回填（2026-09-14 22:11 → 09-15 15:42，17.5h 处崩溃）

- **判定：AC-025 FAIL（三层缺陷链）**
  1. **日志冻结**：应用文件日志 23:08（开跑 57min）后静默冻结（165KB，远未轮转；此后 16h 零写入，期间 Dashboard 每 8min 挂载本应产生 sys watch INFO）——§13 可诊断性契约破坏，疑 logger 路径死锁/写入 goroutine 消失。
  2. **线性内存增长**：进程树 private 157MB → 16,018MB（~870MB/h，无平台期；线程 2h 后走平、句柄爬升后走平——非句柄泄漏）。
  3. **崩溃序列**：15:31 一个 WebView2 子进程死亡（private 骤降 1.4GB/句柄 -457/线程 -34）→ UI 失效（15:35-15:41 连续 7 次 UIA MISS）→ 15:42 宿主进程消失，**无 WER**（提交耗尽下 runtime 致命退出特征；windowsgui 下 stderr 不可见）。
- **五点表**（private MB）：22:11=157 / 23:11≈1,288 / 09:40=10,391 / 15:30=15,426 / 15:41=16,018（终）。
- **三件套**：崩溃=是（17.5h，无 WER）；内存增长=FAIL（1h 点 ≈1,288 → 末点 16,018，≫10%）；句柄/线程=走平（非泄漏项）。
- **会话证据**：733k+ 条流经会话管线后计数持续增长（nav 循环照常工作至 15:30）。
- **flood 达成率**：99.8-99.9%（AboveNormal 提权后），存活至 harness 清理。
- **产物**：samples.csv 1,027+ 行、soak.log 全程、flood.out.log、CRASH.txt（exit 3 路径真实触发）。
- **遗留调查项（v1.1 方向）**：①logger 冻结根因（logger 包死锁分析）；②实时推送内存增长根因（渲染器堆 vs 引用滞留；T8 合流修复只消除渲染病态未止增长；批量模式 654MB/30min 稳定的对照数据在案）；③静默退出与 M4 缺陷#4 同族归因（无 WER 特征一致）。


## §9 崩溃根因分析（2026-09-16 补充取证）

**实锤归属：Windows 资源耗尽诊断（System 事件 2004，15:09-15:38 共 6 条）指认囤积者是 Go 主进程**——`nats-desktop.exe (49924) 使用了 14.3GB 虚拟内存`（同窗口渲染器仅 1.5GB、nats-server 1.0GB）。15:31-15:32 多个无关进程同时 OOM 崩溃（OSDtPDetect System.OutOfMemory / MoUsoCoreWorker APPCRASH）= 系统提交耗尽的旁证；15:31 渲染器子进程之死是受害者非元凶；15:42 宿主静默退出符合 Go runtime 提交分配失败的 fatal 特征（windowsgui 下 stderr 不可见 → 无 WER）。

**根因（高置信，结构性）：wails v3 beta.20 事件管线无界队列**。Go→JS 全部事件经 `internal/mailbox.Mailbox` 投递（每 WebSocket 客户端一个），其源码注释自认 "The queue is unbounded"——`Send()` 无限 append、不阻塞、不丢弃、无背压。realtime 模式逐条 emit（1k msg/s）持续快于消费速率（drain 逐条 WS 写+前端处理）时，宿主进程 pending 队列单调增长：实测 14GB / 63M 条 ≈ 224B/条净滞留，与斜率 870MB/h 精确吻合。

**修复方向（应用侧，比依赖上游更可控）**：realtime 模式 Go 侧加时间窗合流（≤100ms 或 ≤N 条聚合单次 emit，复用既有 batch 聚合器）——§6.4 语义不变（全量有序、延迟 ≤100ms 远低于 200ms P95 门），emit 速率 1k/s → ≤10/s，结构性消除积压。建议同时向上游反馈 wails mailbox 无背压问题。

## §10 崩溃根因结论 + 日志冻结（2026-09-16 补充）

- §9 根因经 A/B 实验完整证实（见 m6-perf §10/§10.1）：泄漏 A=宿主侧无界事件邮箱（已修 4784e27）；泄漏 B=渲染器内联 eval 拼接churn（已修 5988d7b，realtime 传输统一 100ms/500 走暂存路径，验证尾段斜率 633-970→166 MB/h @2k/s）。
- **日志冻结（57min）为独立缺陷**：logging 包静态排查无显式死锁（rotatingWriter 互斥单层、无嵌套获取）；候选=外部删除文件致 fd 孤儿（mtime 冻结特征吻合）或写入方停摆。需专项复现探针（长跑 + 定期 prog-check 点），列 v1.1 与渲染器堆分析并列首项。§13 可诊断性在冻结窗口内失效的风险照录。
