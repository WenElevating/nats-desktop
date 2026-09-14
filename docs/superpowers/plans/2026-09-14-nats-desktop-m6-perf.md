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

- **列表加载 500 streams ≤500ms**：按 brief 与 **Task 6 合并执行**（10k 数据集就绪后取前 500 计时）——本表登记**执行顺序依赖：Task 6 数据集 + 计时腿先行，结果回填本表**。自动化近似参考（本轮 vitest bench 复跑，§1.7）：10k 行列表冷挂载 mean 15.9ms、排序切换 mean 9.9ms（React 提交层），与 500ms 门禁之间有充足余量。
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
- 列表加载 500 streams ≤1,500ms：Task 6 合并（同 §1.6 顺序依赖）。

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
| 列表加载 500 streams | Task 6 顺序依赖（bench 近似余量充足） | 同左 | PENDING（Task 6 回填） |
| 滚动帧率 | PENDING-MANUAL | PENDING-MANUAL | — |
| 操作反馈 | UIA 上限估计 80ms；帧级 PENDING-MANUAL | 同左 | 近似 PASS |
| 上屏 P95（实时/批量） | 双模式 PENDING-MANUAL（自动化等价证据 §1.6） | 同左 | PENDING-MANUAL |
| 安装包体积 | 便携 exe 20,582,912B ≈ 19.6MiB（≤30MB） | 同左 | PASS |

**核心发现（Task 11 汇入）**：内存门禁 breach 集中在实时逐条推送模式的前端渲染管线（`session:msgs` 1k/s 事件过桥 + 渲染 + V8 堆滞留）；空载与批量模式均大幅低于门禁。缓解杠杆：`session_push_batching`（-52%）、降缓冲上限、批量事件合帧；根治方向：推送合帧/虚拟化渲染批次化。
