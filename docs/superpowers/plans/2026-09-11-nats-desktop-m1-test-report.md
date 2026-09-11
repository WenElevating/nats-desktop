# NATS 桌面客户端 M1 测试报告

- 日期：2026-09-11
- 分支 / HEAD：`desktop/m1` @ `256168e`（功能代码 20 提交 + 终审修复 + 验收补录，共 23 提交，基线 `510aa6e`）
- 范围：M1 = 应用骨架 + 主题/i18n + 设置/日志服务 + context 连接管理（规格 `docs/superpowers/specs/2026-09-11-nats-desktop-v1-spec.md` §6.1/§6.2/§6.12 + 测试基建）
- 结论先行：**M1 测试通过，可合并**。自动化 46 Go + 39 前端用例全绿；性能冒烟达标（体积/冷启动/内存）；GUI 真机冒烟 8/9 直接过，1 项缺陷（CRITICAL-B1）被发现→修复→回归测试+端到端复测通过；12 项遗留明确移交 M2/M6 并附人工确认清单。

---

## 1. 测试执行总览（五层体系中 M1 覆盖部分）

规格 §20 五层测试体系（单元/性能/压力/集成/UI 交互）中，M1 交付了：单元测试（全量）、集成测试（内嵌 nats-server 真协议）、性能冒烟（M1 基线）、UI 交互测试（组件级自动化 + 控制器真机冒烟）。压力测试（洪峰/长稳）与低配档属 M2–M6 范围（M1 无消息流功能）。

| 层 | 结果 | 证据位置 |
|---|---|---|
| 单元测试（Go） | **46 用例全绿**（connections 25、logging 9、version 6、settings 5、appdir 2、testutil 自证 1；计数含修复轮新增回归） | `go test ./... -count=1` 本报告 §2 |
| 单元/组件测试（前端） | **39 用例全绿**（9 文件：connections-page 10、connstate-ui 9、shell 6、theme 4、command 3、i18n 2、connstate 2、update 2、settings-page 1） | `npx vitest run` 本报告 §2 |
| 集成测试 | 内嵌 nats-server（`nats-server/v2 v2.15.0-preview.1`）跑真协议：连接状态机全转移、断线自愈、认证失败终止、context 互操作、测试连接（RTT+JS 探测）；CLI 互操作（AC-003）以**真实 natscli** 双向实测 | `internal/connections/*_test.go`、`internal/testutil/`；AC-003 记录 |
| 性能冒烟 | 体积 17.8MB≤30MB；冷启动中位 661ms≤2s（5 轮）；内存 private 口径 233.9MB≤300MB（WS 口径 424.9MB 判定留 M6 统一口径）；单实例二启 149ms 退出 | 验收记录 §3 |
| UI 交互（自动化） | 壳 8 入口+aria-current+无 emoji、命令面板导航/切换、五态 UI 事件驱动、表单校验/测试连接/删除次序（Disconnect 先于 Delete）/失败 toast+对话框保持 | 各 `tests/*.test.tsx` |
| UI 交互（真机冒烟） | 9 项走查：8 过 + 1 缺陷→修复→复测过 | 本报告 §4 |

**门禁**：i18n 双语言 key 完整性（缺失即红）已进 vitest 与 CI；CI 三段流水线（vet+test[-race] / tsc+eslint+vitest / wails3 build+产物上传）已就绪，PR 触发。本地 `-race` 因工具链 cgo 缺陷不可用（预存在），由 CI Windows runner 承接（首跑验证列为遗留 #5）。

## 2. 最终回归原始输出（HEAD `256168e`，2026-09-11 23:17）

```
$ go test ./... -count=1
ok  internal/appdir       0.143s
ok  internal/connections  11.603s   ← 内嵌服务器用例最慢包
ok  internal/logging      0.541s
ok  internal/settings     0.454s
ok  internal/testutil     0.541s
ok  internal/version      0.454s
$ go vet ./...            → clean
$ npx vitest run
Test Files  9 passed (9)
     Tests  39 passed (39)
$ npm run build && wails3 build → PASS（bin/nats-desktop.exe 17.8 MiB）
```

## 3. 性能冒烟数字（M1 基线，机器=高配档参考机 i7-13700HX/16GB/SSD/Win11）

| 指标 | 预算 | 实测 | 判定 |
|---|---|---|---|
| 安装包（便携 exe） | ≤30MB | 17.8MB | PASS |
| 冷启动（frontend 加载代理标记，5 轮中位） | ≤2s | 661ms | PASS（余量 >3×） |
| 空载内存（private 提交求和，61s） | ≤300MB | 233.9MB | PASS |
| 空载内存（WS 求和口径） | 300MB | 424.9MB | 口径争议 → M6 统一复测 |
| 单实例二启退出 | 即退 | 149ms, exit 0 | PASS |
| 操作反馈 ≤100ms | 双档 | 无头不可测 | PENDING-MANUAL（§6） |

## 4. 真机 GUI 冒烟（控制器执行，computer-use + 本地 nats-server:4333）

| # | 走查项 | 结果 |
|---|---|---|
| 1 | 首启引导卡片 + 侧栏 8 入口全 SVG 线性图标（无 emoji）（AC-001） | ✅ |
| 2 | 创建表单全字段（认证五选一/TLS/JS/高级） | ✅ |
| 3 | 测试连接：**"Connected, RTT 0ms, JetStream: no"**（回环 RTT=0 已知语义；JS 探测正确——服务器未开 -js） | ✅ |
| 4 | 保存 → 列表行 + Connect → **Active 徽标 + 绿点 "local-test · Connected"**（AC-002） | ✅ |
| 5 | 主题切 Dark：全界面即时深色、Indigo 选中态清晰、无样式错乱（AC-020） | ✅ |
| 6 | 语言切 zh-CN：导航/设置页/tabs/状态/toast 全中文即时生效（AC-021） | ✅ |
| 7 | 重启：深色 + 中文保持（持久化） | ✅ |
| 8 | 重启自动恢复连接（原 PENDING-MANUAL 项） | ❌→**修复→复测 ✅**（见 §5 B1） |
| 9 | 单实例二启即退 | ✅（进程级） |

## 5. 缺陷发现与修复记录（测试有效性的核心证据）

| # | 缺陷 | 发现于 | 严重级 | 修复 |
|---|---|---|---|---|
| 1 | 依赖版本钉子被 tidy 剥离但报告不实 | Task 1 审查 | Important | `6466749` 空导入钉住 + 复审 |
| 2 | 日志脱敏对畸形 URL 的 userinfo 泄漏（`nats://u:p%ss@h` 落盘） | Task 5 审查 | Important（违反 §13.3 硬约束） | `0aacde2` maskUserinfo + 回归测试（RED 复现泄漏） |
| 3 | Validate 误报 data-URI 凭证不可达；EnvWarnings 空值 nil | Task 6 审查 | Important/Minor | `5ca3c96` + 回归 |
| 4 | Connect 错误路径竞态：Disconnect 打断拨号时 failed 覆盖用户的 terminal disconnected | Task 8 审查（并发重点审查） | Important | `1b0d561` setStateIfCurrent gen-guard + 竞态测试（RED 复现 `[connecting disconnected failed]`） |
| 5 | 后端操作失败无用户反馈（违反 §18.5）；编辑预填竞态 | Task 10 审查 | Important/Minor | `2353015` toast + epoch 守卫 |
| 6 | 条件式 hook（Rules of Hooks 地雷）；fix-connection 落点错 tab | Task 11 审查 | Important(潜在)/Minor | `3e4d7bc` + RED→GREEN |
| 7 | **CRITICAL-B1：设置页整包保存冲掉后端持久化的 last_active_context → 启动自动恢复连接失效** | **控制器真机冒烟**（跨任务所有权缝隙，任务级审查盲区） | **Critical** | `ab65f72`：`settings.Update` 串行化 + `SaveSettings` 服务端合并（last_active_context 后端独占）+ persistActive 共用互斥 + 回归测试；**端到端复测**：写回 context → 重启 → netstat 证实应用与服务器 ESTABLISHED，设置不再被冲 |

另：终审同时修复 设置保存失败 toast（I1）、desktop/README 模板替换（I3）、错误文案统一（M6）、`@wailsio/runtime` 锁版本（M4）。每个修复轮均经复审或 RED→GREEN 证据确认。

## 6. 待人工确认项（PENDING-MANUAL，附路径，验收记录 §4 有完整双语指引）

1. 反馈时延 ≤100ms 体感/录屏确认（设置页逐控件）
2. AC-019 错误密码 GUI 走查（自动化已覆盖行为）
3. AC-020 跟随系统模式下切系统深浅 1s 内跟随
4. AC-027 更新通知视觉（需 Releases 或临时调低版本号）
5. 更新检查断网启动静默
6. 启动恢复-服务器离线场景（failed 一次不循环 + WARN 日志）
7. 更新通知二次启动聚焦已有窗口（视觉）

## 7. 遗留项移交（M2/M6，验收记录 §5 全清单）

要点：CI `-race` Windows runner 首跑验证；main.go 无 ready 日志（冷启动用代理标记）；前端 chunk 507kB 超 500kB 警告（M2 code-split）；启动 emit 竞态未接 CheckUpdate 兜底；pre-release 版本比较偏差（首个 tag 前修）；rotate 双失败路径加固；设置数字输入 0 无钳制；pins.go 保洁；交互 polish 积压（Ctrl+K 热键测试/双击防护/占位符门禁）。

## 8. 测试环境

| 项 | 值 |
|---|---|
| 机器 | i7-13700HX（16C24T）/ 15.7GB RAM / SSD（≥规格高配档参考机） |
| 系统 | Windows 11 家庭中文版 build 26200，WebView2 152.0.4191.66 |
| 工具链 | go1.26.0、Node v24.11.1、wails3 @ v3.0.0-beta.20 |
| 集成夹具 | 内嵌 nats-server v2.15.0-preview.1（单节点/认证节点）+ 独立进程 nats-server:4333（GUI 冒烟） |
| 已知限制 | 本机 `-race` 工具链 cgo 缺陷（CI 承接）；GUI 冒烟为脚本化走查非全量 E2E |

## 9. 结论

| 维度 | 结果 |
|---|---|
| 功能（M1 范围） | **Pass**（自动化+真机；AC-001/002/003/020/021 实测通过） |
| 性能（M1 基线） | **Pass**（体积/冷启动/内存 private 口径；WS 口径与低配档留 M6） |
| 稳定性 | M1 范围 Pass（竞态专项测试+修复）；24h 长稳按计划属 M6 |
| 兼容性 | context 与 natscli 双向互通实测 Pass；nats-server 矩阵后续里程碑 |
| 安全 | 凭证零落盘（脱敏+回归测试）Pass；崩溃报告默认关 Pass |

**最终结论：M1 通过验收，分支可合并。** 后续动作：开 PR 验证 CI（含 `-race` 首跑）→ 合并 → M2（Messages 消息功能）计划编制。
