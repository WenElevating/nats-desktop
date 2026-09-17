# M6 性能双档实测与内存口径统一（AC-023/024）——实测数据表

- 任务：M6 Task 5（2026-09-14 13:26–15:00 执行）；分支 `desktop/m6`；应用二进制 `desktop/bin/nats-desktop.exe`（VERSION=1.0.0，production 构建，含 Task 5 GPU 注入点，构建命令 `wails3 task windows:build VERSION=1.0.0`）。
- 目标服务器：本机常驻真 nats-server `nats://127.0.0.1:4333`（PID 23016，JetStream 开启，无系统账户——监控为 §8.3.1 降级面）；全程存活（实测前后 4333 LISTENING 在案）。
- 执行环境注记：物理桌面处于锁屏状态。锁屏下 UIA 读写、进程/日志观测、flood 注入均正常；**WebView2 `document.visibilityState === "hidden"`**，由此产生两处已登记偏差（§S2 监控轮询门禁、§1.6/§S3 视觉腿）。
- 本文所有数字均来自本次实跑；命令与原始 CSV 路径逐项照录（CSV 为 PowerShell 运行时产物，表内数字为准）。

## 0. 工具与口径（单一事实源）

### 0.1 采样器 `desktop/scripts/perf-sample.ps1`（新增，Task 6/7 复用）

CSV 列：`timestamp,private_mb,ws_mb,cpu_s,handles,threads`；**private 口径 = 主进程 + 全部 WebView2 子进程逐 PID `PrivateMemorySize64` 求和**（M2 §4.3 既定口径）。

子进程匹配规则（**实现时实证**，2026-09-14，VERSION=1.0.0 构建）：全部 `msedgewebview2.exe` 子进程的 `CommandLine` 含 `--user-data-dir=%APPDATA%\nats-desktop.exe\EBWebView` 与 `--webview-exe-name=nats-desktop.exe --webview-exe-version=1.0.0`，对 `nats-desktop` 的正则匹配捕获 **6 个**子进程（browser 主、crashpad-handler、gpu-process、network utility、storage utility、renderer）；同机 **26 个**其它应用的 `msedgewebview2.exe`（如 cc-switch.exe，user-data-dir `%APPDATA%\com.ccswitch.desktop`）**均不匹配**——规则选择精确。

注：CSV 中 `private_mb/ws_mb` 的千位逗号是 PowerShell `N1` 格式化产物（如 `1,550.9` = 1550.9MB），判读时注意；本文表内均已还原为纯数字。

### 0.2 GPU 注入点（新增）

`desktop/main.go`（opts 构造后、`application.New` 前）：`NATSDESKTOP_DISABLE_GPU=1` 时 `opts.Windows.AdditionalBrowserArgs` 追加 `--disable-gpu`（wails v3.0.0-beta.20 的 `application.Options.Windows.WindowsOptions.AdditionalBrowserArgs []string`，Windows 平台专用字段）。仅 `scripts/perf-lowspec.ps1` 设置该 env。

## 1. 高配档（本机原生，§19.2 高配列）

### 1.1 冷启动 ≤2s —— **MEASURED-PASS**

方法：M2 §4.2 同法（PowerShell Stopwatch 启动进程 + 毫秒轮询日志 `%APPDATA%\nats-desktop\logs\nats-desktop.log`，每轮杀进程树，5 轮取中位）。双标记（照录）：

- **ready**：日志 `msg=ready`（应用级显式标记）
- **frontend**：日志 `Handling request" url=/ `（本轮实测确认当前 wails beta.20 的 slog 文本格式为 `msg="[AssetFileServerFS] Handling request" url=/`——URL 是独立 slog 键，与 M2 记录的连写格式 `Handling request url=/` 不同，轮询正则相应修正；语义同 M2：WebView2 已创建、前端开始加载）

命令：`powershell -File %TEMP%\coldstart-measure.ps1 -Rounds 5 -Tag high`（Stopwatch 起 `Start-Process bin\nats-desktop.exe -PassThru`，5ms 轮询日志增量；CSV `%TEMP%\coldstart-high.csv`）。

| 轮次 | ready (ms) | frontend (ms) |
|---|---:|---:|
| 1 | 211 | 704 |
| 2 | 155 | 587 |
| 3 | 155 | 650 |
| 4 | 153 | 614 |
| 5 | 156 | 618 |
| **中位数** | **155** | **618** |

判定：ready 155ms / frontend 618ms ≤ 2s → **PASS（余量 >3 倍）**；与 M1/M2 基线（139ms/589ms）同口径可比（+16ms/+29ms，VERSION 构建 + M3–M5 功能增量，同量级）。

### 1.2 常驻内存 ≤300MB —— 空载双点 PASS / 典型负载 FAIL（§1.5）

**点 1：空载 60s（无连接，M1/M2 同口径）—— PASS**

方法：临时将 `%APPDATA%\nats-desktop\settings.json` 的 `last_active_context` 置空（杜绝启动自动恢复连接；测后原样恢复并校验 `"last_active_context": "local-test"` 回读一致）；启动后 `desktop/scripts/perf-sample.ps1 -IntervalSec 15 -DurationMin 1`。命令：`powershell -File %TEMP%\idle60-run.ps1`；CSV `%TEMP%\perf-idle60-high.csv`。

| t (s) | private_mb | ws_mb | handles | threads |
|---|---:|---:|---:|---:|
| 0 | 245.2 | 425.9 | 3618 | 155 |
| 16 | 231.7 | 413.8 | 3617 | 156 |
| 32 | 231.5 | 422.7 | 3721 | 171 |
| 49 | 231.4 | 422.7 | 3721 | 171 |
| 65 | 243.1 | 436.2 | 3715 | 163 |

稳态 private ≈ **231.4–245.2MB** ≤ 300MB → **PASS**（M2 基线 238.4MB，口径一致）。

**点 1b（补充）：空载+已连接（新实例自动恢复 local-test@4333 后）**：private 合计 266.9MB（主 63.4 + browser 37.2 + crashpad 3.9 + gpu 100.8 + utility×2 22.3 + renderer 39.3）——仍 ≤300MB，但连接本身带来 +35MB（renderer/GPU）。

**点 2：典型负载 30min —— FAIL（实测数字见 §1.5；偏差：监控轮询被锁屏 visibility 门禁暂停，见 §S2）**

### 1.3 频繁连接/断开 100 次（§20.3-3）—— **AUTOMATED-PASS（Go 腿）**

新增 `desktop/internal/connections/switch_stress_test.go`（`TestSwitchStress100Cycles`）：`testutil.StartSysServer` 进程内夹具 + 临时目录 contexts 注册表（`natscontext.NewRegistry(NewFileBackendAt(t.TempDir()))`，不动真实用户 settings），两上下文 `switch-a`/`switch-b`（app 凭据），循环 100 次 `Connect(A)`→等 connected→`Connect(B)`→等 connected；goroutine 基线取「首连建立后」（使 <10 断言度量**每轮泄漏**而非末态单连接的常驻 goroutine 面——客户端 read/flush + 服务器侧 conn handler 都计入 `runtime.NumGoroutine`），结束后静置 2s 再测；总预算 9min（测试上限 10min，§20.3-3）。

命令：`cd desktop && go test ./internal/connections/ -run TestSwitchStress -count=1 -timeout 12m`

结果：**100 轮 4.44s，goroutine base=33 final=33（差 0 < 10）**；末态 `Manager Snapshot` = connected/switch-b；无 panic（panic 即测试失败）→ **PASS**。整包回归：`go test ./internal/connections/ -count=1` 16.9s 全绿（含本测试）。UIA 侧 100 次切换单列为手测矩阵行（可 WAIVED 引用本 Go 腿）。

### 1.4 吞吐与守恒汇总（注入器腿）

| 腿 | 目标 | flood 发布 | 会话接收 | 守恒 | 速率达成 |
|---|---|---:|---:|---|---:|
| 高配 典型负载 1k×30min（实时） | 1,000 msg/s | 1,797,032 | 1,797,032 | **1:1 精确** | 998 msg/s（99.8%） |
| 高配 5k 持续腿（实时，§20.3-2） | 5,000 msg/s | —（保护性中止，见下） | 2,312,790（中止读数） | 丢帧计数=总量−10,000 整 | 均值 4,973 msg/s（99.5%） |
| 高配 批量模式探针 1k×3min（批量） | 1,000 msg/s | 179,502 | 179,502 | **1:1 精确** | 997 msg/s（99.7%） |
| 低配模拟 1k×60s（实时） | 1,000 msg/s | 59,909 | 59,909 | **1:1 精确** | 995–998 msg/s（99.5–99.8%） |

会话「已丢弃」计数在全部腿中恒等于 `总量 − 缓冲上限 10,000`（§6.4 环形缓冲按设计丢最旧并精确计数；非接收丢帧）。UI 状态条速率读数（UIA）与发布端速率一致（4,965 msg/s 读数 @5k 腿、944 msg/s @1k 腿）。

### 1.5 常驻内存典型负载（§12 条件「典型负载持续 30 分钟」）—— **FAIL（本节为 M6 核心发现）**

**腿 A：典型负载 30min（高配）**

- 条件实测组合：1 活跃连接（local-test@4333）+ 1 实时订阅会话 @1k msg/s + Dashboard 挂载；**监控轮询未启动**（§S2 偏差——锁屏 `visibilityState=hidden` 使 `useMonitor` 的 Start 门禁不满足；该偏差使内存读数**偏低**，即实际典型负载只会更高）。
- 命令：`go run ./cmd/flood -url nats://127.0.0.1:4333 -subject m6perf.load -rate 1000 -size 1024 -dur 30m` + `perf-sample.ps1 -IntervalSec 60 -DurationMin 31`；CSV `%TEMP%\perf-typical30-high.csv`。
- 结果（private 求和，30 个采样）：**1,376–1,551MB 区间锯齿稳态**（GC 周期回落再增长，无单调泄漏趋势：renderer 1,255.7 → 1,195.5 → 1,155.8MB 逐 5min 读数缓降）；进程分解显示增量几乎全部在 **renderer 子进程（1,14x–1,26xMB）**，主进程稳定 96.4MB、GPU 78–103MB。
- 载荷停止后：private 停在 1,374MB 不回落（90s 观察）；会话「清空」（AC-006 语义，列表+计数重置）后 renderer 仍 1,113–1,139MB——**V8 已提交堆不归还 OS，直至进程重启**。
- 判定：**FAIL**——典型负载 private ≈1.4GB，为 300MB 门禁的 ~4.6 倍。空载双点 PASS 与负载 FAIL 并存，说明门禁 breaches 由**实时逐条推送的前端渲染管线**（1k msg/s `session:msgs` 事件过桥 + 渲染）驱动，非连接/框架基线问题。

**腿 B：5,000 msg/s × 10min 持续腿（§20.3-2，高配条件）—— 保护性提前中止（如实记录）**

- 命令：`go run ./cmd/flood -url nats://127.0.0.1:4333 -subject m6perf.load -rate 5000 -size 1024 -dur 10m` + `perf-sample.ps1 -IntervalSec 30 -DurationMin 11`；CSV `%TEMP%\perf-flood5k-high.csv`。
- 实际执行：有效发布 ~465s（≈7m45s，会话侧均值 **4,973 msg/s ≈ 99.5% 目标**；UIA 速率读数 4,965），中止时会话已收 **2,312,790** 条、丢帧计数 = 总量−10,000 整。
- 内存：锯齿上行 2.0→7.0GB（GC 回落再增长），**峰值 private 6,965MB**；主机 commit 压力 37.5/40.3GB、物理内存空闲 0.3GB——**为保护宿主机与常驻 4333 服务器提前中止**（继续跑满 10min 有 commit 耗尽波及无关进程的风险）。中止后 renderer 私有内存 4,455→3,701MB 缓慢回落（GC 逐代回收）。
- 判定：速率达成 + 会话层零丢失 + 丢帧计数精确；**内存面灾难性超标（≥7.0GB vs 300MB，>23 倍）**。视觉丢帧 <5% 判读仍 PENDING-MANUAL（§S3）。

**腿 C：批量推送缓解探针（1k×3min，非门禁，供 Task 11/规格反馈）**

- 新建批量模式会话（UIA 切换创建表单 推送方式=批量），同法 flood 1k×3min；CSV `%TEMP%\perf-batch1k-high.csv`。
- 结果：private 266.7（基线）→ 峰值 **653.8MB** → 停止后 573.7MB（renderer 312.5MB 缓降）；守恒 1:1 精确。
- 对比：同速率下批量推送峰值 ≈ 实时推送的 **1/2.1**（653.8 vs ~1,432 中位）——`session_push_batching` 设置是现成的缓解杠杆，但仍高于 300MB 门禁，不能单独作为整改闭环。

**内存门禁汇总**：空载（无连接/已连接）两档均 PASS；典型负载条件高配 FAIL（~1.4GB）、低配模拟 FAIL（741.5MB 峰值，§2.3）；缓解杠杆在案（批量模式 -52%）。→ **AC-023 内存项判 FAIL，随 Task 11 汇入规格反馈。**

### 1.6 列表加载 / 滚动 / 反馈 / 上屏 P95

- **列表加载 500 streams ≤500ms**：**Task 6 已回填，见 §6.2（Go 前 500 取数 34–37ms）与 §6.4（UIA 全 10k 列表首帧 894–1,166ms，虚拟化渲染）——两档门禁 PASS**。自动化近似参考（本轮 vitest bench 复跑，§1.7）：10k 行列表冷挂载 mean 15.9ms、排序切换 mean 9.9ms（React 提交层），与 500ms 门禁之间有充足余量。
- **滚动 ≥60fps**：PENDING-MANUAL（§S3-1）。
- **操作视觉反馈 ≤100ms**：UIA 自动近似腿——`暂停` 按钮 Invoke → UIA 树出现 `已暂停` 文本 **80ms**（Stopwatch + 2ms 轮询 + UIA COM 往返，读数为**上限估计**）→ 与 ≤100ms 一致的间接证据；视觉面（帧级）PENDING-MANUAL（§S3-2）。
- **上屏 P95 ≤200ms（实时与批量分别验证，§12 原文）**：帧级到达时刻需要录屏/DevTools，锁屏不可用 → **两种模式均 PENDING-MANUAL**（§S3-3）。自动化等价证据：①会话层守恒 1:1（消息无损到达 Go 会话层，§1.4）；②UIA 状态条速率与发布端一致（实时链路活的）；③批量模式同批时间戳语义有前端测试钉住（M2 AC-006）。登记为「单模式近似 + 另一模式同样 PENDING」的诚实口径（brief F27 允许的兜底）。

### 1.7 前端 bench 复跑（`npx vitest bench --run --maxWorkers=2`，2026-09-14 14:58）

```
bench/tests/bench/sessions.bench.ts
  steady flood: one 500-msg batch into a full 10k buffer   hz=25.42  mean=42.21ms  ±6.66%
  cold flood: 10,000 msgs as 500x20 batches                hz=4.19   mean=241.06ms ±2.47%
bench/tests/bench/streams.bench.ts
  sort toggle: messages column on mounted 10k list         hz=108.40 mean=9.85ms   ±5.36%
  cold mount: 10k-row StreamList render                    hz=73.46  mean=15.88ms  ±10.55%
```

2 files / 2 tests 全过。与 M2 基线同源同数量级（无回归信号）。

## 2. 低配模拟档（「模拟（2 核亲和 + GPU 禁用）」，§19.2 低配列）

方法：`desktop/scripts/perf-lowspec.ps1`（新增）：`NATSDESKTOP_DISABLE_GPU=1` → `Start-Process ..\bin\nats-desktop.exe` → 50ms 轮询进程出现后立刻 `ProcessorAffinity = 0x3`（2 核掩码）。注记：亲和在 Start-Process 后 ~60–150ms 落地，ready 标记前的最早期启动段不受限（如实记录；ready 本身 203ms，早于重度渲染阶段，影响可忽略）。

**GPU 禁用实证**（本轮实测）：renderer 与 browser 进程 CommandLine 均含 `--disable-gpu`（`check-gpu-flag.ps1` 全子进程扫描：browser=YES / renderer=YES / 其余共享进程 no）；gpu-process 仍存在（WebView2 软件合成路径）但 private 21.3MB vs 高配 100.8MB（硬件加速）——禁用生效。

### 2.1 冷启动 ≤4s —— **MEASURED-PASS（模拟）**

命令：`powershell -File %TEMP%\coldstart-lowspec.ps1 -Rounds 5`（M2 §4.2 同法 + 每轮启动后即置 2 核亲和；CSV `%TEMP%\coldstart-lowspec.csv`）。

| 轮次 | ready (ms) | affinity |
|---|---:|---|
| 1 | 349 | 0x3 |
| 2 | 200 | 0x3 |
| 3 | 203 | 0x3 |
| 4 | 437 | 0x3 |
| 5 | 201 | 0x3 |
| **中位数** | **203** | |

判定：203ms ≤ 4s → **PASS（余量 ~20 倍）**。

### 2.2 常驻内存 ≤400MB（空载 60s 点）—— **PASS（模拟）**

同一 launcher 启动（无连接空载，settings 置空同 §1.2）；`perf-sample.ps1 -IntervalSec 15 -DurationMin 1`；CSV `%TEMP%\perf-idle60-lowspec.csv`。

| t (s) | private_mb | ws_mb |
|---|---:|---:|
| 0 | 176.3 | 381.6 |
| 17 | 175.3 | 388.3 |
| 33 | 174.7 | 396.2 |
| 49 | 174.7 | 396.2 |
| 66 | 177.6 | 399.8 |

稳态 private ≈ **174.7–177.6MB** ≤ 400MB → **PASS**（低于高配空载 231MB：GPU 禁用去掉硬件加速层开销）。

### 2.3 订阅吞吐 1,000 msg/s × 60s（实时）—— 速率/守恒 PASS，负载内存 FAIL（模拟）

- 会话经 UIA 创建（同高配法），flood 59,909 条 @998 msg/s（99.5–99.8%）；会话接收 **59,909 = 发布数，1:1 精确**；丢帧计数 = 总量−10,000 整。
- 内存（CSV `%TEMP%\perf-flood1k-lowspec.csv`）：空载 191.0 → 峰值 **741.5MB**（注入中）→ 停止后 496.0MB 稳态（renderer 317.7MB 滞留）。
- 判定：速率与守恒 **PASS**；负载内存 741.5MB > 400MB → 与高配同机理（实时逐条推送前端面）**FAIL**（§12 低配常驻内存条件为「典型负载 30 分钟」，本轮按 brief 为 60s 腿——趋势与高配 30min 一致，30min 完整腿列 PENDING-MANUAL/M6 收尾可选补测）。

### 2.4 低配其余行

- 10k 行滚动 ≥30fps、反馈 ≤100ms：PENDING-MANUAL（§S3，同高配路径，另加 perf-lowspec.ps1 启动）。
- 列表加载 500 streams ≤1,500ms：**Task 6 已回填（§6.2/§6.4），两档 PASS**。

## S2. 偏差登记（锁屏可见性）

- **现象**：锁屏下 WebView2 `document.visibilityState === "hidden"`；`useMonitor.ts` 的轮询生命周期门禁 `connected + visible + !paused → StartMonitoring`（§20.2 失焦暂停，注释原文）不满足 → Go 侧 `MonitorService.pollLoop` 未启动（应用日志 13:50 后无任何新增 `monitor snapshot` 行；Dashboard 挂载痕迹 `sys watch created/stopped` 在案）。
- **影响**：§12「典型负载 = … + 监控页轮询开启」的第三成分在锁屏下无法真实建立；30min 腿实际为「连接 + 1k 实时会话」双成分。该偏差使内存读数**偏低**（保守方向）——补上轮询只会更高于门禁，不改变 §1.5 的 FAIL 判定方向。
- **解锁后补全路径（PENDING-MANUAL）**：解锁桌面 → 启动应用 → 打开「监控」页（或总览）→ 确认日志每 5s `monitor snapshot` → `perf-sample.ps1 -IntervalSec 60 -DurationMin 31` 复跑 30min 腿 → 回填 §1.5。

## S3. PENDING-MANUAL 清单（精确路径，人工执行后回填本文）

| # | 项 | 门禁 | 精确路径 |
|---|---|---|---|
| 1 | 大列表滚动帧率（高/低配） | ≥60 / ≥30fps | 解锁桌面 → `perf-lowspec.ps1`（低配腿）/直接启动（高配腿）→ 连接 4333 → Task 6 的 10k streams 数据集就绪后导航「流」→ 虚拟列表持续滚动 30s → DevTools（dev 构建 `wails3 dev` 或生产构建加 `-webviewdevtools`）→ Performance 面板录制 → FPS 轨道判读；或 240fps 录屏逐帧计数 |
| 2 | 操作视觉反馈（帧级） | ≤100ms | 同上环境 → Messages 页任一按钮（暂停/清空）→ 录屏逐帧：点击帧 → 加载态/状态变化帧差值；对照本文 UIA 上限估计 80ms |
| 3 | 会话上屏 P95 实时模式 | ≤200ms | 解锁 → 实时会话订阅 `m6perf.p95` → `go run ./cmd/flood -rate 1000 -dur 60s -subject m6perf.p95` → 录屏（240fps）逐帧比对消息携带时间戳 vs 上屏帧时刻，取 P95 |
| 4 | 会话上屏 P95 批量模式 | ≤200ms | 同上，会话先切「批量」（创建表单 推送方式=批量）→ 同法录屏判读（同批多条共享上屏帧时取批内最早消息时刻） |
| 5 | 典型负载 30min 含监控轮询补全 | ≤300/400MB | 见 §S2 解锁补全路径；回填 §1.5/§2.3 |
| 6 | 5k×10min 完整腿（解除内存压力后） | 丢帧<5% | §1.5 腿 B 的内存整改/缓解（如批量模式默认化）落地后重跑完整 10min + 录屏判读界面丢帧率 <5% |
| 7 | UIA 100 次上下文切换 | 无泄漏 | 可 WAIVED：引用 `TestSwitchStress100Cycles`（Go 腿全绿，§1.3）；如需 UI 腿：Messages 页头部上下文菜单 100 次 A→B 切换 + 无卡顿观察 |

## 4. 双端采样口径登记（§20.3-4）

OS 进程树采样（Go 主进程 + WebView2 全部子进程逐 PID private 求和，§0.1）为**门禁口径**；本轮进程分解（§1.5）进一步证明负载增量几乎全部落在 **renderer 子进程**——即「渲染进程 private 内存即前端足迹的进程面」在实测中成立。前端 **JS 堆侧**程序化采样需 DevTools 在场（`--remote-debugging-port` 或解锁后附加）——锁屏不可用，**登记为偏差**：以 OS 进程树口径为门禁，JS 堆两点快照（1h/24h，§12.1 长稳配套）列为解锁后增强证据，不作门禁。

## 5. 结论

| §12 指标 | 高配实测 | 低配（模拟）实测 | 判定 |
|---|---|---|---|
| 冷启动 | ready 155ms / frontend 618ms（中位） | ready 203ms（中位） | **两档 PASS** |
| 常驻内存（空载点） | 231.4–245.2MB | 174.7–177.6MB | **两档 PASS** |
| 常驻内存（典型负载） | ~1.4GB 稳态（30min）/7.0GB 峰值（5k 腿） | 741.5MB 峰值（60s 腿） | **两档 FAIL**（renderer 实时推送面；批量模式 -52% 缓解数据在案） |
| 订阅吞吐 | 1k×30min 与 5k 持续腿速率达成 99.5–99.8%，会话层零丢失，缓冲丢弃计数精确 | 1k×60s 同 | **PASS**（视觉丢帧判读 PENDING-MANUAL） |
| 频繁切换 100 次 | Go 腿：100 轮 4.44s，goroutine 差 0 | —（同 Go 腿覆盖） | **PASS** |
| 列表加载 500 streams | **Task 6 已回填（§6.2/§6.4）**：Go 侧前 500 取数 34–37ms；UIA 全 10k 列表首帧 894–1,166ms（虚拟化，仅渲染视口行） | 同左（Go 腿同数） | **PASS**（§12 高/低配两档） |
| 滚动帧率 | PENDING-MANUAL | PENDING-MANUAL | — |
| 操作反馈 | UIA 上限估计 80ms；帧级 PENDING-MANUAL | 同左 | 近似 PASS |
| 上屏 P95（实时/批量） | 双模式 PENDING-MANUAL（自动化等价证据 §1.6） | 同左 | PENDING-MANUAL |
| 安装包体积 | 便携 exe 20,582,912B ≈ 19.6MiB（≤30MB） | 同左 | PASS |

**核心发现（Task 11 汇入）**：内存门禁 breach 集中在实时逐条推送模式的前端渲染管线（`session:msgs` 1k/s 事件过桥 + 渲染 + V8 堆滞留）；空载与批量模式均大幅低于门禁。缓解杠杆：`session_push_batching`（-52%）、降缓冲上限、批量事件合帧；根治方向：推送合帧/虚拟化渲染批次化。

## 6. Task 6 压力数据集预置与大数据集实测（AC-028 + §20.3，2026-09-14 15:22–16:05 执行）

### 6.0 工具与数据集

- **预置工具**：`desktop/cmd/loaddata`（新增，test-only）——`go run ./cmd/loaddata -url nats://127.0.0.1:4333 -streams 10000 -million 1000000 -kvkeys 100000`。幂等设计：每流先 `mgr.LoadStream` 探测已存在即跳过；`LOAD_MSGS` 按当前消息数续发（中断重跑不重复）；`LOAD_KV` 走 `CreateOrUpdateKeyValue`（`jetstream.KeyValue` 只绑定已存在桶，首跑必建）。1M 消息为 256B 载荷 `js.PublishAsync` 500/批（同步逐条 RTT 无法分钟级完成——对 brief「js.Publish 批 500/批」的批量语义实现，已在工具 doc comment 注明）；KV 键 `v%06d`、值 256B、History 1。Ctrl-C 安全：`signal.NotifyContext` + 各加载器逐单元检查 ctx，部分数据重跑自动续齐。
- **烟测**：`go test ./cmd/loaddata/ -count=1` 全绿——内嵌 `testutil.StartSysServer`（app 凭据）跑 5 流/100 消息/50 键，summary 计数与服务端状态（`jsm.StreamNames`、流 State.Msgs、`kvs.Keys`）双向互证 + 二次执行幂等断言（created/skipped/published/put 全零增量）。
- **预置结果（4333，PID 23016 全程存活）**：总耗时 **5m57.4s** = 流 10,000 条 **5m4.9s** + 消息 1,000,000 条 **25.56s**（≈39.1k msg/s）+ KV 100,000 键 **26.87s**；进度打印逐 2,000 流 / 100k 消息 / 20k 键在案（工具 stdout）。
- **服务器状态 before/after**：before = **0 流 / 0 KV 桶**（Task 5 的 m2flood/m6perf 注入为 core-NATS 直发不落流，无遗留需要清理）；after = **10,002 流**（10,000×`LOAD_S%05d` + `LOAD_MSGS` + KV 底层流 `KV_LOAD_KV`）+ 桶 `LOAD_KV`（100,000 键，29.1 MiB）。`LOAD_MSGS` 1,000,000 条 / 281.3 MiB / first_seq=1 / last_seq=1,000,000。
- **加载期内存观测**（`%TEMP%\loaddata-memsample.csv`，15s 采样，35 点）：nats-server private 167.5 → **峰值 1,157.9MB**（1M 消息发布段），主机空闲物理内存全程 ≥1.37GB——**无内存压力，批大小 500 未需下调**。数据集常驻使服务器 private +~990MB（10k 流元数据 ~650MB + 1M 消息/100k 键数据 ~340MB），Task 7 典型负载复用此服务器时按此基线判读。

### 6.1 测量方法（Go 侧）

Go 侧计时程序为 OS 临时目录一次性测量脚本（`%TEMP%\ac028.go`，用后即删不入库；`cd desktop && go run` 对 4333 实跑），全部为**应用真实取数路径**的等价实现：

- Streams 列表 = `jsadmin.ListStreams` 路径：jsm `mgr.Streams(nil)`（`$JS.API.STREAM.LIST` 分页，页内含全量 StreamInfo——非逐流 INFO 请求，jsm.go manager.go:524 实现核实）+ jetstream `js.ListStreams`（同 API 的 jetstream 封装）互证 + 仅名 `mgr.StreamNames` 对照；
- 前 500 子集 = `js.ListStreams` 迭代取前 500 条 Info 即停（§12「500 streams 列表加载」腿）；
- 1M 流尾页 = `jsadmin.BrowseStream` 等价全路径：`js.Stream` 绑定 + 抛弃式消费者（`DeliverByStartSequencePolicy`/`OptStartSeq=999951`/`AckNone`/2min InactiveThreshold）+ `FetchNoWait(51)` 取 50 条 + 消费者删除，整路径计时；
- KV 100k 键 = `buckets.ListKeys` 路径：`kv.Watch(ctx, ">", jetstream.MetaOnly())` 排序消费者拉满 100,000 条到 nil 哨兵 + 首 50 键 `kv.Get` 值补齐对照。
- 每项均含预热轮（首轮 OS/文件缓存效应如实标注），后取多轮。

### 6.2 Streams 列表 10k 行 —— **MEASURED-PASS**

数据面：10,002 流。| 路径 | 轮次与读数 |
|---|---|
| 应用路径 `jsm.Streams`（ListStreams 全量等价） | 预热 640ms；实测 **643 / 649 / 778ms**（n=10002 全量含 State） |
| jetstream `js.ListStreams` 分页互证 | **581 / 697 / 620ms** |
| 仅名 `StreamNames` | 89 / 111ms |
| **前 500 子集**（§12 腿，§1.6/§2.4 回填） | **34 / 37 / 36ms** → 高配 ≤500ms / 低配 ≤1,500ms **PASS（余量 13–22×）** |

- **应用 5s 默认请求超时判定**：应用路径最慢轮 778ms ≪ 5s（settings `request_timeout_seconds=5`）——**默认设置下 10k 列表可正常加载**，不会触发 §6.6 不可用指引面板。
- 10k 流元数据单价：jsm 全量 ≈ 0.064ms/流（含每流 State 汇总），与 1k 时代经验外推一致偏优（STREAM.LIST 分页摊薄请求开销）。

### 6.3 1M 消息流浏览器尾页 —— **MEASURED-PASS（门禁 ≤1s）**

`LOAD_MSGS`（1,000,000 条，256B）尾页 = seq 999,951–1,000,000 共 50 条（12,800B）：

- **Go 侧 BrowseStream 等价全路径 5 轮**：67（首轮）/ 22 / 11 / 15 / 19ms——含流绑定 + 消费者创建 + Fetch + 消费者删除整链。**≤1s 门禁 PASS（余量 ~15×+）**。
- 判读：`DeliverByStartSequence` 尾页取数与流总深度（1M seq）无关——首末页同价，浏览器任意位置跳转取数常数化。

### 6.4 KV 100k 键分页 —— **MEASURED-PASS**

`LOAD_KV`（100,000 键 / History 1 / 29.1 MiB）：

| 腿 | 读数 | 门禁判读 |
|---|---|---|
| Go `ListKeys` 路径（Watch MetaOnly 全量快照）3 轮 | 279 / 276 / **231ms** | 1k 键基线 22.8–38.1ms（M4）×100 键量 → 外推线性上界 ~2.3–3.8s，**实测 231–279ms 优线性 ~10×**（分页摊薄）；≤500ms 高配门 **PASS**，5s 应用默认超时不触 |
| 首 50 键 `kv.Get` 值补齐 2 轮 | 12 / 9ms | 与 M4 同量级 |
| **UIA**：键值存储页 → 选中 LOAD_KV → 首键 `v000000` 可见 | 382（首轮）/ 141 / 162ms | **PASS**（上限估计，UIA 轮询粒度 50ms） |

### 6.5 UI 侧实测（UIA，锁屏桌面）

本轮锁屏会话 UIA 链路可驱动且**页面挂载取数真实执行**（Streams/KV/浏览器三页均实际加载数据出行——与 §S2 监控轮询被 visibility 门禁暂停的观察并存：门禁只拦轮询循环，不影响本轮页面首取）。计时为 **Stopwatch + 50ms UIA FindAll 轮询的上限估计**（含 UIA COM 往返）：

| 腿 | 操作序列（UIA） | 3 轮读数 | 门禁判读 |
|---|---|---|---|
| Streams 页 10k 列表首帧 | 侧栏「流」Invoke → 首个 `LOAD_S` 行出现在 UIA 树 | 1,166 / 901 / 894ms | 含 Go 取数 ~640ms（§6.2）+ 桥 + 渲染；§12 无「10k 全量」独立门，对照 500ms/1.5s 档：超 500ms、**远低于低配 1.5s**；虚拟列表实证：10,002 流仅 93 个行级 UIA 元素（视口外不渲染） |
| 1M 流浏览器尾页 | 流页 → LOAD_MSGS 行 Toggle 选中 → 详情「消息」Invoke → 浏览器「尾页」Invoke → seq 999951 行可见 | 652 / 664 / 688ms | **≤1s PASS**（上限估计；Go 腿 11–67ms） |
| KV 100k 键页 | 见 §6.4 表 | 382 / 141 / 162ms | **PASS** |
| 任意位置跳转（近似） | 「搜索流」输入 `LOAD_S0999x`（10k 名域尾部）→ 目标行可见 | 70 / 78 / 77ms | 自动化近似 **PASS**（客户端过滤瞬时） |

**PENDING-MANUAL（精确路径）**：§12「任意位置跳转 ≤1s」的**虚拟列表滚动手测腿**——滚轮/拖动滚动条至第 N 千行的帧级滚动流畅度需 DevTools（锁屏不可用）：解锁桌面 → 启动应用连 4333 → 流页（10k 数据集在位）→ DevTools（`wails3 dev` 或生产构建 `-webviewdevtools`）→ 手动滚动列表至 `LOAD_S09xxx` 区段 → Performance 面板判读滚动帧率与行出现时延；或以 §6.5 搜索跳转腿 + 虚拟化渲染证据（93 元素/10,002 流）作 WAIVED 依据。

### 6.6 小结（AC-028 两项实测值 + 关联腿）

| AC-028 项 | 实测值 | 判定 |
|---|---|---|
| 10k 流列表加载 | Go 643–778ms（应用路径全量含 State）/ 前 500 = 34–37ms；UIA 首帧 894–1,166ms | **PASS**（默认超时 5s 不触；500 流腿两档 PASS） |
| 1M 消息流尾页 | Go 11–67ms；UIA 652–688ms | **PASS（≤1s，余量 ~15×）** |
| 100k KV 键分页（关联） | Go 231–279ms + 首页值补齐 9–12ms；UIA 141–382ms | **PASS**（对 1k 基线优线性外推 ~10×） |
| 任意位置跳转（关联） | 搜索跳转 70–78ms（近似）；滚动手测 PENDING-MANUAL | 近似 PASS |
| 数据集 | 4333 在位：10,002 流 / 1M×256B 消息 / 100k KV 键（Task 7 典型负载直接复用） | — |


## 7. Task 8 复测：实时推送合并（coalescing）修复后的典型负载内存（2026-09-14 18:24–19:27）

Task 8 在 `useSessions` 落地实时推送合并修复（`session:msgs` 事件先入 ref 待处理缓冲，每动画帧一次 `applyPendingMsgs` 折叠入 React state；`document.hidden` 时暂停、visibilitychange 恢复；缓冲 2×cap 高水位裁剪；`clear()` 同步丢弃未折叠缓冲）。本节为修复后的同剖面复测（Task 5 §1.5 腿 A 口径：1 连接 local-test@4333 + 1 实时会话 @1k msg/s + 会话页挂载）。

**环境差异声明（对照 Task 5 腿 A，判读时必须纳入）**：① Task 5 跑在锁屏 `visibilityState=hidden` 下（监控轮询被门禁暂停、合成器不绘制）；本轮窗口为**前台可见**（165Hz 面板，rAF 驱动 60 帧/s 折叠 + 真实合成），负载只高不低。② 运行 A 附加 `--force-renderer-accessibility`（UIA 树稳定暴露所需），运行 B 无该 flag（M5 自然激活法）。

**命令（照录）**：`wails3 task windows:build VERSION=1.0.0`（含 Task 8 修复）→ `bin\flood.exe -url nats://127.0.0.1:4333 -subject m6mem.x -rate 1000 -size 1024 -dur 35m|25m` → UIA 建实时会话（`scripts/uia-create-session.ps1`，M5 方法）→ `scripts/perf-sample.ps1 -IntervalSec 60 -DurationMin 30|20`。采样器本轮修复一处缺陷：`N1` 数字格式在中文区域下输出千位逗号破坏 CSV 列（如 `1,300.0`），改 `0.0` 无分组格式（§0.1 注记作废，CSV 列自此严格 6 列）。

| 腿 | 条件 | 稳态 private（主+WebView2 树求和） | 进程分解 | 会话状态守恒 |
|---|---|---|---|---|
| 运行 A（30min，forced-a11y） | 窗口可见 + `--force-renderer-accessibility` | **1,637.9–1,701.5MB**（末 20 采样中位 **1,681.4MB**；前 8 分钟爬坡段锯齿峰值 3,334MB 后回落） | renderer ~2,989MB（爬坡段）；稳态回落 | 总收 733,686 时已丢弃 723,686 → **保留恰 10,000** |
| 运行 B（20min，无 flag） | 窗口可见 + UIA 自然激活（M5 法） | 末 10 采样 **1,268.4–1,323.8MB**（中位 **1,293.7MB**；GC 锯齿谷值 361.8MB） | 增量在 renderer（与 Task 5 同） | 同上口径（chip 读数 952–970 msg/s 与发布端一致） |

**对照 Task 5 腿 A（修复前）**：1,376–1,551MB 锯齿稳态（hidden、监控轮询门禁暂停——口径偏低）。修复后运行 B **1,268–1,324MB**：在窗口可见（更重合成/rAF 负载）条件下稳态中位下降 ~9%（1,293.7 vs ~1,432 估计中位），锯齿谷值深至 361.8MB（修复前未见）。

**判定口径（如实）**：① **每次事件 setState 的病理已消除**（组件级：`tests/messages-sessions-coalesce.test.tsx` 7 用例钉住「缓冲期零 setState / 一帧一折 / 顺序守恒 / 高水位有界 / 隐藏暂停 / clear 不复活 / 卸载取消」；10k 消息 ingest+flush <2s 门禁保持）。② **状态面精确有界**：实测显示缓冲恰为 cap=10,000，高水位裁剪无泄漏（35min 连续负载进程树句柄/线程数平稳：~3,806–3,868 / 154–174）。③ **稳态常驻仍高于 300MB 门禁**（1.3GB 量级）——与 Task 5 判定一致：V8/PartitionAlloc 已提交页不归还 OS（Task 5 §1.5 停载后不回落观察仍成立），内存门禁 AC-023 的 FAIL 结论**不变**；批量模式杠杆（653.8MB，-52%）仍是最有效缓解，合并修复在其上叠加渲染次数 1000→~60/s 的响应性收益。④ 运行 A 证明 forced-a11y 客户端常驻时 renderer 多占 ~350MB——无障碍客户端挂载场景的内存代价首次量化，登记为已知面。

原始 CSV：`desktop/bin/perf-task8-postfix.csv`（运行 A，31 采样）、`desktop/bin/perf-task8-postfix-noa11yflag.csv`（运行 B，21 采样）。

UIA 冒烟同场证据：会话 chip 实时读数 970→952 msg/s、`共 N 条 / 已丢弃 N−10,000 条` 精确守恒（`scripts/uia-session-rate.ps1` 读值）；flood 发布端 2,096,091 条 @998 msg/s（99.8%）。


## §10 修复后复测（2026-09-15 晚，commit 4784e27）

**场景**：与 §7 同构——flood 1k msg/s（m6mem.x，1024B）+ 实时会话 + 应用进程树采样 40 分钟（41 样本，bin/m6fix-evidence.csv）。修复：realtime 模式 Go 侧 16ms/200 微批（4784e27），emit 速率 1k/s → ~62 events/s 封顶。

**逐进程归因（新证据，3 样本 × 3min 间隔）**：
- **Go 主进程：116.3 → 118.1 → 119.8MB，走平**——修复前同进程 800MB/h（Event 2004：17.5h 时 14.3GB）。**修复 A（邮箱囤积）验证有效**。
- **渲染器 pid=14948：1,045 → 1,093 → 1,112MB（+67MB/6min ≈ 670MB/h）仍在增长**——独立的第二个泄漏（V8 已提交堆在持续分配下的棘轮式增长），与邮箱缺陷无关。

**整树 40 分钟窗**：947 → 1,563MB，斜率 904-925MB/h（中位 1,246MB）——与修复前总斜率相当：**主进程斜率归零，但渲染器斜率（此前被主进程斜率掩盖）成为主导**。

**结论修正**：17.5h 崩溃是**双泄漏叠加**——主因 A（wails 邮箱，已修并有本节证据）+ 次因 B（渲染器 V8 堆，未修）。仅修 A 不足以让 AC-025 过门：B 单独在 24h 内仍会耗尽数十 GB。B 的根因定位需要解锁桌面 + DevTools 堆快照对比（锁屏不可行），列 v1.1 首项；短期缓释不变（批量推送 654MB/30min 稳定 + 降低订阅速率 + 清空按钮）。

**修复 A 的有效性证据清单**：主进程走平（本节三样本）；微批契约单测（TestPusherRealtimeLowRateSingleElement/BurstConservation：1000 条突发零丢失零乱序、批 ≤200）；全量门禁绿（Go 14 包 + vitest 309）。


### §10.1 修复 B（传输统一 100ms/500）验证（2026-09-15 深夜，commit 后）

**A/B 实验定位**：批量模式（10 events/s × ~600KB，走 >8KB 暂存 HTTP 路径）渲染器 18 分钟平台 410-455MB 锯齿（1.35M 消息计数精确守恒）；realtime 16ms/200（62 events/s × ~16KB 走 ≤8KB 内联 eval 拼接）渲染器棘轮 633-970MB/h。**驱动因子 = 内联拼接事件速率**。

**修复**：realtimeInterval/realtimeMaxMsgs 提升至与批量相同（100ms/500，pipeline.go 常量注释含机制说明）。

**修复后验证**（实时会话 + 双 flood 合计 ~2k msg/s——严苛条件，40 分钟 40 样本，bin/renderer-track-fixed.csv）：
- 爬坡起点 290MB → 稳态 ~450-492MB 锯齿；**尾段 30 分钟斜率 166 MB/h**（对照修复前 realtime 633-970 MB/h），且双倍速率下。锯齿形态与批量平台一致（GC 正常回落）。
- 同窗口 Go 主进程 103.8-104.1MB 走平（修复 A 持续有效）。

**遗留**：尾段 166MB/h 是否完全归零需 24h 尺度判定（见复跑长稳）；如为 V8/PartitionAlloc 水位漂移则预期出现平台期。

## §12 残余泄漏 B 归因·第二阶段（2026-09-17 凌晨，金标准复跑后）

**基线**（m6-soak §11）：修复后构建 24h 满窗不崩溃；树内存残余 ~108MB/h 线性棘轮，逐进程实锤归属 WebView2 browser 进程（48140，终值 2,777MB）。

**A/B 定模式无关性**（同 exe = Sep 15 23:17 修复版、同载 1k msg/s×1024B、各 1h、每进程采样 `bin/ab-leakB-batch/ppsample-batch.csv`）：
- **batch 模式同样棘轮：wv_sum +111.5MB/h、browser 进程 +109.8MB/h、Go 主进程 +5.7MB/h（平稳）**——与 24h realtime 复跑的 ~108MB/h 无差异。
- 结论：**残余泄漏与推送模式无关，位于两模式共享的 Go→JS 大事件传输通道**（500KB 级聚合事件 >8KB 阈值 → wails parked-payload HTTP/URL-scheme task 路径，browser 进程为必经节点）。
- batch 1h 内 UIA 导航 56 循环全 ok（短窗无 UIA 劣化，长窗劣化仅在 24h 尺度显化）。

**已排查并排除**：
1. HTTP 响应缓存：payload 响应已带 `Cache-Control: no-store`（wails `application.go` serveEventPayload）。
2. Go 侧 payload 存储：`take()` 取走即删 + 30s TTL + 7.5s sweep + 64MB 全局上限——主进程 24h/1h 双跑平稳与之吻合。
3. 上游：wails #4587（eval 泄漏）经 PR #5930 落地为现行 parked 机制；issue/PR 无 WebView2 browser 进程专项跟进——本残余属上游未charted区域。

**工作假设**：滞留在 WebView2 拦截请求（URL-scheme task / WebResourceRequested）机器内部，量级 ~3.2KB/事件（110MB/h ÷ 36k 事件/h），约合每字节的 0.6%——第三方层，应用代码不可达。

**判别实验 Run C**（20 msg/s 低速，聚合批 ~2 条 ≈400B < 8KB → 走内联 eval、绕开 parked 通道）：browser 若平坦 → parked 通道滞留坐实，修复方向 = 应用侧自建 WebSocket 旁路（v1.1 结构性方案）或上报上游 / 缩批至 8KB 内（代价：33 evals/s，需复验内联路径渲染器棘轮）；browser 仍 ~110MB/h → 每事件节奏型泄漏，与路径无关，另寻攻击面。

**缓解现状（如发布）**：110MB/h → 24h +2.6GB，运行多日有长压风险（首崩案例 14.3GB 才致命；该残余无崩溃观察至 3.2GB/24h），但 ≤10% 门禁客观 FAIL。短周期会话（<4h）内增速无感（<450MB）。

### §12.1 Run C 结果：parked 假说被推翻（2026-09-17 04:00）

Run C（20 msg/s 低速，聚合批 ~400B < 8KB → 全走内联 eval、绕开 parked 通道，1h，`bin/ab-leakB-lowrate/`）：
- **browser 进程 +253~265MB/h、wv_sum +265MB/h、主进程也增长（净 ~+25-70MB/h，A/B 档主进程是平的）**——低速下棘轮反而比高速档（110MB/h）快 2.4 倍。
- **三项假说全部被否**：①parked 通道专属滞留（内联路径同样棘轮）；②每事件节奏型（两档同为 ~10 事件/s，斜率差 2.4×）；③每字节型（20/s 的字节流是 1k/s 的 1/50，斜率反升）。
- 诚实结论：**browser 进程增长的驱动与消息载荷大小、事件条数、投递路径均无单调关系**——过程级归因（browser 进程）成立，但驱动变量尚未锁定。
- 新线索：主进程在低速档也出现 ±20MB 锯齿（周期约与导航触及监控页的 8min 周期吻合），提示**导航换页 churn**（页面 mount/unmount、监控轮询挂载）可能是被低估的公共变量——它在 A/B/C/24h 四轮中全程存在。

### §12.2 分解矩阵（2×2 + 空闲基线，2026-09-17 凌晨排队）

| 腿 | 导航 | 消息投递 | 判据 |
|---|---|---|---|
| D0（空闲基线） | 无 | 无（建会话失败成为意外空腿） | 全部斜率应≈0，否则存在第四变量 |
| D1（仅投递） | 无 | 1k msg/s → m6mem.x | 斜率高 → 投递驱动（WS 旁路方案成立） |
| E（仅导航） | 60s 循环 | 1 msg/s（噪声级） | 斜率高 → 换页/挂载churn驱动（前端卸载卫生审计） |
| A/B/C 已有 | 有 | 有（三档速率/路径） | 110/110/265 MB/h |

判读规则：D1、E 斜率与 A/B/C 对齐即可归因；若两腿都平而 A/B/C 棘轮，则需 nav×load 交互项假设。产物：`bin/legD-floodonly/`（D0）、`bin/legD1-deliveryonly/`、`bin/legE-navonly/`。

### §12.3 Run D1（仅投递·无导航）：browser +231.3MB/h —— 投递通道单独即可驱动棘轮（2026-09-17 07:45）

`bin/legD1-deliveryonly/`：会话 m6mem.x 建立成功（VERIFY-OK），应用钉在消息页（realtime 模式），flood 1k msg/s × 1h 全程（3.57M 条，99.2%），**零导航**。结果：browser 进程 **+231.3MB/h**、wv_sum +228.0、主进程 +6.0（平坦）。
- **投递 alone 即可驱动 browser 棘轮，且速率高于全浸泡档（110）**——导航换页对消息页的周期性卸载（7/8 占空比）反而稀释了棘轮。
- 矩阵现状：空闲 D0=0.1 / 纯投递 D1=231 / 投递1k+导航 A,B,24h=108-110 / 投递20+导航 C=265。纯导航 E2（1 msg/s，修复后采样器）排队中，用于分离导航独立分量。
- 对修复方向的含义：**WS 数据面旁路（会话消息批改走自建回环 WebSocket）正中要害**——无论残余滞留位于 parked fetch、eval 拼接还是高频事件触发的 browser 合成器churn，把 1k msg/s 级数据流整体挪出 wails 事件管线都直接移除该驱动。若 E2 显示导航还有独立分量，则追加前端卸载卫生审计为第二工作项。

### §12.4 修复验证：WS 数据面旁路生效（2026-09-17 14:50）

**实施**（计划 `2026-09-17-nats-desktop-leakb-ws-dataplane.md`，Tasks 1-5 全部经子代理 TDD 执行，commit 669f990→c9e3b31→52cef33）：`internal/messaging/wshub.go` 回环 WS hub（token 鉴权 + 64 批有界缓冲 + 溢出断连）；`session:msgs` 数据面 hub-only（nil 回退旧路径；`session:state` 控制面不动）；前端 `msgChannel` + useSessions 异步接入。CI desktop-ci 全绿（含 -race）。

**验证跑**（`bin/legD1-wsfix/ppsample2.csv`，与 §12.3 leg D1 同载同型：realtime 会话钉在消息页、零导航、1k msg/s）：

| 指标 | 修复前（leg D1） | 修复后（本跑） |
|---|---|---|
| browser 进程斜率 | **+231.3 MB/h** | **+2.51 MB/h**（≤10 闸门 PASS，92× 改善）|
| wv_sum 斜率 | +228.0 MB/h | +1.29 MB/h |
| main 斜率 | +5.7 MB/h | +6.0 MB/h（平坦）|
| 轨迹形态 | 线性棘轮 | 140-153MB 锯齿、均值平坦 |
| 帧渲染证明 | — | flood 2.81M 条经 WS 送达（77.9% 达成）；UIA「尚未收到消息」占位符消失 |

**实施过程中揪出的三个真缺陷（均已修复+回归测试/杠杆）**：
1. **coder/websocket 默认跨源拒绝**（accept.go:95）：webview 的 `Origin: http://wails.localhost` 握手被 403，数据面静默饿死而控制面计数正常——极易误判。修复 `InsecureSkipVerify: true`（真安全边界=每次启动 token 常量时比较 + 仅回环；Origin 头客户端可伪造，对本端点无增量价值）+ `TestMsgHubAcceptsBrowserOrigin` 回归（52cef33）。
2. **WebView2 UIA 无障碍自动激活失效**（本机 ~2026-09-17 12:00 起）：渲染器 AX 经 CDP 验证健康、Chrome/Edge 正常、UIA 树却空心——24h 浸泡的「UIA 冻结」缺陷极可能是同机制中途掉线（翻案候选）。新增 `NATSDESKTOP_FORCE_AX=1` 杠杆（`--force-renderer-accessibility`，仿 GPU lever），9 按钮即时物化；UIA 自动化从此不依赖脆弱的自动激活。
3. **exe 构建顺序陷阱**：前端改动必须 `npm run build` 后再 `go build`，否则 exe 内嵌旧 dist——首轮验证假阳性即栽在这里（旧前端订阅 wails 事件、新 Go 已切 hub → 零帧渲染 → 内存平坦假象）。

**剩余工作**：导航/页面挂载分量（E2=233.7MB/h，嫌疑=监控/流/KV 页挂载重拉 10k 流/100k KV 巨型数据集走同条 wails 大载荷通道）——独立计划跟进；两分量修复后跑 24h 深泡#3 终验（级联假设一并验证）。
