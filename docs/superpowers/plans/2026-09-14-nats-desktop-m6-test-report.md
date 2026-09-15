# NATS 桌面客户端 M6 测试报告

- 日期：2026-09-15；分支 `desktop/m6`；对应验收记录 `2026-09-14-nats-desktop-m6-acceptance.md`
- 性能/长稳原始数据不在此重复：perf（`2026-09-14-nats-desktop-m6-perf.md`）与 soak（`2026-09-14-nats-desktop-m6-soak.md`，§8 实跑回填）为单一事实源。

---

## 1. 门禁终态（本收尾复跑，2026-09-15，输出照录）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 前端单测 | `cd desktop/frontend && npx vitest run --maxWorkers=2`（本机默认并行 OOM——M5 Task 9 在案环境约束，沿用） | **36 文件 / 309 用例全绿**（Task 8 后基线 308 + F-1 掩码测试 1 = 309；含 i18n 完整性 2 例——本收尾 key 补齐后复跑通过） |
| 前端类型 | `npx tsc --noEmit` | 净（TSC_OK） |
| 前端构建 | `npm run build` | 成功（tsc + vite，built in 785ms） |
| Go 静态 | `go vet ./...` | 净（VET_OK） |
| Go 全量 | `cd desktop && go test ./... -count=1` | **全部 ok（exit 0）**——14 包（internal 13 + cmd/loaddata）零失败 |

### 1.1 环境偏差如实记录（TestTransfer100MBLocalServer）

前两轮全量在 `internal/buckets` 出现 `TestTransfer100MBLocalServer` FAIL：`download: {ErrorCode:validation Error:insufficient disk space at download target}`。**根因是环境非代码**：宿主 C: 盘使用率 100%（剩余 ~405MB，`df` 照录），测试下载目标为 `t.TempDir()`（C: 的 %TEMP%），全量并行下其他包测试夹具的临时文件把 C: 可用空间压到 100MB 对象阈值以下——M4 的磁盘空间事前门禁（产品真实安全检查）**正确触发**。证据链：①隔离复跑 `go test ./internal/buckets/ -run TestTransfer100MBLocalServer -count=1` → ok（1.5s）；②以 `TEMP/TMP=D:\temp-m6-gate`（230GB 空闲）复跑全量 → 14 包全 ok、exit 0。判定：环境性 disk-pressure flake（C: 满为该主机慢性状态，M5 起在案），非回归；CI（空间充裕）不受影响。建议列主机维护项（清理 C: 临时文件）。

## 2. 发布产物清单（`desktop/bin/dist/`，bin/ gitignored，产物留本地）

| 文件 | 字节 | MB | SHA256 |
|---|---:|---:|---|
| `nats-desktop-amd64-installer.exe`（NSIS，user scope 免 UAC） | 9,578,875 | **9.14** | `84570d051501dc4149eddf390110bb2143873615687264c27fe09c79f6261440` |
| `nats-desktop-1.0.0-windows-amd64-portable.zip` | 7,822,422 | **7.46** | `c4f05209732f6547b7474193259750bbd3e4e0cfd3b40e780ff18dcaf843f990` |
| `SHA256SUMS.txt`（LF 行尾，跨平台 sha256sum 可解析） | 211 | — | 上两项的摘要，`sha256sum -c` round-trip 双 OK |

- 应用 exe（`bin/nats-desktop.exe`，20,584,960 B）：`52cc2de9bbc2da3aa0497cee93f1ff82f47bd39a1717f87d00ef98f15b653e57`——与 zip 内逐字节同哈希（cmp 验证）、与安装后的 `%LOCALAPPDATA%\Programs\NATS Desktop\nats-desktop.exe` 同哈希（T10 post-soak 冒烟）。
- 版本门（VerQueryValue P/Invoke，未用 .NET FileVersionInfo——对 wails 构建产物恒空，T1 复现）：exe/installer 字符串表 ProductVersion 均 `1.0.0`，与 `wails_tools.nsh INFO_PRODUCTVERSION "1.0.0"` 与运行时 `msg=ready version=1.0.0` 三源一致。
- 尺寸门 ≤30MB：双产物 PASS（9.14 / 7.46）。
- zip 内容：`nats-desktop.exe` + `README-portable.txt`（UTF-8 BOM：免安装说明、SmartScreen/未签名提示 TODO-002、数据位置与明文凭证警告、SHA256 校验、语言切换/更新检查指引）。
- 注：zip 哈希不可复现（Compress-Archive 嵌入 mtime）；installer 哈希对相同输入稳定。安装/卸载冒烟全过（matrix #40，2026-09-15）：`/S` 静默装/卸、无 UAC、开始菜单与 HKCU Uninstall 键生灭正确、`%APPDATA%` 数据按设计保留。
- 打包记录：T9 报告（NSIS 3.12 便携装前置、`windows:package INSTALL_SCOPE=user VERSION=1.0.0` 版本陷阱规避、make-release.ps1 幂等门禁）。

## 3. CI 首跑五轮迭代史（push 授权后，2026-09-14；即 M6 Task 2+3 提前消化）

| 轮 | run ID | 触发提交 | 结果 → 整改 |
|---|---|---|---|
| 1 | **34793152560** | push 8c32bac..（M5 全量 105 提交） | go job 挂在 vet（`go:embed frontend/dist` 无产物——go job 从未真跑的潜伏缺陷暴露）；frontend job 挂在 eslint 4 处（M5 组件本机未跑过 lint）→ go job 加占位 dist + eslint 修复（SORT_KEYS 类型化/三处 hook 依赖，ebd07d3） |
| 2 | 34793640071 | ebd07d3 | **`-race` 首跑真发现（M1 起挂账项正式闭环）**：① jsm.go serverdata 竞态（request.go:145 尾读计数无锁）；② TestHeaderMatchPerformance（性能断言在 -race 下无意义）；③ TestBackupRestoreRoundTrip（恢复重放最终一致，CI 慢盘 24/50）→ 新建 `internal/sysreq` 包（DoReq 的 race-free 复制适配，尾读入锁；monitor reqFn/directedReq + testutil 全改道）+ race_on/off 构建标签 + backup 轮询断言改最终一致（32c3522） |
| 3 | 34794532410 | 32c3522 | go job ✅（-race 干净）；build job 首跑挂：接口模式 bindings 3 处 TS18047（M6 计划首要项）→ M6 Task 2 就地执行：接口模式全量 regen 重提交（12 文件，-2323/+187）+ 3 处 null-guard + 同命令二次 regen no-op 证明（a71bbc1）+ M6 计划入库（c5820af） |
| 4 | 34795173386 | a71bbc1 | connections 一次性 flake（黑洞 5s 悬挂前提被 CI 网络栈打破，failed 在 disconnect 前合法出现——非管理器缺陷）→ 断言改**次序感知**（真不变量=failed 不得出现在终态 disconnected 之后，583417b） |
| 5 | **34795551931** | 583417b | **四 job 全绿**（go[-race] / frontend / build / lint）——CI 首跑闭环，main @ 583417b 与远端同步 |

**最终绿链**：run 34795551931（四 job 全绿）为 CI 锚点；此后 M6 分支（e60cde1..99f29c6）各任务以本地全量门禁为准（G15），由维护者 push 时触发后续 CI。

## 4. 覆盖率

### 4.1 Go（§20.1 门槛：业务逻辑 ≥80%）

| 包 | Before（M6 前） | After | 门 |
|---|---:|---:|---|
| internal/settings | 72.7% | **97.0%** | ≥80 ✅ |
| internal/version | 77.4%¹ | **90.6%** | ≥80 ✅ |
| internal/appdir | 71.4% | **92.9%**（Dir/LogsDir 函数 100%） | ≥80 ✅ |
| internal/monitor（顺带） | 82.4%（M5 记录值） | **82.8%** | ≥80 ✅ |

¹ version before 77.4 与 brief 记录 75.5 的差异 = T1 改 version.go 后的起始基线（progress.md M6 T4 登记，非漂移）。

全包覆盖（T4 门禁 `-cover` 输出，exit code 保真）：appdir 92.9 / buckets 81.1 / connections 83.7 / jsadmin 81.2 / jsctx 100.0 / logging 71.1 / messaging 86.5 / monitor 82.8 / natsver 85.7 / settings 97.0 / version 90.6；隔离复跑补测：sysreq 79.1 / testutil 69.9（两者不在 §20.1 三包门内；testutil 为夹具包）。

剩余未覆盖（如实）：settings `Save` 的 MarshalIndent 错误分支（全字段可序列化不可达）；version `CheckLatest/CheckUpdate` 真网路径（不打真网）与合法 URL 不可达分支；monitor runClusterOp panic-recover 兜底。

### 4.2 前端（门 ≥70%）

| 面 | 覆盖率 | 说明 |
|---|---:|---|
| 前端总体 | **83.45%** | M5 Task 14 基线（34 文件 268 测试 @83.45%）；M6 T8 +38 用例（308）与 T10 F-1 +1（309）后未重跑 coverage 报告（vitest coverage 非 M6 门禁项），如实注记 |
| kv 面整体 | **88.88%** | M4 整改闭环（68.03 → 88.88：BucketForm 95 / KeyValuePage 93.93 / schema 100） |

### 4.3 纯逻辑 100% 面（§20.1）

环形缓冲（messaging 86.5% 包内核心纯函数全覆盖）、推送模式切换、速率统计、格式化（`lib/format.ts` 新测试表 48 行）——各里程碑证伪测试在案；丢弃计数纯逻辑 100% 为 M2 既有证明。

## 5. 负载 flake 整改记录

- **建档（M6 T1）**：全量套件跨包并行时偶发失败三例——`sysreq TestDoReqPlainPing` / `messaging TestServiceFullChainLocalServer` / `testutil TestStartSysServerPermissions`。**预存性证明**：stash 全部 T1 改动在基点 583417b 复现同 flake。既定口径：负载 flake 不做归因 triage，门禁遇此三例先隔离复跑再定论。
- **整改（6c2cebf）**：仅测试文件 + testutil 夹具助手（ConnectUser，任务书明示许可）——握手/请求/advisory 等待超时裕量 2s/5s → **10s**；零产品代码、零断言语义变更、零 sleep。逐测试明细见 T4 报告「Load-flake stabilization」（含顺手同机制收敛的 TestDoReqNoResponders/TestDoReqSnappyOptOut，非名单但同机理）。
- **验证**：三包联合 `-count=2` 全绿（近似全量并行口径）；全量 `go test ./... -count=1` exit 0（sysreq 3.6s / testutil 5.7s / messaging 81.6s，三例全绿）。
- **诚实注记**：flake 为概率性，一轮绿不证明根除；机理上需 >5× 于既往失败观测的调度饥饿才会复现 10s 窗。
- **CI 侧对照**：connections 黑洞 flake（CI 第 4 轮）属另一机理（网络栈前提差异），以断言次序感知修复（583417b），未动语义。

## 6. `-race` 说明（本机不可用，以 CI 为准）

- **本机**：`-race` 因工具链 cgo 缺陷不可用（msys2 gcc 损坏 + C 盘满，M2 起在案预存环境注记）——本机门禁不含 `-race`，所有本地全量结果均为非 -race。
- **CI**：windows-latest go job 开启 `-race`（race_on 构建标签门控 sysreq 适配层）。**首跑（run 34793640071）即真发现** jsm.go serverdata 竞态（request.go:145 尾读 ctr 无锁，该文件自 2026-05 未动——上游预存），以 `internal/sysreq` race-free 复制适配整改（32c3522；swap-back 条件已在包注释登记）；此后 go job 连续三轮 -race 干净（34794532410 / 34795173386 / 34795551931 全绿）。
- 结论：数据竞争面的权威证据以 CI -race 为准；上游 jsm.go 的原竞点仍在上游库内（应用侧已全部改道 sysreq），列 v1.1 上游整治清单。

## 7. 手测矩阵与 PENDING-MANUAL 汇总

- 矩阵终态：**40 行 = 16 EXECUTED / 24 LIVE-待办 / 0 WAIVED**（matrix；post-soak 批次 2026-09-15 转 EXECUTED 10 行，逐行证据在 T10 报告）。
- 解锁桌面后的 PENDING-MANUAL 全集（精确路径已备）：录屏判读类（上屏 P95 双模式、滚动帧率、洪峰丢帧）、键盘/IME 全程复验、32 张截图基线、原生对话框类（备份/恢复、上传/下载选择器）、AC-027（待远端 release）、典型负载 30min 含监控轮询补全腿（perf §S2/S3）。
- 锁屏是 M1–M5 各 PENDING 腿的共性根因（原生对话框/录屏判读/IME/像素目视不可驱动）；本机中文 IME 另拦截合成文本输入（M2–M5 既定约束同因）。

## 8. 测量与长稳判定指针（数字不在此重复）

| 域 | 结论 | 事实源 |
|---|---|---|
| 双档性能 | 冷启动 155/203ms、空载内存 231/175MB、吞吐 99.5%+1:1、列表加载 34–37ms、100 切换 delta 0、安装包 9.14MB PASS；**典型负载内存 FAIL**（1,294–1,551MB；批量 653.8MB）；滚动/反馈帧级/上屏 P95 PENDING-MANUAL | perf §1/§2/§5/§6/§7 |
| 24h 长稳 | **AC-025 FAIL**：17.5h 崩溃（日志 57min 冻结 + 内存 157→16,018MB 线性 + 宿主静默退出无 WER）；短档验证跑全绿 | soak §8（§5 验证跑） |
| 压力数据集 | 10,002 流 / 1M×256B / 100k KV（loaddata 幂等预置 5m57s）；AC-028 取数门全 PASS | perf §6 |
| 前端 bench | sessions steady 25.42hz / cold-flood 4.19hz；streams sort 108.4hz / cold-mount 73.5hz（2/2 过，M2 基线同量级） | perf §1.7 |
| 安全终扫 | AC-030 三腿 PASS（F-1 已修 99f29c6）；源码 52 文件 + 日志样本 0 凭证命中 | T10 报告 §2/§4 |
