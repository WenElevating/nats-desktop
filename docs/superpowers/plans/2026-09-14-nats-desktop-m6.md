# NATS 桌面客户端 M6（发布收尾）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 v1.0 发布收尾：构建/打包/发布线（版本注入、NSIS + 便携 zip + SHA256、≤30MB）、性能与稳定性验证（AC-023/024 双档实测、AC-025 24h 长稳、AC-028 大数据集）、质量收口（bindings 全量 regen 重提交、Go 覆盖率 3 包 → 80%、前端 Minor 修复波、无障碍与截图基线）、手测矩阵汇总执行、验收结论与文档收口（§21 十三项 checklist、§25 验收结论回填、TODO-001..005 状态更新）。

**Architecture:** 无新功能面。三条线串行：**构建发布线**（Task 1 元数据/版本注入 → Task 2 bindings regen 重提交 → Task 3 CI 首跑 → Task 9 打包发布）——先收口构建一致性再做包；**性能稳定性线**（Task 4 覆盖率+Go Minor → Task 5 双档实测与内存口径 → Task 6 压力数据集 → Task 7 24h 长稳挂机）——共享一个 PowerShell 采样器；**质量收尾线**（Task 8 前端 Minor+无障碍+截图基线 → Task 10 手测矩阵核销 → Task 11 验收文档收口）。低配档以「2 核 CPU 亲和 + env 门控 `--disable-gpu`」在本机模拟（wails v3 `application.Options.AdditionalBrowserArgs` 注入点已核），真机低配为可选用户输入。

**Tech Stack:** 沿用全部既有栈；**零新增运行时依赖**；PowerShell（UIA 冒烟/采样/打包脚本，M3–M5 惯例）；NSIS（wails 模板自带 `build/windows/nsis/`）；`cmd/loaddata` 复用 `cmd/flood` 模式（test-only 工具）。

**规格依据:** `docs/superpowers/specs/2026-09-11-nats-desktop-v1-spec.md`（v1.1）§12（性能规格 + 12.1 稳定性）、§20.3（稳定性测试）、§21（发布要求十三项）、§22（回滚方案）、§24（TODO-001..005）、§25（验收结论）、§13.3/AC-030（日志洁净终扫）；AC-022/023/024/025/026/027/028/030。遗留并入：M5 验收 §6 全部移交（bindings regen 首要项、CI -race 首跑、trace/ErrTimeout 手测、34 项 Deferred Minors、settings/version/appdir 覆盖率、像素配色核对）；M1–M5 各验收记录 §7/§8 回填区 PENDING-MANUAL 项。

## 执行前置：TODO 裁决（用户输入，不偷偷假设——spec §24 原文）

以下五项是 spec §24 明列、截止 M6 的用户裁决。**执行开始前由用户逐项给出**；计划以「默认值」参数化，Task 1/9/11 消费裁决结果：

| 编号 | 问题 | 默认值（用户未另行裁决时） |
|---|---|---|
| TODO-001 项目名 | 展示名/产品名（GitHub `nats-desktop` 已被占用） | 展示名 **NATS Desktop**（显示层：NSIS 元数据/窗口标题/README）；**不改** Go module 路径与仓库名（改名 churn 巨大，module `github.com/WenElevating/nats-desktop` 保持） |
| TODO-002 代码签名 | 是否购 Windows 代码签名证书 | **不购**：README 写明 SmartScreen 警告说明 + 附 SHA256（spec §23 应对原文） |
| TODO-003 Sentry DSN | 崩溃报告是否配置远端 | **不配置**：保持崩溃报告默认关闭、仅本地日志（v1.0 立场不变，spec §6.13） |
| TODO-004 macOS/Linux | 是否随 v1.0 发布 | **不随**：仅 Windows 正式验收（既有决策维持），其余平台构建脚本保留不动 |
| TODO-005 context 路径 | Windows context 目录确认 | **已闭环**（M1 与 CLI 互操作实测 AC-003 通过）——Task 11 仅更新 §24 表状态为 Resolved |

## Global Constraints

来自规格 v1.1 与既有里程碑裁定的硬约束（值逐字取自规格/验收记录）：

1. **发布 checklist（§21 十三项（安装包与文档是两项，逐字对齐 spec 清单），逐项映射任务）**：功能完成/单测覆盖/集成/性能/稳定性/UI 交互/日志/配置/协议版本/向后兼容/回滚方案/**安装包（NSIS + 便携 zip）与 SHA256 校验和**/**文档（README 含明文凭证风险说明、语言切换、系统要求）**——Task 11 逐项勾选并给出证据指针。
2. **性能预算（§12 双档，验收表 §19.2 逐值）**：冷启动 ≤2s/≤4s；常驻内存 ≤300MB/≤400MB；订阅吞吐 5,000/1,000 msg/s 丢帧 <5%；列表加载（500 streams）≤500ms/≤1,500ms；大列表滚动 ≥60fps/≥30fps；操作反馈 ≤100ms 双档；**安装包 ≤30MB**；上屏延迟 P95 ≤200ms 双档；稳定运行 ≥24h、内存增长 ≤10%。实测值回填 §19.2 表（Task 11 改 spec，版本记录 v1.1→v1.2）。
3. **内存口径统一（M2 验收 §6-14 裁定）**：以 **private working set 求和** 为准（WS 求和含共享页重复计入，仅参考列）；测量条件含「空载 60s」与「典型负载 30 分钟」双点。
4. **TODO 裁决为执行时用户输入（§24「不要偷偷假设」原文）**：上表默认值仅在用户确认后生效；任何偏离默认的裁决由 Task 1/9/11 落地并在验收记录登记。
5. **凭证不入日志终扫（§13.3/AC-030）**：Task 10 对全部源码与日志样本做终扫（password/token/creds/jwt 明文 grep + 设置页掩码复验）；本地文件路径/字节数/摘要可入日志（既有裁定延续）。
6. **零新增运行时依赖**；前端 devDependency 例外逐项记录（本计划预计零例外——无障碍用人工/脚本核查而非引入 axe 依赖，理由：8 页面 × mock 环境搭建成本远超收益，键盘路径+对比度计算脚本+截图基线覆盖同一验收意图，裁定记录于验收文档）。
7. **push 是外发动作（Task 3）**：`git push origin main`（当前领先 105 提交）仅在用户于执行确认时授权；CI `-race` 首跑（M1 起在案）是本里程碑闭环项。CI 保持现有三 job 结构（go/frontend/build），不在本里程碑扩 workflow。
8. **24h 长稳占用机器一夜（Task 7）**：启动后挂机，期间机器不可用于其他重负载；采样与页面切换全自动，次日收数判定。
9. **bindings 树是提交物（M4/M5 裁定延续；M6 首要项）**：Task 2 先修 3 处 null-guard（AccountsPanel `stream_names` ×2、DangerZone `snapshot.servers`）再全量 regen 并一次性重提交（22+ 文件 createFrom 包装代差），此后 regen 为 no-op/净 diff。
10. **低配档 = 本机模拟**：2 核 CPU 亲和（`ProcessorAffinity=0x3`）+ GPU 禁用（main.go env 门控 `NATSDESKTOP_DISABLE_GPU=1` → `AdditionalBrowserArgs "--disable-gpu"`，**仅测试注入点，不进正常启动路径**，wails v3 beta.20 `application.Options.AdditionalBrowserArgs` 已核存在）；真机低配为可选用户输入，缺省时低配表列「模拟」并在验收记录注明（诚实口径）。
11. **截图基线 = 参考集非门禁（裁定）**：AC-026 截图回归在 v1.0 建立 8 页 × 2 主题 × 2 语言 = 32 张基线集（`docs/screenshots/v1.0/`）；像素级 diff 门禁列 v1.1（无既有基线可回归，v1.0 先立基线——验收记录登记）。
12. **i18n 完整性门禁延续**（en/zh key 集相等，缺失即构建失败）；lucide-only 禁 emoji 延续；UIA/手测不可驱动腿如实列 PENDING-MANUAL 附精确路径（M3–M5 惯例）。
13. **LocalServer 真服务器延续**（nats://127.0.0.1:4333，2s 探测 skip）：Task 5/6/7 性能与数据集实测打真服务器（用户指令延续）；4333 未运行时请用户按其既有方式拉起（`nats-server` 不在 PATH、仓库内无该二进制——**不要臆造启动命令**；用户不可及时性能任务阻塞并如实记录，审查 F22）。
14. **手测矩阵为汇总核销制（Task 10）**：从 M1–M5 六份验收记录抽取全部 PENDING-MANUAL/待执行行成 checklist，逐条执行/标注；用户在场才能做的项明确列 LIVE-待办交还用户，不虚报。
15. **每任务收尾全量门禁**：`cd desktop && go test ./... -count=1 && go vet ./...` + `cd frontend && npx vitest run --maxWorkers=2 && npx tsc --noEmit`（本机 vitest 必须 `--maxWorkers=2`，默认并行 OOM——M5 Task 9 在案环境约束）；触碰前端时另跑 `npm run build`。

---

### Task 1: 版本注入与产品元数据收口（TODO-001 落地）

**Files:**
- Modify: `desktop/internal/version/version.go`（`const appVersion` → `var appVersion` + 注入文档）
- Modify: `desktop/build/windows/Taskfile.yml`（VERSION 变量 + ldflags 注入）
- Modify: `desktop/build/config.yml`（info 块真实元数据，消费 TODO-001 裁决）
- Modify: `desktop/README.md`（标题/描述对齐展示名）
- Test: `desktop/internal/version/version_test.go`（增补）

**Interfaces:**
- Consumes: TODO-001 用户裁决（展示名；默认 NATS Desktop）。
- Produces: `wails3 task windows:build VERSION=1.0.0` 产出版本正确的 exe（Task 9 打包消费）；`version.Current()` 返回注入值（未注入时默认 `0.1.0`）；config.yml info 块真实值（`wails3 task common:update:build-assets` 再生成 info.json/syso）。

- [ ] **Step 1: 增补失败测试**

`desktop/internal/version/version_test.go` 追加：

```go
// TestCurrentDefaultNotInjected: 无 ldflags 注入时 Current 返回包内默认值。
// appVersion 必须是 var（可被 -X 注入），本测试锁定默认值不被意外改动。
func TestCurrentDefaultNotInjected(t *testing.T) {
	if got := Current(); got != "0.1.0" {
		t.Fatalf("default appVersion = %q, want 0.1.0 (bump via ldflags, not source)", got)
	}
}
```

- [ ] **Step 2: 红灯 → 实现 → 绿灯**

Run: `cd desktop && go test ./internal/version/ -count=1` → 当前即绿（const 也过）——本步的差异在**注入能力**：把 `version.go:19` 的 `const appVersion = "0.1.0"` 改为：

```go
// appVersion is the running application version. Overridable at build time:
//   go build -ldflags "-X github.com/WenElevating/nats-desktop/desktop/internal/version.appVersion=1.0.0"
// (wails3 task windows:build VERSION=1.0.0 wires this in build/windows/Taskfile.yml).
var appVersion = "0.1.0"
```

Run: `go test ./internal/version/ -count=1` → PASS。

- [ ] **Step 3: Taskfile 版本注入**

`desktop/build/windows/Taskfile.yml`：顶层 `vars:` 增加 `VERSION: '{{.VERSION | default "0.1.0"}}'`；`build:native` 的 `BUILD_FLAGS` 生产分支由 `-ldflags="-w -s -H windowsgui"` 改为 `-ldflags="-w -s -H windowsgui -X github.com/WenElevating/nats-desktop/desktop/internal/version.appVersion={{.VERSION}}"`（dev 分支不动）。`build:` 任务的 vars 透传块补 `VERSION: '{{.VERSION}}'`。

验证注入（审查 F6 修正：`-X` 只改运行时 `Current()`；exe 的 VersionInfo 来自 info.json/syso，其版本在 Step 4 才更新）：

```powershell
cd desktop; wails3 task windows:build VERSION=1.0.0
# 运行时验证（Step 3 的正确判据）: 启动 exe 后日志出现 ready version=1.0.0
```
**版本双源不变量（审查 F20）**：运行时版本（`-X` 注入）与 exe 元数据版本（`config.yml info.version` → info.json → syso/NSIS）必须**同 bump**——发布构建一律 `VERSION=x.y.z` 与 `info.version: "x.y.z"` 成对改；Step 4 完成后复验 `(Get-Item bin\nats-desktop.exe).VersionInfo.ProductVersion` == 1.0.0 == 日志 version。

- [ ] **Step 4: config.yml 元数据（消费 TODO-001）**

`desktop/build/config.yml` info 块改为（默认值展示；用户裁决不同则替换）：

```yaml
info:
  companyName: "WenElevating"
  productName: "NATS Desktop"
  productIdentifier: "com.wenelevating.natsdesktop"
  description: "A desktop client for NATS: contexts, messaging, JetStream, KV, object store, monitoring"
  copyright: "(c) 2026, WenElevating"
  comments: "Open-source NATS desktop client"
  version: "1.0.0"
```

Run: `cd desktop && wails3 task common:update:build-assets`（再生成 info.json；README 指示该命令会覆盖手工改动——本步即其用途）。`git diff desktop/build/windows/info.json` 确认 ProductName/CompanyName 已真实化。README.md 标题与首段对齐展示名。

- [ ] **Step 5: 门禁 + 提交**

Run: `cd desktop && go test ./... -count=1 && go vet ./...`
Commit: `feat(desktop): build-time version injection + product metadata (M6 Task 1)`

---

### Task 2: bindings 全量 regen 重提交（M6 首要项）

**Files:**
- Modify: `desktop/frontend/src/features/monitoring/AccountsPanel.tsx`、`DangerZone.tsx`（3 处 null-guard）
- Modify: `desktop/frontend/bindings/**`（全量 regen 重提交）
- Test: 既有 270 前端测试全量回归

**Interfaces:**
- Consumes: M5 验收 §6-1 移交（TS18047 ×3：AccountsPanel `stream_names` ×2、DangerZone `snapshot.servers`——仅出现在**接口模式**生成树下）。
- Produces: regen 后 tsc/vitest 全绿且 bindings 树与**构建路径生成器输出**一致（接口模式）——此后任何 `wails3 task windows:build` 触发的 regen 为 no-op 或净 diff（Task 9 打包构建的前置；G9）。

- [ ] **Step 0: 生成器模式对齐（审查 F1 修正——关键事实）**

构建链（`windows:build → build:native → common:build:frontend → common:generate:bindings`）的生成命令是 `wails3 generate bindings -f '...' -clean=true -ts **-i**`（build/Taskfile.yml:191）——**`-i` 接口模式**给一切 slice 类型加 `| null`（生成器 render/type.go：json 会把 nil slice 序列化为 null）。M5 Task 9 提交的 monitor bindings 是**类模式**（无 `-i`，`stream_names: string[]` 非 null），所以 3 处 TS18047 只在走构建路径的 regen 后出现。本任务一律使用**与构建路径一致的命令**：

```powershell
cd desktop; wails3 task common:generate:bindings BUILD_FLAGS='-tags production'
# 等价直呼: wails3 generate bindings -f '-tags production' -clean=true -ts -i
```

- [ ] **Step 1: 复现（先红）**

Step 0 的命令跑完后：

```powershell
cd frontend; npx tsc --noEmit
```
Expected: 3 处 TS18047（"possibly null"）报错——记录原文（预期：AccountsPanel 两处、DangerZone 一处 `snapshot.servers`；以实际报错行号为准）。**注意**：全量重生成是 22+ 文件的类→接口模式代差（构造器包装消失、字段可空化），diff 远大于 M5 见到的局部漂移——这是预期。

- [ ] **Step 2: 源码 null-guard（9207fd3 风格，模式无关写法）**

3 处按报错实际行号加 guard：`stream_names ?? []`、`(row.stream_names ?? [])`、`servers ?? []`——或等价可选链。**不改语义**：空值时行为与旧类模式树完全一致（空列表渲染）。

Run: `npx tsc --noEmit` → 0 errors（此时对着**接口模式生成树**编译）。

- [ ] **Step 3: 全量重提交 + 回归（显式门禁，非走过场——接口模式树从未被整套跑过）**

```powershell
cd desktop; wails3 task common:generate:bindings BUILD_FLAGS='-tags production'   # 树即构建路径产物
cd frontend; npx vitest run --maxWorkers=2 ; npx tsc --noEmit ; npm run build
```
Expected: 270/270（现有数）+ tsc 净 + build 成功。**若 vitest 有结构性失败**（`toEqual` 对接口实例 vs 类实例为结构比较应兼容；不兼容处按报错修测试断言，不改产品语义）——逐条记录。再用**同一命令**跑第二次 regen → `git status` 必须为空（no-op 证明——这是 G9 的验收，命令必须与构建路径一致）。
Commit（bindings 树 + 2 个源文件一次提交）: `chore(desktop): full bindings regen recommit (interface mode) + null-guards (M6 Task 2)`

---

### Task 3: CI 首跑验证（用户授权 push）

**Files:**
- 无代码改动预期；如 CI 红则修复提交（`fix(desktop): ...`）

**Interfaces:**
- Consumes: 用户执行确认时对 push 的授权（G7）；本地 main 领先 origin/main 105 提交。
- Produces: CI `-race` 首跑记录（run URL 入台账与 m6-test-report）；红的修绿。

- [ ] **Step 1: push（授权后）**

```bash
git push origin main
```

- [ ] **Step 2: 盯跑与修复**

```bash
gh run watch --exit-status   # 或 gh api repos/WenElevating/nats-desktop/actions/runs 轮询
```
四个 job（go `-race -cover` / frontend tsc+eslint+vitest --coverage / build / bench——desktop-ci.yml 实有四 job，M2 加的 bench 含 2 核容器管线地板，审查 F21）逐一核对。本机无法跑 `-race`（TSAN error 87 在案）——若 CI 报数据竞争，按报错栈定位修复（候选热点：monitor 包共享状态、messaging 会话）；记录首跑结论（绿/红+修复提交）入 `.superpowers/sdd/progress.md`。若用户未授权 push：本任务标记 BLOCKED-on-user，执行跳到 Task 4，授权后补跑。

- [ ] **Step 3: 台账**

progress.md 记录 run URL + 结果；无代码提交则无 commit。

---

### Task 4: Go 覆盖率收口 + Go 侧低成本修复波

**Files:**
- Test: `desktop/internal/settings/settings_test.go`（增补）、`desktop/internal/version/version_test.go`（增补）、`desktop/internal/appdir/appdir_test.go`（增补/新建）
- Modify: `desktop/internal/monitor/forms.go`（③ae.Description 回退）、`accounts.go` 或测试（⑦cap 不变量）、`snapshot_test.go`（㊟degraded wire 形状断言）、`clusterops.go`（⑫conflict elapsed 日志）+ doc 注释（⑯⑱①）
- Test: `desktop/internal/monitor/` 对应测试文件 + 新增 `connz_bench_test.go`（㉟）

**Interfaces:**
- Consumes: M5 验收 §6 覆盖率遗留（settings 72.7% / version 75.5% / appdir 71.4% → ≥80%，§20.1 门）+ Deferred Minors ①③⑦⑫⑯⑱㊟㉟。
- Produces: 三包覆盖率 ≥80%（`go test -cover` 数值入 m6-test-report）；monitor 包修复波提交。

- [ ] **Step 1: settings 增补（契约已核 settings.go:41-95；**注意 TestCorruptFileFallsBack 已存在于 settings_test.go:34——损坏回退已被覆盖，勿重复**，审查 F7。新增的是等值强化与未覆盖分支）**

```go
// TestLoadCorruptedEqualsDefault: 损坏回退的**全结构等值**强化（既有测试只断言无错+默认主题）。
func TestLoadCorruptedEqualsDefault(t *testing.T) {
	path := t.TempDir() + "/settings.json"
	if err := os.WriteFile(path, []byte(`{"behavior":`), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := Load(path)
	if err != nil {
		t.Fatalf("corrupted settings must fall back, got err: %v", err)
	}
	if st != Default() {
		t.Fatalf("corrupted settings must equal Default(), got %+v", st)
	}
	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Fatalf("corrupted file must be preserved as .bak: %v", err)
	}
}

// TestLoadNotExistsReturnsDefault（未覆盖分支：os.IsNotExist 早退）。
func TestLoadNotExistsReturnsDefault(t *testing.T) {
	st, err := Load(t.TempDir() + "/absent.json")
	if err != nil || st != Default() {
		t.Fatalf("absent settings = (%+v, %v), want (Default, nil)", st, err)
	}
}

// TestUpdateConcurrentNoLostWrite: 两个并发 Update 各改一个字段，落盘后两者都在
// （fileMu 串行化——settings.go:87 的契约半边）。
func TestUpdateConcurrentNoLostWrite(t *testing.T) {
	path := t.TempDir() + "/settings.json"
	if err := Save(path, Default()); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_ = Update(path, func(cur *Settings) {
				if i == 0 {
					cur.Behavior.PollIntervalSeconds = 7
				} else {
					cur.Behavior.RequestTimeoutSeconds = 9
				}
			})
		}(i)
	}
	wg.Wait()
	st, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Behavior.PollIntervalSeconds != 7 || st.Behavior.RequestTimeoutSeconds != 9 {
		t.Fatalf("lost write: %+v", st.Behavior)
	}
}
```

（imports 需补 `os`、`sync`。随后以 `go test ./internal/settings/ -coverprofile` 列未覆盖分支，逐个补表驱动至 ≥80%——以实际覆盖缺口为准，不预设清单。）

- [ ] **Step 2: version 增补**：`CompareVersions` 边界表（等长/不等长/前导零/预发布后缀忽略语义按现有实现锁定）、`CheckLatest` 的 ctx 取消路径（httptest 假 GitHub API：慢响应 + 1ms ctx → cancelled 类错误，无 panic）。

- [ ] **Step 3: appdir 增补（审查 F24 修正：appdir 只导出 `Dir()`/`LogsDir()`，无 ContextDir——context 目录在 natscontext 库侧，不在本包）**：`t.Setenv("APPDATA", dir)`/`LOCALAPPDATA` 驱动 `Dir()`/`LogsDir()` 各分支 + 环境缺失时的后备分支（按 appdir.go 实际后备逻辑用 unset env 驱动）；路径拼接断言。

- [ ] **Step 4: monitor 修复波（逐项）**

①③：`forms.go` ClassifyMonitorError 的 api.ApiError 分支改为 `msg := ae.Description; if msg == "" { msg = ae.Error() }` + 表驱动测试（Description 空 → 非 CodeServer 空串，用 `ae.Error()` 回退——jsm ApiError.Error() 永不空，M5 Task 3 审查在案）。
⑦：accounts_test 增 `TestAccountRowsStreamNamesCap`——构造 60 流的 AccountDetail，断言 `Streams==60 && len(StreamNames)==50`（纯函数直调）。
㊟：snapshot_test 的 `TestSnapshotNoSysPermission` 增 `b, _ := json.Marshal(snap); if bytes.Contains(b, []byte(`"servers":null`)) { t.Fatal(...) }`。
⑫：clusterops.go CodeConflict 返回前补 `s.log.Warn("cluster op rejected: in progress", "op", op, "target", target)`（G9 口径：op/target，无载荷）。
⑯⑱①：三处 doc 注释更正（StartCluster 就绪判据描述、interval() 注释与实际一致、cluster.go 头注释/Opts 注释）。
㉟：新建 `desktop/internal/monitor/connz_bench_test.go`：

```go
// BenchmarkListServerConnectionsPage: 1,024 行分页的服务端往返墙钟（G13 该子门的 bench 证据）。
// 跑法: go test ./internal/monitor/ -bench BenchmarkListServerConnectionsPage -benchtime 5x -run '^$'
func BenchmarkListServerConnectionsPage(b *testing.B) {
	f := testutil.StartSysServer(b) // testutil 助手接受 testing.TB——若只收 *testing.T，改为包一层
	...
}
```
**实现注意**：`StartSysServer` 与 `ConnectUser` 均只收 `*testing.T`（testutil/cluster.go:60/274）——bench 需要二者，**在同提交内把这两个助手签名放宽为 `testing.TB`**（零风险加宽：函数体只用 `t.Helper()`/`t.Fatal`/`t.Cleanup`，均为 TB 接口方法），bench 直呼即可（审查 F5）。1024 连接用 `ConnectUser` 循环建立。记录 ns/op 与 wall-clock 到报告。

- [ ] **Step 5: 门禁 + 提交**

Run: `cd desktop && go test ./... -count=1 -cover && go vet ./...`（不用管道截断——保 exit code，审查 F14）
核对三包覆盖率 ≥80%（不足则继续补表驱动至达标——目标值照录报告）。
Commit: `test(desktop): coverage closeout (settings/version/appdir) + monitor minor fixes (M6 Task 4)`

---

### Task 5: 性能双档实测与内存口径统一（AC-023/024）

**Files:**
- Create: `desktop/scripts/perf-sample.ps1`（采样器，Task 6/7 复用）
- Create: `desktop/scripts/perf-lowspec.ps1`（低配模拟启动器：2 核亲和 + GPU 禁用 env）
- Modify: `desktop/main.go`（GPU 禁用注入点，env 门控，3 行）
- Create: `docs/superpowers/plans/2026-09-14-nats-desktop-m6-perf.md`（实测数据表，Task 11 汇入）

**Interfaces:**
- Consumes: M2 性能基建（cmd/flood 注入器、vitest bench、既有基线：冷启动/内存 M1-M2 口径、628k msg/s 会话吞吐、前端 1 万条 136ms）；LocalServer 4333。
- Produces: §19.2 高配/低配两列实测值（Task 11 回填 spec）；采样器 CSV（列以脚本为准：`timestamp,private_mb,ws_mb,cpu_s,handles,threads`——**private 口径 = 主进程 + 全部 WebView2 子进程逐 PID 求和**，M2 §4.3 既定口径，脚本为单一事实源）。

- [ ] **Step 1: 采样器 + GPU 注入点**

`main.go`（opts 构造后、`application.New` 前）：

```go
	// Low-spec simulation lever (M6 Task 5, test-only): NATSDESKTOP_DISABLE_GPU=1
	// appends the WebView2 --disable-gpu switch for AC-024 simulated low-spec runs.
	// Never set in normal operation; see scripts/perf-lowspec.ps1.
	if os.Getenv("NATSDESKTOP_DISABLE_GPU") == "1" {
		opts.AdditionalBrowserArgs = append(opts.AdditionalBrowserArgs, "--disable-gpu")
	}
```

`desktop/scripts/perf-sample.ps1`（审查 F2/F15/F16 修正版：**进程树求和 + 真实时长退出**）：

```powershell
param([string]$ProcName = "nats-desktop", [string]$OutCsv, [int]$IntervalSec = 60, [int]$DurationMin = 0)
# Memory sampler (M6 Task 5). 口径 (M2 acceptance §4.3): private working set summed over the
# MAIN process AND all its WebView2 children (msedgewebview2.exe whose CommandLine references
# this app's WebView2 user-data dir). Main-only would read ~60MB of a ~238MB baseline.
# DurationMin 0 = run until the process exits. CSV columns are the single source of truth:
# timestamp,private_mb,ws_mb,cpu_s,handles,threads
if (-not $OutCsv) { $OutCsv = Join-Path $env:TEMP ("perf-" + (Get-Date -Format yyyyMMdd-HHmmss) + ".csv") }
$deadline = if ($DurationMin -gt 0) { (Get-Date).AddMinutes($DurationMin) } else { $null }
"timestamp,private_mb,ws_mb,cpu_s,handles,threads" | Out-File $OutCsv -Encoding utf8
while ($true) {
  $main = Get-Process -Name $ProcName -ErrorAction SilentlyContinue
  if (-not $main) { break }
  # WebView2 children of THIS app: user-data dir keyed on the exe name (wails default).
  $children = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
    Where-Object { $_.CommandLine -match [regex]::Escape($ProcName) }
  $set = @($main) + @($children | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
  $row = "{0},{1:N1},{2:N1},{3:N1},{4},{5}" -f (Get-Date -Format o),
    (($set | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB),
    (($set | Measure-Object WorkingSet64 -Sum).Sum / 1MB),
    (($set | Measure-Object CPU -Sum).Sum),
    (($set | Measure-Object HandleCount -Sum).Sum),
    (($set | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum)
  $row | Out-File $OutCsv -Append -Encoding utf8
  if ($deadline -and ((Get-Date) -gt $deadline)) { break }
  Start-Sleep -Seconds $IntervalSec
}
Write-Host "samples -> $OutCsv"
```
（子进程过滤规则：wails WebView2 的 `--user-data-dir` 指向含 exe 名的应用数据目录，CommandLine 匹配 exe 名即本 app 子进程；实现时以实际 CommandLine 抽样验证规则并记入脚本头注释。）

`desktop/scripts/perf-lowspec.ps1`：`$env:NATSDESKTOP_DISABLE_GPU="1"` → `Start-Process ..\bin\nats-desktop.exe` → `$proc = Get-Process nats-desktop; $proc.ProcessorAffinity = 0x3`（2 核）。

- [ ] **Step 2: 高配档实测（本机，§19.2 全表逐项 + §20.3-2/3 两腿）**

真服务器 4333 运行中（若未运行：按用户既有的 4333 启动方式请用户拉起——`nats-server` 不在 PATH，**不要**臆造启动命令；用户不可及时本 Step 阻塞并如实记录）。逐项执行并记入 m6-perf.md：
- **冷启动 ≤2s**：**M2 §4.2 已验证方法为主法**（审查 F26：不臆造 UIA cmdlet）——PowerShell Stopwatch 启动进程后毫秒轮询日志文件出现 `msg=ready` 与前端标记 `[AssetFileServerFS] Handling request url=/` 两个标记，5 轮取中位，每轮杀进程树；与 M1/M2 基线（中位 139ms/589ms）同口径可比。方法与标记名照录报告。
- **常驻内存 ≤300MB**：采样器（进程树口径）空载 60s + 典型负载 30min（连 4333 + Monitoring 开启 + 一个实时订阅会话 1k msg/s）双点（G3 口径）。
- **订阅吞吐 5,000 msg/s 丢帧 <5%**：`go run ./cmd/flood -url nats://127.0.0.1:4333 -subject m6perf.x -rate 5000 -size 1024 -dur 10m`（**§20.3-2 的 10 分钟持续腿**，审查 F8——M2 只跑过 60s）；会话状态条丢帧率 UIA 读数或手测 + 前端 bench 复跑，方法照录。
- **频繁连接/断开 100 次（§20.3-3，审查 F9）**：Go 侧自动化腿——新增 `desktop/internal/connections/switch_stress_test.go`：`StartSysServer` 夹具 + 两个 context（临时 settings/contexts 目录），循环 100 次 `Connect(nameA)`→等 connected→`Connect(nameB)`→等 connected，结束后断言：goroutine 数（`runtime.NumGoroutine` 前后差 <10）、Manager Snapshot 状态 connected、无 panic；超时上限 10 分钟。UIA 侧 100 次切换单列为手测矩阵行（可 WAIVED 引用 Go 腿证据）。
- **列表加载 500 streams ≤500ms**：与 Task 6 合并执行（10k 数据集下取前 500 计时），此处记执行顺序依赖。
- **滚动 ≥60fps / 反馈 ≤100ms**：UIA 不可测帧率——如实列 PENDING-MANUAL（DevTools 帧率/手动观察 + 精确路径）。
- **上屏 P95 ≤200ms 双模式（§12 原文「实时与批量分别验证」，审查 F27）**：实时与批量各一条会话各采样（M2 §4 同法：注入 + 状态条时延读数/录屏手测点），或如实登记单模式近似 + 另一模式 PENDING-MANUAL。

- [ ] **Step 3: 低配模拟档**

`perf-lowspec.ps1` 启动 → 同表跑：冷启动（≤4s，M2 §4.2 同法）、内存（≤400MB）、1,000 msg/s（60s 腿即可——§20.3-2 的 10min 腿是高配条件）、10k 行滚动（手测）、反馈 ≤100ms。全部标注「模拟（2 核 + GPU 禁用）」。

- [ ] **Step 4: 双端采样口径登记（§20.3-4，审查 F10）**

OS 级采样（Go 主进程 + WebView2 渲染进程合计）已覆盖进程面；**前端 JS 堆侧**无程序化采样（需 DevTools 在场）——登记为偏差：以 OS 进程树口径 + 「渲染进程内存即前端足迹」解释写入 m6-perf.md；如执行时桌面解锁可补 DevTools 堆快照两点（1h/24h）为增强证据，不作门禁。

- [ ] **Step 5: 提交**

Commit: `feat(desktop): perf samplers + lowspec lever + AC-023/024 measurements (M6 Task 5)`（脚本 + main.go 3 行 + switch_stress_test.go + m6-perf.md；vitest bench 复跑结果照录）

---

### Task 6: 压力数据集与大数据集实测（AC-028 + §20.3）

**Files:**
- Create: `desktop/cmd/loaddata/main.go`（test-only 工具：预置 10k streams / 1M 消息流 / 100k KV keys）
- Create: `desktop/scripts/load-1m.sh`（或并入 loaddata 子命令）
- Test: `desktop/cmd/loaddata/main_test.go`（轻量：参数校验 + 小规模烟测）

**Interfaces:**
- Consumes: LocalServer 4333（JS 开启）；jsadmin/messaging 既有 API；Task 5 采样器。
- Produces: 4333 上的预置数据集（Task 7 典型负载复用）；AC-028 两项预期实测值入 m6-perf.md。

- [ ] **Step 1: loaddata 工具（TDD 轻量）**

```go
// cmd/loaddata: test-only dataset presetter (M6 Task 6, AC-028/§20.3).
// Usage: loaddata -url nats://127.0.0.1:4333 -streams 10000 -million 1 -kvkeys 100000
// Creates N named streams, one stream with M messages (256B payload, batched publish),
// and a KV bucket with K keys. Idempotent per name (skips existing). Ctrl-C safe.
package main
```
实现要点（审查 F4 修正）：
- **流预置幂等**：每名先 `if _, err := mgr.LoadStream(name); err == nil { continue }`（streams.go:194 探测）再 `mgr.NewStream("LOAD_S%05d")`——10k 流预置分钟级可能被中断重跑，跳过已存在是硬需求。
- **1M 消息**：`js.Publish` 批 500/批 + 每 10 万打印进度。
- **KV 桶先建后用**：`js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{Bucket: "LOAD_KV", History: 1})`（kv.go:534——`jetstream.KeyValue` 只绑定已存在桶，首跑必 404），随后 `kvs.Put(ctx, []byte("v%06d"), key)` 循环 100k。
- 全程 `-url` 默认 4333。烟测：`-streams 5 -million 100 -kvkeys 50` 连内嵌临时服务器断言数量（`jsm.StreamNames` 计数 + `js.StreamNames` / `kvs.Keys` 计数）。

- [ ] **Step 2: 预置 + 实测**

4333 上跑全量预置（预计分钟级，进度可见）。逐项实测记 m6-perf.md：
- Streams 列表 10k 行：加载计时（Go 侧 `List` 计时 + UIA 打开 Streams 页首帧计时）；任意位置跳转 ≤1s（虚拟列表滚动到手测行，DevTools/PENDING-MANUAL 如实标注）；500-stream 子集计时回填 Task 5 的列表加载项。
- 1M 消息流浏览器翻至尾页：尾页加载 ≤1s（高配）——Go 侧 `BrowseStream` 尾页取数计时 + UI 侧 UIA 计时。
- 100k KV 键分页：键列表加载计时（既有 1k 键 22.8–38.1ms 基线外推上界，实测照录）。

- [ ] **Step 3: 提交**

Commit: `feat(desktop): loaddata dataset tool + AC-028 large-dataset measurements (M6 Task 6)`

---

### Task 7: 24 小时长稳（AC-025，挂机过夜）

**Files:**
- Create: `desktop/scripts/soak.ps1`（编排：启动 + 导航循环 + 采样 + 结束判定）
- Create: `docs/superpowers/plans/2026-09-14-nats-desktop-m6-soak.md`（收数报告）

**Interfaces:**
- Consumes: Task 5 采样器；4333 + Task 6 数据集（典型负载：1k msg/s 持续注入 + Monitoring 轮询开启）；M5 UIA 导航按钮点击模式。
- Produces: 24h 判定三件套：无崩溃（进程存活 + WER 无新记录）、内存 1h vs 24h 增长 ≤10%（private 口径）、句柄/线程无持续增长（线性回归斜率≈0 或目测平稳）。

- [ ] **Step 1: soak.ps1 编排（审查 F3/F17 修正：flood 真实旗标 + 订阅会话腿）**

```powershell
# soak.ps1: 24h stability harness (AC-025). Launches the app connected to 4333,
# creates ONE realtime subscription session on the flood subject (§12 典型负载 = 1 连接
# + 1 订阅会话 + 监控轮询——会话环缓冲/事件管线是最易漏的子系统，不可缺),
# cycles the sidebar nav every 60s via UIA, keeps a 1k msg/s flood running,
# samples the process tree every 60s (perf-sample.ps1), and writes a verdict at the end.
param([int]$Hours = 24)
$nav = @("dashboard","messages","streams","consumers","kv","objects","monitoring","settings")
# 0) 构建 flood 并显式引用（flood 旗标是 -url/-subject/-rate/-size/-dur——cmd/flood/main.go:85-91）
go build -o bin\flood.exe .\cmd\flood
# 1) 启动 flood: Start-Process ..\bin\flood.exe -ArgumentList "-url","nats://127.0.0.1:4333","-subject","soak.load","-rate","1000","-size","1024","-dur","$($Hours)h"
# 2) 启动 app（连 4333 的 context）
# 3) 采样器后台: Start-Job ..\perf-sample.ps1 -IntervalSec 60
# 4) UIA 创建订阅会话: Messages 页 → Sessions → New Session → subject=soak.load → 实时模式（M5 冒烟同款 UIA 定位）
# 5) 导航循环: 每 60s UIA 点下一个导航项（锁屏下 UIA 可用，M3–M5 已证；定位器读 task-14-m5-report 冒烟段）
# 6) 结束: $Hours 后停 flood/app，输出判定（1h 点 vs 末点 private 差 / 首点，句柄/线程首末对比，会话累计计数仍在增长=管线活着）
```
**实现注意**：导航按钮的 UIA 定位用 M5 冒烟脚本已验证的 name/testid 模式（执行者读 `.superpowers/sdd/task-14-m5-report.md` 的冒烟段取实际可用定位器）；锁屏下 UIA 点按已验证可用（M3–M5）。

- [ ] **Step 2: 挂机执行**

启动 soak.ps1 → 机器挂机 24h（G8：用户已知晓）。期间不接受其他重负载。

- [ ] **Step 3: 收数判定**

m6-soak.md 照录：采样 CSV 摘要（首/1h/6h/12h/24h 五点表）、三件套判定、异常事件（若有：时间点 + 日志摘录——日志只含 subject/size/计数，G5 口径）。任一不达标注并按 §12.1 排查（内存增长超 10% → 按 goroutine/缓存点定位，pprof 可临时加——若需改产品代码则单独 fix 提交）。
Commit: `test(desktop): 24h soak harness + AC-025 verdict (M6 Task 7)`

---

### Task 8: 前端 Minor 修复波 + 无障碍 + 截图基线（AC-026 + AC-022 复验）

**Files:**
- Modify: `desktop/frontend/src/features/monitoring/{ServerTable.tsx,NodeDetail.tsx,ConnectionsTop.tsx,EventsPanel.tsx,DangerZone.tsx}`、`features/dashboard/{AdvisoryList.tsx,DashboardPage.tsx}`、`lib/`（新 `format.ts` 统一格式化器）
- Test: 对应 `tests/*.test.tsx` 增补
- Create: `desktop/scripts/screenshots.ps1` + `docs/screenshots/v1.0/`（32 张基线）

**Interfaces:**
- Consumes: M5 Deferred Minors ⑲㉑㉒㉓㉔㉖㉛㉜；AC-026（双主题×双语言）、AC-022（键盘路径）。
- Produces: 修复波提交 + 32 张截图基线 + 无障碍走查记录（入 m6-test-report）。

- [ ] **Step 1: 修复波（逐项小改 + 每项至少一条断言）**

⑲ ServerTable/ConnectionsTop 行 `role="button"` 补 Space 键（onKeyDown 加 `e.key === " "`）。
㉑ ConnectionsTop 非 cid 键首屏 aria-sort 修正：初始即按服务器语义标 `descending`（cid 标 ascending），toggle 逻辑同步——测试断言初始 aria-sort。
㉒ 传输 throw 一致化：ConnectionsTop/AccountsPanel 的 catch 改为保留现有数据 + toast（不清空列表）——与 NodeDetail 错误卡行为对齐；测试注入 reject 断言列表保留。
㉓ NodeDetail 错误卡补重试按钮（复用 refresh 入口）。
㉔ `lib/format.ts`：`formatBytes(bytes, {maxUnit:"TiB"})` 单实现（B→TiB 阶梯），ConnectionsTop/AccountsPanel/NodeDetail 统一引用；formatBytes 单测表（0/B/KiB/MiB/GiB/TiB/负数不出现）。
㉖ EventsPanel create 失败 toast 限频：同类错误 5s 内只 toast 一次（ref 时间戳）。
㉛ AdvisoryList.pushAdvisory 改为委托 EventsPanel.pushEvent（cap 参数化）。
㉜ DashboardPage aria-valuenow 钳制 `Math.min(100, ...)`。

- [ ] **Step 2: 无障碍走查（AC-026 半边 + AC-022 复验）**

键盘路径：Ctrl+K 面板 → Streams → 某流 → 消息浏览器全程键盘（UIA/手测，M1 已过——复验记录）；8 页面 Tab 顺序/焦点环/Escape 关闭抽查。对比度：PowerShell 脚本算 tokens.css 关键组合（fg/bg-panel、fg-muted/bg-panel、danger/bg-panel）WCAG 比值 ≥4.5 记录；不足项修复 token 或记录豁免理由（大字号 3:1）。零 critical 违规判定照录。

- [ ] **Step 3: 截图基线（AC-026 另半边，G11 参考集）**

`screenshots.ps1`：对 8 页面 × 2 主题 × 2 语言（设置切 theme/lang → UIA 导航 → `CopyScreen`/Graphics.CopyFromScreen 存 PNG）→ `docs/screenshots/v1.0/{page}-{theme}-{lang}.png` 共 32 张。命名含构建版本。README/docs 注明参考集性质。**执行条件（审查 F18）：必须在解锁的交互桌面运行**——锁屏下 CopyFromScreen 捕获锁屏/黑帧，主题与语言切换也依赖真实 UI 交互；执行时与用户协调解锁窗口，不可解锁则 32 张列 PENDING-MANUAL 交还用户。

- [ ] **Step 4: 门禁 + 提交**

Run: `cd frontend && npx vitest run --maxWorkers=2 && npx tsc --noEmit && npm run build`（+ Go 全量，因 ⑲ 等触碰 tsx 无 Go 改动仍跑防意外）。
Commit: `fix(desktop): frontend minor wave + a11y pass + screenshot baseline (M6 Task 8)`

---

### Task 9: 打包发布线（NSIS + 便携 zip + SHA256 + 安装冒烟 + README）

**Files:**
- Modify: `desktop/Taskfile.yml` 或 `desktop/build/windows/Taskfile.yml`（新增 `package:portable` 任务）
- Create: `desktop/scripts/make-release.ps1`（打包 + zip + SHA256 + 体积断言）
- Modify: `desktop/README.md`（发布章节）
- Test: 人工/脚本冒烟记录入 m6-test-report

**Interfaces:**
- Consumes: Task 1（版本注入与元数据）、Task 2（bindings 一致）；TODO-002 裁决（默认不签名）。
- Produces: `desktop/bin/dist/` 下 NSIS 安装包 + 便携 zip + SHA256SUMS.txt（体积 ≤30MB 断言）；README 发布章节。

- [ ] **Step 0: 机器前置（审查 F23：NSIS 本机未装，`where makensis` 为空）**

安装 NSIS ≥3.x（winget `NSIS.NSIS` 或官网下载），确认 `makensis` 入 PATH；`wails3 generate webview2bootstrapper` 首跑需网络。前置不满足时本任务 BLOCKED-on-user（如实记录，不跳过验收）。

- [ ] **Step 1: 构建 + NSIS**

```powershell
cd desktop
wails3 task windows:build VERSION=1.0.0
wails3 task windows:package INSTALL_SCOPE=user VERSION=1.0.0   # per-user 免 UAC（G14 决策）
```
Expected: `bin/` 产出 `nats-desktop-amd64-installer.exe`（wails NSIS 模板命名按实际照录）。

- [ ] **Step 2: 便携 zip + SHA256 + 体积断言**

`make-release.ps1`：

```powershell
# 1) portable zip: exe + README-portable.txt（免安装说明 + SmartScreen 提示）
Compress-Archive -Path bin\nats-desktop.exe -DestinationPath bin\dist\nats-desktop-1.0.0-portable.zip
# 2) checksums
Get-FileHash bin\dist\* -Algorithm SHA256 | ForEach-Object { "{0}  {1}" -f $_.Hash, (Split-Path $_.Path -Leaf) } | Out-File bin\dist\SHA256SUMS.txt -Encoding ascii
# 3) size gate (§12 ≤30MB, hard fail)
$oversize = Get-ChildItem bin\dist\*.exe, bin\dist\*.zip | Where-Object { $_.Length -gt 30MB }
if ($oversize) { throw "size gate FAIL: $($oversize.Name)" } else { Write-Host "size gate PASS" }
```

- [ ] **Step 3: 安装/卸载冒烟**

NSIS 静默：`./nats-desktop-amd64-installer.exe /S` → 等待 → 断言安装目录 exe 存在 + 开始菜单/桌面快捷方式（按模板实际）→ 启动 1 次（UIA 主窗可见）→ 卸载 `uninstall.exe /S` → 断言目录清除、注册表 Uninst 键消失。照录 m6-test-report（含失败分支处理）。

- [ ] **Step 4: README 发布章节**

安装（NSIS/便携）、系统要求（Win10+ x64、WebView2 Runtime 说明）、**SmartScreen 警告说明 + SHA256 校验步骤**（TODO-002 默认不签名的原文应对）、明文凭证风险（既有章节校对）、语言切换、更新检查 opt-in 说明。
Commit: `feat(desktop): release packaging line - nsis/portable/sha256/README (M6 Task 9)`

---

### Task 10: 手测矩阵汇总执行 + AC-030 终扫

**Files:**
- Create: `docs/superpowers/plans/2026-09-14-nats-desktop-m6-manual-matrix.md`
- Create: `desktop/scripts/security-sweep.ps1`（凭证/载荷日志终扫）

**Interfaces:**
- Consumes: M1–M5 六份验收记录的全部 PENDING-MANUAL/待执行/回填区行；M2 trace import/export 与 ErrTimeout 手测移交；M5 降级 live 腿重跑义务；AC-030。
- Produces: 手测矩阵文档（每行：来源里程碑/条目/结果/执行人日期）；终扫脚本与结果。

- [ ] **Step 1: 汇总 checklist**

从六份 acceptance 文档 grep `PENDING-MANUAL|待执行|回填区` 生成矩阵初稿（预期 ≈15–25 行，含：M2 滚动流畅度/上屏视觉面、M3 截图/PENDING 2 行、M4 对象选择器 3 腿、M5 降级 live 腿/断节点标红实拍/像素配色核对、AC-026 键盘路径等——以 grep 实际产出为准）。

- [ ] **Step 2: 逐条执行（能自动则自动）**

每行三态：EXECUTED（附截图/计时/结果）/ LIVE-待办（需用户在场，列精确步骤交还）/ WAIVED（附理由）。重点腿：
- **M5 降级 live 腿重跑**：app 用户 context 连 4333 → Monitoring 页降级横幅显示服务器原文（I-1 修复后的真腿验证，M5 复审遗留义务）。
- **AC-015 断节点标红实拍**：testcluster 跑 3 节点 → 杀 1 节点 → 截图红行。
- **M2 trace import/export 手测** + **ErrTimeout 部分结果手测**（按 m5-acceptance §5 精确路径）。
- **AC-027 更新检查显式腿（审查 F12——不再「顺带」）**：Task 1 的版本注入让模拟高版本变得轻易——`wails3 task windows:build VERSION=0.0.9` 构建后启动（远端无 >0.0.9 的 release，`CheckLatest` 必判 HasUpdate）→ 断言出现一次可关闭的新版本通知含下载链接；检查失败静默腿已有 M1 自动化。**注意 M1 在案已知缺陷**：「启动 emit 竞态（前端未挂载时事件丢失）未接线兜底」（m1-acceptance §5-7）——若通知偶发不出现，先按该竞态归因排查而非误判回归，结果如实记录。

- [ ] **Step 3: AC-030 终扫**

`security-sweep.ps1`：
```powershell
# 1) 源码扫: 凭证形状字符串进 log 语句（password|token|creds|jwt|private_key 邻近 log/Printf/Info/Warn/Error）
# 2) 日志样本扫: %APPDATA%\nats-desktop\logs\*.log 中 grep -i 'password|token|-----BEGIN'
# 3) 设置页掩码复验: UIA 断言 creds 字段显示为掩码
```
Expected: 源码扫零命中（命中即修+复扫）；日志样本零凭证明文。
Commit: `chore(desktop): manual matrix closeout + AC-030 security sweep (M6 Task 10)`

---

### Task 11: 验收收口文档（§25 回填 + §21 checklist + TODO 表 + m6 验收/测试报告）

**Files:**
- Modify: `docs/superpowers/specs/2026-09-11-nats-desktop-v1-spec.md`（§19.2 实测列、§24 TODO 状态、§25 验收结论、版本记录 v1.1→v1.2）
- Create: `docs/superpowers/plans/2026-09-14-nats-desktop-m6-acceptance.md`、`2026-09-14-nats-desktop-m6-test-report.md`

**Interfaces:**
- Consumes: 全部前置任务产出（m6-perf/soak/manual-matrix、打包产物、CI 记录、覆盖率数值）。
- Produces: v1.0 发布判定的最终文档集。

- [ ] **Step 1: spec 回填**——§19.2 表九行实测值（高/低配列）；§24 TODO-001..005 状态更新（Resolved + 裁决内容）；§25 验收结论按模板勾选；版本记录加 v1.2 行（变更：M6 实测回填与 TODO 关闭）。
- [ ] **Step 2: m6-acceptance.md**——AC-022/023/024/025/026/027/028/030 逐条映射（自动腿证据/手测腿结果）；§21 十三项 checklist 逐项勾选 + 证据指针；G1–G15 约束核对表；Deferred Minors 全量处置表（Task 4/8 已修项 + 其余 DEFER 理由——从 progress.md 滚存清单生成，**逐条有去向**）；裁定记录（截图基线参考集、低配模拟口径、命名/签名/DSN/平台四 TODO 裁决、内存口径）。
- [ ] **Step 3: m6-test-report.md**——四层测试汇总（单测计数/覆盖率表/双档性能表/长稳/压力数据集/UIA+手测矩阵计数）；CI 首跑记录（或 BLOCKED 状态如实）；构建产物清单（installer/zip/SHA256/体积）；遗留清单（v1.1 候选）。
- [ ] **Step 4: 终门禁 + 提交**

Run: `cd desktop && go test ./... -count=1 && go vet ./... && cd frontend && npx vitest run --maxWorkers=2 && npx tsc --noEmit && npm run build`
Commit: `docs(desktop): M6 acceptance closeout - spec backfill, checklists, reports (M6 Task 11)`

---

## 自查记录（writing-plans Self-Review + reviewing-plans 审查闭环）

1. **Spec 覆盖**：§21 十三项 → T1(版本/元数据)+T2(bindings)+T3(CI)+T4(覆盖率)+T5(性能)+T6(集成/压力)+T7(稳定性)+T8(UI 交互/无障碍)+T9(安装包/文档)+T10(手测矩阵)+T11(回滚确认[文档项]/验收结论)——逐项有任务；§12 双档与 §19.2 表 → T5/T6/T7/T11；§20.3 六项 → T5(10min 腿+100 切换)/T6(压力数据集)/T7(长稳+双端口径登记)；AC-022/023/024/025/026/028/030 → T5/T7/T8/T10；**AC-027 → T10 显式腿**（VERSION=0.0.9 构建模拟高版本 + M1 emit 竞态在案提示）；§22 回滚方案确认为 T11 文档核对项（无服务端可回滚，§22 原文即文档性确认）；§24 TODO → 执行前置裁决块 + T1/T9/T11 落地。
2. **占位符扫描**：无 TBD；所有「以 grep/实测为准」的动态清单点（T10 Step1、T2 Step1 报错行号）均给出确定性的生成方法与预期形态，非空指令。
3. **类型一致性**：无跨任务新符号依赖（T5 采样器 CSV 列名固定供 T7 复用；T8 `lib/format.ts:formatBytes(bytes, opts)` 单点定义；T6 loaddata 仅 CLI 出口）。
4. **操作维度覆盖**：容量（§12 双档→T5/T6 bench+实测）；失败（CI 红→T3 修复路径；长稳不达→T7 排查路径）；可观测（T7 采样 CSV + 日志口径；T10 终扫）；完整性（SHA256→T9；bindings 一致性→T2）。

## 审查记录（reviewing-plans，报告 `.superpowers/sdd/m6-plan-review.md`）

只读审查代理报告 **2C/11I/14M**（其中 7 项 plan-mandated），控制器逐条对源码/模块缓存复核后全部坐实并修入计划：

- **C1/F1 生成器模式错配**：构建链 Taskfile.yml:191 用 `-ts -i`（接口模式，slice 全可空）而计划命令漏 `-i`（类模式）——复现步永不红、提交树对构建路径永非 no-op。→ Task 2 重写为 Step 0 模式对齐（`wails3 task common:generate:bindings BUILD_FLAGS='-tags production'`），Step 3 同命令二次 regen 的 no-op 证明才成立。
- **C2/F2 采样器只测主进程**：WebView2 六子进程占既有 238.4MB 口径的 ~75%——AC-023/024 内存门空转、AC-025 增长检测失明。→ 采样器重写为进程树求和（Win32_Process CommandLine 过滤本 app 子进程）。
- **I 系列**：F3 soak flood 旗标错（-s/-sub→-url/-subject）+ 先 build flood；F4 loaddata KV 须 CreateOrUpdateKeyValue + LoadStream 探测幂等；F7 settings 损坏回退已有测试（改等值强化+新分支）；F8 §20.3-2 的 5k×10min 腿补入 T5；F9 §20.3-3 的 100 次切换腿补入 T5（Go 侧 switch_stress_test 自动化）；F12 AC-027 显式腿入 T10（含 M1 emit 竞态在案提示）；F15 CSV 列名以脚本为单一事实源；F16 DurationMin 真死线退出；F17 soak 补订阅会话腿；F23 NSIS 机器前置 Step 0；F26 冷启动改用 M2 §4.2 已验证方法。
- **Minor 系列**：F5 testutil 助手放宽 testing.TB；F6/F20 版本验证点与双源同 bump 不变量；F10 双端采样登记偏差（T5 Step 4）；F11 §21 十三项（非十二）；F14 门禁去管道截断；F18 截图须解锁会话；F21 CI 四 job；F22 4333 拉起不臆造命令；F24 appdir 无 ContextDir；F25 T2 Step 3 为显式门禁；F27 上屏 P95 双模式。
- 保留裁定（审查认可为诚实偏差）：F13 截图基线参考集（G11）、低配模拟口径（G10）、G6 零依赖（无障碍不引 axe 的理由在案）。
