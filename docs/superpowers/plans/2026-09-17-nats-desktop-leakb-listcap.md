# Leak B Fix 2 — List Response Caps (Streams / KV Keys) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the nav/page-mount memory driver (E2: 233.7MB/h, m6-perf §12.2) by capping the two unbounded Go→JS list payloads — `ListStreams` (10k streams ≈ 2-4MB polled every 5s) and `ListKeys` (100k KV keys) — moving the wire to bounded, sorted top-N responses with server-side filtering, honest totals, and truncation markers.

**Architecture:** Both lists keep fetching FULL metadata Go-side (totals stay exact), then apply the caller's filter in memory, sort (streams: messages desc), and deliver at most `listStreamsCap=500` / `kvListKeysCap=1000` items plus `total` + `truncated`. The frontend shows a truncation banner, drives the streams filter box server-side (debounced), and slows the streams poll 6× while truncated. The memory mechanism being fixed is the same wails large-payload browser-process retention that fix 1 (WS data plane) removed for `session:msgs` — these list responses stay on bindings (they are request/response, not push), so the fix is to make them bounded, not to re-transport them.

**Tech Stack:** Go 1.26 (jsadmin/buckets), wails bindings regen (`wails3 generate bindings -ts -i -clean=true`), React 18 + vitest 5.

**Scope decision:** Monitoring snapshot is EXCLUDED (one small row per server, measured small). Stream message browser is already paginated (spec §6.6). KV watch panels are push-based small events.

## Global Constraints

- 测试必须全面：TDD 每任务，收尾同载验证跑（legE3 复测）保留证据（用户绑定指令）。
- §13.3：不记录任何 payload 内容；列表响应不含消息体。
- §6.6 语义修订（v1.5 登记）：「读取全部 stream 元信息」保持（Go 侧全量取回，Total 精确）；**交付**改为按消息数降序前 500 + `total`/`truncated`；名称/subject 筛选从客户端过滤改为服务端匹配（对全量数据过滤后封顶），筛选语义（名称、subject 模糊匹配）不变。
- §6.8 KV：键列表交付前 1000 + `total`/`truncated`，键值内容不上 wire（仅元数据，现状保持）。
- 有界性原则（泄漏 A/B 教训）：任何 Go→JS 响应不得超过常量上限；轮询在截断状态下自动降频 6×。
- i18n：新增文案键必须 en.json / zh-CN.json 同步（CONTRIBUTING）。
- CI：go `-race`（本地环境跑不了 -race 时 CI 仲裁）；vitest `--maxWorkers=2`；bindings 提交（`-ts -i -clean=true`，CONTRIBUTING.md:21 已修正）。
- 收尾验证判据：legE3 型纯导航 1h 跑 browser 斜率 ≤10MB/h（对照 E2 233.7）。

---

## File Structure

- Modify: `desktop/internal/jsadmin/streams.go:84` — `ListStreams(filter string)`: filter → sort → cap; `listStreamsCap` package var (tests shrink it).
- Modify: `desktop/internal/jsadmin/types.go:123` — `ListStreamsResult` gains `Total int` + `Truncated bool`.
- Modify: `desktop/internal/jsadmin/streams_test.go` — cap/sort/filter tests.
- Modify: `desktop/internal/buckets/kv.go:201` — `ListKeys`: cap + Total/Truncated; `kvListKeysCap` var.
- Modify: `desktop/internal/buckets/kv_test.go`（或同包现存测试文件）— cap tests.
- Modify: `desktop/frontend/src/features/streams/useStreams.ts` — filter param, truncated throttle, total state.
- Modify: `desktop/frontend/src/features/streams/StreamsPage.tsx` + `StreamList.tsx` — server-driven filter box + truncation banner.
- Modify: `desktop/frontend/src/features/kv/useKv.ts` + `KeyList.tsx`（或 KeyValuePage.tsx）— truncation banner.
- Modify: `desktop/frontend/src/locales/en.json` + `zh-CN.json` — new keys（两边同步）.
- Modify: `desktop/frontend/tests/streams-page.test.tsx`, `kv-page.test.tsx` — mocks gain total/truncated; banner/throttle tests.
- Regen: `desktop/frontend/bindings/` — `ListStreams(filter)` signature.

---

### Task 1: Go — ListStreams filter/sort/cap

**Files:**
- Modify: `desktop/internal/jsadmin/types.go:123`, `desktop/internal/jsadmin/streams.go:84`
- Modify: `desktop/internal/jsadmin/streams_test.go`

**Interfaces:**
- Consumes: existing `mgr.Streams(nil)` fetch + `BuildStreamSummary` (unchanged).
- Produces (Tasks 3 consumes via binding):
  - `func (s *JetAdminService) ListStreams(filter string) ListStreamsResult`
  - `type ListStreamsResult struct { CallResult; Streams []StreamSummary \`json:"streams"\`; Total int \`json:"total"\`; Truncated bool \`json:"truncated"\`; UnavailableReason string \`json:"unavailable_reason"\` }`
  - `var listStreamsCap = 500`（包级变量，测试可缩）
  - Semantics: filter (case-insensitive substring over stream Name and each subject) applies to the FULL fetched set; survivors sort by Messages desc, ties by Name asc; first `listStreamsCap` delivered; `Total` = survivor count (post-filter, pre-cap); `Truncated` = Total > cap.

- [ ] **Step 1: Write the failing tests**

Append to `desktop/internal/jsadmin/streams_test.go` (reuse the file's existing LocalServer stream-creation helper; create streams with distinct message counts and names):

```go
func TestListStreamsCapSortFilter(t *testing.T) {
	requireLocalServer(t)
	svc := newJetAdminService(t) // 本文件既有的构造 helper；名字不同则照抄既有测试的构造段
	// 7 streams: msg counts 0/10/20/.../60, names s-0..s-6, subjects ["sN.>"]
	for i := 0; i < 7; i++ {
		name := fmt.Sprintf("cap-s-%d", i)
		if _, err := svc.CreateStream(StreamForm{
			Name: name, Subjects: []string{fmt.Sprintf("cap-s-%d.>", i)},
			Storage: "file", Retention: "limits",
		}); !res.Ok() { /* 按既有测试的断言风格写 */ }
		// publish i*10 msgs（用既有 publish helper；与同文件其它测试一致）
	}
	svc.listStreamsCap = 5 // 包级 var，测试缩容
	res := svc.ListStreams("")
	if !res.Ok() { t.Fatalf("ListStreams: %+v", res) }
	if !res.Truncated || res.Total != 7 {
		t.Fatalf("Truncated=%v Total=%d, want true/7", res.Truncated, res.Total)
	}
	if len(res.Streams) != 5 { t.Fatalf("len=%d want 5", len(res.Streams)) }
	for i := 1; i < len(res.Streams); i++ {
		if res.Streams[i-1].Messages < res.Streams[i].Messages {
			t.Fatalf("not sorted desc: %v", res.Streams)
		}
	}
	// filter: server-side, matches name or subjects substring, case-insensitive
	fres := svc.ListStreams("CAP-S-1") // 大写也能命中（大小写不敏感）
	if !fres.Ok() || fres.Total != 1 || fres.Truncated ||
		len(fres.Streams) != 1 || fres.Streams[0].Name != "cap-s-1" {
		t.Fatalf("filtered: %+v", fres)
	}
}
```

（按文件内既有 helper 的真名落笔：若流创建/publish 用的是 `svc.CreateStream` 返回 `CallResult`、publish 走 `svc.Publish` 或直接 nats 发布，逐字沿用同文件既有测试写法。）

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && go test ./internal/jsadmin/ -run TestListStreamsCapSortFilter -v`
Expected: COMPILE ERROR — `ListStreams` takes 0 args / `res.Truncated` undefined

- [ ] **Step 3: Implement**

types.go — replace the ListStreamsResult struct:

```go
type ListStreamsResult struct {
	CallResult
	Streams           []StreamSummary `json:"streams"`            // 失败时 nil
	Total             int             `json:"total"`              // 筛选后总数（封顶前）
	Truncated         bool            `json:"truncated"`          // Total > listStreamsCap
	UnavailableReason string          `json:"unavailable_reason"` // 非空 → 前端渲染指引面板
}

// listStreamsCap bounds the ListStreams wire response (m6-perf §12.2: a 10k-
// stream list is 2-4MB every poll and ratchets the WebView2 browser process).
// Package var so tests can shrink it.
var listStreamsCap = 500
```

streams.go — replace ListStreams:

```go
func (s *JetAdminService) ListStreams(filter string) ListStreamsResult {
	mgr, _, res := s.handles()
	if !res.Ok() {
		reason := ""
		if res.ErrorCode == CodeJSUnavailable {
			reason = ReasonNoResponders
		}
		return ListStreamsResult{CallResult: res, UnavailableReason: reason}
	}
	streams, _, _, err := mgr.Streams(nil)
	if err != nil {
		reason := ReasonServer
		if isNoResponders(err) {
			reason = ReasonNoResponders
		} else if isTimeout(err) {
			reason = ReasonTimeout
		}
		return ListStreamsResult{CallResult: ClassifyError(err), UnavailableReason: reason}
	}
	f := strings.ToLower(strings.TrimSpace(filter))
	all := make([]StreamSummary, 0, len(streams))
	for _, st := range streams {
		info, err := st.LatestInformation()
		if err != nil {
			continue // 单流信息失败不拖垮整表（natscli missing 语义）
		}
		sum := BuildStreamSummary(info.Config.Name, info.Config, info.State, info.Cluster)
		if f != "" && !streamMatchesFilter(sum, f) {
			continue
		}
		all = append(all, sum)
	}
	// 消息数降序、名称升序定序（稳定，供截断语义与前端排序一致）
	sort.Slice(all, func(i, j int) bool {
		if all[i].Messages != all[j].Messages {
			return all[i].Messages > all[j].Messages
		}
		return all[i].Name < all[j].Name
	})
	truncated := len(all) > listStreamsCap
	if truncated {
		all = all[:listStreamsCap]
	}
	return ListStreamsResult{Streams: all, Total: len(all), Truncated: truncated}
}

// streamMatchesFilter: §6.6 名称/subject 模糊匹配（大小写不敏感的子串）。
func streamMatchesFilter(s StreamSummary, f string) bool {
	if strings.Contains(strings.ToLower(s.Name), f) {
		return true
	}
	for _, sub := range s.Subjects {
		if strings.Contains(strings.ToLower(sub), f) {
			return true
		}
	}
	return false
}
```

（imports 视需要补 `sort`、`strings`；`Total` 赋值注意在截断前取 `len(all)`——按上面代码顺序即可。**修正**：`Total` 必须是截断前的存活总数，即 `total := len(all)` 在截断前赋值。）

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && go test ./internal/jsadmin/ -run 'TestListStreams' -v -count=1` then `go test ./internal/jsadmin/ -count=1`
Expected: PASS（既有 ListStreams 测试同步改签名：`svc.ListStreams("")`）

- [ ] **Step 5: Commit**

```bash
git add desktop/internal/jsadmin/
git commit -m "feat(jsadmin): ListStreams server-side filter + messages-desc sort + 500 cap (leak B fix 2, part 1)"
```

---

### Task 2: Go — ListKeys cap

**Files:**
- Modify: `desktop/internal/buckets/kv.go:201`（Result 类型同文件/types）
- Modify: `desktop/internal/buckets/` 现存 kv 测试文件

**Interfaces:**
- Produces: `ListKeysResult` gains `Total int` + `Truncated bool`；`var kvListKeysCap = 1000`；语义同 Task 1（自然键序不排序，只封顶）。

- [ ] **Step 1: Write the failing tests**（模式同 Task 1：`svc.listKeysCap` 缩到 5，建 12 键，断言 Truncated/Total=12/len=5；沿用同文件既有 bucket+keys helper）

- [ ] **Step 2: Verify fail**（compile error: Truncated undefined）

- [ ] **Step 3: Implement** — watcher 循环里 `if len(keys) >= kvListKeysCap { truncated = true; break }`（注意：提前跳出必须照常 `Stop()` watcher，且因哨兵未到，此处 **不算**「部分伪装成功」——截断是显式字段而非错误）；循环后 `total := len(keys)` 记录（截断时 Total=已读数不等于真实总数——**改为**：MetaOnly watcher 无法预知总数，Total 语义=「已读到的键数」，截断时前端文案用「前 1000 键（更多未列出）」，不用具体总数）。

- [ ] **Step 4: Verify pass** + 全包回归

- [ ] **Step 5: Commit** `feat(buckets): ListKeys 1000-key cap with truncation marker (leak B fix 2, part 2)`

---

### Task 3: Frontend — streams server-filter + banner + throttle

**Files:**
- Modify: `desktop/frontend/src/features/streams/useStreams.ts`, `StreamsPage.tsx`, `StreamList.tsx`, `src/locales/en.json`, `zh-CN.json`
- Modify: `desktop/frontend/tests/streams-page.test.tsx`

**Interfaces:**
- Consumes: `ListStreams(filter: string)` binding（Task 1 + regen）; `res.total: number; res.truncated: boolean`
- Produces: hook state `total`, `truncated`; poll interval ×6 while truncated; filter box debounced 300ms → `refresh(filter)`.

- [ ] **Step 1: Write the failing tests**（streams-page.test.tsx，沿用既有 vi.mock 模式）

```ts
it("shows the truncation banner and slows polling while truncated", async () => {
  vi.mocked(ListStreams).mockResolvedValue({
    ...ok,
    streams: [stream("cap-s-1")],
    total: 10000,
    truncated: true,
  } as never);
  render(<StreamsPage />);
  expect(await screen.findByText(/前 500|first 500/i)).toBeInDocument(); // i18n 文案断言按实际 key
  // banner 文案含 total：断言 /10,000|10000/ 也在文档
});
it("passes the filter box input to ListStreams (server-side filter)", async () => {
  render(<StreamsPage />);
  await screen.findByText(/cap-s-1/);
  await userEvent.type(screen.getByPlaceholderText(/filter|筛选/i), "orders");
  await waitFor(() => expect(ListStreams).toHaveBeenCalledWith("orders"));
});
```

（mock 的 `ok`/`stream()` helper 照抄该文件既有定义；placeholder 文案按现有筛选框实际 i18n 键改断言。）

- [ ] **Step 2: Verify fail** → **Step 3: Implement**:
  - useStreams: `const [filter, setFilter] = useState("")`; `fetchList` calls `ListStreams(filter)`; 存 `total/truncated` state；轮询 interval：`truncated ? intervalMs.current * 6 : intervalMs.current`；暴露 `setFilter`（内部 300ms debounce 后立即 fetchList + 重置轮询计时）。
  - StreamsPage: 筛选框 onChange → `setFilter(value)`（去客户端过滤，改服务端）。
  - StreamList: `truncated` 时头部渲染 banner：en `"Showing first 500 of {total} streams (by message count)"` / zh `"显示前 500 条流（共 {total}，按消息数排序）"`；i18n 键 `streams.truncatedBanner`（两 locale 同步加）。
- [ ] **Step 4: Verify pass** + 全套件 `npx vitest run --maxWorkers=2`
- [ ] **Step 5: Commit** `feat(frontend): server-driven stream filter + truncation banner + throttled polling (leak B fix 2, part 3)`

---

### Task 4: Frontend — KV keys truncation banner

**Files:** `useKv.ts`, `KeyList.tsx`（或 KeyValuePage.tsx）, locales, `tests/kv-page.test.tsx`
- 同 Task 3 模式：mock 带 `total/truncated`；banner 键 `kv.truncatedKeys`：en `"Showing first 1000 keys (more not listed)"` / zh `"显示前 1000 个键（更多未列出）"`。
- TDD 四步 + `feat(frontend): kv keys truncation banner (leak B fix 2, part 4)`

---

### Task 5: Bindings regen + full gates

- `cd desktop && wails3 generate bindings -ts -i -clean=true`（diff 只含 ListStreams 签名 + 两个新字段）
- `go test ./... -count=1 && go vet ./...`；`npx vitest run --maxWorkers=2 && npx tsc --noEmit && npx eslint src tests`
- **前端必须 `npm run build` 后再 `go build -o bin/nats-desktop.exe .`**（§12.4 教训）
- Commit + push，desktop-ci 全绿为门。

---

### Task 6: Validation + spec v1.5 + docs

- legE3 型纯导航 1h 复跑（复用 `bin/legE3.sh`，OutDir 改 `legE3-postfix`）：判据 browser 斜率较 E2 233.7 显著崩塌（目标 ≤10MB/h；若仅部分下降，按页分解腿继续归因并如实记录）。
- m6-perf §12.5 回填 + spec v1.5 版本行 + §6.6/§6.8 修订（列表封顶语义）+ 台账。
- Commit + push。
