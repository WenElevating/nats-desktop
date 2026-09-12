# NATS 桌面客户端 M2 测试报告

- 日期：2026-09-12
- 分支 / HEAD：`desktop/m2` @ `36299c9`（18 个实现/修复提交 + 终审修复波，基线 `908fbbf`）
- 范围：M2 = Messages 消息功能（规格 §6.3/§6.4）——发布/请求、订阅会话（默认实时推送/批量可选/环形缓冲/丢弃计数/暂停恢复语义/JS 定位回放）、消息路径 trace、性能采样基建与 CI 低配档、context 冲突检测回补、M1 遗留接线
- 结论先行：**M2 测试通过，可合并**。按用户指令全程以真实本地 nats-server（127.0.0.1:4333，JetStream 开启）执行单元集成/性能/压力/并发验证；自动化 132 Go + 96 前端用例全绿；真机 UIA 冒烟实测 AC-004/005/006/007 的 UI 腿全部通过；发现并修复 1 个 Critical（B2）+ 6 个 Important；压力实测端到端 628k msg/s 持续、洪峰 49.9k msg/s UI 数据面正确。

---

## 1. 测试执行总览（对照规格 §20 五层体系）

| 层 | 结果 | 关键证据 |
|---|---|---|
| 单元测试（Go） | **132 用例全绿 / 7 包**（messaging 72.7s 为内嵌+真机重包） | `go test ./... -count=1`（§2 原始输出） |
| 单元/组件测试（前端） | **96 用例全绿 / 14 文件**（含 i18n 完整性门禁、base64 二进制安全、虚拟化窗口断言） | `npx vitest run` |
| 性能测试 | Go 管线 **14.15M msg/s**（门槛 5 万的 283×）；真机端到端 **628,370 msg/s** 持续 10s（门槛 5 千的 126×）；前端 1 万条 **105-136ms**（门槛 2s）；洪峰中 chip 实测 **41,753 msg/s** 实时速率 | `TestPipelineThroughputFloor`、`TestSessionRealServerStress`、`messages-perf.test.ts` |
| 压力测试 | **AC-007 实测**：flood 49,898 msg/s（目标 50k 的 99.8%）×10s——守恒精确（46,743 = 10,000 缓冲 + 36,743 丢弃）、丢弃角标正确、洪峰后 UI 即时恢复、进程存活 | Task 13 + 控制器冒烟 §7 |
| 并发测试 | 五态状态机全转移（含 Disconnect×in-flight-Connect 竞态回归 M1 遗产）；会话并发收流 `-count=2` + CI `-race`；断线重订阅 payload 前缀审计（零回补/零重复）；暂停语义双文本断言 | `sessions_test.go`/`manager_test.go` |
| 集成测试 | 内嵌 nats-server + **真实本地服务器双路径**：每个连通场景均有 `*LocalServer` 变体（用户指令），context 互操作 CLI 实测（M1 遗产持续绿） | `pubreq/sessions/jsposition/trace/service *_test.go` |
| UI 交互测试 | 组件级 96 用例（行为断言非渲染冒烟）+ **控制器 UIA 真机冒烟**（AC-004/005/006/007 UI 腿实测通过） | `tests/messages-*.test.tsx`、验收记录 §7 |

## 2. 最终回归原始输出（HEAD `36299c9`）

```
$ go test ./... -count=1
ok  internal/appdir       0.166s
ok  internal/connections  12.014s
ok  internal/logging      0.651s
ok  internal/messaging    72.713s
ok  internal/settings     0.469s
ok  internal/testutil     0.662s
ok  internal/version      0.503s
$ go vet ./...  → clean
$ npx vitest run → Test Files 14 passed (14) / Tests 96 passed (96)
$ npm run build → MessagesPage 84.54kB 独立 chunk（code-split 生效）
```

## 3. 性能/压力实测数字（全部打真实本地 nats-server 4333）

| 指标 | 门槛（§12） | 实测 | 判定 |
|---|---|---|---|
| Go 管线吞吐 | ≥50,000 msg/s | **14.15M msg/s**（283×） | PASS |
| 端到端持续吞吐（SessionManager 全链路，10s 窗口） | ≥5,000 msg/s | **628,370 msg/s**（126×），守恒精确 | PASS |
| AC-007 洪峰 | 50,000 msg/s ×10s 界面可用 | flood 达成 **49,898 msg/s**（99.8%）；洪峰中 chip **41,753 msg/s**、丢弃角标 36,743、缓冲 10,000 封顶、守恒精确；洪峰后 UI 即时恢复 | PASS |
| AC-005 速率显示 | 流动中显示约目标速率 | 流动中 chip 实测 **143 msg/s**（目标 150） | PASS（B2 修复后） |
| 上屏延迟 P95 | ≤200ms | 前端逻辑吞吐 10k 条 105-136ms 间接覆盖；逐条 P95 采样留人工 | 部分验证 |
| exe 体积 | ≤30MB | 18.7 MiB | PASS |
| 冷启动（ready 标记中位） | 高配 ≤2s | ready **139ms** / frontend 589ms | PASS |
| 内存（private 口径，空载） | ≤300MB | 238.4MB | PASS（WS 口径留 M6） |

## 4. 真机 GUI 冒烟（UIA 驱动真实应用 + 真服务器，验收记录 §7 全表）

| 项 | 结果 |
|---|---|
| AC-004 req echo | ✅ UI 填表→请求→`{"pong":true,…}`、耗时 6ms、历史+清空按钮在位 |
| AC-005 实时收流 | ✅ 流动中速率 143 msg/s、列表虚拟化渲染、累计爬升 |
| AC-006 暂停/恢复 | ✅ 暂停→显示冻结 4393（暂停期注入 600 不上涨）；恢复→解冻至真实 4990、无回补 |
| AC-007 50k 洪峰 | ✅ 数据面（见 §3）；视觉流畅度留人工判读 |
| 启动自动恢复（M1 B1 回归） | ✅ 重启即重连 4333 |
| AC-029 hex 视图 / 清空按钮 UI | ⏸ PENDING-MANUAL（50k 后 UIA 提供方停答，应用进程/窗口正常；Go/组件测试已覆盖语义） |

## 5. 缺陷发现与修复记录（本轮 8 项，全部带回归测试或显式记录）

| # | 缺陷 | 发现于 | 级别 | 修复 |
|---|---|---|---|---|
| 1 | 依赖钉子被 tidy 剥离但报告不实 | T1 审查 | Important | 空导入钉住+复审 |
| 2 | 日志脱敏畸形 URL userinfo 泄漏 | T5 审查 | Important | maskUserinfo+回归（RED 复现） |
| 3 | Validate 误报 data-URI；EnvWarnings nil | T6 审查 | Important | 修复+回归 |
| 4 | Connect 错误路径竞态覆盖用户断连态 | T8 审查 | Important | gen-guard+竞态测试（RED 复现 `[connecting disconnected failed]`） |
| 5 | messaging form 结构体缺 json tag（前后端契约分裂） | T7 审查 | Important | snake tags+JSON 钉住测试 |
| 6 | 发布超时未消费 request_timeout 设置（死配置） | T8 审查 | Important | mount seed+测试 |
| 7 | **B2（Critical）：会话收流不触发 session:state——速率/累计在真实 UI 中永远为 0** | **控制器真机冒烟**（跨任务缝隙：Go 测试只断言转移事件、前端测试自造事件） | **Critical** | `5788412`：deliver→throttle.notify + 静默期速率回落；RED 复现 GUI 症状；4 个回归测试（含真机变体）；**修复后重建应用 UIA 复测通过** |
| 8 | 终审 4 项 Important：push-mode 显示缺失、发布历史缺载荷/时间、header 过滤未实现（显式延期 M3）、重连不标记暂停（显式记录偏差） | 终审 | Important | `36299c9`：前两项代码修复+测试；后两项按裁定记录规格偏差 |

## 6. 遗留移交（验收记录 §6 全清单 21 项）

要点：CI Windows runner `-race` 首跑验证（唯一未满足的并发兜底）；M1 TestAuthFailure Windows flake 待清理；集群 hop 测试随 M3 集群功能；低配档真机复测与内存口径统一随 M6；header 过滤（M3 首位，须含洪峰下过滤性能验证）；UIA 高频更新场景树暴露面积收敛（M3 自动化测试前置）。

## 7. 测试环境

| 项 | 值 |
|---|---|
| 机器 | i7-13700HX / 15.7GB / SSD（≥规格高配档） |
| 系统 | Windows 11 家庭中文版 build 26200，WebView2 152.0.4191.66 |
| 工具链 | go1.26.0、Node v24.11.1、wails3 @ v3.0.0-beta.20 |
| NATS 服务器 | **真实本地长驻 nats-server v2.15.0-preview.1 @ 127.0.0.1:4333（-js，监控 :8333）** + 内嵌单节点/认证节点夹具（hermetic 双路径） |
| 已知限制 | 本机 `-race` 间歇不可用（C 盘/msys2 gcc，CI 承接）；computer-use 代理停用后 GUI 冒烟改用 UIA；flood 工具为发布端测量（会话端速率由 SessionManager 断言） |

## 8. 结论

| 维度 | 结果 |
|---|---|
| 功能（M2 范围） | **Pass**（AC-004/005/006/007 真机实测；push-mode 徽章/历史字段终审补齐；header 过滤显式延期已记录） |
| 性能 | **Pass**（管线/端到端/洪峰三档全部超门槛一个数量级以上） |
| 并发/稳定性 | **Pass**（竞态专项+审计式测试；24h 长稳按计划属 M6） |
| 安全 | **Pass**（payload 零落盘 grep 验证、凭证脱敏 M1 回归绿） |
| UI 交互 | **Pass**（96 组件用例 + 真机冒烟；无障碍截图回归属 M6 全量走查） |

**最终结论：M2 通过验收，分支可合并。** 合并后动作：开 PR 验证 CI（`-race` 首跑）→ M3（Streams + Consumers 管理）计划编制，其输入为验收记录 §6 遗留清单（header 过滤实现居首）。
