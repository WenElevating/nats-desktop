# NATS 桌面客户端 M6 验收记录（发布收尾里程碑）

- 日期：2026-09-15；分支 `desktop/m6`（M6 Task 11 收尾时 HEAD：`99f29c6` + 本验收文档提交）
- 结论：**有条件通过（附已知限制）**——已同步回填 spec §19.2 / §24 / §25（spec v1.2，2026-09-15）。**两项 FAIL 如实并列，发布决策显式留给维护者。**
- 证据体系：双档性能实测 `2026-09-14-nats-desktop-m6-perf.md`（下称 perf）；24h 长稳 `2026-09-14-nats-desktop-m6-soak.md`（下称 soak，§8 实跑回填）；手测矩阵 `2026-09-14-nats-desktop-m6-manual-matrix.md`（下称 matrix）；测试报告 `2026-09-14-nats-desktop-m6-test-report.md`（下称 test-report）；任务报告 `.superpowers/sdd/task-*-m6-report.md`；台账 `.superpowers/sdd/progress.md` M6 段。

---

## 1. AC 逐条映射（§19.1 验收标准 ↔ 证据）

判定口径：**PASS**（验收预期达成，证据在案）/ **FAIL**（实测不达，如实记录）/ **PENDING-MANUAL**（需解锁桌面/远端前提，精确步骤已备，不冒充已测）。混合状态逐腿拆分标注。

### AC-022 命令面板与操作效率 —— **PASS（核心腿）/ 剩腿 PENDING-MANUAL**

| 腿 | 证据 | 判定 |
|---|---|---|
| Ctrl+K → Streams → 消息浏览器纯键盘路径 | M1 人工全键盘通过记录（有效基线）；M6 T8 真应用 UIA 复验：`scripts/uia-keyboard-path.ps1` leg 1 **PASS**（含 toggle 状态探测） | PASS |
| 常用操作 ≤3 击 / ≤5 键可达 | 组件级证伪测试在案（M1–M5 持续回归：palette/导航/表单入口）；M6 T8 补齐 6 处 role=button 行 **Space 与 Enter 同权**（ServerTable/SessionView/KeyList/KeyValuePage/StreamList/StreamMsgs，含 preventDefault 断言）+ radix Dialog Escape 关闭测试 | PASS |
| 全程键盘复验 + IME 中文输入走查 | 本测量主机活动中文 IME 拦截合成文本输入（字母进组合窗，与 M2–M5「全程不使用合成鼠标/键盘」约束同因）；脚本就绪（`uia-keepalive.ps1` + `uia-keyboard-path.ps1`），换英文布局桌面即可重跑 | **PENDING-MANUAL**（matrix #38） |

### AC-023 高配性能档 —— **FAIL（常驻内存项；其余 PASS，附 PENDING-MANUAL 腿）**

| §12 指标 | 实测 | 判定 |
|---|---|---|
| 冷启动 ≤2s | ready **155ms** / frontend 618ms（5 轮中位，M2 同法） | PASS（perf §1.1） |
| 常驻内存 ≤300MB（空载 60s） | private 231.4–245.2MB（无连接）/ 266.9MB（已连接） | PASS（perf §1.2） |
| 常驻内存 ≤300MB（典型负载 30min） | 实时逐条推送稳态 **1,376–1,551MB**（修复前）→ 合流修复后中位 **1,293.7MB**（窗口前台可见、负载更重口径）；renderer 面为主，V8 已提交堆不归还 OS | **FAIL**（perf §1.5/§7；~4.3–5× 门禁） |
| 5,000 msg/s × 10min | 会话均值 4,973 msg/s（**99.5%**）、守恒精确（丢弃=总量−10,000 整）；**7m45s 保护性中止**（主机 commit 37.5/40.3GB，护机护 4333，如实照录）；负载内存峰值 6,965MB | 速率 PASS / 内存 **FAIL**（perf §1.5 腿 B） |
| 列表加载 500 streams ≤500ms | 前 500 取数 **34–37ms**（10k 数据集在位） | PASS（perf §6.2） |
| 100 次连接切换无泄漏 | Go 腿 `TestSwitchStress100Cycles`：100 轮 4.44s，goroutine delta **0** | PASS（perf §1.3；UIA 腿可 WAIVED 引用） |
| 滚动 ≥60fps / 操作反馈 ≤100ms / 上屏 P95 ≤200ms | 帧级判读需 DevTools/录屏（锁屏不可用）；自动化近似在案：UIA 反馈上限估计 80ms、10k 行冷挂载 mean 15.9ms、会话层守恒 1:1 | **PENDING-MANUAL**（perf §S3-1/2/3/4） |

**AC-023 总判定：FAIL（内存项）**—— breach 集中在实时逐条推送前端渲染管线；缓解杠杆在案（批量模式 653.8MB，-52%）；详见 §5 裁定 6。

### AC-024 低配性能档 —— **FAIL（负载内存项，同高配机理；其余 PASS）**

口径：**模拟**（2 核 `ProcessorAffinity=0x3` + `NATSDESKTOP_DISABLE_GPU=1`；GPU 禁用经子进程 CommandLine 实证：gpu-process 21.3MB vs 硬件 103MB）。

| 指标 | 实测 | 判定 |
|---|---|---|
| 冷启动 ≤4s | ready 中位 **203ms**（5 轮） | PASS（perf §2.1） |
| 空载内存 ≤400MB | 174.7–177.6MB | PASS（perf §2.2） |
| 1,000 msg/s × 60s 吞吐 | 59,909 发 = 59,909 收 **1:1 精确**，速率 99.5–99.8% | PASS（perf §2.3） |
| 负载内存 ≤400MB | 峰值 **741.5MB**（实时逐条推送） | **FAIL**（同高配机理；60s 腿按 brief 执行，30min 完整腿列 PENDING-MANUAL） |
| 列表加载 ≤1,500ms | 同 Go 腿 34–37ms | PASS（perf §6.2） |
| 10k 滚动 ≥30fps | 帧级 PENDING-MANUAL（perf §S3-1） | PENDING-MANUAL |

### AC-025 24 小时稳定性 —— **FAIL（如实记录）**

- 实跑 2026-09-14 22:11 → 09-15 15:42，**17.5h 处崩溃**（exit 3 崩溃路径真实触发；harness 守卫 d4ffab9 在位）。判定与五点表、三件套、崩溃序列全文见 **soak §8 实跑回填**。
- **三层缺陷链**：① 应用文件日志开跑 57min 后静默冻结（165KB 远未轮转，此后 16h 零写入——§13 可诊断性契约破坏，疑 logger 路径死锁/写入 goroutine 消失）；② 进程树 private **157MB → 16,018MB 线性增长**（~870MB/h 无平台期；线程/句柄走平，非句柄泄漏）；③ 15:31 一个 WebView2 子进程死亡 → UI 失效（7 次连续 UIA MISS）→ 15:42 宿主**静默退出无 WER**（提交耗尽下 runtime 致命退出特征；与 M4 缺陷#4 同族归因）。
- 崩溃前功能正常：nav 循环照常至 15:30、会话计数持续增长（733k+ 条流经管线）、flood 达成率 99.8–99.9%。
- 短档验证跑（6min/30min，T7）全部 PASS：nav 全命中、守恒精确、句柄/线程平稳（soak §5）。
- **判定对照预期**：「无崩溃」FAIL；「内存较 1h 点增长 ≤10%」FAIL（1h 点 ≈1,288MB → 末点 16,018MB，≫10%）；「无资源泄漏」FAIL（内存面）。三项全不达。

### AC-026 无障碍与截图回归 —— **半边 PASS（对比度/语义树/键盘）/ 截图基线 PENDING-MANUAL**

| 腿 | 证据 | 判定 |
|---|---|---|
| 对比度扫描（零 critical） | `scripts/contrast-check.ps1` 实跑（WCAG 2.x）：8 组关键 fg/bg 对**全部 ≥4.5:1**——最差 4.56:1（light fg-muted），无豁免项、零 FAIL（T8 §4） | PASS |
| 无障碍语义树 | 真应用 UIA 走查：主导航 8 页、上下文菜单、会话 chip（速率/计数实时刷新）、表格行角色均以可访问名正确暴露 | PASS |
| 键盘可达（效率半边） | 见 AC-022（Ctrl+K 真应用 PASS + Space/Enter 同权组件测试） | PASS |
| 截图基线对比（32 张） | `scripts/screenshots.ps1` 就绪（8 页 × 2 主题 × 2 语言；均色/黑帧检测防锁屏废片；构建版本 README）；按 F18 执行条件（解锁交互桌面）**未执行**。裁定：基线=参考集非门禁（G11），像素 diff 门禁列 v1.1 | **PENDING-MANUAL**（matrix #39） |

### AC-027 更新检查 —— **自动化逻辑达标 / 显式腿需远端 release（首发后复验）**

- **自动化腿**：`TestCheckLatestTimeoutIsSilentError`（失败静默）+ CheckLatest 语义测试（空 tag/取消 ctx/版本比较锁定）全绿——「检查失败时无任何干扰」达标。
- **显式腿（0.0.9 构建 → 必判 HasUpdate → 一次可关闭通知）**：前提失效——远端仓库**无任何 release**，post-soak 实测多次启动 `update check: status 404`（日志 ERROR 两条、无通知出现=静默语义符合）。该腿需远端先发布 >当前版本的 release（matrix #6 LIVE-待办）。
- **在案归因提示**：若通知偶发不出现，先按 M1 §5-7 已知「启动 emit 竞态（前端未挂载时事件丢失）未接线兜底」归因，勿误判回归。
- **裁定**：见 §5 裁定 5。

### AC-028 大数据集 —— **PASS（取数/跳转/尾页门全部达标；滚动帧率腿 PENDING-MANUAL）**

| 门 | 实测 | 判定 |
|---|---|---|
| 10k streams 列表加载 | 应用路径 643–778ms（10,002 流全量含 State；应用 5s 默认超时不触）；**前 500 = 34–37ms**（§12 两档门 13–22× 余量）；UIA 首帧 894–1,166ms（虚拟化：10,002 流仅 93 个行级 UIA 元素） | PASS（perf §6.2/§6.5） |
| 1M 消息流浏览器尾页 ≤1s | Go 全路径 11–67ms（~15× 余量）；UIA 652–688ms | PASS（perf §6.3/§6.5） |
| 任意位置跳转 ≤1s | 搜索跳转 70–78ms（近似）；滚动手测腿 PENDING-MANUAL（perf §6.5/§S3） | 近似 PASS / 帧级 PENDING-MANUAL |
| 关联：KV 100k 键 | Go 231–279ms + 首页值补齐 9–12ms；UIA 141–382ms | PASS（perf §6.4） |
| 数据集 | 4333 在位：10,002 流 / 1M×256B / 100k KV 键（loaddata 幂等预置 5m57.4s，工具+烟测入库） | 在案（perf §6.0） |

### AC-030 凭证脱敏与日志洁净 —— **PASS（F-1 缺陷已修复；修复的 UIA 复验留下一解锁窗口）**

| 腿 | 证据 | 判定 |
|---|---|---|
| 源码扫（密码/token 不入日志） | `scripts/security-sweep.ps1` 腿 1：52 个非测试 .go 文件凭证形状词 × log 调用同行 **0 命中**；另做 multi-line 人工复核（RedactContext 为控制本体：password/token/user_jwt/user_seed/nkey 恒掩码 `***`，creds/cert/key/ca 仅存路径，URL userinfo 剥离 fail-closed） | PASS |
| 日志样本扫 | 腿 2：`%APPDATA%\nats-desktop\logs\*.log`（含长稳运行期实时日志）`password\|token\|-----BEGIN` **0 命中** | PASS |
| 设置页掩码复验 | 腿 3（`-UiaMaskCheck`）：password 字段 `IsPassword=True` PASS；**token 字段明文（IsPassword=False）→ 记缺陷 F-1** → **已修复**（`99f29c6`：`ctx-token` 默认 `type="password"` + Eye/EyeOff 切换 + 证伪测试，临时移除掩码测试即红） | PASS（修复后）；UIA 复验属 LIVE 腿，留下一窗口会话确认 `IsPassword=True` |

---

## 2. §21 发布要求十三项 checklist

| # | 发布要求 | 判定 | 证据指针 |
|---|---|---|---|
| 1 | 功能开发完成（§4.1 全表） | ✅ | M1–M6 六里程碑全部任务闭环（progress.md）；八页功能 AC-001~021 实测在案（各里程碑 acceptance） |
| 2 | 单元测试通过（覆盖率门槛达标） | ✅ | Go 全量套件全绿（14 包）+ vet 净；§20.1 三包门 settings 97.0 / version 90.6 / appdir 92.9（≥80）；前端 83.45% + kv 88.88%（≥70）；vitest 309/309。详见 test-report §4 |
| 3 | 集成测试通过（内嵌服务器全链路 + 3 节点集群） | ✅ | LocalServer 全链路 4333 真服务器实测贯穿 M6 全部测量；testcluster 三节点集群 UIA 冒烟 6/6 LIVE（M5）；CI 集成 job 绿 |
| 4 | 性能测试通过（双档全指标，AC-023/024） | ✅ 附 FAIL 注记 | 冷启动/空载内存/吞吐/列表加载/安装包 PASS；**常驻内存典型负载子项 FAIL 如实记录**（spec §19.2/§25）；滚动/反馈帧级/上屏 P95 PENDING-MANUAL |
| 5 | 稳定性测试通过（AC-025） | ❌ **FAIL** | 24h 长稳 17.5h 崩溃（soak §8）：日志冻结 + 内存线性增长 + 静默退出；v1.1 方向已登记（§5 裁定 6）。**本项为「有条件通过」的直接来源** |
| 6 | UI 交互测试通过（AC-022/026） | ✅ 附 PENDING-MANUAL 注记 | 对比度 8/8 ≥4.5:1 零豁免；UIA 语义树走查过；键盘核心腿过；32 张截图基线 + 键盘/IME 复验为 PENDING-MANUAL（matrix #38/#39） |
| 7 | 日志完整（§13 契约实现） | ✅ 附注记 | §13.3 聚合口径实测在案（M1–M6 各冒烟）；RedactContext 脱敏契约有测试。**注记**：长稳 57min 处日志冻结缺陷随 AC-025 FAIL 一并登记（v1.1 整改项），短档运行无此现象 |
| 8 | 配置正确（§15 全项生效与持久化） | ✅ | settings.json 持久化/损坏回退/.bak 防线实测（T10 观察①；settings 包 97% 覆盖）；主题/语言/确认级别即时生效 + 重启保持（M1–M3 冒烟） |
| 9 | 协议版本确认（nats-server 兼容矩阵 §17.2） | ✅ | nats-server v2.15.0-preview.1（内嵌/3 进程集群/4333 常驻）+ 2.10.x（CI）全链路实测在案 |
| 10 | 向后兼容确认（context 与 natscli 互操作 AC-003） | ✅ | M1 三步互操作 LIVE-PASS（CLI 建→应用可用；应用建→CLI 可连 315µs）+ `TestInteropRoundTrip` 回归；M6 打包后 context 契约未动 |
| 11 | 回滚方案确认（§22） | ✅ | 无服务端可回滚由数据兼容保证（不写私有字段进 context、设置新增字段可选）；安装器保留上一版资产路径（README Release 节） |
| 12 | 安装包（NSIS + 便携 zip）与 SHA256 校验和就绪 | ✅ | 安装包 9.14MB + zip 7.46MB + `SHA256SUMS.txt`（round-trip 校验过）+ 版本三源一致（VerQueryValue 双产物门）；安装/卸载冒烟全过（matrix #40）。test-report §2 |
| 13 | 文档就绪（README 含明文凭证风险说明、语言切换、系统要求） | ✅ | `desktop/README.md`：系统要求（Win10+ x64 + WebView2）、SmartScreen/未签名说明（TODO-002）、明文凭证风险指针、SHA256 校验、语言切换、构建发布指南；便携包内 README-portable.txt 同步 |

**小结：12 项达标（#4 带 FAIL 子项注记、#6/#7 带 PENDING/缺陷注记）+ 1 项 FAIL（#5 稳定性）。**

---

## 3. G1–G15 全局约束核对

| # | 约束（m6 计划 Global Constraints） | 判定 | 核对说明 |
|---|---|---|---|
| G1 | §21 十三项 checklist 逐项勾选 + 证据指针 | ✅ | 本文 §2（12+1 FAIL 结构，注记如实） |
| G2 | 性能预算 §12 双档逐值，实测回填 §19.2（spec v1.1→v1.2） | ✅ | spec §19.2 九行全部回填；内存与稳定运行两项 FAIL 如实；PENDING-MANUAL 三行不冒充 |
| G3 | 内存口径统一：private working set 求和为门禁（WS 求和参考列）；空载 60s + 典型负载 30min 双点 | ✅ | `perf-sample.ps1`：private = 主进程 + 全部 WebView2 子进程逐 PID 求和（子进程匹配规则实证，26 个他应用 webview 正确排除）；双点均实测；子进程匹配、CSV 列、进程分解齐备（perf §0.1/§1.2/§1.5） |
| G4 | TODO 裁决为执行时用户输入，偏离默认须登记 | ✅ | 用户裁决 2026-09-14：TODO-002/003/004 默认采纳 + push 授权；TODO-001 按计划默认（用户指令：展示名 NATS Desktop、module/仓库不改）。全部登记于 §5 裁定 1 与 spec §24 |
| G5 | 凭证不入日志终扫（§13.3/AC-030） | ✅ | 三腿终扫（T10 + post-soak 补腿 3）；F-1 发现→修复闭环（99f29c6） |
| G6 | 零新增运行时依赖；devDependency 例外逐项记录 | ✅ | M6 全程 `package.json` 零改动（git diff 583417b..HEAD 为空）；go.mod 仅 klauspost/compress indirect→direct 重分类（预存漂移，T1 披露，非新增依赖）；无障碍用脚本核查未引 axe（例外清单=空） |
| G7 | push 为外发动作 + CI `-race` 首跑闭环 | ✅ | push 经用户授权后执行；CI 五轮迭代至全绿（test-report §3），`-race` 首跑真发现 jsm.go serverdata 竞态并以 sysreq 包整改（32c3522）——M1 起挂账的「CI -race 未验证」正式闭环 |
| G8 | 24h 长稳占用机器一夜 | ✅（执行完毕，判定 FAIL） | 2026-09-14 22:11 点火 → 09-15 15:42 崩溃收数；期间无其他重负载；产物三件套保留（soak §8） |
| G9 | bindings 树是提交物：先补 null-guard 再全量 regen + no-op 证明 | ✅ | CI 闭环第 4 轮就地执行（a71bbc1）：接口模式全量 regen 12 文件（-2323/+187）+ 3 处 null-guard + 同命令二次 regen `git status` 为空的 no-op 证明（progress.md CI 段） |
| G10 | 低配档 = 本机模拟（2 核亲和 + GPU 禁用），非真机时表列「模拟」 | ✅ | 全部表格标注「模拟」；GPU 禁用 CommandLine 实证；亲和落地窗口 60–150ms 如实记录（perf §2 头） |
| G11 | 截图基线 = 参考集非门禁；像素 diff 门禁列 v1.1 | ✅（脚本就绪，32 张未拍） | `screenshots.ps1` 就绪 + `docs/screenshots/v1.0/README.md`（G11 参考集性质声明 + 用户执行步骤）；基线集生成列 matrix #39 PENDING-MANUAL——本约束的「建立基线」半边尚未完成，如实标注 |
| G12 | i18n 完整性门禁延续（en/zh key 集相等）；lucide-only 禁 emoji；UIA 不可驱动腿如实 PENDING-MANUAL | ✅ | 完整性测试全绿；本收尾补齐 `connections.showToken/hideToken` 双语 key 后 parity 校验 NONE-diff；emoji 码位扫描零命中（M1/M3/M4 复验）；PENDING-MANUAL 全部附精确路径 |
| G13 | LocalServer 真服务器延续（4333） | ✅ | 双档性能/5k 腿/长稳/数据集全部打真 4333（常驻存活，数据集未 purge）；connz 1024 行分页 bench 8.83ms/op（门 500ms，56× 余量，G13 子门补齐） |
| G14 | 手测矩阵汇总核销制（M1–M6 全 PENDING 行抽取，用户在场项列 LIVE-待办不虚报） | ✅ | 40 行矩阵：**16 EXECUTED / 24 LIVE-待办 / 0 WAIVED**；post-soak 批次 10 行转 EXECUTED 带逐行证据（T10 报告） |
| G15 | 每任务收尾全量门禁 | ✅ | 各任务报告门禁段在案；本收尾复跑全量门禁（test-report §1） |

---

## 4. Deferred Minors 全量处置表

来源：M5 终审 DEFER(M6) 清单 36 项（ledger ①–㊱ + 终审新发现 N-1~N-4）+ T8 接续盘点 + T10 发现 + 负载 flake 整改。**每条有去向**：FIXED(本里程碑) 附提交，DEFER(M6后) 附理由。编号以 progress.md「Minor 滚存」与 m5-final-review.md triage 表为准（ledger 存在编号间隙：无 ㉘ 号项）。

### 4.1 已在本里程碑修复

| 项 | 内容 | 处置 | 证据 |
|---|---|---|---|
| ① | cluster.go 头注释/Opts 字段注释陈旧（D2 后） | FIXED（T4，doc-only） | ed8a101「doc-only: StartCluster readiness criteria + cluster.go header/Opts (16/1)」 |
| ③ | ClassifyMonitorError 空 Description 可产生空错误文本 | FIXED（T4） | forms.go 空 Description → 回退 `ae.Error()`（证其永不空）+ 表驱动 4 例测试；ed8a101 |
| ⑦ | accountRows >50 流 cap 不变量无测试 | FIXED（T4） | `TestAccountRowsStreamNamesCap`（60 流 → Streams==60 && len(StreamNames)==50）；ed8a101 |
| ⑫ | CodeConflict 冲突路径无 elapsed 日志 | FIXED（T4） | runClusterOp 冲突路径补 `Warn("cluster op rejected: in progress", op, target)`（G9 口径无载荷）+ 块覆盖计数 1；ed8a101 |
| ⑯ | StartCluster doc 注释陈旧（就绪判据/「测试一律传 3」） | FIXED（T4，doc-only） | ed8a101（同 ① 行） |
| ⑱ | interval() doc 与实际不符（<2 → 5s 非 clamp 2） | FIXED（T4，doc-only） | ed8a101 service.go 注释对齐 |
| ⑳ | version.go Current() doc 残留 M1 口径 | FIXED（T4，doc-only） | ed8a101 version.go |
| ㊟ | Go 侧无 degraded wire 形状 marshal 断言（M5 终审 Trivial） | FIXED（T4） | `TestSnapshotNoSysPermission` 增 json.Marshal 断言不含 `"servers":null`；ed8a101 |
| ㉟ | connz 1024 行分页无墙钟 bench（G13 子门） | FIXED（T4） | `BenchmarkListServerConnectionsPage` 8.83ms/op（5×，1024 行满页断言）；ed8a101 |
| ⑲ | 行 role=button 无 Space 键 | FIXED（T8，超范围补齐同类 6 处） | ServerTable/SessionView（M5 已改）+ KeyList/KeyValuePage/StreamList/StreamMsgs 补齐，每处证伪测试；415ae68 |
| ㉑ | 非 cid 排序键首屏方向标签语义反转 | FIXED（T8） | `serverDefaultDir`（cid 升序、其余降序）+ flip 语义 + 初始 aria-sort 证伪测试；415ae68 |
| ㉒ | 传输层 throw 处理不一致（错误卡 vs toast+清空） | FIXED（T8） | ConnectionsTop/AccountsPanel 失败保数据 + toast 原文（不再清空）+ reject 注入测试；415ae68 |
| ㉓ | NodeDetail 错误卡无重试按钮 | FIXED（T8） | `node-error-retry` 复用 load 入口 + 失败→重试→恢复测试；415ae68 |
| ㉔ | formatBytes MiB 封顶 + NodeDetail 私有双格式化器 | FIXED（T8） | `lib/format.ts` 单一 formatBytes（B→TiB 阶梯 + maxUnit），PubPanel MiB 口径保留，测试表 48 行；415ae68 |
| ㉖ | watch-create 持续失败每次过滤变更都 toast（风暴） | FIXED（T8） | `shouldToastError`（5s 窗口/按原文/>50 键清表）+ 纯函数表 + 组件级测试；415ae68 |
| ㉛ | pushAdvisory 与 pushEvent 重复 | FIXED（T8） | 已委托 pushEvent（cap 参数化默认 100）+ 对拍测试；415ae68 |
| ㉜ | aria-valuenow 未钳制（used>max 可 >100） | FIXED（T8） | `Math.min(100, Math.max(0,…))` 与条宽同源 + ratio=2 证伪测试；415ae68 |
| F-1（T10 新发现） | 连接配置 token 输入框明文（AC-030 腿 3） | FIXED（T10 收尾） | 99f29c6：默认掩码 + Eye/EyeOff 切换 + 证伪测试（本收尾并补齐 i18n 双语 key） |
| 负载 flake ×3 | sysreq TestDoReqPlainPing / messaging TestServiceFullChainLocalServer / testutil TestStartSysServerPermissions（全量并行偶发，T1 建档） | FIXED（整改提交 6c2cebf） | 测试/夹具助手超时裕量 2s/5s→10s（零断言变更、零产品码）；三包联合 -count=2 全绿 + 全量并行复现条件 exit 0。诚实注：概率性缺陷一轮绿不证明根除，失败窗口需 >5× 既往调度饥饿（详见 test-report §5） |
| N-4 | 降级测试夹具伪造 wire 不可能形状 | FIXED（M5 终审修复波，先于 M6） | 5ffd923 并入 I-1 修复：servers:null/[] 事件路径测试 ×2 |

### 4.2 DEFER（M6 后）——逐条理由

| 项 | 内容 | 理由 |
|---|---|---|
| ② | testutil seed 端口 TOCTOU | 测试夹具披露项，业界标准做法（listen 后回填），无产品影响 |
| ④ | Go 侧并发双 Stop→Start 竞窗（一拍自愈） | 已被 M5 I-2 修复（前端 desired-state 串行队列）覆盖主风险面；Go 半边一拍自愈，观察项 |
| ⑤ | pollLoop panic 后 running 挂真（Start 静默无效） | 显式 Stop/Start 可恢复；自动重启属 v1.1 候选增强（与 AC-025 的 logger/goroutine 排查同批） |
| ⑥ | TestNotifyConnStateStopsTicker 首帧等待语义 | test-only，brief 原文行为，断言未弱化 |
| ⑧ | accounts_test 内联 EnableJetStream 冗余死重 | 纯测试卫生；b47f543 后幂等无害，清理收益低 |
| ⑨ | offer 内测试调度机制未藏于 lazyStart 标志后 | 生产构造器急启（syswatch.go:128-132），死分支仅测试工效问题 |
| ⑩ | emitter 启动与 registry.add 间竞窗（M4 继承） | 窗极小、最坏丢一条目；M5 终审已裁定接受，修复需重排启动序（回归面 > 收益） |
| ⑪ | CONNECT 事件用 DisconnectEventMsg 解析 | 形状子集、输出全等（cosmetic）；改名牵动 wire 兼容面 |
| ⑬ | natscli 措辞微漂 | brief 原文优先，维持现状 |
| ⑭ | "within 5s" Note 文案硬编码 | 服务器协议措辞；i18n 化列 v1.1 文案轮 |
| ⑮ | StreamBalance 域上下文用默认 API 主题 | natscli 同款设计（既定裁定，非缺陷） |
| ⑰ | smoke_test interval 表用例复用单例 settingsPath | **如实更正**：progress 台账 M6 T4 行将 ⑰ 列入修复清单，但提交 ed8a101 实际未含 smoke_test.go 改动——⑰ 维持 DEFER（序偶安全、test-only） |
| ㉕ | 前端 SORT_KEYS 缺 last 键 | spec 无该列，Go 白名单接受（serverops.go:46）——内外自洽，无用户可见影响 |
| ㉗ | EventsPanel 事件 useState 不可变前插 O(n) | 洪峰 jank 风险面；T8 的 rAF 合流已消除最高频渲染病理，此项属低频页（监控事件），列 v1.1 与 ⑤ 同批 |
| ㉙ | 监控页流操作 expectedName 重输一致性门 | 设计固有（StreamDetail 变体更强），非缺陷 |
| ㉚ | 离线 meta leader 卡禁用 | defensible（离线节点无操作对象） |
| ㉝ | uint64 >2^53 JS 精度 | 系统性 Wails 限制（预存）；触发需 >9PB 计数，现实不可达 |
| ㉞ | advisory 环跨断连保留 | 有意的共享选择（断连后事件可回看）；随附 N-2 后果一并评估 |
| ㊱ | m5-testcluster.json context 保留 | M3 式手测回填前置（披露项），供 matrix #37 腿复用 |
| N-1 | resolveServerID 冷路径 error_code="server" 而非 "not_connected" | 仅「已知集为空 ∧ 断连竞穿 UI connected 门」可达；错误文本原文照显；v1.1 对齐 error code 一行改动 |
| N-2 | watch 重建后 seq 重启 → React key/testid 重复 | cosmetic 渲染警告；v1.1 改 `watch_id:seq` 复合 key 或清环（与 ㉞ 联动决策） |
| N-3 | Wails 框架 Debug 级绑定日志回显全量参数/结果 | 框架行为（先于 M5）；默认级别 info 不触发；user 列在 wire 白名单已排除 JWT/certs。处置：保持 debug 关闭的文档提示列 v1.1 |
| T8 新发现 | `internal/asciigraph` 上游用例失败（TestPlot/TestPlotMany 轴刻度断言；接手前即存在，T8 未触碰） | 上游库整治项，与本里程碑交付面无关；单列 v1.1 upstream 清单（升 pin 或本地 fork 修复） |
| T10 观察 | ①BOM settings.json → .bak 防线实测有效（非缺陷）；②context chip 列表启动时快照（新 context 需重启应用才入菜单；连接时实时重读）；③radix 模态打开时背景 a11y 树 aria-hidden（UIA 需先关菜单） | 全部为行为记录非缺陷；②列 v1.1 增强候选（context 目录 watcher），③为 UIA 脚本操作约定 |

---

## 5. 裁定登记（adjudications）

1. **TODO-001~005 四+一项裁决（spec §24 全表 Resolved）**：用户裁决（2026-09-14）采纳默认三项——TODO-002 不购签名证（README SmartScreen 说明 + SHA256）、TODO-003 不配 Sentry（仅本地日志）、TODO-004 仅 Windows 正式验收；TODO-001 按用户执行指令落地为展示名 **NATS Desktop**（module/仓库名不变；GitHub `nats-desktop` 名被 thedataflows 占用 → 仓库定名 WenElevating/nats-desktop），版本/元数据三源一致有门禁；TODO-005 由 M1 互操作实测闭环（AC-003）。
2. **低配模拟口径**：低配档全部数据来自本机模拟（2 核 `ProcessorAffinity=0x3` + env 门控 `--disable-gpu`），所有表列显式标注「模拟」；GPU 禁用经子进程 CommandLine 实证；亲和在进程启动后 60–150ms 落地（ready 前最早期段不受限，如实记录）。真机低配为可选用户输入，未执行。
3. **截图基线 = 参考集非门禁**：v1.0 建立 32 张基线集属「参考集」性质（G11 裁定），像素级 diff 门禁列 v1.1（无既有基线可回归）。当前状态：脚本+检测+README 就绪，32 张实际生成 PENDING-MANUAL（matrix #39）——首发前建议补拍。
4. **内存口径 = OS 进程树 private 求和**：门禁口径为主进程 + 全部 WebView2 子进程逐 PID `PrivateMemorySize64` 求和（M2 §6-14 裁定延续，WS 求和仅参考列）。前端 JS 堆程序化采样需 DevTools 在场（锁屏不可用），登记为偏差：JS 堆两点快照列解锁后增强证据，不作门禁。进程分解证明负载增量集中于 renderer 子进程（perf §1.5），口径与结论自洽。
5. **AC-027 显式腿需真实 release**：远端仓库无任何 release（update check 实测 404，静默语义符合且与自动化 `TestCheckLatestTimeoutIsSilentError` 同向）——「模拟更高版本号」的前提在本环境不可构造（更新检查硬编码 api.github.com，单测不打真网）。裁定：AC-027 以自动化逻辑测试覆盖达标，显式通知腿留**首发后复验**（发布 >当前版本 release 后按 matrix #6 步骤走查；若通知不出现先按 M1 §5-7 emit 竞态归因）。
6. **AC-025 与内存门 FAIL 的 v1.1 修复方向**（登记为「有条件通过」的解除条件）：
   - 渲染器堆滞留分析：实时推送内存增长根因定位（V8/PartitionAlloc 已提交页不归还 OS；T8 合流修复只消除逐事件 setState 病理——稳态中位 -9%、锯齿谷值 361.8MB、状态面精确有界——未止增长）；
   - logger 冻结排查：长稳 57min 处文件日志静默冻结（疑 logger 包死锁/写入 goroutine 消失），§13 契约破坏面；
   - 静默退出归因：15:42 宿主无 WER 退出与 M4 缺陷#4 同族（windowsgui 下 stderr 不可见）；排查方向含 commit 耗尽下 runtime 致命退出路径与 WebView2 子进程存活性监督；
   - 缓释路径（已可用，随文档发布）：`session_push_batching` 批量推送（653.8MB vs ~1.4GB，-52%，30min 稳定）、降低订阅速率、会话「清空」按钮。

---

## 6. 遗留与移交

- **手测矩阵 24 行 LIVE-待办**（matrix）：全部需解锁桌面用户在场，精确步骤已备；建议顺序：先 #35 已闭环类扫尾（无）→ #6（待远端 release）→ #38 键盘/IME → #39 截图基线 → 录屏判读类（#13/#15/#17/#23）→ 原生对话框类（#29/#30/#24）。
- **v1.1 整治清单**：§5 裁定 6 三项根因 + Deferred Minors（§4.2）+ asciigraph upstream + 截图 diff 门禁 + context 目录 watcher 候选。
- **维护者决策点**：是否以「有条件通过」首发（Release 建议标注已知限制：高频实时订阅场景内存；推荐用户开启批量推送模式），或待 v1.1 根因修复后发布。本验收不代决策。
