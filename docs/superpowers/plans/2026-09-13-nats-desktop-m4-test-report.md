# NATS 桌面客户端 M4 测试报告

- 日期：2026-09-13
- 分支 / HEAD：`desktop/m4` @ `91799ed`（Task 1–10）+ 本报告提交（Task 11）
- 范围：计划 `2026-09-13-nats-desktop-m4.md` Task 1–11 的测试总量、性能实测、缺陷与修复、覆盖率终值、CI 状态（配套《2026-09-13-nats-desktop-m4-acceptance.md》验收记录）

## 1. 用例数（2026-09-13 新鲜实跑，非缓存汇总）

| 套件 | 命令 | 结果 |
|---|---|---|
| Go 全量 | `cd desktop && go test ./... -count=1` | **11 包全部 ok，0 失败，0 SKIP**；`appdir 0.17s / buckets 20.2s / connections 13.6s / jsadmin 27.2s / jsctx 2.1s / logging 1.8s / messaging 79.5s / natsver 1.0s / settings 1.0s / testutil 1.9s / version 1.6s` |
| Go 规模 | `grep -rE "^func Test" internal/` | **231 个顶层 `Test` 函数 + 5 个 `Benchmark`**（buckets 包 38 个 Test，为 M4 业务主体；含子测试则用例数更多——M3 口径） |
| LocalServer 子集 | `go test ./internal/buckets/ -run LocalServer -count=1` | 11/11 PASS（真服务器 4333，≈25s，无 SKIP；含洪峰/并发/100MB/断连等重量级场景） |
| 前端全量 | `cd frontend && npx vitest run` | **25 文件 / 173 测试全部通过**（13.8s；含 i18n 双语 parity 门 AC-021 自动化半边） |
| 前端+覆盖率 | `npx vitest run --coverage` | 173/173 通过 + v8 覆盖率输出（§4） |
| 静态检查 | `go vet ./...`；`tsc --noEmit`；`eslint src --max-warnings 0` | 全部干净 |

与 M3 基线对比：Go 184 顶层（11 包）/ 前端 155 → **Go 231 + 5 bench / 前端 173**；净增主要在 buckets（Task 1–6/10：38 个 Test + 2 bench）与 kv/objects 前端套件（Task 7/8 新增 14 例；Task 9 补 remediation 用例）。

## 2. 性能实测表（§12 预算；Task 10 实跑 @ 91799ed，i7-13700HX / 真服务器 4333）

| 预算项 | 门槛 | 实测 | 判定 |
|---|---|---|---|
| 1k 键桶键浏览（ListKeys 1000 + 当前页 50 值补齐） | ≤500ms 高配 / ≤1.5s 低配 | **22.8–38.1 ms**（多轮） | PASS（余量 13–22×） |
| `BenchmarkKvListKeysLocalServer` | 信息性 | 10.26 ms/op（1.77 MB/op，15,225 allocs/op）；复跑 11.76 ms/op | magnitude 记录 |
| KV watch 洪峰 | 初始 1k + 10k 更新零丢失 | **10,000/10,000 精确，dropped=0**（-count 3） | PASS |
| 对象 watch 洪峰 | 零丢失 | **10,000/10,000 精确，dropped=0** | PASS |
| 100MB 对象上传 | 字节精确 + 进度 + digest | **143.8 / 152.8 / 191.7 MB/s**；bytes 精确、首事件 running、终态 complete | PASS |
| 100MB 对象下载 | 同上 + SHA256 | **250.6 / 251.9 / 265.0 MB/s**；`digest_match=true`；落盘流式 SHA256 一致 | PASS |
| 并发 | 12 goroutine 混合操作零错误 | KV 桶建删×3 / 键 put-del×20 / 对象桶建删×3，共享单 Service，**0 错误** | PASS |
| 传输互斥 | 单飞 | busy → `ErrTransferBusy`；前端重排队 | PASS |
| 应用体积 | ≤30MB | 19.2 MiB（`wails3 build` 产物 20,081,152 B） | PASS |

冒烟补充测量：AC-013 watch 注入 → UIA 可见行时延 1.6–4.1s（锁屏 WebView2 后台节流 + MSAA 遍历开销所致的观察链路上限，非投递时延；验收记录 §7 行 e / §8 回填）。

## 3. 缺陷记录与修复

| # | 缺陷 | 发现/裁定 | 修复 |
|---|---|---|---|
| 1 | **对象传输初始事件 `phase:""`**（契约枚举为 running/complete/incomplete；计数器/进度 UI 依赖首个 running 事件） | Task 6 代码评审 Important（7c5dbdc 引入） | **`cfdfe7a`**：upload/download 两处模板字面量补 `Phase: "running"`；`TestUploadDownloadRoundTrip` 新增每方向首事件 phase 断言（phases[0]=="running"） |
| 2 | **RenameObject 丢失元数据**（nats.go `UpdateMeta` 裸 `{Name}` 会清零 Description/Headers/Metadata——外部创建对象的描述静默丢失） | Task 5 评审裁定（计划派发 Task 6 修复；`5e199d8` 引入） | **`cfdfe7a`**（同修复波）：GetInfo → 复制 Name/Description/Headers/Metadata → UpdateMeta；`TestRenameObjectPreservesMetadata` 行为级 RED→GREEN（先证丢失再证保全，含 Headers 注入断言）；objects.go 虚假注释一并修正 |
| 3 | **KV watch 哨兵事件被前端丢弃**（Go 哨兵省略 `key`/`operation`（omitempty），前端首版严格校验会整条丢弃 → `snapshotDone` 永不翻转） | Task 7 实现者自审发现（提交前修复，随 `9c6ac58` 落地） | **`9c6ac58`**：`applyWatchEvent` 与 `Events.On("kv:watch")` 双处把缺失 `key`/`operation` 归一化为 `""`；测试以「物理删除字段的载荷」钉住哨兵路径 |
| 4 | 一次性应用退出（冒烟中，无日志、无 WER 记录、受控复现未现） | Task 11 冒烟新发现（验收记录 §6-8 / §7 行 e 注记） | 未修复（不可复现）；怀疑锁屏 WebView2/Wails 环境因素，终审 whole-branch review 关注 watch/emit 路径 panic 缝隙 |
| 5 | jsadmin 全并行 `go test ./... -cover` 一次性失败（3 次复跑未现） | Task 10 观察（预存在时敏测试） | 未修复；登记观察项，CI（-cover 开启后）若复现取日志定位 |

评审修复波汇总：M4 十任务全部经 `reviewing` 只读评审 + 修复波（台账 `.superpowers/sdd/progress.md` M4 段），评审结论均为 clean/Approved（0 Critical / 0 Important 遗留；Minor 登记终审）。

## 4. 覆盖率终值（`go test ./internal/... -cover -count=1`，2026-09-13 实测）

| 包 | 覆盖率 | 门（§20.1） |
|---|---:|---|
| jsctx | 100.0% | 达标（M3 66.7% → Task 9 整改） |
| connections | 86.4% | 达标 |
| messaging | 86.1% | 达标 |
| natsver | 85.7% | 达标 |
| jsadmin | 81.2% | 达标（M3 78.8% → Task 9 整改） |
| **buckets** | **80.4%** | **达标（M4 新包，Task 10 内 77.5%→80.4%）** |
| logging | 71.1% | 改善达标（轮转失败分支有行为测试；reopen 臂跨平台不可达，如实登记） |
| settings | 72.7% | 未达 → 遗留（M3 登记，M4 未触碰） |
| version | 75.5% | 未达 → 遗留 |
| appdir | 71.4% | 未达（薄封装）→ 遗留 |
| testutil | 28.6% | 测试辅助包，不计门槛 |

前端（v8 provider，Task 9 接入并钉基线；本轮复测与基线一致）：**总 78.44% statements（≥70% 门 PASS）**；分组：messages 87.32% / streams 85.21% / connections 82.02% / consumers 79.24% / settings 76.74% / objects 71.19% / lib 93.02%；**features/kv 68.03% 未达 70% → 整改项**（BucketForm 35% / KeyValuePage 60.6% / schema 56.5%，验收记录 §6-1 移交）。

## 5. CI 状态

- 工作流：`.github/workflows/desktop-ci.yml`（Task 10 扩展）——go job `go vet` + `go test ./... -race -count=1 -cover`；前端 job `npm ci` + `tsc --noEmit` + `eslint --max-warnings 0` + `vitest run --coverage`；构建 job `wails3 build`。
- **触发分支 main；远端工作流运行记录 0 次**（`gh api repos/WenElevating/nats-desktop/actions/runs` total_count=0）——里程碑工作在 `desktop/m4` 分支，未触及 main 过滤。合并后首跑同时是 `-race` 于 Windows runner 的首次真实验证（M1 遗留回填点）。
- 本机 `-race` 不可用（cgo 预存在）→ 竞态覆盖依赖 CI（现状 = 无执行记录，如实登记）。

## 6. 测试方法与证据链注记

1. **真服务器纪律**：buckets/jsadmin/messaging 的 LocalServer 变体全部实跑 `nats://127.0.0.1:4333`（2.15-preview），0 SKIP；冒烟同打此服务器，结束后 `/jsz` 无 m4 残留。
2. **TDD**：每任务报告含 RED 证据（编译失败或行为失败原文）与 GREEN 全绿输出；台账逐任务登记（`.superpowers/sdd/task-{1..10}-m4-report.md`）。
3. **确定性手段**：uniqueSuffix 隔离共享服务器、差异配置触发 ErrBucketExists、修订号全序推导表（Task 3）、`-count 3` 洪峰 flake 检查、断连测试 3 次尝试弱通过约定。
4. **冒烟辅助**：临时 `go run` 注入器（jetstream KV/ObjectStore API + workqueue 流创建），用后已删除、不入库；应用日志与 UIA 读值互为印证。
