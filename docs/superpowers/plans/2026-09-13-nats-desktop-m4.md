# NATS 桌面客户端 M4（KeyValue + 对象存储）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M4 里程碑：KV 桶与键的完整管理（桶 CRUD/compact、键分页浏览与批量值补齐、修订历史、put/create/update 三语义含冲突结构化反馈、del/purge、revert、watch 实时视图）+ 对象桶与对象完整管理（桶 CRUD/封存、对象浏览/改名/删除、多文件上传与流式下载含进度/速率/SHA256 校验/磁盘空间检查、watch），外加 M3 验收记录列入 M4 的整改项（覆盖率四项、workqueue 浏览提示）。

**Architecture:** Go 侧新增 `internal/buckets` 包，全部走 **jetstream API**（KeyValueManager/ObjectStoreManager 内嵌于 JetStream 接口，无需 jsm）：复用 jsadmin 的 connSource/handles/CallResult 模式（包内私有重声明 3 行接口，零 churn）。watch 为**通用管理器**（单 goroutine + 有界 channel 4096 丢最旧计数 + 原子 id 注册表 + 断连全停，main.go emit side-band 扩展 `bktSvc.NotifyConnState`），KV 与对象共用。上传/下载经**计数 Reader/Writer 包装**实现进度事件（`obj:transfer`），下载 tee 进 SHA256 与 `ObjectInfo.Digest`（`SHA-256=<b64url>`）校验，Windows 磁盘空间用 `x/sys/windows.GetDiskFreeSpaceEx`（已是依赖）。前端新增 `features/kv/` 与 `features/objects/`，watch 视图复用虚拟列表模式。

**Tech Stack:** 沿用 M1–M3（Wails v3.0.0-beta.20、Go 1.26、React 18 + TS + Vite、Tailwind v4、shadcn、lucide、zod、vitest ^5、@tanstack/react-virtual）。Go **零新增依赖**（x/sys/windows 已在）。前端唯一加法例外：devDependency `@vitest/coverage-v8`（覆盖率门槛 §20.1 可测性，M3 验收整改项 9，不进产物）。

**规格依据:** `docs/superpowers/specs/2026-09-11-nats-desktop-v1-spec.md`（v1.1）§6.8（KeyValue）/§6.9（对象存储）/§6.4（watch 复用订阅会话机制语义）/§8.5（事件契约加法扩展）/§11/§12/§18，AC-013、AC-014、AC-029（值/对象二进制半边复用 PayloadView）。M3 验收记录（`2026-09-12-nats-desktop-m3-acceptance.md`）§6 遗留清单第 9 项（覆盖率整改四项）与第 3 项（workqueue 提示）并入；nsr_domain 经查证 **natscli 与 jsm.go 均未接入 JS 定位**（jsm.New 仅用 JSDomain/JSAPIPrefix）——显式裁定不接（natscli parity），验收记录登记；备份取消/恢复改名继续延 M6（M3 裁定原文）。

## Global Constraints

来自规格 v1.1 与既有里程碑裁定的硬约束（值逐字取自规格/验收记录）：

1. **KV 冲突语义（§6.8 异常表）**：create 冲突 → 显示冲突提示并**引导改用 put 或查看现有值**；update 版本冲突 → 显示冲突说明与**最新修订版号**，**保留用户编辑内容**（前端错误不丢草稿）；revert 无历史（键仅一次修订）→ **禁用 revert 按钮并提示原因**（前端按 revision 判定禁用，Go 侧 sentinel `ErrNoHistory` 双保险）。冲突走**新 error_code `conflict`**（闭集加法扩展：`not_connected`/`js_unavailable`/`not_found`/`validation`/`server`/`cancelled`/`conflict`）；update 冲突结果附 `current_revision` 字段。
2. **对象异常（§6.9 异常表）**：上传中断（连接断开）→ 停止上传、**标记该对象为不完整、不删除已完成分片、提示重试入口**（transfer 事件 `phase=incomplete`，复用 M3 backup 模式）；下载目标磁盘剩余空间小于对象大小 → **开始前提示并阻止**（`GetDiskFreeSpaceEx` 预检，前端阻止 + Go 侧拒绝双保险）；封存桶写操作 → 显示服务器错误原文并提示封存状态（桶详情 `sealed` 状态下前端禁用上传/编辑，错误仍原文透传）。
3. **危险操作分级（延续 §6.6/§6.12 裁定）**：删除桶（KV 与对象）= 二级名称匹配确认（错误名拒绝且对话框保持）；删键（del，历史可查可 revert）/purge 键 / 桶 compact（PurgeDeletes，破坏性清史）/ 删除对象 / 封存对象桶 = 一级确认；`confirm_level=relaxed` 一级直执行，二级任何级别强制。
4. **事件契约加法扩展（§8.5）**：新增三个事件——`kv:watch`（载荷 `{watch_id, bucket, key, revision, operation: put|delete|purge, payload_b64, payload_size, is_utf8, timestamp_ms, dropped_total}`，`key=""` 为初始完成 sentinel）、`obj:watch`（`{watch_id, bucket, name, size, chunks, digest, mod_time_ms, deleted, dropped_total}`，`name=""` 为 sentinel）、`obj:transfer`（`{transfer_id, bucket, name, direction: upload|download, phase: running|complete|incomplete, bytes_done, bytes_total, digest_match?, error?}`）。watch 发射经有界 channel（4096）**丢最旧并计数**（背压：UI 可用优先；`dropped_total` 随每条事件捎带累计丢弃数——§6.4「丢弃计数准确显示」的 wire 来源；每 4096 次丢弃打一条 WARN 日志）；transfer 事件 phase 单调（running→complete/incomplete，终态后不再发射）。全部载荷蛇形 json。watch 的订阅 ctx 必须是**长生命周期**（仅受 StopWatch/断连控制的 cancel ctx）——**绝不带 s.timeout()**（nats.Context(ctx) 会随超时静默注销订阅）。
5. **值/对象内容不入日志（§13.3 延续）**：KV 值、对象数据、摘要以外的文件内容不入日志；本地文件路径、键名、对象名、字节数、修订号可入。凭证不入日志（延续）。
6. **键名与桶名校验（双侧对齐 nats.go 真实规则）**：**桶名** `^[a-zA-Z0-9_-]+$`（nats.go `validBucketRe`，KV 与对象桶同则——**不是** stream 名规则，stream 允许 `.` `>` `*`）；**键名** `^[-/_=.a-zA-Z0-9]+$` 且禁前后点/连续点（nats.go `validKeyRe` + `keyValid()`，含 `/`——natscli 创建的 `a/b` 键必须可读写）；watch 过滤串另用 searchKey 规则（键规则 + `*` 与尾部 `>`）。zod 与 Go 同规则，枚举显式值禁空串（M3 Global 11 延续）。
7. **KV 值大小上限**：payload 编辑器仅 UTF-8 文本可写；非 UTF-8 值走查看 + hex + 下载（复用 `PayloadView`）；值字节数 >8MB 前端拦截不提交（对齐 §6.3 发布防护口径），Go 侧校验双保险。
8. **SHA256 校验（AC-014）**：下载完成时 Go 侧 tee 计算的 SHA256 与 `ObjectInfo.Digest`（`SHA-256=<base64url>` 格式）比对，结果经 `digest_match` 事件字段回传；不匹配 → `phase=incomplete` + 错误说明（文件保留供人工比对）。
9. **性能与规模（§12 精神 + AC-013/014）**：1,000 键桶键列表（含当前页 50 键值补齐）≤500ms（高配）/≤1.5s（低配门）；watch 初始 1k 键 + 10k 更新**零丢失**（4,096 缓冲 + 消费速率下断言）；100MB 对象上传/下载吞吐与进度字节精确性实测记录（bytes_done 收尾 == bytes_total）；并发 12 goroutine 桶/键混合操作零错误。
10. **i18n（AC-021）**：新增 `kv.*`、`objects.*` 命名空间 en/zh-CN 双侧同步（完整性门禁）。
11. **UI 规范（§18 延续）**：lucide SVG 禁 emoji；值/JSON 等宽字体（PayloadView 复用）；空态引导；失败 toast + 可展开原文；主题三态。
12. **依赖**：Go 零新增（x/sys/windows v0.47.0 已 direct；并发用 `sync.WaitGroup`——**不用 errgroup**，golang.org/x/sync 当前不在依赖树）；前端唯一例外 devDependency `@vitest/coverage-v8`（M3 整改项 9，dev-only 不进产物——**钉版本** `npm i -D -E @vitest/coverage-v8@5.0.0`，与 lockfile 的 vitest 5.0.0 精确 peer 匹配）。
13. **真服务器测试（用户 2026-09-11 指令延续）**：LocalServer（nats://127.0.0.1:4333，2s 探测 skip）+ 内嵌双路径；`<Area><Behavior>LocalServer` 命名。
14. **M3 遗留整改并入（验收记录 §6 第 9 项）**：jsadmin 覆盖率 78.8%→≥80%（补 mirror/source copy 分支、unavailable ErrorCode pin、jsctx domain 分支、PickBackupDirectory headless 分支等台账列名的缺口测试）；logging 轮转失败路径测试；前端 coverage provider 接入并记录组件覆盖率基线（≥70% 门槛，未达标列整改）；workqueue 流浏览 `allow_direct` 提示（StreamMsgs 错误 toast 附加指引文案，前端已知 retention）。
15. **提交纪律与 bindings 惯例（M3 延续）**：conventional commits 红→绿→提交；`wails3 generate bindings -ts -clean=true` 后重生树**不入库**（9207fd3 空值守卫已就位，手改 models 提交）；分支 `desktop/m4` 自 main 切出。

## File Structure

```
desktop/
├── internal/
│   └── buckets/                      # 新包：KV + 对象存储（全 jetstream API）
│       ├── types.go                  # wire 契约 + 错误码 + 事件常量（Task 1）
│       ├── forms.go                  # 桶/键表单校验映射 + KV 错误分类（纯逻辑）（Task 1）
│       ├── service.go                # 绑定门面 + handles() + connSource（Task 2）
│       ├── kv.go                     # KV 桶 CRUD/compact + 键全操作（Task 2/3）
│       ├── watch.go                  # 通用 watch 管理器 + KV/对象 watch + NotifyConnState（Task 4）
│       ├── objects.go                # 对象桶 CRUD/封存 + 对象浏览/改名/删除（Task 5）
│       ├── transfer.go               # 上传/下载 + 进度 + SHA256 + 磁盘预检 + 文件选择（Task 6）
│       ├── disk_windows.go           # GetDiskFreeSpaceEx（Task 6，//go:build windows）
│       ├── disk_other.go             # 非 Windows 桩（Task 6）
│       └── *_test.go                 # 内嵌 + LocalServer 双路径
├── main.go                           # 修改：注册 BucketService + emit side-band NotifyConnState（Task 4）
└── frontend/
    ├── src/
    │   ├── features/
    │   │   ├── kv/
    │   │   │   ├── KeyValuePage.tsx  # 桶列表 + 详情 + 键列表布局（Task 7）
    │   │   │   ├── BucketForm.tsx    # KV 桶创建/编辑/复制（Task 7）
    │   │   │   ├── KeyList.tsx       # 键分页/筛选（客户端分页）（Task 7）
    │   │   │   ├── KeyDetail.tsx     # 值查看 + 历史列表（Task 7）
    │   │   │   ├── KeyEditor.tsx     # put/create/update 编辑器（冲突保草稿）（Task 7）
    │   │   │   ├── WatchPanel.tsx    # KV watch 实时视图（Task 7）
    │   │   │   ├── schema.ts         # zod（Task 7）
    │   │   │   └── useKv.ts          # 数据/操作/watch hook（Task 7）
    │   │   ├── objects/
    │   │   │   ├── ObjectsPage.tsx   # 桶列表 + 详情 + 对象列表（Task 8）
    │   │   │   ├── BucketForm.tsx    # 对象桶表单（Task 8）
    │   │   │   ├── ObjectList.tsx    # 对象列表（Task 8）
    │   │   │   ├── UploadPanel.tsx   # 多选上传 + 进度（Task 8）
    │   │   │   ├── schema.ts         # zod（Task 8）
    │   │   │   └── useObjects.ts     # 数据/操作/transfer/watch hook（Task 8）
    │   │   └── streams/StreamMsgs.tsx # 修改：workqueue allow_direct 提示（Task 9）
    │   ├── lib/bindings.ts           # 修改：buckets 再导出（Task 7 起）
    │   └── App.tsx                   # 修改：kv/objects 占位换 lazy（Task 7/8）
    ├── tests/kv-*.test.tsx、objects-*.test.tsx  # 组件测试（Task 7/8）
    └── tests/bench/  # （无新增——规模基准在 Go 侧）
.github/workflows/desktop-ci.yml      # 修改：go job 加 -cover 输出；frontend job 加 coverage（Task 10）
docs/superpowers/plans/2026-09-13-nats-desktop-m4-acceptance.md  # Task 11
docs/superpowers/plans/2026-09-13-nats-desktop-m4-test-report.md # Task 11
```

职责边界：`forms.go` 纯逻辑零 NATS 依赖（100% 单测）；`kv.go`/`objects.go` 各管一个资源面；`watch.go` 只管订阅生命周期与背压；`transfer.go` 只管字节搬运与进度/校验；`service.go` 只做门面。KV 值编码复用 `jsadmin.EncodeBrowserMsg` 的口径（本包自带 `encodeValue` 同构实现，避免跨包导出 churn——两处各 ~15 行，裁定可接受）。

---

### Task 1: buckets 契约与纯逻辑（类型/表单校验/KV 错误分类）

**Files:**
- Create: `desktop/internal/buckets/types.go`、`desktop/internal/buckets/forms.go`、`desktop/internal/buckets/forms_test.go`

**Interfaces:**
- Consumes: `jetstream`（仅类型引用：`KeyValueConfig/ObjectStoreConfig`）。
- Produces（后续任务全部依赖，签名逐字）:
  - `CallResult` 同 jsadmin 口径（本包重声明：`{ErrorCode, Error string}` + `Ok()`），错误码常量含新增 `CodeConflict = "conflict"`；`ClassifyKvError(err error) CallResult`（`ErrKeyExists`/`ErrKeyRevisionMismatch` → conflict；`ErrKeyNotFound`/`ErrBucketNotFound` → not_found；`ErrBucketExists` → conflict；其余经 `ClassifyError` 同构分支——本包复制 jsadmin 双分支实现并补 KV sentinels）。
  - `KvBucketForm{Name, Description string; History uint8; TtlSeconds int64; MaxBytes int64; Replicas int; MaxValueSize int32}`（数值 0=默认）；`ValidateKvBucketForm(f) error`。
  - `ObjBucketForm{Name, Description string; MaxBytes int64; Replicas int}`；`ValidateObjBucketForm(f) error`。
  - `KvBucketSummary{Name, Description string; Values uint64; History int64; TtlSeconds int64; Bytes uint64; MaxBytes int64; Replicas int; IsCompressed bool}`；`BuildKvBucketSummary(st jetstream.KeyValueStatus) KvBucketSummary`。
  - `ObjBucketSummary{Name, Description string; Size uint64; ObjectCount? —— 注意 ObjectStoreStatus 无 count 字段（验证过：Bucket/Description/TTL/Storage/Replicas/Sealed/Size/BackingStore/Metadata/IsCompressed），`ObjBucketSummary{Name, Description string; Size uint64; Sealed bool; Replicas int; TtlSeconds int64}`；`BuildObjBucketSummary(st jetstream.ObjectStoreStatus) ObjBucketSummary`。
  - `KeyMeta{Key string; Revision uint64; CreatedMs int64; Operation string}`（operation: put|delete|purge）；`BuildKeyMeta(e jetstream.KeyValueEntry) KeyMeta`。
  - `KeyValueOut{Key string; Revision uint64; PayloadB64 string; PayloadSize int; IsUtf8 bool; CreatedMs int64; Operation string; NotFound bool}`（批量值补齐的单键结果，缺失键 NotFound=true 而非整批失败）；`encodeValue(key string, val []byte, rev uint64, created time.Time, op string) KeyValueOut`。
  - `ValidateKeyName(key string) error`（字符集 `^[-/_=.a-zA-Z0-9]+$`，禁空、禁前后点/`..`；含 `/`——natscli 互操作）；`ValidateWatchFilter(s string) error`（键规则放宽：允许 `*` 与尾部 `>`）；`ValidatePayloadSize(n int) error`（>8MB 拒绝）。
  - wire 事件类型 `KvWatchEvent/ObjWatchEvent/ObjTransferEvent`（Global 4 载荷）+ 常量 `EventKvWatch="kv:watch"`、`EventObjWatch="obj:watch"`、`EventObjTransfer="obj:transfer"`；sentinels `ErrNoHistory = errors.New("key has no previous revision to revert to")`、`ErrDiskSpace = errors.New("insufficient disk space at download target")`、`ErrPayloadTooLarge`（本包口径）。

- [ ] **Step 1: 写失败的测试（forms_test.go）**

```go
package buckets

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

func TestValidateKvBucketForm(t *testing.T) {
	// 合法组：History 0（=服务器默认 1）与显式值均可
	for _, ok := range []KvBucketForm{
		{Name: "CFG", History: 5, Replicas: 1},
		{Name: "cfg-2_x", History: 0, Replicas: 0}, // Replicas 0 → 默认 1
	} {
		if err := ValidateKvBucketForm(&ok); err != nil {
			t.Fatalf("%+v: %v", ok, err)
		}
	}
	bad := []KvBucketForm{
		{Name: "", Replicas: 1},                  // 空名
		{Name: "has space", Replicas: 1},         // 桶名字符集 ^[a-zA-Z0-9_-]+$
		{Name: "my.bucket", Replicas: 1},         // 点对桶名非法（stream 规则不适用）
		{Name: "S", Replicas: 9},                 // 副本 1–5
		{Name: "S", TtlSeconds: -1, Replicas: 1}, // TTL ≥0
		{Name: "S", MaxBytes: -2, Replicas: 1},   // ≥-1
	}
	for i := range bad {
		if err := ValidateKvBucketForm(&bad[i]); err == nil {
			t.Fatalf("case %d accepted: %+v", i, bad[i])
		}
	}
}
```

```go
func TestValidateKeyName(t *testing.T) {
	// 字符集 = nats.go validKeyRe ^[-/_=.a-zA-Z0-9]+$ + 禁前后点/连续点（含 / —— natscli 互操作）
	for _, ok := range []string{"a", "ab", "app.name", "k-1_x=2", "A.B.C", "path/key"} {
		if err := ValidateKeyName(ok); err != nil {
			t.Fatalf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "a b", "a*", ">", ".a", "a.", "a..b"} {
		if err := ValidateKeyName(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	// watch 过滤串单独规则：键规则 + `*` + 尾部 `>`
	if err := ValidateWatchFilter("a.*"); err != nil {
		t.Fatalf("watch filter: %v", err)
	}
	if err := ValidateWatchFilter("a.>"); err != nil {
		t.Fatalf("watch filter tail: %v", err)
	}
}

func TestClassifyKvError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"key exists", jetstream.ErrKeyExists, CodeConflict},
		{"revision mismatch", jetstream.ErrKeyRevisionMismatch, CodeConflict},
		{"bucket exists", jetstream.ErrBucketExists, CodeConflict},
		{"key not found", jetstream.ErrKeyNotFound, CodeNotFound},
		{"bucket not found", jetstream.ErrBucketNotFound, CodeNotFound},
		{"stream not found (jetstream envelope)", jetstream.ErrStreamNotFound, CodeNotFound},
		{"other", jetstream.ErrJetStreamNotEnabled, CodeJSUnavailable},
	}
	for _, c := range cases {
		if got := ClassifyKvError(c.err).ErrorCode; got != c.want {
			t.Fatalf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}

func TestBuildKvBucketSummary(t *testing.T) {
	// 桩 status：jetstream.KeyValueStatus 接口共 10 方法（Bucket/Values/History/TTL/
	// BackingStore/Bytes/IsCompressed/LimitMarkerTTL/Metadata/Config）——
	// MaxBytes/Replicas 无 getter，必须经 Config() 取（kv.go:311-343）。
	stub := stubKvStatus{bucket: "CFG", values: 42, history: 5, ttlSecs: 60, bytes: 1024, compressed: true, maxBytes: 2048, replicas: 2}
	s := BuildKvBucketSummary(stub)
	if s.Name != "CFG" || s.Values != 42 || s.History != 5 || s.TtlSeconds != 60 || s.Bytes != 1024 || !s.IsCompressed {
		t.Fatalf("%+v", s)
	}
	if s.MaxBytes != 2048 || s.Replicas != 2 {
		t.Fatalf("config-derived fields: %+v", s) // 经 stub.Config() 取
	}
}

func TestEncodeValueRoundTrip(t *testing.T) {
	out := encodeValue("k", []byte("hello"), 3, time.Unix(1700000000, 0), "put")
	if out.Revision != 3 || out.PayloadSize != 5 || !out.IsUtf8 || out.Operation != "put" || out.CreatedMs != 1700000000000 {
		t.Fatalf("%+v", out)
	}
	raw, err := base64.StdEncoding.DecodeString(out.PayloadB64)
	if err != nil || string(raw) != "hello" {
		t.Fatalf("b64: %v", err)
	}
	if out := encodeValue("k", []byte{0xff}, 4, time.Time{}, "put"); out.IsUtf8 {
		t.Fatal("binary must be non-utf8")
	}
}

func TestWireTagsAreSnakeCase(t *testing.T) {
	b, _ := json.Marshal(KvWatchEvent{WatchId: "w1", Bucket: "B"})
	if !strings.Contains(string(b), `"watch_id":"w1"`) || !strings.Contains(string(b), `"bucket":"B"`) {
		t.Fatalf("kv watch wire: %s", b)
	}
	b2, _ := json.Marshal(ObjTransferEvent{TransferId: "t1", BytesTotal: 9})
	if !strings.Contains(string(b2), `"transfer_id":"t1"`) || !strings.Contains(string(b2), `"bytes_total":9`) {
		t.Fatalf("transfer wire: %s", b2)
	}
}
```

- [ ] **Step 2: 红灯 → 实现 types.go + forms.go**

`types.go` 完整内容（错误码 + wire 类型 + 事件常量 + sentinels）：

```go
// Package buckets implements the KeyValue (§6.8) and Object Store (§6.9)
// management surface over the jetstream API.
package buckets

import "errors"

const (
	CodeOK            = ""
	CodeNotConnected  = "not_connected"
	CodeJSUnavailable = "js_unavailable"
	CodeNotFound      = "not_found"
	CodeValidation    = "validation"
	CodeServer        = "server"
	CodeCancelled     = "cancelled"
	CodeConflict      = "conflict" // KV create 已存在 / update 修订不符 / 桶已存在（§6.8 异常 1/2）
)

type CallResult struct {
	ErrorCode string `json:"error_code"`
	Error     string `json:"error"`
}

func (r CallResult) Ok() bool { return r.ErrorCode == CodeOK }

func fail(code, msg string) CallResult { return CallResult{ErrorCode: code, Error: msg} }

var (
	ErrNoHistory       = errors.New("key has no previous revision to revert to")
	ErrDiskSpace       = errors.New("insufficient disk space at download target")
	ErrPayloadTooLarge = errors.New("value exceeds 8MB limit")
)

// Event names (spec §8.5 additive extensions).
const (
	EventKvWatch     = "kv:watch"
	EventObjWatch    = "obj:watch"
	EventObjTransfer = "obj:transfer"
)

type KvBucketForm struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	History       uint8  `json:"history"`        // 0 = 服务器默认(1)，1–64
	TtlSeconds    int64  `json:"ttl_seconds"`    // ≥0，0 = 不过期
	MaxBytes      int64  `json:"max_bytes"`      // ≥-1
	Replicas      int    `json:"replicas"`       // 1–5，0 视为 1
	MaxValueSize  int32  `json:"max_value_size"` // ≥-1
}

type KvBucketSummary struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	Values        uint64 `json:"values"`
	History       int64  `json:"history"`
	TtlSeconds    int64  `json:"ttl_seconds"`
	Bytes         uint64 `json:"bytes"`
	MaxBytes      int64  `json:"max_bytes"`
	Replicas      int    `json:"replicas"`
	IsCompressed  bool   `json:"is_compressed"`
}

type ObjBucketForm struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	MaxBytes    int64  `json:"max_bytes"` // ≥-1
	Replicas    int    `json:"replicas"`  // 1–5
}

type ObjBucketSummary struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Size        uint64 `json:"size"`
	Sealed      bool   `json:"sealed"`
	Replicas    int    `json:"replicas"`
	TtlSeconds  int64  `json:"ttl_seconds"`
}

type ListBucketsResult struct {
	CallResult
	KvBuckets         []KvBucketSummary `json:"kv_buckets"`
	ObjBuckets        []ObjBucketSummary `json:"obj_buckets"`
	UnavailableReason string            `json:"unavailable_reason"`
}

type BucketDetailResult struct {
	CallResult
	Form      KvBucketForm `json:"form"` // KV 详情（GetKvBucketDetail）
	CreatedMs int64        `json:"created_ms"`
}

// KeyMeta: 键名+元数据（列表用，值另行批量补齐）。
type KeyMeta struct {
	Key        string `json:"key"`
	Revision   uint64 `json:"revision"`
	CreatedMs  int64  `json:"created_ms"`
	Operation  string `json:"operation"` // put | delete | purge
}

type ListKeysResult struct {
	CallResult
	Keys []KeyMeta `json:"keys"`
}

// KeyValueOut: 批量值补齐的单键结果；缺失键 NotFound=true（键在列表后被删）。
type KeyValueOut struct {
	Key         string `json:"key"`
	Revision    uint64 `json:"revision"`
	PayloadB64  string `json:"payload_b64"`
	PayloadSize int    `json:"payload_size"`
	IsUtf8      bool   `json:"is_utf8"`
	CreatedMs   int64  `json:"created_ms"`
	Operation   string `json:"operation"`
	NotFound    bool   `json:"not_found"`
}

type GetKeyValuesResult struct {
	CallResult
	Values []KeyValueOut `json:"values"`
}

type KeyHistoryEntry struct {
	Revision    uint64 `json:"revision"`
	PayloadB64  string `json:"payload_b64"`
	PayloadSize int    `json:"payload_size"`
	IsUtf8      bool   `json:"is_utf8"`
	CreatedMs   int64  `json:"created_ms"`
	Operation   string `json:"operation"`
}

type GetKeyHistoryResult struct {
	CallResult
	Entries []KeyHistoryEntry `json:"entries"`
}

// PutKeyResult: revision 为新修订号；冲突时 CurrentRevision 填当前修订（§6.8 异常 2）。
type PutKeyResult struct {
	CallResult
	Revision        uint64 `json:"revision"`
	CurrentRevision uint64 `json:"current_revision"`
}

type ObjectOut struct {
	Name      string `json:"name"`
	Size      uint64 `json:"size"`
	Chunks    uint32 `json:"chunks"`
	Digest    string `json:"digest"`
	ModTimeMs int64  `json:"mod_time_ms"`
	Deleted   bool   `json:"deleted"`
}

type ListObjectsResult struct {
	CallResult
	Objects []ObjectOut `json:"objects"`
}

// KvWatchEvent / ObjWatchEvent / ObjTransferEvent（Global 4 载荷）。
type KvWatchEvent struct {
	WatchId     string `json:"watch_id"`
	Bucket      string `json:"bucket"`
	Key         string `json:"key,omitempty"` // "" = 初始完成 sentinel
	Revision    uint64 `json:"revision"`
	Operation   string `json:"operation"`
	PayloadB64  string `json:"payload_b64,omitempty"`
	PayloadSize int    `json:"payload_size"`
	IsUtf8      bool   `json:"is_utf8"`
	TimestampMs int64  `json:"timestamp_ms"`
	DroppedTotal uint64 `json:"dropped_total"` // 发射时累计丢弃数（§6.4 丢弃计数显示的 wire 来源）
}

type ObjWatchEvent struct {
	WatchId   string `json:"watch_id"`
	Bucket    string `json:"bucket"`
	Name      string `json:"name,omitempty"` // "" = sentinel
	Size      uint64 `json:"size"`
	Chunks    uint32 `json:"chunks"`
	Digest    string `json:"digest"`
	ModTimeMs int64  `json:"mod_time_ms"`
	Deleted   bool   `json:"deleted"`
	DroppedTotal uint64 `json:"dropped_total"`
}

type ObjTransferEvent struct {
	TransferId string `json:"transfer_id"`
	Bucket     string `json:"bucket"`
	Name       string `json:"name"`
	Direction  string `json:"direction"` // upload | download
	Phase      string `json:"phase"`     // running | complete | incomplete
	BytesDone  uint64 `json:"bytes_done"`
	BytesTotal uint64 `json:"bytes_total"`
	DigestMatch *bool `json:"digest_match,omitempty"` // 下载完成时
	Error      string `json:"error,omitempty"`
}
```

`forms.go`：`ClassifyKvError`（先 KV sentinels：`errors.Is(err, jetstream.ErrKeyExists/ErrKeyRevisionMismatch/ErrBucketExists) → CodeConflict`；`ErrKeyNotFound/ErrBucketNotFound → CodeNotFound`；再走与 jsadmin 相同的 `jetstream.JetStreamError` 双分支 + `nats.ErrNoResponders → js_unavailable` + 兜底 server）；`ValidateKvBucketForm`（**桶名 `^[a-zA-Z0-9_-]+$`**（nats.go validBucketRe，非 stream 规则）、replicas 1–5 默认 1、ttl_seconds ≥0、max_bytes/max_value_size ≥-1、history ≤64）；`ValidateObjBucketForm`（name/replicas/max_bytes 同口径）；`ValidateKeyName`（**`^[-/_=.a-zA-Z0-9]+$`** 且不以点开头/结尾/不含 `..`——与 nats.go validKeyRe+keyValid 一致，含 `/`）；`ValidateWatchFilter(s)`（键规则放宽：允许 `*` 与尾部 `>`）；`ValidatePayloadSize`；`BuildKvBucketSummary`（接口 → wire：**MaxBytes/Replicas 经 `st.Config()` 取**——接口无 getter；TTL `.Seconds()` 取整）；`BuildObjBucketSummary`。测试桩 `stubKvStatus` 实现 `jetstream.KeyValueStatus` **全部 10 个方法**（Bucket/Values/History/TTL/BackingStore/Bytes/IsCompressed/LimitMarkerTTL/Metadata→nil/Config→填好 MaxBytes/Replicas 的 KeyValueConfig）。

- [ ] **Step 3: 绿灯 + 提交**

```bash
go test ./internal/buckets/ -v && go vet ./...
git add -A && git commit -m "feat(desktop): buckets wire types, form validation, kv error classification"
```

---

### Task 2: KV 桶服务（CRUD/compact）+ 服务注册

**Files:**
- Create: `desktop/internal/buckets/service.go`、`desktop/internal/buckets/kv.go`、`desktop/internal/buckets/kv_test.go`
- Modify: `desktop/main.go`（注册 BucketService）

**Interfaces:**
- Consumes: Task 1 全部；`jsctx.New`；`settings.Load`（request_timeout_seconds）；jsadmin 的 connSource 模式（本包重声明：`type connSource interface { Conn() *nats.Conn; JSParams() (string, string, bool) }`，`connections.Manager` 天然满足）。
- Produces（绑定方法）: `NewBucketService(mgr connSource, log *slog.Logger, emit func(name string, data any), settingsPath string) *BucketService`；`ListKvBuckets() ListBucketsResult`（经 `js.KeyValueStores(ctx)` lister；同时填充 ObjBuckets=nil——Task 5 补对象半边）；`GetKvBucketDetail(name string) BucketDetailResult`；`CreateKvBucket(form KvBucketForm) CallResult`；`UpdateKvBucket(form KvBucketForm) CallResult`；`DeleteKvBucket(name string) CallResult`；`CompactKvBucket(name string) CallResult`（`kv.PurgeDeletes(ctx, jetstream.DeleteMarkersOlderThan(-1))`，负值=无条件全删）。

- [ ] **Step 1: 写失败的测试（kv_test.go 核心链路）**

```go
package buckets

import (
	"testing"

	"desktop/internal/testutil"
)

// 助手族（对齐 jsadmin Task 3 模式）
type connStub struct{ nc *nats.Conn; domain, prefix string }

func (c *connStub) Conn() *nats.Conn                 { return c.nc }
func (c *connStub) JSParams() (string, string, bool) { return c.domain, c.prefix, true }

func newSvc(t *testing.T, url string) *BucketService {
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { nc.Close() })
	return NewBucketService(&connStub{nc: nc}, nil, nil, "")
}

func TestKvBucketLifecycle(t *testing.T) {
	svc := newSvc(t, testutil.StartJSServer(t))
	form := KvBucketForm{Name: "CFG", History: 5, Replicas: 1}
	if res := svc.CreateKvBucket(form); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	list := svc.ListKvBuckets()
	if !list.Ok() || len(list.KvBuckets) != 1 || list.KvBuckets[0].Name != "CFG" || list.KvBuckets[0].History != 5 {
		t.Fatalf("list: %+v", list)
	}
	// 详情 → 表单回显
	d := svc.GetKvBucketDetail("CFG")
	if !d.Ok() || d.Form.History != 5 {
		t.Fatalf("detail: %+v", d)
	}
	// 更新（history 5→10）
	form.History = 10
	if res := svc.UpdateKvBucket(form); !res.Ok() {
		t.Fatalf("update: %+v", res)
	}
	if d = svc.GetKvBucketDetail("CFG"); !d.Ok() || d.Form.History != 10 {
		t.Fatalf("after update: %+v", d.Form)
	}
	// 删除
	if res := svc.DeleteKvBucket("CFG"); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	if list = svc.ListKvBuckets(); !list.Ok() || len(list.KvBuckets) != 0 {
		t.Fatalf("after delete: %+v", list)
	}
}

func TestKvBucketCompact(t *testing.T) {
	svc := newSvc(t, testutil.StartJSServer(t))
	if res := svc.CreateKvBucket(KvBucketForm{Name: "CMP", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	// 放键 + 删键 → compact 后桶 Values 下降（删除标记与历史被清除）
	// 注意：PutKey 属 Task 3——本测试**写入 kv_compact_test.go 并以 build tag
	// `//go:build m4_task3` 搁置**，Task 3 Step 3 移除该 tag 启用（跨任务编译交接）。
	if _, res := svc.PutKey("CMP", "k", "djE=", "put", 0); !res.Ok() {
		t.Fatal(res)
	}
}

func TestKvBucketValidationAndErrors(t *testing.T) {
	svc := newSvc(t, testutil.StartJSServer(t))
	if res := svc.CreateKvBucket(KvBucketForm{Name: "", Replicas: 1}); res.ErrorCode != CodeValidation {
		t.Fatalf("gate: %+v", res)
	}
	if res := svc.CreateKvBucket(KvBucketForm{Name: "CFG", Replicas: 1}); !res.Ok() {
		t.Fatal(res)
	}
	// 重复创建 → conflict。注意：nats-server 对"完全相同配置"的重复 CREATE 是幂等成功
	// （DeepEqual 短路，server/stream.go:881-905；nats.go 客户端另有同构兼容分支）——
	// 必须用**差异配置**（不同 Description）才能确定性拿到 ErrBucketExists。
	if res := svc.CreateKvBucket(KvBucketForm{Name: "CFG", Description: "other", Replicas: 1}); res.ErrorCode != CodeConflict {
		t.Fatalf("dup: %+v", res)
	}
	if res := svc.DeleteKvBucket("NOPE"); res.ErrorCode != CodeNotFound {
		t.Fatalf("missing: %+v", res)
	}
}
```

（**跨任务交接指令（Task 2 执行时落实）**：`TestKvBucketCompact` 依赖 Task 3 的 `PutKey`——写入独立文件 `kv_compact_test.go` 并在文件头加 `//go:build m4_task3` 编译标签使本任务全量编译通过；Task 3 Step 3 删除该标签启用。本任务立即交付 `TestKvBucketLifecycle` 与 `TestKvBucketValidationAndErrors`；LocalServer 变体 `TestKvBucketLifecycleLocalServer` 结构同上。）

- [ ] **Step 2: 红灯 → 实现 service.go + kv.go 桶半边**

`service.go`：

```go
type BucketService struct {
	mgr          connSource
	log          *slog.Logger
	emit         func(name string, data any)
	settingsPath string
	watches      *watchRegistry // Task 4 接入；本任务为 nil 安全
}

func NewBucketService(mgr connSource, log *slog.Logger, emit func(name string, data any), settingsPath string) *BucketService {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if emit == nil {
		emit = func(string, any) {}
	}
	return &BucketService{mgr: mgr, log: log, emit: emit, settingsPath: settingsPath}
}

func (s *BucketService) timeout() time.Duration { /* settings.Load → Behavior.RequestTimeoutSeconds，缺省 5s（对齐 jsadmin）*/ }

func (s *BucketService) js() (jetstream.JetStream, CallResult) {
	nc := s.mgr.Conn()
	if nc == nil {
		return nil, fail(CodeNotConnected, "not connected")
	}
	domain, prefix, ok := s.mgr.JSParams()
	if !ok {
		return nil, fail(CodeNotConnected, "not connected")
	}
	js, err := jsctx.New(nc, domain, prefix)
	if err != nil {
		return nil, fail(CodeServer, err.Error())
	}
	return js, CallResult{}
}
```

`kv.go` 桶半边（全部 CallResult；ctx 带 `s.timeout()`）：`ListKvBuckets`（`js.KeyValueStores(ctx)` → range `.Status()` → `BuildKvBucketSummary`；错误分类：no responders → UnavailableReason=ReasonNoResponders 语义对齐 jsadmin，not_connected → 空指引）；`GetKvBucketDetail`（`js.KeyValue(ctx, name).Status(ctx)` → 表单回显 + CreatedMs——KeyValueStatus 无 Created 字段（验证过），CreatedMs=0，`BucketDetailResult.CreatedMs` 恒 0 可接受，前端不显示创建时间）；`CreateKvBucket`（Validate → `jetstream.KeyValueConfig{Name, Description, History, TTL: secs*time.Second, MaxBytes, Replicas, MaxValueSize}` → `js.CreateKeyValue`）；`UpdateKvBucket`（Validate → `js.UpdateKeyValue`）；`DeleteKvBucket`（`js.DeleteKeyValue(ctx, name)`）；`CompactKvBucket`（`kv.PurgeDeletes(ctx, jetstream.DeleteMarkersOlderThan(-1))`——**负值 = 无条件全删**；`0` 是 30 分钟默认而非全删，kv_options.go:77-83，勿用）；main.go 注册 `buckets.NewBucketService(manager, logger, emit, settingsPath)`。

- [ ] **Step 3: 绿灯 + bindings + 提交**

```bash
go test ./internal/buckets/ -v && go test ./... && go vet ./...
wails3 generate bindings -ts -clean=true   # 重生树不入库；models 增量手改提交（9207fd3 惯例）
git add -A && git commit -m "feat(desktop): kv bucket service (crud/compact) with conflict semantics"
```

---

### Task 3: KV 键服务（列表/批量值/历史/put 三语义/del 两模式/revert）

**Files:**
- Modify: `desktop/internal/buckets/kv.go`、`desktop/internal/buckets/kv_test.go`、`desktop/internal/buckets/kv_compact_test.go`（启用 Task 2 搁置测试）

**Interfaces:**
- Consumes: Task 1/2 全部。
- Produces（绑定方法）:
  - `ListKeys(bucket string) ListKeysResult`——`js.KeyValue(ctx, bucket)` → `kv.Watch(ctx, ">", jetstream.MetaOnly(), jetstream.UpdatesOnly()?)` **不用 UpdatesOnly**（需要最新值 meta）→ 收集全部 `KeyValueEntry` 至 nil sentinel → `[]KeyMeta` → `watcher.Stop()`。deleted 键（最新为 delete marker）包含且 Operation=delete（§6.8「历史可查」浏览语义）。
  - `GetKeyValues(bucket string, keys []string) GetKeyValuesResult`——**sync.WaitGroup + 预分配索引写入**并发 8（不用 errgroup：golang.org/x/sync 不在依赖树，Global 12）`kv.Get`；`ErrKeyNotFound` → 该键 `NotFound=true`。
  - `GetKeyHistory(bucket, key string) GetKeyHistoryResult`——`kv.History(ctx, key)` → 含值全量。
  - `PutKey(bucket, key, payloadB64, mode string, expectedRevision uint64) PutKeyResult`——mode 闭集 `put|create|update`：put → `kv.Put`；create → `kv.Create`（`ErrKeyExists → conflict` + 错误文本含「已存在，可改用 put 或查看现有值」指引拼接服务器原文）；update → `kv.Update(ctx, key, val, expectedRevision)`（`ErrKeyRevisionMismatch → conflict`，**冲突时回读当前修订填 CurrentRevision**——`kv.Get` 失败则 0）；校验：ValidateKeyName + ValidatePayloadSize。
  - `DeleteKey(bucket, key, mode string) CallResult`——mode 闭集 `delete|purge`：`kv.Delete` / `kv.Purge`。
  - `RevertKey(bucket, key string) PutKeyResult`——`kv.History` 后按**删除态感知算法**取回退目标：若最新条目为 delete/purge marker → 目标 = **最新非删除修订本身**（恢复最后有效值，删除态 revert 语义）；否则目标 = 最新修订的**前一个**有效修订；有效修订总数 ≤1（活键单修订，或删除态下无更早有效修订）→ `fail(CodeValidation, ErrNoHistory.Error())`；取到目标后 `kv.Put(目标值)` 返回新修订。

- [ ] **Step 1: 写失败的测试（kv_test.go 追加核心链路）**

```go
func TestKvKeyLifecycle(t *testing.T) {
	svc := newSvc(t, testutil.StartJSServer(t))
	svc.CreateKvBucket(KvBucketForm{Name: "OPS", History: 10, Replicas: 1})
	// 键 a 系列（修订号 = 桶底层流序列，全局递增——本块内只写 a，序号可预测）
	r1, res := svc.PutKey("OPS", "a", b64("v1"), "put", 0)
	if !res.Ok() || r1.Revision != 1 {
		t.Fatalf("put1: %+v", res)
	}
	r2, res := svc.PutKey("OPS", "a", b64("v2"), "put", 0)
	if !res.Ok() || r2.Revision != 2 {
		t.Fatalf("put2: %+v", res)
	}
	// create 冲突（§6.8 异常 1，无写入不占序列）
	if _, res := svc.PutKey("OPS", "a", b64("x"), "create", 0); res.ErrorCode != CodeConflict {
		t.Fatalf("create conflict: %+v", res)
	}
	// update 期望不符 → conflict + CurrentRevision（§6.8 异常 2，无写入）
	if _, res := svc.PutKey("OPS", "a", b64("v3"), "update", 1); res.ErrorCode != CodeConflict || res.CurrentRevision != 2 {
		t.Fatalf("update conflict: %+v", res)
	}
	if r3, res := svc.PutKey("OPS", "a", b64("v3"), "update", 2); !res.Ok() || r3.Revision != 3 {
		t.Fatalf("update ok: %+v", res)
	}
	// 历史（3 次修订含值，升序）
	h := svc.GetKeyHistory("OPS", "a")
	if !h.Ok() || len(h.Entries) != 3 || h.Entries[0].Revision != 1 {
		t.Fatalf("history: %+v", h)
	}
	// revert → 回到 v2（put 产生 revision 4）
	r4, res := svc.RevertKey("OPS", "a")
	if !res.Ok() || r4.Revision != 4 {
		t.Fatalf("revert: %+v", res)
	}
	v, _ := svc.GetKeyValues("OPS", []string{"a"})
	if string(mustB64(v.Values[0].PayloadB64)) != "v2" {
		t.Fatalf("revert value: %+v", v.Values[0])
	}
	// del（保留历史）→ 列表标记 delete；历史仍在（4 修订 + marker=5 条）
	if res := svc.DeleteKey("OPS", "a", "delete"); !res.Ok() {
		t.Fatalf("del: %+v", res)
	}
	kl := svc.ListKeys("OPS")
	if kl.Keys[findKey(kl.Keys, "a")].Operation != "delete" {
		t.Fatalf("after del: %+v", kl.Keys)
	}
	if h = svc.GetKeyHistory("OPS", "a"); !h.Ok() || len(h.Entries) != 5 {
		t.Fatalf("history after del: %+v", h)
	}
	// 删除态 revert（F-09 语义）：最新为 delete marker → 恢复最后有效值 v2（put 产生 revision 6）
	r6, res := svc.RevertKey("OPS", "a")
	if !res.Ok() || r6.Revision != 6 {
		t.Fatalf("revert after delete: %+v", res)
	}
	v, _ = svc.GetKeyValues("OPS", []string{"a"})
	if string(mustB64(v.Values[0].PayloadB64)) != "v2" {
		t.Fatalf("revert-after-delete value: %+v", v.Values[0])
	}
	// 键 b（在 a 系列断言全部完成后创建——修订号从 7 起，不干扰上面断言）
	if _, res := svc.PutKey("OPS", "b", b64("new"), "create", 0); !res.Ok() {
		t.Fatalf("create fresh: %+v", res)
	}
	// 列表（MetaOnly 语义，2 键）+ 批量值补齐（含缺失键 NotFound 路径）
	kl = svc.ListKeys("OPS")
	if !kl.Ok() || len(kl.Keys) != 2 {
		t.Fatalf("list: %+v", kl)
	}
	gv := svc.GetKeyValues("OPS", []string{"a", "missing"})
	if !gv.Ok() || len(gv.Values) != 2 || gv.Values[0].PayloadSize != 2 || gv.Values[1].NotFound != true {
		t.Fatalf("values: %+v", gv)
	}
	// revert 无历史（键 b 仅 1 次修订，§6.8 异常 3 Go 半边）
	if _, res := svc.RevertKey("OPS", "b"); res.ErrorCode != CodeValidation || !strings.Contains(res.Error, ErrNoHistory.Error()) {
		t.Fatalf("no-history: %+v", res)
	}
	// purge（彻底清除）→ 历史只剩 marker
	if res := svc.DeleteKey("OPS", "a", "purge"); !res.Ok() {
		t.Fatalf("purge: %+v", res)
	}
}
```

（助手 `b64(s)`/`mustB64(s)`/`findKey(keys, k)` 在 kv_test.go 定义；LocalServer 变体 `TestKvKeyLifecycleLocalServer` 同构。）

- [ ] **Step 2: 红灯 → 实现键半边（按 Interfaces 逐方法；冲突路径的指引文案拼入 Error：`已存在 (key exists)；可改用 put 或查看现有值` 模式——英文服务器原文前置）**

- [ ] **Step 3: 启用 Task 2 搁置的 compact 测试 + 绿灯 + bindings + 提交**

```bash
go test ./internal/buckets/ -run "TestKv" -v && go test ./... && go vet ./...
wails3 generate bindings -ts -clean=true
git add -A && git commit -m "feat(desktop): kv key operations (list/history/put-create-update/del-purge/revert)"
```

---

### Task 4: 通用 watch 管理器（KV + 对象）+ 断连全停

**Files:**
- Create: `desktop/internal/buckets/watch.go`、`desktop/internal/buckets/watch_test.go`
- Modify: `desktop/main.go`（emit closure side-band：`if ev, ok := data.(connections.StateEvent); ok { … bktSvc.NotifyConnState(ev) }`——对齐 msgSvc 既有写法）、`desktop/internal/buckets/service.go`（watches 初始化）

**Interfaces:**
- Consumes: Task 1 事件类型；`jetstream.KeyValue.Watch`/`ObjectStore.Watch`。
- Produces:
  - `CreateKvWatch(bucket, keys string) CreateWatchResult`——`CreateWatchResult{CallResult, WatchId string}`（**单结构体返回**，Wails 多返回值会序列化为 JSON 数组破坏既有前端消费模式）；keys 空 = 整桶（`WatchAll`），否则 `Watch(keys)`（keys 经 `ValidateWatchFilter`）；事件 `kv:watch`（初始逐键 + `key=""` sentinel，随后增量；值含 payload）。**订阅 ctx 用 `context.Background()` 派生的长生命周期 cancel ctx——绝不带 s.timeout()**（`nats.Context(ctx)` 随超时静默注销订阅）。
  - `CreateObjWatch(bucket string) CreateWatchResult`——事件 `obj:watch`。
  - `StopWatch(watchId string) CallResult`；`NotifyConnState(ev connections.StateEvent)`（断开/失败 → 全部 watcher Stop + 注册表清空 + WARN 日志计数）。
  - 背压：每 watcher 一个 `chan any` 容量 4096 的 ring——满时丢最旧 + `dropped atomic.Uint64`；单发射 goroutine 顺序 `emit`，**每条事件捎带 `dropped_total` 字段**（= entry.drop.Load()，前端丢弃计数 wire 来源）且**每 4096 次丢弃打一条 WARN**（对齐 messaging 丢弃语义，§11）；watcher.Stop() 与发射 goroutine 退出经 `done chan`。

- [ ] **Step 1: 写失败的测试（watch_test.go 核心链路）**

```go
func TestKvWatchLifecycle(t *testing.T) {
	url := testutil.StartJSServer(t)
	var mu sync.Mutex
	var events []KvWatchEvent
	svc := NewBucketService(&connStub{nc: mustConn(t, url)}, nil, func(name string, data any) {
		if name == EventKvWatch {
			mu.Lock()
			events = append(events, data.(KvWatchEvent))
			mu.Unlock()
		}
	}, "")
	svc.CreateKvBucket(KvBucketForm{Name: "W", Replicas: 1})
	svc.PutKey("W", "k1", b64("v1"), "put", 0)
	wid, res := svc.CreateKvWatch("W", "")
	if !res.Ok() || wid.WatchId == "" {
		t.Fatalf("watch: %+v", res)
	}
	// 初始值 + sentinel 到达
	waitForCond(t, 2*time.Second, func() bool {
		mu.Lock(); defer mu.Unlock()
		return len(events) >= 2 && events[len(events)-1].Key == ""
	})
	// 增量：另一连接 put + del
	inj := mustConn(t, url)
	defer inj.Close()
	js2, _ := jsctx.New(inj, "", "")
	kv2, _ := js2.KeyValue(context.Background(), "W")
	kv2.Put(context.Background(), "k2", []byte("v2"))
	kv2.Delete(context.Background(), "k1")
	waitForCond(t, 2*time.Second, func() bool {
		mu.Lock(); defer mu.Unlock()
		return len(events) >= 4 && events[len(events)-1].Operation == "delete" && events[len(events)-1].Key == "k1"
	})
	// 停止后再无事件
	if res := svc.StopWatch(wid.WatchId); !res.Ok() {
		t.Fatalf("stop: %+v", res)
	}
	n := len(events)
	kv2.Put(context.Background(), "k3", []byte("v3"))
	time.Sleep(300 * time.Millisecond)
	mu.Lock(); defer mu.Unlock()
	if len(events) != n {
		t.Fatalf("events after stop: %d != %d", len(events), n)
	}
}

func TestWatchStopsOnDisconnect(t *testing.T) {
	// 内嵌服务器 + 关闭连接触发 NotifyConnState(disconnected) → 全部 watch 停止、注册表空
}

func TestKvWatchFloodNoLossLocalServer(t *testing.T) {
	// 1k 初始键 + 10k 更新零丢失（Global 9）：断言 events 计数（put+delete+sentinel）覆盖全部注入
}
```

（`waitForCond`/`mustConn` 本包定义（对齐 jsadmin/messaging 惯例）；`TestKvWatchFloodNoLossLocalServer` 完整实现：1k 键初始（等 sentinel）→ 计数清零 → inj 连接 10k 次 Put 单键 → waitForCond 计数==10k，`svc.watchDropped()==0`。`TestWatchStopsOnDisconnect`：注册 2 个 watch → `svc.NotifyConnState(connections.StateEvent{State: connections.StateDisconnected})` → 断言 `svc.watchCount()==0` 且后续 Put 不产生事件。）

- [ ] **Step 2: 红灯 → 实现 watch.go**

```go
type watchRegistry struct {
	mu      sync.Mutex
	next    uint64
	entries map[string]*watchEntry
}

type watchEntry struct {
	id    string
	ch    chan any // 容量 4096；满则丢最旧
	drop  atomic.Uint64
	done  chan struct{}
	log   *slog.Logger // 丢弃 WARN 落点
	stops []func() // watcher.Stop + 发射 goroutine 退出
}

func (r *watchRegistry) launch(id string, emit func(string, any), eventName string) *watchEntry {
	e := &watchEntry{id: id, ch: make(chan any, 4096), done: make(chan struct{})}
	go func() {
		for {
			select {
			case v := <-e.ch:
				switch ev := v.(type) { // 每条事件捎带累计丢弃数（wire 来源）
				case KvWatchEvent:
					ev.DroppedTotal = e.drop.Load()
					emit(eventName, ev)
				case ObjWatchEvent:
					ev.DroppedTotal = e.drop.Load()
					emit(eventName, ev)
				}
			case <-e.done:
				return
			}
		}
	}()
	return e
}

// offer 有界入队：满时丢最旧并计数（背压裁定，Global 4）；每 4096 次丢弃一条 WARN（§11）。
func (e *watchEntry) offer(v any) {
	for {
		select {
		case e.ch <- v:
			return
		default:
			select {
			case <-e.ch: // 丢最旧
				if n := e.drop.Add(1); n%4096 == 1 && e.log != nil {
					e.log.Warn("watch events dropped", "watch_id", e.id, "dropped_total", n)
				}
			default:
			}
		}
	}
}
```

`CreateKvWatch`：**`wctx, wcancel := context.WithCancel(context.Background())`**（长生命周期——绝不用 `s.timeout()` 的 ctx：`nats.Context(ctx)` 会随超时静默注销订阅；wcancel 存入 entry.stops）；`js.KeyValue(bucket).Watch(wctx, keysOrAll)`（**不用 UpdatesOnly**——要初始值；keys 空 → `WatchAll(wctx)`）；goroutine `for entry := range watcher.Updates()`：nil → offer(sentinel KvWatchEvent{WatchId, Bucket, Key: ""}) 后继续（不退出，增量仍来）；非 nil → `offer(encodeValue(...)) + WatchId`。`StopWatch`：entry 关闭（close done + stops 执行[wcancel + watcher.Stop] + 注册表删除）。`NotifyConnState`：state != connected → 全部 Stop + `s.log.Warn("watchers stopped", "count", n)`。main.go side-band 扩展（msgSvc 行旁追加 bktSvc 行）。

- [ ] **Step 3: 绿灯 + bindings + 提交**

```bash
go test ./internal/buckets/ -run "TestKvWatch|TestWatch" -v && go test ./... && go vet ./...
wails3 generate bindings -ts -clean=true
git add -A && git commit -m "feat(desktop): generic watch manager (kv/obj) with bounded backpressure and disconnect stop"
```

---

### Task 5: 对象桶与对象浏览服务（桶 CRUD/封存/对象列表/删除/改名 + 对象 watch）

**Files:**
- Create: `desktop/internal/buckets/objects.go`、`desktop/internal/buckets/objects_test.go`

**Interfaces:**
- Consumes: Task 1/2/4 全部（ListBucketsResult.ObjBuckets 半边、watchRegistry）。
- Produces（绑定方法）: `ListObjBuckets() ListBucketsResult`（与 ListKvBuckets 同一 result 结构；本方法填 ObjBuckets 半边——前端两页各调各的，result 结构共享）；`GetObjBucketDetail(name string) ObjBucketDetailResult{CallResult, Form ObjBucketForm, Sealed bool}`；`CreateObjBucket/UpdateObjBucket(form) CallResult`；`DeleteObjBucket(name) CallResult`；`SealObjBucket(name) CallResult`（`os.Seal(ctx)`）；`ListObjects(bucket string) ListObjectsResult`（**`os.List(ctx, jetstream.ListObjectsShowDeleted())`**——默认 List 会过滤已删除对象（object.go:1361 IgnoreDeletes），不带该选项「已删除徽标」永不出现；`ErrNoObjectsFound` 吞掉返回空数组）；`DeleteObject(bucket, name) CallResult`（对**不存在**的对象 → not_found；对**已删除**对象再删 → Ok（nats.go 文档语义：已删除不报错），实现时以库行为为准并测试钉住）；`RenameObject(bucket, name, newName string) CallResult`（`os.UpdateMeta(ctx, name, jetstream.ObjectMeta{Name: newName})`）；`CreateObjWatch`（Task 4 registry 复用，Updates `<-chan *ObjectInfo` → ObjWatchEvent）。

- [ ] **Step 1: 写失败的测试（objects_test.go 核心链路）**

```go
func TestObjBucketAndObjectLifecycle(t *testing.T) {
	url := testutil.StartJSServer(t) // 单一 url：svc 与直连 osb 必须指向同一内嵌服务器
	svc := newSvc(t, url)
	if res := svc.CreateObjBucket(ObjBucketForm{Name: "FILES", Replicas: 1}); !res.Ok() {
		t.Fatalf("create: %+v", res)
	}
	// 直接经 jetstream 放一个对象（上传是 Task 6）
	js, _ := jsctx.New(mustConn(t, url), "", "")
	osb, _ := js.ObjectStore(context.Background(), "FILES")
	osb.PutBytes(context.Background(), "doc.txt", []byte("hello"))
	list := svc.ListObjBuckets()
	if !list.Ok() || len(list.ObjBuckets) != 1 || list.ObjBuckets[0].Name != "FILES" {
		t.Fatalf("buckets: %+v", list)
	}
	objs := svc.ListObjects("FILES")
	if !objs.Ok() || len(objs.Objects) != 1 || objs.Objects[0].Size != 5 || objs.Objects[0].Digest == "" {
		t.Fatalf("objects: %+v", objs)
	}
	// 改名 + 删除
	if res := svc.RenameObject("FILES", "doc.txt", "readme.txt"); !res.Ok() {
		t.Fatalf("rename: %+v", res)
	}
	if objs = svc.ListObjects("FILES"); !objs.Ok() || objs.Objects[0].Name != "readme.txt" {
		t.Fatalf("after rename: %+v", objs)
	}
	if res := svc.DeleteObject("FILES", "readme.txt"); !res.Ok() {
		t.Fatalf("delete: %+v", res)
	}
	// 已删除对象仍出现在列表（ShowDeleted）且带 Deleted 徽标（§6.9 浏览语义）
	objs = svc.ListObjects("FILES")
	if !objs.Ok() || len(objs.Objects) != 1 || !objs.Objects[0].Deleted {
		t.Fatalf("after delete: %+v", objs)
	}
	// 对不存在对象 → not_found；对已删除对象再删 → Ok（库文档语义，钉住）
	if res := svc.DeleteObject("FILES", "ghost"); res.ErrorCode != CodeNotFound {
		t.Fatalf("missing: %+v", res)
	}
	if res := svc.DeleteObject("FILES", "readme.txt"); !res.Ok() {
		t.Fatalf("re-delete deleted: %+v", res)
	}
	// 封存 → 写操作被拒（原文透传）+ Sealed 状态可见（§6.9 异常 3 半边）
	if res := svc.SealObjBucket("FILES"); !res.Ok() {
		t.Fatalf("seal: %+v", res)
	}
	d := svc.GetObjBucketDetail("FILES")
	if !d.Ok() || !d.Sealed {
		t.Fatalf("sealed detail: %+v", d)
	}
	if _, err := osb.PutBytes(context.Background(), "x", []byte("y")); err == nil {
		t.Fatal("write to sealed bucket must fail")
	}
}
```

（LocalServer 变体 `TestObjBucketAndObjectLifecycleLocalServer` 同构——同样注意单一 `testutil.ConnectLocalServer` 连接语义。）

- [ ] **Step 2: 红灯 → 实现 objects.go（按 Interfaces 逐方法；ListObjects 空桶/全删除桶返回空数组非 nil；DeleteObject 对已删除对象 → not_found 语义）**

- [ ] **Step 3: 绿灯 + bindings + 提交**

```bash
go test ./internal/buckets/ -run "TestObj" -v && go test ./... && go vet ./...
wails3 generate bindings -ts -clean=true
git add -A && git commit -m "feat(desktop): object bucket and object management (crud/seal/list/rename/delete/watch)"
```

---

### Task 6: 上传/下载（进度事件 + SHA256 + 磁盘预检 + 原生文件选择）

**Files:**
- Create: `desktop/internal/buckets/transfer.go`、`desktop/internal/buckets/disk_windows.go`、`desktop/internal/buckets/disk_other.go`、`desktop/internal/buckets/transfer_test.go`

**Interfaces:**
- Consumes: Task 1 `ObjTransferEvent/ErrDiskSpace`；Wails `application.Get().Dialog.OpenFile()/SaveFile()`（M3 PickBackupDirectory 同款链）；`jetstream.ObjectMeta/ObjectResult`；`os.File`。
- Produces（绑定方法 + 事件）:
  - `PickUploadFiles() []string`（`OpenFile().CanChooseFiles(true).PromptForMultipleSelection()`；取消 → 空 slice）；`PickDownloadDirectory() string`（对齐 PickBackupDirectory）；`OpenInFileManager(path string) CallResult`（§6.9「打开所在目录入口」：Windows 下 `exec.Command("explorer", "/select,"+filepath.Clean(path)).Start()`——零新依赖；其他平台返回 validation「not supported on this platform」）。
  - `UploadObject(bucket, path, rename string) CallResult`——阻塞调用 + `obj:transfer` 事件：transfer_id 自增；`transferMu` 互斥（同 M3 backupMu 模式，同时只允许一个传输——多文件由前端排队）；`os.Open(path)` → `stat.Size()` 为 bytes_total → `countingReader{r, func(n){ emit running(bytes_done) }}` 包装 → `os.Put(ctx, ObjectMeta{Name: renameOrBase}, cr)`；ctx 经 `context.WithTimeout(ctx, 传输超时=max(设置超时, size/1MB*秒)… 简化：ctx 不设超时但挂 conn-close watchdog（对齐 M3 backup.go 的 watchConnClose 模式，代码可参照复制）→ 断连 → Put 返回错误 → `phase=incomplete` + error 原文（已完成分片保留在服务器，重试入口=前端再调一次，Global 2）。
  - `DownloadObject(bucket, name, dir string) CallResult`——磁盘预检：`free, _ := diskFree(dir)`，**`if free > 0 && free < info.Size`** 才拒绝（`free == 0` = 未知平台/查询失败，不阻止——disk_other 桩返回 0；漏掉 `free > 0` 前置会让非 Windows 全部下载被阻止）→ `fail(CodeValidation, ErrDiskSpace)`（开始前阻止，Global 2）；`os.Get(ctx, name)` → ObjectResult → `Info()` 取 bytes_total/digest（返回时 info 已就绪）→ 目标文件 `os.Create(dir/name)`（已存在 → 覆盖前先删，Windows rename 语义）→ `io.Copy(countWriter{f, emit}, result)` + `io.TeeReader` 进 `sha256.New()` → 完成后 `digestMatch := "SHA-256="+base64.URLEncoding.EncodeToString(hash.Sum(nil)) == info.Digest` → 不匹配 → `phase=incomplete` + error「digest mismatch」；匹配 → `phase=complete` + digest_match=true。（注：nats.go 的 `ObjectResult.Read` 在 EOF 时**已内建**摘要校验并返回 `ErrDigestMismatch`——tee 复核是第二道双保险，兼得结构化 digest_match 字段；实现时可先捕获 Read 错误再交叉验证。）
  - `diskFree(path string) (uint64, error)`（windows: GetDiskFreeSpaceEx；other: 返回 0, nil = 未知不阻止）。

- [ ] **Step 1: 写失败的测试（transfer_test.go）**

```go
func TestUploadDownloadRoundTrip(t *testing.T) {
	url := testutil.StartJSServer(t)
	var mu sync.Mutex
	var evs []ObjTransferEvent
	svc := NewBucketService(&connStub{nc: mustConn(t, url)}, nil, func(n string, d any) {
		if n == EventObjTransfer {
			mu.Lock(); evs = append(evs, d.(ObjTransferEvent)); mu.Unlock()
		}
	}, "")
	svc.CreateObjBucket(ObjBucketForm{Name: "TR", Replicas: 1})
	// 2MB 随机文件上传
	src := filepath.Join(t.TempDir(), "blob.bin")
	payload := make([]byte, 2<<20)
	rand.Read(payload)
	os.WriteFile(src, payload, 0o600)
	if res := svc.UploadObject("TR", src, ""); !res.Ok() {
		t.Fatalf("upload: %+v", res)
	}
	mu.Lock()
	last := evs[len(evs)-1]
	mu.Unlock()
	if last.Phase != "complete" || last.BytesTotal != 2<<20 || last.BytesDone != 2<<20 {
		t.Fatalf("upload events: %+v", last)
	}
	// 下载到另一目录 → SHA256 一致（digest_match=true，AC-014）
	dst := t.TempDir()
	if res := svc.DownloadObject("TR", "blob.bin", dst); !res.Ok() {
		t.Fatalf("download: %+v", res)
	}
	got, _ := os.ReadFile(filepath.Join(dst, "blob.bin"))
	if !bytes.Equal(got, payload) {
		t.Fatal("content mismatch")
	}
	mu.Lock(); defer mu.Unlock()
	dlLast := evs[len(evs)-1]
	if dlLast.Phase != "complete" || dlLast.DigestMatch == nil || !*dlLast.DigestMatch {
		t.Fatalf("download digest: %+v", dlLast)
	}
}

func TestDownloadDiskSpaceGate(t *testing.T) {
	// stub diskFree（包级 var 便于替换）返回极小值 → DownloadObject 返回 validation+ErrDiskSpace 且不创建文件
}

func TestUploadIncompleteOnDisconnect(t *testing.T) {
	// LocalServer + 大对象（20MB）上传中途 close 底层连接 → phase=incomplete 事件 + 非 Ok 返回；
	// 服务器侧已有分片保留（GetInfo 对不完整对象返回存在性——jetstream 对未完成对象 Put 失败时
	// 服务器保留 chunks，nats 行为），断言事件序列最后为 incomplete（对齐 M3 备份断连测试手法）
}
```

（`diskFree` 为包级 `var diskFree = defaultDiskFree` 便于 stub；`TestUploadIncompleteOnDisconnectLocalServer` 时序不稳时对齐 M3 处置：轮询放宽 3 次仍不稳则 PENDING-MANUAL 记录。）

- [ ] **Step 2: 红灯 → 实现 transfer.go + disk_windows.go/disk_other.go（计数回调节流：每 ≥64KB 或 200ms 发一次 running 事件，避免 2MB→2 事件太疏或逐字节太密；upload/download 均用 transferMu 单飞）**

- [ ] **Step 3: 绿灯 + bindings + 提交**

```bash
go test ./internal/buckets/ -run "TestUpload|TestDownload|TestDisk" -v && go test ./... && go vet ./...
wails3 generate bindings -ts -clean=true
git add -A && git commit -m "feat(desktop): object upload/download with progress events, sha256 verify, disk gate"
```

---

### Task 7: KV 前端全量（页面/桶表单/键列表/键详情/编辑器/watch 面板）

**Files:**
- Create: `desktop/frontend/src/features/kv/{KeyValuePage,BucketForm,KeyList,KeyDetail,KeyEditor,WatchPanel}.tsx`、`schema.ts`、`useKv.ts`
- Modify: `src/App.tsx`（kv 占位换 lazy）、`src/lib/bindings.ts`（KV 系再导出）
- Create: `desktop/frontend/tests/kv-page.test.tsx`

**Interfaces:**
- Consumes: 绑定 `ListKvBuckets/GetKvBucketDetail/CreateKvBucket/UpdateKvBucket/DeleteKvBucket/CompactKvBucket/ListKeys/GetKeyValues/GetKeyHistory/PutKey/DeleteKey/RevertKey/CreateKvWatch/StopWatch`；`useConfirm`；`PayloadView`；`RateSampler` 不需要；事件 `kv:watch`。
- Produces: `useKv()`——`{buckets, unavailableReason, refresh, selected, select, keys, keysLoading, page, setPage, filter, setFilter, pageValues, loadValues, detail(form 回显), actions{createBucket, updateBucket, deleteBucket, compactBucket, putKey, deleteKey, revertKey}, watch{active, start, stop, events(≤10k ring), dropped}}`；页面组件导出供 App lazy。

页面结构（§6.8 处理逻辑顺序）：
- 左栏：桶列表（名称/键数/字节数/历史/TTL）+ Create 按钮 + 搜索；选中 → 右侧桶详情（配置回显 + Edit/Delete(L2 名称匹配)/Compact(L1) 按钮 + Compact 文案「将清除全部删除标记与历史」）。
- 桶详情下方：键区——KeyList（客户端分页 20/50/100 + 键名筛选；列：键名/当前修订版/操作徽标(put/delete)/最后修改时间；当前页经 `GetKeyValues` 补齐值大小列）；行点击 → KeyDetail（当前值 PayloadView + 历史列表(修订/时间/操作/值查看) + Revert 按钮（`revision ≤1 或最新为 delete 且无更早修订 → 禁用 + tooltip「仅一次修订，无可回退版本」`，§6.8 异常 3）+ Del(L1「历史可查可 revert」文案)/Purge(L1「彻底清除，不可恢复」文案) 按钮 + 编辑入口）。
- KeyEditor dialog：mode `put|create|update`（update 显示期望修订版=当前，锁定展示）；文本编辑器（textarea 等宽；>8MB 拦截 + 非 UTF-8 值只读提示走查看）；提交 → `PutKey`；**conflict 处理（§6.8 异常 1/2）**：create 冲突 → 内联冲突横幅「键已存在——可改用 put 或查看现有值」（+「改用 put」一键切换 mode 按钮）；update 冲突 → 内联「期望修订版 X 与当前 Y 不符」+ **期望修订自动刷新为 Y、编辑内容保留**（草稿 state 不动，只更新 revision 显示）。
- WatchPanel：Start Watch（整桶/键过滤输入）→ 实时滚动行（时间/操作徽标/键/修订/值预览 32 字符），≤10k ring + 虚拟化（复用 SessionView 模式）；Stop 按钮；sentinel 行「初始快照完成」；**角落显示累计丢弃计数 chip「已丢弃 N」（取最近一条事件的 `dropped_total`，>0 时呈警示色）**——§6.4 丢弃计数准确显示在 KV watch 的落点。
- i18n `kv.*` 全量双侧；zod（schema.ts 与 Go 校验同规则：桶名/键名/History 1–64/TTL ≥0/MaxBytes ≥-1/Replicas 1–5/枚举显式）。

组件测试（tests/kv-page.test.tsx，mock 绑定 + Events.On 推事件，沿用 M3 模式）：
1. 桶列表渲染 + 选中详情回显 + L2 删除错名拒绝/对名删除（沿用 streams-danger 测试手法）。
2. 键分页（100 键 mock → 50/页翻页 + 筛选）+ 值补齐调用参数（当前页键名数组）。
3. KeyEditor 三 mode：create 冲突内联横幅 + 一键切 put；update 冲突 → 修订显示刷新 Y + 草稿保留（textarea 值不变断言）。
4. revert 禁用条件（revision 1）+ 启用路径（revision ≥2 调用 RevertKey）。
5. watch：Events.On 推 5 条 + sentinel → 列表 5 行 + sentinel 行；Stop 调 StopWatch；10k 上限 ring（推 10_005 条 → 保留最后 10_000）。
6. unavailable_reason → 指引面板非空表。

- [ ] **Step 1: 写失败的组件测试（上述 6 项，红）**
- [ ] **Step 2: 实现全部组件 + hooks + i18n + bindings 再导出（绿）**
- [ ] **Step 3: `npx vitest run && npm run build`；提交 `feat(desktop): kv page (buckets, keys, history, editor with conflict handling, watch)`**

---

### Task 8: 对象前端全量（页面/桶表单/对象列表/上传下载面板/watch）

**Files:**
- Create: `desktop/frontend/src/features/objects/{ObjectsPage,BucketForm,ObjectList,UploadPanel}.tsx`、`schema.ts`、`useObjects.ts`
- Modify: `src/App.tsx`（objects 占位换 lazy）、`src/lib/bindings.ts`（对象系 + transfer/watch 再导出）
- Create: `desktop/frontend/tests/objects-page.test.tsx`

**Interfaces:**
- Consumes: 绑定 `ListObjBuckets/GetObjBucketDetail/CreateObjBucket/UpdateObjBucket/DeleteObjBucket/SealObjBucket/ListObjects/DeleteObject/RenameObject/PickUploadFiles/PickDownloadDirectory/UploadObject/DownloadObject/CreateObjWatch/StopWatch`；`useConfirm`；事件 `obj:watch`/`obj:transfer`。
- Produces: `useObjects()`——`{buckets, refresh, selected, select, objects, detail{form, sealed}, actions{…}, transfers: Map<id, ObjTransferEvent>, watch{…}}`。

页面结构：
- 左栏桶列表（名称/大小/封存徽标）+ Create；右详情（配置 + Edit/Delete(L2)/Seal(L1)——**Sealed 后禁用上传/编辑按钮并显示封存徽标与提示**，§6.9 异常 3 前端半边）+ 对象列表（名称/大小/chunks/修改时间/已删除徽标；行操作：下载/改名(L1 轻)/删除(L1)）。
- UploadPanel：选择文件（`PickUploadFiles` 多选 → 队列）→ 每文件可选重命名输入 → 开始 → 逐文件 `UploadObject`（前端排队，transfer 事件驱动进度条 per 文件：bytes_done/bytes_total + 速率=前端差分）→ `phase=incomplete` → 该文件标红「上传不完整——重试」按钮（Global 2 重试入口）；全部完成 → 列表刷新。
- 下载：行点击下载 → `PickDownloadDirectory` → `DownloadObject` → 进度 + 完成时 digest_match 显示（✓ 校验一致 / ✗ 不一致警示）+ **「打开所在目录」按钮（调 `OpenInFileManager(完整文件路径)`，§6.9 处理逻辑第 3 段明文要求）**；磁盘不足（validation+ErrDiskSpace 文本）→ 阻止提示（Go 已拒绝，前端 toast 原文）。
- WatchPanel 对象版（增删对象事件滚动）。
- i18n `objects.*` 双侧。

组件测试（objects-page.test.tsx）：
1. 桶/对象列表渲染 + 封存桶上传禁用 + 徽标。
2. 上传流：PickUploadFiles 返回 2 路径 → 队列 → 逐个 UploadObject 调用参数（bucket/path/rename）→ transfer 事件 50%→complete → 列表刷新；incomplete → 重试按钮。
3. 下载流：目录选择 → DownloadObject 参数 → 进度 → digest_match=true 显示 + **「打开所在目录」按钮调用 OpenInFileManager**；磁盘错误 toast。
4. L1/L2 确认沿用（删对象 L1、删桶 L2 错名拒绝）。
5. watch 推事件渲染 + Stop。
6. unavailable 指引面板。

- [ ] **Step 1: 写失败的组件测试（红）**
- [ ] **Step 2: 实现（绿）+ i18n + bindings**
- [ ] **Step 3: `npx vitest run && npm run build`；提交 `feat(desktop): objects page (buckets, objects, upload/download with progress, watch)`**

---

### Task 9: M3 遗留整改（覆盖率四项 + workqueue 提示）

**Files:**
- Modify: `desktop/internal/jsadmin/*_test.go`（补覆盖：mirror/source copy 分支 `TestCopyStreamMirrorSource`、unavailable ErrorCode pin `TestListStreamsUnavailableErrorCode`、`TestPurgeKeepAndSubject` 已有则补 ErrorCode 断言）、`desktop/internal/jsctx/jsctx_test.go`（domain 分支 `TestNewWithDomain`——domain 非空时走 NewWithDomain：错误 domain → account info 失败）、`desktop/internal/logging/logging_test.go`（轮转失败路径：只读目录触发 rotate 错误分支）、`desktop/frontend/src/features/streams/StreamMsgs.tsx`（workqueue 提示）
- Modify: `desktop/frontend/package.json`（+devDependency `@vitest/coverage-v8`）、`desktop/frontend/vitest.config.ts`（coverage 配置 providers v8、include features、thresholds 暂不设硬门只输出）

**Interfaces:** 无新接口；产出 = 覆盖率数字达标证据 + 提示文案。

- [ ] **Step 1: Go 覆盖率补测（红→绿）：目标 `go test ./internal/jsadmin/ -cover ≥ 80.0`、`./internal/jsctx/ ≥ 85`、`./internal/logging/` 轮转失败分支有测试。logging 触发手法：Windows 目录 read-only 属性不阻止文件创建——改用「把 `nats-desktop.log` 路径占用为**目录**」使 rotate 后 `os.OpenFile` reopen 失败（可靠触发），测试断言 rotate 错误被记录且进程不崩**
- [ ] **Step 2: workqueue 提示：StreamMsgs 错误 toast 处——当 `summary.retention === "workqueue"` 时附加指引文案 key `streams.msgs.workqueueHint`（「workqueue 流浏览需服务器 allow_direct；nats stream edit 可开启」），i18n 双侧**
- [ ] **Step 3: 前端 coverage 接入：`npm i -D -E @vitest/coverage-v8@5.0.0`（**钉版本**——peer 是精确 vitest@5.0.0，与 lockfile 匹配，浮动会 ERESOLVE）；`npx vitest run --coverage` 记录 components 基线（报告 ≥70% 达标情况，未达标列整改）；CI frontend job 追加 `--coverage` 输出**
- [ ] **Step 4: 全量验证 + 提交 `test(desktop): m3 remediation - coverage lift, workqueue hint, frontend coverage provider`**

---

### Task 10: 性能/压力/并发验证 + CI

**Files:**
- Create: `desktop/internal/buckets/perf_test.go`、`desktop/internal/buckets/stress_test.go`
- Modify: `.github/workflows/desktop-ci.yml`（go job `go test ./... -cover` 输出覆盖率行）

**Interfaces:** 产出性能证据（M4 测试报告数据源）。

- [ ] **Step 1: `TestKvKeys1000BrowseLocalServer`**——建桶（History 1）+ 注入 1,000 键 → `ListKeys` + 当前页 50 键 `GetKeyValues` 合计耗时断言 ≤1.5s（低配门）+ t.Logf 实测（高配 ≤500ms 记录）；`BenchmarkKvListKeysLocalServer`。
- [ ] **Step 2: `TestWatchFlood10kLocalServer`**（Task 4 已有 `TestKvWatchFloodNoLossLocalServer`——本任务对象版 `TestObjWatchFloodNoLossLocalServer`：100 对象 + 10k 更新零丢失）**
- [ ] **Step 3: `TestTransfer100MBLocalServer`**——100MB 对象上传+下载：吞吐 t.Logf（MB/s）、进度事件字节精确（末事件 bytes_done==bytes_total）、SHA256 匹配、下载文件字节相等；**100MB 夹具磁盘临时文件生成与清理**
- [ ] **Step 4: `TestConcurrentBucketOpsLocalServer`**——12 goroutine：4×KV 桶 create/del、4×键并发 put/del（同桶不同键）、4×对象桶 create/del，零错误（对齐 M3 并发测试形态）
- [ ] **Step 5: CI 修改（go job `go test ./... -cover` 输出覆盖率行，**含 buckets 包 ≥80% 判定**——§20.1 对 M4 新增主体代码同样生效，测试报告记录终值）+ 全量验证 + 提交 `test(desktop): m4 perf/stress/concurrency suites and ci coverage output`**

---

### Task 11: 验收记录 + 测试报告 + UIA 冒烟（控制器任务）

**Files:**
- Create: `docs/superpowers/plans/2026-09-13-nats-desktop-m4-acceptance.md`、`docs/superpowers/plans/2026-09-13-nats-desktop-m4-test-report.md`

- [ ] **Step 1: `wails3 build` + 启动真应用（本地服务器 4333）**
- [ ] **Step 2: UIA 冒烟清单**（沿用 M3 §7 MSAA/UIA 方法，时间盒 ≤45 分钟）：

| 冒烟项 | 断言 |
|---|---|
| KV 桶创建 → 键列表 | 表单 → toast → 列表 |
| put/create/update 三语义 | create 冲突横幅 + 一键切 put；update 冲突修订刷新 + 草稿保留 |
| 历史 + revert | 3 修订 → revert 回 v2；单修订键按钮禁用 |
| del/purge 分级 + compact | del L1 历史可查；purge L1 不可逆文案；compact L1 |
| AC-013 watch | 开整桶 watch → 另一会话 put/del → ≤1s 实时行 + 修订号 |
| 对象桶 + 上传/下载 | AC-014：5MB 文件上传进度 → 下载 → digest ✓ + 列表刷新 + **「打开所在目录」按钮** |
| 上传不完整 + 重试入口 | 断连注入（尽力）或标注 PENDING-MANUAL |
| 封存桶 | Seal → 上传禁用 + 写操作原文提示 |
| 磁盘不足阻止 | 小磁盘分区/标注 PENDING-MANUAL |
| 主题/语言回归 | 深色 + zh-CN 无硬编码/无 emoji |

- [ ] **Step 3: 验收记录**（AC-013/014 逐条；§6.8 异常 3 行 + §6.9 异常 3 行映射；裁定登记：nsr_domain 不接（natscli/jsm.go parity 证据）、备份取消/恢复改名延 M6 原文、watch 背压丢最旧设计（dropped_total wire 呈现）、KV 桶 CreatedMs 恒 0（接口无该字段）、传输单飞互斥、对象重复删除 Ok（库语义）、下载 digest 双保险（tee + 库内建）；遗留清单：多文件并行上传（当前排队）、非 UTF-8 值编辑、对象链接（AddLink 未暴露）、compact 后 marker 保留期语义（-1 全删）等）
- [ ] **Step 4: 测试报告**（用例数、覆盖率终值（Go 分包 + 前端组件基线）、性能实测表（1k 键/100MB 传输/10k watch/并发）、缺陷记录与修复 SHA、CI 状态）
- [ ] **Step 5: 提交 + 终审交接（whole-branch review → 修复波 → 合并选项）**

---

## 自审记录（含独立评审后修复）

**独立计划评审**：`reviewing-plans` 只读子代理报告存于 `.superpowers/sdd/m4-plan-review.md`（4 Critical / 10 Important / 8 Minor）。全部 Critical 与 Important 已修入计划：F-01（KeyValueStatus 桩补齐 10 方法、MaxBytes/Replicas 经 Config() 取）、F-04（§6.9「打开所在目录入口」——Task 6 `OpenInFileManager` 绑定 + Task 8 按钮 + Task 11 冒烟行）、F-10（生命周期测试重构：create b 移至 a 系列断言之后，修订号重推）、F-11（重复建桶用差异配置触发 ErrBucketExists——同配置是服务器幂等成功）、F-03/F-05（桶名 `^[a-zA-Z0-9_-]+$`、键名含 `/` 对齐 nats.go regex）、F-06（watch ctx 长生命周期，禁 timeout ctx）、F-07（ListObjects 带 ListObjectsShowDeleted）、F-08（CreateWatchResult 单结构体返回）、F-09（revert 删除态感知算法 + del 后 revert 断言 revision 6）、F-12（compact DeleteMarkersOlderThan(-1) 全删语义）、F-13（dropped_total 随事件捎带）、F-14（logging 轮转失败用路径占用目录触发）、F-22（WaitGroup 替代 errgroup，零新依赖）。Minor 一并修复（F-15 引用编号/库名、F-17 丢弃 WARN、F-18 `free > 0` 前置、F-19 钉版本、F-20 双保险与重复删除语义注记、F-21 buckets 包覆盖率门槛、F-23 跨任务 build-tag 交接、F-24 模板 url/imports 修正）。

1. **Spec 覆盖**：§6.8 全部（桶列表/详情/创建/编辑/删除/键浏览分页含值大小列/历史/put-create-update-del-purge-revert-compact/watch 单键与整桶）→ Task 1–4/7/11；§6.8 异常 3 行 → Task 1（conflict 分类）/3（PutKey 语义 + revert 删除态）/7（UI 横幅+禁用+草稿保留）；§6.9 全部（桶 CRUD/封存/对象浏览含已删除徽标/上传多选重命名进度速率/下载进度+SHA256+磁盘检查+**打开所在目录入口**/删除/watch）→ Task 5/6/8/11；§6.9 异常 3 行 → Task 6（不完整+磁盘）/8（封存禁用+重试入口）；AC-013 → Task 4/7/11；AC-014 → Task 6/8/11；M3 遗留整改四项 + workqueue 提示 → Task 9；nsr_domain/备份取消/恢复改名 → 显式裁定记录（规格依据段 + Task 11 验收）。缺口：无。
2. **占位符扫描**：无 TBD/「适当处理」；Task 2→3 的 compact 测试经 build tag `m4_task3` 显式交接（跨任务编译序），非占位符。
3. **类型一致性**：`KvWatchEvent/ObjWatchEvent（含 dropped_total）/ObjTransferEvent` Task 1 定义、Task 4/6/7/8 消费一致；`PutKeyResult.CurrentRevision` T1→T3→T7；`CreateWatchResult` T4 定义、T7/T8 消费；`connStub/newSvc/mustConn/waitForCond` T2/3 定义、后续复用；绑定方法名与 T7/T8 再导出清单一致。
4. **运维覆盖**：性能（1k 键 ≤500ms/1.5s、100MB 传输、watch 1k+10k 零丢失）→ Task 10 断言 + 实测；并发/完整性（12 goroutine、watch 守恒 + dropped_total、SHA256 双保险、磁盘预检 free>0 前置）→ Task 4/6/10；失败路径（§6.8/§6.9 异常逐行、上传断连、digest 不匹配、磁盘不足、封存写入、重复删除）→ Task 3/5/6 测试；可观测（进度事件、watch 丢弃 WARN + dropped_total wire、payload/凭证不入日志 Global 5）→ 各任务实现内嵌。
