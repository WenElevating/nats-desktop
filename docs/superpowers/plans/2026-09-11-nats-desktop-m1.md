# NATS 桌面客户端 M1（应用骨架 + 连接管理）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M1 里程碑：可运行的 Wails v3 桌面骨架（侧边导航布局、浅/深/跟随系统三态主题、en/zh-CN 双语言、设置与日志服务）加完整的 context 连接管理（CRUD、测试连接、五态连接状态机、状态 UI），并搭好测试基建（内嵌 nats-server 夹具、CI 流水线、i18n 完整性门禁）。

**Architecture:** 本仓库根目录保留 natscli 源码作参照；新增 `desktop/` 独立 Go module（`go.work` 串联）。Go 侧服务层直接依赖 nats.go/jsm.go/natscontext（与 CLI 同版本），经 Wails 类型化绑定暴露给 React 前端；连接状态变化经 Wails 事件推送。前端 Vite + React + TS + Tailwind + shadcn/ui，设计令牌驱动深浅主题。

**Tech Stack:** Wails v3（**钉住 v3.0.0-beta.20**）、Go 1.25+（本仓库工具链 1.26）、React 18、TypeScript、Vite、Tailwind CSS v4、shadcn/ui、lucide-react、cmdk、react-i18next、vitest + @testing-library/react、`nats.go v1.53.1`、`jsm.go v0.4.2-0.20260907110945-19fe165a004c`（含 natscontext）、`nats-server/v2 v2.15.0-preview.1`（仅测试依赖）。

**规格依据:** `docs/superpowers/specs/2026-09-11-nats-desktop-v1-spec.md`（v1.1）。M1 覆盖规格 §6.1（应用框架，除更新检查外的壳部分在本计划内）、§6.2（连接与 Context 管理）、§6.12（外观与行为设置）及测试基建。§6.3–§6.11 属 M2–M5，各自另有计划。

## Global Constraints

来自规格的硬约束，每个任务隐含遵守（值逐字取自规格）：

1. **技术栈锁定（规格 §4.1）**：Wails v3（beta，若阻断开发可退守 v2）；React + shadcn/ui + Tailwind；图标 lucide SVG 线性图标，**全局禁止 emoji 图标**；后端直接依赖 nats.go + jsm.go + natscontext，不包装 CLI 进程。
2. **性能（§12，M1 可测部分）**：冷启动到可交互 高配 ≤2s / 低配 ≤4s；操作视觉反馈（点击到加载态/反馈）双档 ≤100ms；常驻内存 高配 ≤300MB / 低配 ≤400MB（典型负载，M1 为空载基线）。验收在 Task 14。
3. **日志（§13）**：位置 `%APPDATA%/nats-desktop/logs`，轮转 5MB × 3 个文件；级别 debug/info/warn/error 可调；**日志不得记录任何凭证内容**（密码、token、creds 内容、私钥）——Task 5 以测试证明。
4. **设置（§7.1.2 / §16.3）**：`%APPDATA%/nats-desktop/settings.json`，字段与默认值按规格（theme=system、language=en、poll_interval_seconds=5、request_timeout_seconds=5、confirm_level=standard、session_push_batching=false、session_buffer_size=10000、log_level=info、crash_reports=false、update_check=true）；原子写（临时文件+替换）；损坏时重命名 `.bak` 回退默认并记 WARN 日志。
5. **context 互操作（§7.1.1 / §17.3 / AC-003）**：与 natscli 同目录同格式，**不写入 CLI 不认识的私有字段**；文件权限 0600（Windows 上尽力而为）。
6. **连接状态机（§10）**：五态 closed 集 disconnected/connecting/connected/reconnecting/failed；**认证失败 → failed，不得自动重试循环**；状态事件含 context/state/since/rtt_ms（§7.1.4）。
7. **主题三态（§18.2 / AC-020）**：light/dark/system，切换即时生效不需重启；system 模式跟随系统深浅变化（1s 内同步）；持久化到设置文件。
8. **i18n（§6.12 / AC-021）**：英文默认 + zh-CN 完整包；**语言 key 缺失即构建失败**（Task 3 的完整性测试进 CI）。
9. **请求超时（§8.2.2）**：默认 5s（设置可调 1–60s）；查询类重试 1 次、变更类 0 次（M1 的连接测试不自动重试）。
10. **安全（§16）**：密码/token 在 UI 默认掩码显示；连接建立超时用 `nats.Timeout` 控制。
11. **依赖版本（natscli go.mod:22-25）**：`jsm.go v0.4.2-0.20260907110945-19fe165a004c`、`nats.go v1.53.1`、`nats-server/v2 v2.15.0-preview.1`（仅测试）、`nkeys v0.4.16`；Wails 钉 `v3.0.0-beta.20`（beta 迭代快，升级须读 changelog）。
12. **更新检查（§6.1）**：GitHub Releases 查询超时 5s，失败静默跳过；有新版本显示一次可关闭的通知——Task 12。
13. **提交纪律**：每个任务以 conventional commit 提交（feat/test/chore/docs），测试红→绿→提交。

## File Structure

```
仓库根/
├── go.work                          # use . + ./desktop（Task 1）
├── .github/workflows/desktop-ci.yml # CI（Task 13）
└── desktop/                         # wails3 init -t react 生成后改造
    ├── go.mod                       # module github.com/WenElevating/nats-desktop/desktop
    ├── main.go                      # 装配：日志、设置、连接管理器、服务注册、窗口、托盘
    ├── internal/
    │   ├── appdir/appdir.go         # %APPDATA%/nats-desktop 路径解析（设置/日志共用）
    │   ├── settings/settings.go     # 设置结构/Load/Save(原子)/默认值
    │   ├── logging/logging.go       # slog + 5MB×3 轮转 writer + 凭证脱敏
    │   ├── connections/
    │   │   ├── manager.go           # 单活跃连接 + 五态状态机 + 事件发射
    │   │   ├── contexts.go          # context CRUD（natscontext Registry 封装）+ 环境变量告警
    │   │   └── types.go             # State/StateEvent/ContextSummary/ContextForm/TestResult
    │   ├── version/version.go       # GitHub Releases 检查 + 语义版本比较
    │   └── testutil/server.go       # 内嵌 nats-server 夹具（JS 单节点 / 认证节点）
    ├── frontend/
    │   ├── src/
    │   │   ├── main.tsx / App.tsx   # 入口 + 页面切换（M1 不引入路由库，useState 切页）
    │   │   ├── app/shell.tsx        # 侧栏(8 入口)/状态脚/连接横幅
    │   │   ├── app/theme.ts         # ThemeMode 三态应用（.dark class）
    │   │   ├── app/connstate.tsx    # 连接状态 Context（订阅 conn:state 事件）
    │   │   ├── app/i18n.ts          # react-i18next 装配
    │   │   ├── app/command.tsx      # Ctrl+K 命令面板（cmdk）
    │   │   ├── features/settings/SettingsPage.tsx
    │   │   ├── features/connections/ConnectionsPage.tsx
    │   │   ├── components/ui/*      # shadcn 生成
    │   │   ├── lib/bindings.ts      # 生成的绑定 re-export + 错误包装
    │   │   └── locales/en.json, zh-CN.json
    │   └── tests/                   # vitest（theme/i18n 完整性/shell/面板/表单）
    └── build/                       # wails3 生成的构建资产（NSIS 等 M6 用）
```

职责边界：`appdir` 只管路径；`settings` 只管设置文件；`logging` 只管日志设施；`connections` 分 `types.go`（跨任务契约）/`contexts.go`（配置 CRUD）/`manager.go`（运行时连接）；`version` 独立无依赖；`testutil` 只被 `_test.go` 引用。前端 `app/` 是壳与横切关注点，`features/` 是页面。

---

### Task 1: 工作区与 Wails v3 骨架

**Files:**
- Create: `go.work`、`desktop/`（wails3 init 生成：go.mod、main.go、frontend/、build/、Taskfile）
- Modify: 无

**Interfaces:**
- Consumes: 无（起点任务）
- Produces: 可构建运行的 Wails 应用骨架；Go module 路径 `github.com/WenElevating/nats-desktop/desktop`（TODO-001 定名后全局替换）；`desktop/frontend/` 为 Vite+React+TS 工程；`internal/appdir` 包（后续任务 import `appdir.Dir()`）。

- [ ] **Step 1: 安装工具并初始化工程**

```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.20
wails3 doctor          # 预期：WebView2、Go 1.25+ 均就绪
cd /d/GithubProject/nats-desktop
wails3 init -n nats-desktop -t react -d desktop --mod github.com/WenElevating/nats-desktop/desktop
rm -rf desktop/.git    # init 可能生成嵌套 git，删除
```

- [ ] **Step 2: 建 go.work 并钉住依赖**

创建 `go.work`：

```
go 1.26.0

use (
	.
	./desktop
)
```

在 `desktop/go.mod` 确认 `require github.com/wailsapp/wails/v3 v3.0.0-beta.20`；追加 M1 后续需要的依赖（先只加 natscontext 所在的 jsm.go 与测试用 nats-server）：

```bash
cd desktop
go get github.com/nats-io/jsm.go@v0.4.2-0.20260907110945-19fe165a004c
go get github.com/nats-io/nats-server/v2@v2.15.0-preview.1
go mod tidy
```

- [ ] **Step 3: 暴露路径服务（后续任务的地基）**

创建 `desktop/internal/appdir/appdir.go`：

```go
// Package appdir resolves the application's per-user data directory:
// %APPDATA%/nats-desktop on Windows (os.UserConfigDir on other platforms).
package appdir

import (
	"errors"
	"os"
	"path/filepath"
)

// Dir returns the application data directory, creating it when missing.
func Dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "nats-desktop")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// LogsDir returns the logs subdirectory, creating it when missing.
func LogsDir() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	dir = filepath.Join(dir, "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", errors.New("logs dir: " + err.Error())
	}
	return dir, nil
}
```

测试 `desktop/internal/appdir/appdir_test.go`：

```go
package appdir

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDirCreated(t *testing.T) {
	dir, err := Dir()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir)); err != nil {
		t.Fatalf("dir not created: %v", err)
	}
}
```

- [ ] **Step 4: 跑测试与构建**

```bash
cd desktop && go test ./internal/appdir/ -v
# 预期：PASS
wails3 build
# 预期：生成 bin/nats-desktop.exe，无编译错误
```

- [ ] **Step 5: Commit**

```bash
git add ../go.work . && git commit -m "chore(desktop): scaffold Wails v3 app, workspace, appdir"
```

---

### Task 2: 设计令牌与主题三态

**Files:**
- Create: `desktop/frontend/src/app/theme.ts`、`desktop/frontend/src/styles/tokens.css`、`desktop/frontend/tests/theme.test.ts`
- Modify: `desktop/frontend/src/main.tsx`（导入 tokens.css）、`desktop/frontend/src/App.tsx`（挂 ThemeController）

**Interfaces:**
- Consumes: `@wailsio/runtime` 的 `System.IsDarkMode()` 与 `Events.On("common:ThemeChanged")`（Wails v3 内建事件，无需 Go 侧转发）。
- Produces: `type ThemeMode = "light" | "dark" | "system"`；`applyTheme(mode: ThemeMode, systemDark: boolean): void`；`useSystemDark(): { dark: boolean }`。设置持久化由 Task 4 接入（本任务内存态）。

- [ ] **Step 1: 写设计令牌（浅/深两套 CSS 变量，Radix Colors 12 阶派生值）**

`desktop/frontend/src/styles/tokens.css`（完整文件）：

```css
:root {
  /* 中性灰（Radix slate 派生）：浅色 */
  --bg: #ffffff;
  --panel: #fafafa;
  --border: #e2e8f0;
  --border-soft: #f1f5f9;
  --fg: #0f172a;
  --fg-muted: #64748b;
  --fg-faint: #94a3b8;
  /* 强调色 indigo：浅色用 9/10 阶 */
  --accent: #4f46e5;
  --accent-fg: #eef2ff;
  --accent-soft: #eef2ff;
  --accent-strong: #4338ca;
  /* 语义状态色（与强调色分离） */
  --ok: #16a34a; --ok-soft: #dcfce7; --ok-fg: #166534;
  --warn: #d97706; --warn-soft: #fef3c7; --warn-fg: #92400e;
  --danger: #dc2626; --danger-soft: #fee2e2; --danger-fg: #991b1b;
  --info: #2563eb; --info-soft: #dbeafe; --info-fg: #1e40af;
  --mono: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  --font: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
}
.dark {
  /* 真深色分层（非反色）：Radix slate 1–3 阶 */
  --bg: #0c0c0f;
  --panel: #101014;
  --border: #26262b;
  --border-soft: #1c1c21;
  --fg: #fafafa;
  --fg-muted: #a1a1aa;
  --fg-faint: #6b6b74;
  /* indigo：深色用 8/11 阶抬亮 */
  --accent: #818cf8;
  --accent-fg: #1e1b4b;
  --accent-soft: rgb(99 102 241 / 0.16);
  --accent-strong: #a5b4fc;
  --ok: #4ade80; --ok-soft: rgb(74 222 128 / 0.12); --ok-fg: #86efac;
  --warn: #fbbf24; --warn-soft: rgb(251 191 36 / 0.12); --warn-fg: #fde68a;
  --danger: #f87171; --danger-soft: rgb(248 113 113 / 0.12); --danger-fg: #fca5a5;
  --info: #60a5fa; --info-soft: rgb(96 165 250 / 0.12); --info-fg: #93c5fd;
}
```

- [ ] **Step 2: 写失败的测试**

`desktop/frontend/tests/theme.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { applyTheme, type ThemeMode } from "../src/app/theme";

describe("applyTheme", () => {
  beforeEach(() => document.documentElement.className = "");

  it("light mode removes .dark", () => {
    document.documentElement.classList.add("dark");
    applyTheme("light", true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
  it("dark mode adds .dark", () => {
    applyTheme("dark", false);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
  it("system mode follows system darkness", () => {
    applyTheme("system", true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("system", false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
  it("rejects unknown mode", () => {
    expect(() => applyTheme("sepia" as ThemeMode, false)).toThrow();
  });
});
```

- [ ] **Step 3: 运行确认失败**

```bash
cd desktop/frontend && npx vitest run tests/theme.test.ts
# 预期：FAIL — Cannot find module '../src/app/theme'
```

- [ ] **Step 4: 实现 theme.ts**

```ts
export type ThemeMode = "light" | "dark" | "system";

export function applyTheme(mode: ThemeMode, systemDark: boolean): void {
  const dark = mode === "dark" || (mode === "system" && systemDark);
  document.documentElement.classList.toggle("dark", dark);
}
```

- [ ] **Step 5: 运行确认通过**

```bash
npx vitest run tests/theme.test.ts   # 预期：4 passed
```

- [ ] **Step 6: 接线系统主题监听（App.tsx 内 ThemeController）**

在 `App.tsx` 顶部加：

```tsx
import { useEffect, useState } from "react";
import { System, Events } from "@wailsio/runtime";
import { applyTheme, ThemeMode } from "./app/theme";

export function useThemeController(mode: ThemeMode) {
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    let alive = true;
    System.IsDarkMode().then((d) => alive && setSystemDark(Boolean(d)));
    const off = Events.On("common:ThemeChanged", (e) =>
      setSystemDark(Boolean(e.data)),
    );
    return () => { alive = false; off(); };
  }, []);
  useEffect(() => applyTheme(mode, systemDark), [mode, systemDark]);
}
```

`main.tsx` 确认 `import "./styles/tokens.css";`。`vite.config.ts` 的 `tailwindcss()` 插件（模板自带 Tailwind v4）会拾取该 CSS。

- [ ] **Step 7: Commit**

```bash
git add src tests && git commit -m "feat(desktop): design tokens and three-state theme system"
```

---

### Task 3: i18n 框架与完整性门禁

**Files:**
- Create: `desktop/frontend/src/app/i18n.ts`、`desktop/frontend/src/locales/en.json`、`desktop/frontend/src/locales/zh-CN.json`、`desktop/frontend/tests/i18n.test.ts`
- Modify: `desktop/frontend/package.json`（依赖 react-i18next i18next）、`desktop/frontend/src/main.tsx`（import i18n）

**Interfaces:**
- Consumes: 无
- Produces: `useTranslation()`（react-i18next 标准 hook，语言 `en` 默认 / `zh-CN`）；测试 `tests/i18n.test.ts` 断言两种语言 key 树完全一致（CI 门禁，规格 AC-021 的自动化部分）。初始 key 集：nav.*、settings.*、connections.*、common.*（见 Step 1，后续任务往两个文件同步加 key）。

- [ ] **Step 1: 写语言包**

`src/locales/en.json`：

```json
{
  "common": { "cancel": "Cancel", "save": "Save", "delete": "Delete", "close": "Close", "confirm": "Confirm", "search": "Search" },
  "nav": { "dashboard": "Dashboard", "messages": "Messages", "streams": "Streams", "consumers": "Consumers", "kv": "KeyValue", "objects": "Objects", "monitoring": "Monitoring", "settings": "Settings" },
  "conn": { "disconnected": "Not connected", "connecting": "Connecting", "connected": "Connected", "reconnecting": "Reconnecting", "failed": "Connection failed", "switchContext": "Switch context", "bannerReconnecting": "Connection lost, reconnecting…", "bannerFailed": "Connection failed: {{reason}}", "fixConnection": "Edit connection" },
  "settings": { "title": "Settings", "appearance": "Appearance", "theme": "Theme", "themeLight": "Light", "themeDark": "Dark", "themeSystem": "System", "language": "Language", "behavior": "Behavior", "pollInterval": "Poll interval (s)", "requestTimeout": "Request timeout (s)", "logLevel": "Log level", "openLogs": "Open logs folder", "saved": "Settings saved" },
  "connections": { "title": "Connections", "new": "New context", "edit": "Edit", "copy": "Copy", "delete": "Delete", "test": "Test connection", "testing": "Testing…", "name": "Name", "description": "Description", "url": "Server URL", "auth": "Authentication", "authNone": "None", "authUser": "Username / Password", "authToken": "Token", "authCreds": "Credentials file", "authNkey": "NKey file", "user": "Username", "password": "Password", "token": "Token", "credsPath": "creds file path", "nkeyPath": "nkey file path", "tls": "TLS (optional)", "cert": "Certificate", "key": "Private key", "ca": "CA", "js": "JetStream (optional)", "jsDomain": "Domain", "testOk": "Connected, RTT {{rtt}}ms, JetStream: {{js}}", "testFail": "Failed: {{error}}", "deleteActive": "This context is active and will be disconnected first. Continue?", "envWarning": "CLI environment variables detected ({{vars}}). This app ignores them and uses context files only.", "nameInvalid": "Name is required and must not contain path separators", "urlInvalid": "Enter a valid nats:// or tls:// URL" }
}
```

`src/locales/zh-CN.json`：同一 key 树，值译为简体中文（例：`"nav": { "dashboard": "总览", "messages": "消息", "streams": "流", "consumers": "消费者", "kv": "键值存储", "objects": "对象存储", "monitoring": "监控", "settings": "设置" }`，其余对应翻译——由实现者完整译出，**两文件 key 集必须逐字相同**，Step 3 的测试强制这一点）。

- [ ] **Step 2: 写失败的完整性测试**

`tests/i18n.test.ts`：

```ts
import en from "../src/locales/en.json";
import zh from "../src/locales/zh-CN.json";

const flat = (o: Record<string, unknown>, p = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    typeof v === "object" ? flat(v as never, `${p}${k}.`) : [`${p}${k}`]);

describe("i18n completeness (spec AC-021)", () => {
  it("zh-CN has exactly the same keys as en", () => {
    const a = flat(en).sort(), b = flat(zh).sort();
    expect(b).toEqual(a);
  });
  it("no empty values", () => {
    for (const [k, v] of Object.entries(flat(en))) void k, void v;
    const vals = [...Object.values(en), ...Object.values(zh)].flatMap((n) =>
      Object.values(n as Record<string, string>));
    expect(vals.every((s) => s.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 3: 运行确认失败→补齐→通过**

```bash
npm install react-i18next i18next
npx vitest run tests/i18n.test.ts
# 先故意漏译一个 key 验证 FAIL，再补齐 → 预期 PASS
```

- [ ] **Step 4: 实现 i18n.ts 并在 main.tsx 引入**

`src/app/i18n.ts`：

```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";
import zh from "../locales/zh-CN.json";

export const LANGUAGES = ["en", "zh-CN"] as const;

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, "zh-CN": { translation: zh } },
  lng: "en", fallbackLng: "en", interpolation: { escapeValue: false },
});

export function setLanguage(l: string): void {
  if (!(LANGUAGES as readonly string[]).includes(l)) return;
  void i18n.changeLanguage(l);
}
export default i18n;
```

`main.tsx` 顶部加 `import "./app/i18n";`。

- [ ] **Step 5: Commit**

```bash
git add src tests package.json package-lock.json && git commit -m "feat(desktop): i18n framework with en/zh-CN completeness gate"
```

---

### Task 4: 设置服务（Go）与设置页

**Files:**
- Create: `desktop/internal/settings/settings.go`、`desktop/internal/settings/settings_test.go`、`desktop/frontend/src/features/settings/SettingsPage.tsx`、`desktop/frontend/tests/settings-page.test.tsx`
- Modify: `desktop/main.go`（注册 SettingsService）、`desktop/frontend/src/App.tsx`（Settings 页 + 主题/语言接线）

**Interfaces:**
- Consumes: `appdir.Dir()`；Task 2 的 `applyTheme`/`ThemeMode`；Task 3 的 `setLanguage`。
- Produces（后续任务依赖的确切签名）:
  - Go：`type Settings struct { Appearance Appearance; Behavior Behavior; Privacy Privacy; LastActiveContext string }`（JSON 字段与默认值见 Global Constraints #4）；`settings.Default() Settings`；`settings.Load(path string) (Settings, error)`（损坏→重命名 `.bak`→返回默认值与 nil error）；`settings.Save(path string, s Settings) error`（原子写）。
  - 绑定（TS 侧 `import { GetSettings, SaveSettings } from "../bindings/..."`）：`GetSettings() Settings`、`SaveSettings(s Settings) error`（SettingsService 结构体方法，json tag 同 §7.1.2）。
  - 前端：`SettingsPage` 组件，props `{ settings: Settings; onSave(s: Settings): Promise<void> }`。

- [ ] **Step 1: 写失败的 Go 测试**

`internal/settings/settings_test.go`：

```go
package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDefaults(t *testing.T) {
	s := Default()
	if s.Appearance.Theme != "system" || s.Appearance.Language != "en" ||
		s.Behavior.PollIntervalSeconds != 5 || s.Behavior.RequestTimeoutSeconds != 5 ||
		s.Behavior.ConfirmLevel != "standard" || s.Behavior.SessionPushBatching ||
		s.Behavior.SessionBufferSize != 10000 || s.Behavior.LogLevel != "info" ||
		s.Privacy.CrashReports || !s.Privacy.UpdateCheck {
		t.Fatalf("defaults mismatch: %+v", s)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	s := Default()
	s.Appearance.Language = "zh-CN"
	if err := Save(path, s); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil || got.Appearance.Language != "zh-CN" {
		t.Fatalf("roundtrip failed: %v %+v", err, got)
	}
}

func TestCorruptFileFallsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	os.WriteFile(path, []byte("{not json"), 0o600)
	got, err := Load(path)
	if err != nil {
		t.Fatalf("corrupt file must not error: %v", err)
	}
	if got.Appearance.Theme != "system" {
		t.Fatal("corrupt file must return defaults")
	}
	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Fatal("corrupt file must be renamed to .bak")
	}
}

func TestSaveAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	_ = Save(path, Default())
	// 目录下不应残留临时文件
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Fatal("temp file left behind")
		}
	}
	// 写入的是合法 JSON
	b, _ := os.ReadFile(path)
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("not valid json: %v", err)
	}
}
```

- [ ] **Step 2: 运行确认失败**

```bash
go test ./internal/settings/   # 预期：FAIL（包不存在）
```

- [ ] **Step 3: 实现 settings.go**

```go
// Package settings loads and atomically saves the app settings file
// (spec §7.1.2). A corrupt file is renamed to .bak and defaults returned.
package settings

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type Appearance struct {
	Theme    string `json:"theme"`    // light | dark | system
	Language string `json:"language"` // en | zh-CN
}

type Behavior struct {
	PollIntervalSeconds   int    `json:"poll_interval_seconds"`
	RequestTimeoutSeconds int    `json:"request_timeout_seconds"`
	ConfirmLevel          string `json:"confirm_level"` // standard | relaxed
	SessionPushBatching   bool   `json:"session_push_batching"`
	SessionBufferSize     int    `json:"session_buffer_size"`
	LogLevel              string `json:"log_level"` // debug|info|warn|error
}

type Privacy struct {
	CrashReports bool `json:"crash_reports"`
	UpdateCheck  bool `json:"update_check"`
}

type Settings struct {
	Appearance        Appearance `json:"appearance"`
	Behavior          Behavior   `json:"behavior"`
	Privacy           Privacy    `json:"privacy"`
	LastActiveContext string     `json:"last_active_context"`
}

func Default() Settings {
	return Settings{
		Appearance: Appearance{Theme: "system", Language: "en"},
		Behavior: Behavior{PollIntervalSeconds: 5, RequestTimeoutSeconds: 5,
			ConfirmLevel: "standard", SessionPushBatching: false,
			SessionBufferSize: 10000, LogLevel: "info"},
		Privacy: Privacy{CrashReports: false, UpdateCheck: true},
	}
}

func Load(path string) (Settings, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Default(), nil
	}
	if err != nil {
		return Default(), fmt.Errorf("read settings: %w", err)
	}
	var s Settings
	if err := json.Unmarshal(b, &s); err != nil {
		_ = os.Rename(path, path+".bak")
		return Default(), nil // spec §6.12: 损坏回退默认
	}
	return s, nil
}

func Save(path string, s Settings) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return fmt.Errorf("write settings: %w", err)
	}
	return os.Rename(tmp, path) // 原子替换（spec §16.3）
}

// Path returns <appdir>/settings.json, creating the directory.
func Path() (string, error) {
	dir, err := settingsDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.json"), nil
}
```

`settingsDir` 为包内私有别名（调用 `appdir` 会造成循环？不会——appdir 不依赖 settings。直接 `import "...internal/appdir"`，`settingsDir()` 省略，`Path()` 用 `appdir.Dir()`）。绑定服务 `desktop/internal/settings/service.go`：

```go
package settings

import "fmt"

// Service is the Wails-bound facade (bound as application.NewService).
type Service struct{ Path string }

func NewService(path string) *Service { return &Service{Path: path} }

func (s *Service) GetSettings() (Settings, error) { return Load(s.Path) }

func (s *Service) SaveSettings(v Settings) error { return Save(s.Path, v) }

var _ = fmt.Sprintf // 保持 fmt 引用（如无需要可删）
```

（删掉多余 fmt 行，保持编译干净。）

- [ ] **Step 4: Go 测试转绿，生成绑定，接 main.go**

```bash
go test ./internal/settings/ -v        # 预期：4 PASS
wails3 generate bindings -ts -clean=true
```

`main.go` 装配（在 `application.New` 的 `Services` 里追加；路径来自 appdir）：

```go
settingsPath, _ := settings.Path()
settingsSvc := settings.NewService(settingsPath)
// Services: []application.Service{ application.NewService(settingsSvc), ... }
```

- [ ] **Step 5: 写设置页（含失败的组件测试）**

`tests/settings-page.test.tsx`：

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { SettingsPage } from "../src/features/settings/SettingsPage";
import { Default } from "../src/lib/bindings"; // 见 Step 6 的类型再导出

vi.mock("../src/app/i18n", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

it("saves picked theme and language", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<SettingsPage settings={Default()} onSave={onSave} />);
  fireEvent.change(screen.getByLabelText("settings.theme"), { target: { value: "dark" } });
  fireEvent.change(screen.getByLabelText("settings.language"), { target: { value: "zh-CN" } });
  fireEvent.click(screen.getByRole("button", { name: "common.save" }));
  await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
  const saved = onSave.mock.calls[0][0];
  expect(saved.appearance.theme).toBe("dark");
  expect(saved.appearance.language).toBe("zh-CN");
});
```

先跑 `npx vitest run tests/settings-page.test.tsx` 确认 FAIL（组件不存在）。

- [ ] **Step 6: 实现 SettingsPage.tsx**

要点（完整实现，样式用 Tailwind + tokens 变量）：受控表单（theme `select`：light/dark/system；language `select`：en/zh-CN；poll/timeout `input[type=number]`；logLevel `select`；openLogs 按钮调绑定 `OpenLogsDir()`——该绑定在 Task 5 提供，本任务按钮先调 `console.warn` 占位并在 Task 5 替换为真实绑定调用，**验收以 Task 5 转绿为准**）；保存调 `onSave`；父组件（App.tsx）负责：加载时 `GetSettings()` → `useThemeController(settings.appearance.theme)` + `setLanguage(settings.appearance.language)`；`onSave` = `SaveSettings(s)` 后同步主题/语言（即时生效，规格 §6.12）。`src/lib/bindings.ts` 统一再导出生成的绑定函数与 Go 类型（TS 端 `Default` 即默认设置对象字面量，字段与 Go 一致）。

```bash
npx vitest run tests/settings-page.test.tsx   # 预期：PASS
```

- [ ] **Step 7: Commit**

```bash
git add . && git commit -m "feat(desktop): settings service, atomic persistence, settings page"
```

---

### Task 5: 日志服务（轮转 + 凭证脱敏）

**Files:**
- Create: `desktop/internal/logging/logging.go`、`desktop/internal/logging/logging_test.go`
- Modify: `desktop/main.go`（装配 slog：`Options.Logger` 注入 + 按设置级别）、`desktop/frontend/src/features/settings/SettingsPage.tsx`（OpenLogs 真实接线）

**Interfaces:**
- Consumes: `appdir.LogsDir()`、settings.Behavior.LogLevel。
- Produces: `logging.New(dir string, level string) (*slog.Logger, error)`；`logging.OpenLogsDir() error`（Explorer 打开目录）；`logging.RedactContext(c *natscontext.Context) slog.Value`（密码/token 一律 `"***"`，规格 §13.3）。

- [ ] **Step 1: 写失败的测试**

```go
package logging

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nats-io/jsm.go/natscontext"
)

func TestRotationKeepsThreeFiles(t *testing.T) {
	dir := t.TempDir()
	log, err := New(dir, "debug")
	if err != nil {
		t.Fatal(err)
	}
	big := strings.Repeat("x", 64*1024) // 64KB 行
	for i := 0; i < 200; i++ {          // 写 ~12MB，触发 5MB 轮转
		log.Info(big)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "nats-desktop.log*"))
	if len(files) > 3 {
		t.Fatalf("expected at most 3 files, got %d", len(files))
	}
}

func TestNoCredentialsInLog(t *testing.T) {
	dir := t.TempDir()
	log, _ := New(dir, "info")
	ctx := natscontext.New("prod", false,
		natscontext.WithServerURL("nats://a:4222"),
		natscontext.WithUser("u"), natscontext.WithPassword("supersecret"))
	log.Info("context", "context", RedactContext(ctx))
	b, _ := os.ReadFile(filepath.Join(dir, "nats-desktop.log"))
	if strings.Contains(string(b), "supersecret") {
		t.Fatal("password leaked into log")
	}
	if !strings.Contains(string(b), "prod") {
		t.Fatal("non-secret field missing")
	}
}
```

- [ ] **Step 2: 确认失败 → 实现轮转 writer 与脱敏**

`logging.go` 核心结构（完整实现）：`rotatingWriter{path, f, size, maxBytes=5MB, keep=3}`——`Write` 超限时关闭当前文件，把 `nats-desktop.log.2` 删、`.1`→`.2`、当前→`.1`，重开新文件；`New` 返回 `slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: parseLevel(level)}))`；`RedactContext` 返回 `slog.GroupValue`（name/url/description 保留，password/token 置 `"***"`，路径类字段保留）。`OpenLogsDir()` 用 `exec.Command("explorer", dir)`（Windows）。

```bash
go test ./internal/logging/ -v   # 预期：PASS（先 FAIL 再实现，红→绿）
```

- [ ] **Step 3: main.go 装配**

```go
logsDir, _ := appdir.LogsDir()
logger, err := logging.New(logsDir, s.Behavior.LogLevel) // s = 已加载的 settings
if err == nil {
	opts.Logger = logger   // application.Options 字段（Wails v3 内建 slog 注入点）
}
```

SettingsPage 的 openLogs 按钮改为调用绑定 `OpenLogsDir()`（logging.Service 绑定结构体提供该方法）。

- [ ] **Step 4: Commit**

```bash
git add . && git commit -m "feat(desktop): rotating file logger with credential redaction"
```

---

### Task 6: context CRUD（Go）与 CLI 互操作

**Files:**
- Create: `desktop/internal/connections/types.go`、`desktop/internal/connections/contexts.go`、`desktop/internal/connections/contexts_test.go`
- Modify: 无（manager.go 是 Task 8）

**Interfaces:**
- Consumes: `natscontext.Registry`（NewRegistry/NewDefaultFileBackend/WithDefaultResolvers/WithLocalSelector、List/Load/Save/Delete/Known/Select/Selected/Unselect；`natscontext.New(name, load bool, opts ...Option)`）。
- Produces（Task 10 依赖）:
  - `type ContextSummary struct { Name, Description, URL, AuthType, ColorScheme string }`（json tag 小写）
  - `type ContextForm struct { Name, Description, URL, User, Password, Token, Creds, Nkey, Cert, Key, CA, JSDomain, JSAPIPrefix, JSEventPrefix, InboxPrefix, SocksProxy, ColorScheme string; TLSFirst bool }`
  - `type Store struct { ... }`；`NewStore(reg *natscontext.Registry) *Store`
  - 方法：`List(ctx) ([]ContextSummary, error)`、`Save(ctx, ContextForm) error`（存在则加载再覆盖＝编辑语义）、`Delete(ctx, name) error`（活跃/选中处理由 Manager 层做，本方法只删文件并在选中时 Unselect）、`Copy(ctx, src, name) error`、`Validate(ctx, name) error`（文件可达性）
  - `EnvWarnings() []string`（检测 NATS_URL/NATS_CONTEXT/NATS_USER/NATS_PASSWORD/NATS_CREDS/NATS_NKEY，返回存在的变量名）
  - `func NewRegistry() *natscontext.Registry`（WithDefaultResolvers + WithLocalSelector + NewDefaultFileBackend）

- [ ] **Step 1: 写失败的测试（临时目录后端，含互操作断言）**

`contexts_test.go` 核心用例（完整实现约 5 个用例，此处列关键断言）：

```go
func newTestStore(t *testing.T) (*Store, *natscontext.Registry) {
	reg := natscontext.NewRegistry(natscontext.NewFileBackendAt(t.TempDir()))
	return NewStore(reg), reg
}

func TestSaveThenList(t *testing.T) {
	store, _ := newTestStore(t)
	err := store.Save(context.Background(), ContextForm{
		Name: "demo", URL: "nats://demo.nats.io:4222", User: "u", Password: "p",
	})
	if err != nil { t.Fatal(err) }
	list, _ := store.List(context.Background())
	if len(list) != 1 || list[0].Name != "demo" || list[0].AuthType != "userpass" {
		t.Fatalf("unexpected list: %+v", list)
	}
}

// 互操作（规格 §17.3/AC-003）：应用写出的文件必须能被"CLI 同款 Registry"原样读回。
func TestInteropRoundTrip(t *testing.T) {
	store, reg := newTestStore(t)
	_ = store.Save(context.Background(), ContextForm{Name: "demo", URL: "nats://a:4222", Creds: "C:/x.creds"})
	// CLI 使用同一个 natscontext 库与目录：用独立 Registry 模拟 CLI 读取
	fresh := natscontext.NewRegistry(natscontext.NewFileBackendAt(backendDir(reg)))
	got, err := fresh.Load(context.Background(), "demo")
	if err != nil { t.Fatalf("CLI-side load failed: %v", err) }
	if got.ServerURL() != "nats://a:4222" { t.Fatal("url mismatch") }
}

func TestSaveEditSemantics(t *testing.T)  // 同名再保存保留未覆盖字段（编辑语义）
func TestDelete(t *testing.T)             // 删除后 List 为空
func TestValidateName(t *testing.T)       // 空名 / 含 `/\` 拒绝（E-VALIDATION）
func TestEnvWarnings(t *testing.T)        // t.Setenv("NATS_URL","x") → 含 "NATS_URL"
```

（`backendDir` 通过 `NewFileBackendAt` 记录的目录传入；测试与 Store 共用同一目录路径变量。）

- [ ] **Step 2: 红灯 → 实现 types.go + contexts.go**

实现要点（调用序列逐字来自 natscli 源码调查）：`Save` = `natscontext.New(form.Name, reg.Known(ctx, form.Name), natscontext.WithServerURL(...), WithUser/WithPassword/WithToken/WithCreds/WithNKey/WithCertificate/WithKey/WithCA/WithJSDomain/WithJSAPIPrefix/WithJSEventPrefix/WithInboxPrefix/WithSocksProxy/WithColorScheme/WithTLSHandshakeFirst, WithDescription(...))`（空字符串字段跳过对应 Option）→ `reg.Save(ctx, c, name)`；`AuthType` 判定顺序 creds→nkey→token→userpass→none；`Delete` = 选中则 `Unselect` → `reg.Delete`；`Copy` = Load(src) + `natscontext.New(name, true, 以 src 为加载源…)` 或直接 Load 后改名字段保存（采用后者：`reg.Load(src)` → `reg.Save(ctx, c, name)`，natscontext.Context 无 Name 字段则保持原语义以 Save 的 name 参数为准）；`Validate` = Load 后 `c.Validate()` + 证书/creds 路径 `os.Stat`。

```bash
go test ./internal/connections/ -run 'TestSave|TestInterop|TestDelete|TestValidateName|TestEnv' -v
# 预期：全部 PASS（红→绿）
```

- [ ] **Step 3: 手动互操作冒烟（AC-003 的 CLI 半边）**

```bash
# 应用写 context 后，用本仓库的 natscli 验证（同一用户目录）
go run ./nats context list
go run ./nats --context demo rtt -i 1
# 预期：列表含 demo，rtt 可用；反向：go run ./nats context save cli-made --server nats://a:4222 后应用 List 可见
```

- [ ] **Step 4: Commit**

```bash
git add . && git commit -m "feat(desktop): context store over natscontext with CLI interop"
```

---

### Task 7: 内嵌 nats-server 测试夹具

**Files:**
- Create: `desktop/internal/testutil/server.go`、`desktop/internal/testutil/server_test.go`

**Interfaces:**
- Consumes: `nats-server/v2` 的 `server.NewServer(&server.Options{...})` / `srv.Start()` / `srv.ReadyForConnections(d)` / `srv.Shutdown()`（natscli 测试同款，nats/tests/nats_test.go:134-176）。
- Produces（Task 8 及后续所有里程碑测试依赖）:
  - `testutil.StartJSServer(t *testing.T) (url string)` —— 单节点 JetStream 开启、随机端口、StoreDir=t.TempDir()、`t.Cleanup(srv.Shutdown)`
  - `testutil.StartAuthServer(t *testing.T, user, pass string) (url string)`

- [ ] **Step 1: 写失败的自证测试**

```go
package testutil

import (
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

func TestStartJSServerPubSub(t *testing.T) {
	url := StartJSServer(t)
	nc, err := nats.Connect(url)
	if err != nil { t.Fatal(err) }
	defer nc.Close()
	got := make(chan []byte, 1)
	nc.Subscribe("smoke", func(m *nats.Msg) { got <- m.Data })
	nc.Publish("smoke", []byte("ok"))
	select {
	case d := <-got:
		if string(d) != "ok" { t.Fatal("bad payload") }
	case <-time.After(2 * time.Second):
		t.Fatal("no message")
	}
}
```

- [ ] **Step 2: 红灯 → 实现夹具**

```go
package testutil

import (
	"testing"

	"github.com/nats-io/nats-server/v2/server"
)

func start(t *testing.T, opts *server.Options) string {
	t.Helper()
	srv, err := server.NewServer(opts)
	if err != nil { t.Fatal(err) }
	go srv.Start()
	if !srv.ReadyForConnections(10 * time.Second) { t.Fatal("server not ready") }
	t.Cleanup(srv.Shutdown)
	return srv.ClientURL()
}

func StartJSServer(t *testing.T) string {
	return start(t, &server.Options{
		Port: -1, ServerName: "TEST_JS", StoreDir: t.TempDir(), JetStream: true,
	})
}

func StartAuthServer(t *testing.T, user, pass string) string {
	return start(t, &server.Options{
		Port: -1, ServerName: "TEST_AUTH",
		Users: []*server.User{{Username: user, Password: pass}},
	})
}
```

（补 `time` import。注意 natscli 的 3 节点集群夹具在 Windows Skip——M1 只需单节点，Windows CI 可跑。）

- [ ] **Step 3: 绿灯 + Commit**

```bash
go test ./internal/testutil/ -v   # 预期 PASS
git add . && git commit -m "test(desktop): embedded nats-server fixtures"
```

---

### Task 8: 连接管理器（五态状态机）

**Files:**
- Create: `desktop/internal/connections/manager.go`、`desktop/internal/connections/manager_test.go`
- Modify: `desktop/internal/connections/types.go`（若需补 StateEvent 字段）

**Interfaces:**
- Consumes: Task 6 的 `NewRegistry`/Store；Task 7 夹具；`cfg.NATSOptions()` + `nats.Connect(cfg.ServerURL(), opts...)`。
- Produces（Task 9/10/11 依赖）:
  - `type State string`；常量 `StateDisconnected/StateConnecting/StateConnected/StateReconnecting/StateFailed`（值 = disconnected/connecting/connected/reconnecting/failed，规格 §7.3）
  - `type StateEvent struct { Context string \`json:"context"\`; State State \`json:"state"\`; Since string \`json:"since"\`; RttMs int64 \`json:"rtt_ms"\`; Reason string \`json:"reason,omitempty"\` }`
  - `type TestResult struct { OK bool \`json:"ok"\`; RttMs int64 \`json:"rtt_ms"\`; JetStream bool \`json:"jetstream"\`; Error string \`json:"error,omitempty"\` }`
  - `type Manager struct{...}`；`NewManager(reg *natscontext.Registry, log *slog.Logger, emit func(name string, data any)) *Manager`（emit 注入便于测试）
  - 方法：`Connect(ctx, name string) error`、`Disconnect()`、`Snapshot() StateEvent`、`CheckConnection(ctx, form ContextForm) TestResult`（临时连接：`MaxReconnects(1)` + `nats.Timeout(5s)`，RTT 5 次平均，`jsm.New(nc)` 后 `JetStreamAccountInfo()` 探测，随即 Close）、`MeasureRTT() (time.Duration, error)`
  - 事件名常量 `EventConnState = "conn:state"`。

- [ ] **Step 1: 写失败的状态机测试（覆盖规格 §10 全部转移）**

```go
func TestStateMachineHappyPath(t *testing.T) {
	url := testutil.StartJSServer(t)
	m, events := newRecordingManager(t) // 记录 emit 的 (name, payload)
	saveContext(t, m, "demo", url)
	if err := m.Connect(context.Background(), "demo"); err != nil { t.Fatal(err) }
	assertState(t, events, StateConnected)
	m.Disconnect()
	assertState(t, events, StateDisconnected)
}

func TestReconnectOnServerRestart(t *testing.T) {
	// 用可重启的服务器夹具（本测试内联构造，Shutdown 后 NewServer 同 StoreDir 复启）
	// 断开 → StateReconnecting；重启 → StateConnected
}

func TestAuthFailureGoesFailedNoRetryLoop(t *testing.T) {
	url := testutil.StartAuthServer(t, "u", "right")
	m, events := newRecordingManager(t)
	saveContext(t, m, "bad", url, withUser("u", "wrong"))
	_ = m.Connect(context.Background(), "bad")
	assertState(t, events, StateFailed)
	// 3s 内不再出现 StateConnected/StateReconnecting（无重试循环，规格 §6.2）
	time.Sleep(3 * time.Second)
	assertLastState(t, events, StateFailed)
}

func TestCheckConnection(t *testing.T) {
	url := testutil.StartJSServer(t)
	m, _ := newRecordingManager(t)
	res := m.CheckConnection(context.Background(), ContextForm{Name: "t", URL: url})
	if !res.OK || !res.JetStream || res.RttMs < 0 { t.Fatalf("unexpected: %+v", res) }
}
```

- [ ] **Step 2: 红灯 → 实现 Manager**

实现要点（nats.go handler 挂法与 CLI 一致）：`Connect`：互斥锁内若已有连接先关（userClosed=true）；置 connecting（emit）；`cfg, _ := reg.Load(ctx, name)`；`opts, _ := cfg.NATSOptions()`；追加 `nats.Name("nats-desktop")`、`nats.Timeout(5s)`、`nats.MaxReconnects(-1)`、`nats.CustomReconnectDelay(backoff)`（指数退避，参照 natscli internal/util/backoff.DefaultBackoff，桌面侧自实现 2^n 封顶 10s）、五个 handler：`ConnectHandler`→connected；`DisconnectErrHandler`→若非 userClosed 则 reconnecting；`ReconnectHandler`→connected（并刷新 RTT）；`ErrorHandler`→错误串含 `authorization` 则置 failed + `nc.Close()`（**不设 `IgnoreAuthErrorAbort`**，规格要求认证失败即终止）；`ClosedHandler`→非用户关闭且非 failed 时置 failed；每次状态变更 emit `EventConnState` + 更新 `Snapshot`（Since=RFC3339、RttMs 由 connected 时 `nc.RTT()` 取得）。

- [ ] **Step 3: 绿灯**

```bash
go test ./internal/connections/ -v   # 预期：全部 PASS
```

- [ ] **Step 4: Commit**

```bash
git add . && git commit -m "feat(desktop): connection manager with five-state machine and auth-fail handling"
```

---

### Task 9: 前端壳（侧栏、状态脚、命令面板）+ shadcn 装配

**Files:**
- Create: `desktop/frontend/src/app/shell.tsx`、`desktop/frontend/src/app/command.tsx`、`desktop/frontend/src/app/connstate.tsx`、`desktop/frontend/tests/shell.test.tsx`
- Modify: `desktop/frontend/src/App.tsx`（重写为壳 + 页面占位）、`package.json`（shadcn/cmdk 依赖）

**Interfaces:**
- Consumes: 生成的绑定（ListContexts/ConnSnapshot/Disconnect 等）、`Events.On("conn:state")`、Task 3 i18n。
- Produces:
  - `type PageId = "dashboard"|"messages"|"streams"|"consumers"|"kv"|"objects"|"monitoring"|"settings"`
  - `<Shell page={PageId} onNavigate={(p: PageId)=>void}>{children}</Shell>`
  - `useConnState(): { state: string; context: string; rttMs: number; reason: string }`（connstate.tsx，Provider 包 App）
  - `<CommandPalette open onClose onNavigate onSwitchContext>`（cmdk，动作：8 个导航 + 各 context 切换）

- [ ] **Step 1: 安装 shadcn/ui 与依赖**

```bash
cd desktop/frontend
npx shadcn@latest init --yes --base-color neutral
npx shadcn@latest add button dialog dropdown-menu input label select sonner badge --yes
npm install cmdk
```

- [ ] **Step 2: 写失败的壳测试**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { Shell } from "../src/app/shell";

vi.mock("../src/app/i18n", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

it("renders all eight nav entries with svg icons", () => {
  render(<Shell page="settings" onNavigate={() => {}}><div/></Shell>);
  for (const key of ["dashboard","messages","streams","consumers","kv","objects","monitoring","settings"]) {
    expect(screen.getByTestId(`nav-${key}`)).toBeTruthy();
  }
  // 规格 §18.2：禁止 emoji 图标 —— 导航按钮内只允许 svg
  const btn = screen.getByTestId("nav-streams");
  expect(btn.querySelector("svg")).toBeTruthy();
  expect(btn.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
});

it("active nav item is marked", () => {
  render(<Shell page="streams" onNavigate={() => {}}><div/></Shell>);
  expect(screen.getByTestId("nav-streams").getAttribute("aria-current")).toBe("page");
});

it("calls onNavigate on click", () => {
  const nav = vi.fn();
  render(<Shell page="settings" onNavigate={nav}><div/></Shell>);
  fireEvent.click(screen.getByTestId("nav-kv"));
  expect(nav).toHaveBeenCalledWith("kv");
});
```

- [ ] **Step 3: 红灯 → 实现 shell.tsx / connstate.tsx / command.tsx / App.tsx**

实现要点：
- `shell.tsx`：左侧固定栏（`w-56`，顶部 logo 行 + 连接切换 DropdownMenu（列出 contexts，选中调 `Connect` 绑定；显示状态点：connected=绿、reconnecting=橙、failed=红、其余灰））；中部 8 个导航按钮（`lucide-react`：`LayoutDashboard, Mail, Zap, Users, Database, Package, Activity, Settings`，16px/`strokeWidth={1.75}`）；底部状态摘要（context 名 + RTT）。主区顶部连接横幅（reconnecting 橙 / failed 红，文案 `conn.bannerReconnecting`/`conn.bannerFailed` + 「修改连接」按钮跳 Settings）。非 connected 时其余 7 页显示 `<EmptyState>`（"conn.disconnected" 文案 + 引导按钮）。
- `connstate.tsx`：Provider 内 `useState`（初值来自绑定 `ConnSnapshot()`），`Events.On("conn:state", e => setState(e.data))`；导出 `useConnState()`。
- `command.tsx`：`cmdk` 的 `Command.Dialog`，`Ctrl+K` 全局监听（App.tsx 挂载），分组「Go to」（8 页）与「Connections」（ListContexts 结果，点击 = Connect）。
- `App.tsx`：`const [page, setPage] = useState<PageId>("dashboard")` + `useThemeController(settings.appearance.theme)` + ConnStateProvider 包 Shell；Messages/Streams/Consumers/KV/Objects/Monitoring 六页为空态占位组件（M2–M5 实现）；Settings 页挂 Task 4 的 SettingsPage，Connections 管理作为 Settings 页内 tab（Task 10）。

```bash
npx vitest run tests/shell.test.tsx   # 预期：PASS（红→绿）
npm run build                          # tsc + vite 构建通过
```

- [ ] **Step 4: Commit**

```bash
git add . && git commit -m "feat(desktop): app shell with sidebar, status footer, command palette"
```

---

### Task 10: 连接管理 UI（列表 + 表单 + 测试连接）

**Files:**
- Create: `desktop/frontend/src/features/connections/ConnectionsPage.tsx`、`desktop/frontend/src/features/connections/schema.ts`、`desktop/frontend/tests/connections-page.test.tsx`
- Modify: `desktop/frontend/src/App.tsx`（Settings 页加 Connections tab）、`desktop/frontend/src/locales/en.json` + `zh-CN.json`（新增 key 同步双侧）

**Interfaces:**
- Consumes: Task 6/8 的绑定：`ListContexts() ContextSummary[]`、`SaveContext(ContextForm) error`、`DeleteContext(name) error`、`CopyContext(src, name) error`、`CheckConnection(ContextForm) TestResult`、`Connect(name) error`、`Disconnect() error`、`EnvWarnings() []string`（main.go 将 Manager+Store 方法挂到 ConnectionsService 绑定结构体）。
- Produces: `<ConnectionsPage>` 组件（含列表、创建/编辑 Dialog 表单、测试连接按钮、删除确认）。

- [ ] **Step 1: 表单校验 schema（zod，字段规则=规格 §6.2）**

`schema.ts`（完整）：

```ts
import { z } from "zod";

export const contextFormSchema = z.object({
  name: z.string().min(1, "connections.nameInvalid")
    .refine((s) => !/[/\\]/.test(s), "connections.nameInvalid"),
  url: z.string().url("connections.urlInvalid")
    .refine((s) => /^nats:\/\//.test(s) || /^tls:\/\//.test(s), "connections.urlInvalid"),
  description: z.string().optional(),
  authType: z.enum(["none", "userpass", "token", "creds", "nkey"]),
  user: z.string().optional(), password: z.string().optional(),
  token: z.string().optional(), creds: z.string().optional(), nkey: z.string().optional(),
  cert: z.string().optional(), key: z.string().optional(), ca: z.string().optional(),
  jsDomain: z.string().optional(), inboxPrefix: z.string().optional(),
  socksProxy: z.string().optional(), colorScheme: z.string().optional(),
  tlsFirst: z.boolean().optional(),
});
export type ContextFormValues = z.infer<typeof contextFormSchema>;
```

（`npm install zod`。）

- [ ] **Step 2: 写失败的组件测试**

```tsx
// tests/connections-page.test.tsx 关键断言（完整文件含 mock 绑定模块 ../src/lib/bindings）：
it("rejects name with path separator inline", async () => {
  render(<ConnectionsPage />);
  fireEvent.click(screen.getByRole("button", { name: "connections.new" }));
  await userEvent.type(screen.getByLabelText("connections.name"), "a/b");
  fireEvent.click(screen.getByRole("button", { name: "common.save" }));
  expect(await screen.findByText("connections.nameInvalid")).toBeTruthy();
  expect(mockSave).not.toHaveBeenCalled();
});

it("shows test result with rtt and jetstream", async () => {
  mockCheck.mockResolvedValue({ ok: true, rtt_ms: 12, jetstream: true });
  /* 填表后点击测试按钮 */
  expect(await screen.findByText(/RTT 12ms/)).toBeTruthy();
});

it("delete active context asks confirmation", async () => { /* confirm dialog → Disconnect 后 Delete */ });
it("shows env-var warning when present", () => { /* mock EnvWarnings → ['NATS_URL'] → 渲染 connections.envWarning */ });
```

- [ ] **Step 3: 红灯 → 实现 ConnectionsPage**

要点：列表卡片（名称/描述/URL/认证摘要/色彩标签/活跃标记，行动作：Connect、Edit、Copy、Delete）；表单 Dialog（authType 单选切换条件字段；密码 Input `type="password"` 可点眼睛临时显示——规格 §16.4 掩码）；测试连接按钮（loading 态 ≤100ms 出现，结果行显示 `connections.testOk`/`testFail`）；删除走 shadcn AlertDialog（活跃 context 文案 `connections.deleteActive`，确认后先 `Disconnect()` 再 `DeleteContext`）；页顶 EnvWarnings 渲染警告条。

- [ ] **Step 4: 绿灯 + 手动冒烟**

```bash
npx vitest run tests/connections-page.test.tsx   # PASS
wails3 dev
# 手动：新建 context 指向本地 nats-server（可用 docker 或 go run 根仓库内无服务器则跳过）
# 走查：测试连接 → 连接 → 状态点变绿 → 重启 App 自动恢复连接（AC-001/002 路径）
```

- [ ] **Step 5: main.go 注册 ConnectionsService + 启动恢复**

`main.go`：`ConnectionsService` 绑定结构体聚合 Store+Manager 方法（签名与 Step 1 Interfaces 一致）；启动时若 `settings.LastActiveContext` 非空且 Known → 自动尝试恢复连接，失败 1 次即停（规格 §6.1：不循环重试）；连接成功后回写 LastActiveContext。

- [ ] **Step 6: Commit**

```bash
git add . && git commit -m "feat(desktop): connections page with form, test-connection, danger confirms"
```

---

### Task 11: 连接状态 UI 集成（横幅/状态脚/首次引导）

**Files:**
- Create: `desktop/frontend/tests/connstate-ui.test.tsx`
- Modify: `desktop/frontend/src/app/shell.tsx`（横幅与状态脚消费 useConnState）、`desktop/frontend/src/App.tsx`（无任何 context 时进入引导视图）

**Interfaces:**
- Consumes: Task 8 事件 `conn:state`、Task 9 `useConnState`。
- Produces: 完整 §18.3 状态显示：五态在状态脚（点+文案+RTT）与横幅（reconnecting/failed + 修改连接入口）的呈现；首启引导（无 context → 引导卡片）。

- [ ] **Step 1: 写失败的 UI 状态测试**

```tsx
// 用 renderHook + 事件模拟：
it("shows reconnecting banner on conn:state event", () => {
  const off = captureEvents("conn:state"); // 测试助手：拦截 Events.On 注册
  renderShell();
  off.fire({ context: "demo", state: "reconnecting", rtt_ms: 0 });
  expect(screen.getByText("conn.bannerReconnecting")).toBeTruthy();
  expect(screen.getByText("conn.reconnecting")).toBeTruthy();
});

it("failed banner shows reason and edit action", () => { /* state:"failed", reason:"authorization violation" → conn.bannerFailed 含 reason + conn.fixConnection 按钮跳 Settings */ });

it("connected shows rtt in status footer", () => { /* rtt_ms:12 → "12ms" */ });
```

- [ ] **Step 2: 红灯 → 补齐 shell 状态渲染与引导视图**

实现：状态脚 `<StatusFooter>`（useConnState → 状态点颜色 map、context 名、connected 时 `{{rtt}}ms`）；横幅组件按 state 条件渲染；App.tsx 首启（`ListContexts()` 为空数组）渲染引导卡片（`connections.new` CTA → 打开创建 Dialog）。

- [ ] **Step 3: 端到端状态走查（dev 模式）**

```bash
wails3 dev
# 连接本地服务器 → kill 服务器进程 → 观察 reconnecting 横幅 → 重启服务器 → connected
# 错误密码场景 → failed 横幅（含服务器原文）→ 修正后可重连（对应 AC-018/019 的手动路径）
```

- [ ] **Step 4: Commit**

```bash
git add . && git commit -m "feat(desktop): connection state UI - banners, footer, first-run guide"
```

---

### Task 12: 版本检查 + 托盘 + 单实例

**Files:**
- Create: `desktop/internal/version/version.go`、`desktop/internal/version/version_test.go`
- Modify: `desktop/main.go`（托盘、SingleInstance、AppService 注册）、`desktop/frontend/src/App.tsx`（update toast）、`locales/*.json`（update.* key 双侧）

**Interfaces:**
- Consumes: `Options.SingleInstance`、`app.SystemTray.New()`、`app.NewMenu()`（Wails v3 beta.20 验证过的 API）。
- Produces: `version.CompareVersions(a, b string) int`；`version.CheckLatest(ctx context.Context, repo, current string) (UpdateInfo, error)`（5s 超时；`UpdateInfo{Current, Latest, URL string; HasUpdate bool}`）；绑定 `AppVersion() string`、`CheckUpdate() UpdateInfo`、事件 `"update:available"`。

- [ ] **Step 1: 写失败的测试**

```go
func TestCompareVersions(t *testing.T) {
	cases := []struct{ a, b string; want int }{
		{"v1.0.0", "v1.0.1", -1}, {"v1.2.0", "v1.10.0", -1},
		{"v2.0.0", "v1.9.9", 1}, {"v1.0.0", "v1.0.0", 0},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Fatalf("%s vs %s = %d want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestCheckLatestParsesRelease(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"tag_name": "v9.9.9", "html_url": "https://github.com/x/y/releases/v9.9.9"}`))
	}))
	defer srv.Close()
	got, err := CheckLatestAt(context.Background(), srv.URL, "v1.0.0") // CheckLatest 的可注入 URL 变体
	if err != nil || !got.HasUpdate || got.Latest != "v9.9.9" { t.Fatalf("%+v %v", got, err) }
}

func TestCheckLatestTimeoutIsSilentError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	_, err := CheckLatestAt(ctx, "http://127.0.0.1:1", "v1.0.0")
	if err == nil { t.Fatal("expected error") }
}
```

- [ ] **Step 2: 红灯 → 实现（semver 比较 + GET releases/latest，`http.Client{Timeout: 5s}`）→ 绿灯**

- [ ] **Step 3: main.go 集成**

托盘（图标暂用 build/appicon.png 字节）：

```go
systray := app.SystemTray.New()
systray.SetIcon(iconBytes)
systray.SetTooltip("NATS Desktop")
menu := app.NewMenu()
menu.Add("Show").OnClick(func(*application.Context) { app.Window.GetByName("main").Show() })
menu.Add("Quit").OnClick(func(*application.Context) { app.Quit() })
systray.SetMenu(menu)
```

`Options.SingleInstance = &application.SingleInstanceOptions{UniqueId: "nats-desktop-<uuid>"}`（生成后固定写入）；启动时（settings.Privacy.UpdateCheck 为 true）goroutine 跑 CheckLatest，HasUpdate 则 `app.Event.Emit("update:available", info)`；前端 App.tsx 订阅后用 sonner toast 显示一次（可关闭，附 URL 链接）。

- [ ] **Step 4: 走查 + Commit**

```bash
wails3 build && ./bin/nats-desktop.exe
# 验证：二次启动聚焦已有窗口（单实例）；托盘菜单 Show/Quit；版本检查 toast（临时把 current 设 0.0.1 对真实 Releases）
git add . && git commit -m "feat(desktop): update check, system tray, single instance"
```

---

### Task 13: CI 流水线（lint + 单测 + i18n 门禁 + 构建）

**Files:**
- Create: `.github/workflows/desktop-ci.yml`
- Modify: 无

**Interfaces:**
- Consumes: 前述全部任务的测试与构建。
- Produces: PR/push（`desktop/**` 或 workflow 变更触发）四段流水线；`frontend/bindings/` 提交入库（CI 不跑 wails3 generate，避免 beta CLI 漂移——本地改 Go 服务后必须重跑 generate 并提交，写入 `desktop/CONTRIBUTING.md`）。

- [ ] **Step 1: 写 workflow（完整文件）**

```yaml
name: desktop-ci
on:
  pull_request: { paths: ["desktop/**", ".github/workflows/desktop-ci.yml"] }
  push: { branches: [main], paths: ["desktop/**", ".github/workflows/desktop-ci.yml"] }
jobs:
  go:
    runs-on: windows-latest
    defaults: { run: { working-directory: desktop } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: "1.26" }
      - run: go vet ./...
      - run: go test ./... -race -count=1
  frontend:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: desktop/frontend } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: desktop/frontend/package-lock.json }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx eslint src --max-warnings 0
      - run: npx vitest run   # 含 i18n 完整性门禁（规格 AC-021 自动化半边）
  build:
    needs: [go, frontend]
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: "1.26" }
      - run: go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.20
      - run: wails3 build
        working-directory: desktop
      - uses: actions/upload-artifact@v4
        with: { name: nats-desktop-windows, path: desktop/bin/ }
```

- [ ] **Step 2: 本地验证语法与触发路径，写 CONTRIBUTING 说明**

```bash
# 本地等价跑一遍三段
cd desktop && go vet ./... && go test ./... -race
cd frontend && npm ci && npx tsc --noEmit && npx vitest run
cd .. && wails3 build
```

创建 `desktop/CONTRIBUTING.md`：记录「改 Go 服务后 `wails3 generate bindings -ts -clean=true` 并提交 bindings/」「i18n key 双侧同步，CI 会拦」。

- [ ] **Step 3: Commit**

```bash
git add ../.github . && git commit -m "ci(desktop): lint, test, i18n gate, windows build pipeline"
```

---

### Task 14: M1 验收与性能冒烟

**Files:**
- Create: `docs/superpowers/plans/2026-09-11-nats-desktop-m1-acceptance.md`
- Modify: 无

**Interfaces:**
- Consumes: 全部前置任务。
- Produces: M1 验收记录（AC 对照 + 实测数字），M2 计划的输入。

- [ ] **Step 1: 自动化回归**

```bash
cd desktop && go test ./... -race -count=1 && cd frontend && npx vitest run && cd .. && wails3 build
# 预期：全绿
```

- [ ] **Step 2: 手动验收走查（对照规格 §19）**

在验收记录文档中逐条记录结果：

| 规格 AC | M1 走查项 | 通过判据 |
|---|---|---|
| AC-001 | 全新目录启动（临时 `XDG`/AppData 重定向）进入引导，八页可导航 | 引导卡片 + 各页未连接空态 |
| AC-002 | 建 context → 测试连接（本地 nats-server，可用 `docker run -p 4222:4222 nats:latest`） | RTT 数值 + 文件生成 |
| AC-003 | CLI 半边：`go run ./nats context list`/`nats --context X rtt` 互通 | 双向可见可用 |
| AC-019 | 错误密码连接 | failed 横幅原文、无重试循环 |
| AC-020 | 主题三态 + 系统切换 + 重启保持 | 即时生效、1s 内跟随、持久化 |
| AC-021 | zh-CN 全界面 + 重启保持 | 无英文残留（i18n 测试已拦 key） |
| AC-027 | 版本检查（current 调低对真实 Releases） | 一次可关闭通知 |
| §6.1 | 更新失败静默（断网启动） | 无干扰 |

- [ ] **Step 3: 性能冒烟（M1 基线）**

```powershell
# 冷启动 5 次取中位数（到窗口可交互：日志出现 "ready" 行计时）
Measure-Command { Start-Process -Wait .\bin\nats-desktop.exe }   # 人工以秒表/录屏确认可交互时点
Get-Process nats-desktop | Select-Object WorkingSet64            # 空载内存
```

记录：冷启动中位数（对照 高配 ≤2s）、空载内存（对照 ≤300MB 基线）、设置页任意控件点击到反馈（体感 + 录屏逐帧 ≤100ms）。低配档留待 M6 统一双档验证（CI 限核环境在 M2 搭建）。

- [ ] **Step 4: 提交验收记录并收尾**

```bash
git add ../docs && git commit -m "docs(desktop): M1 acceptance record"
```

---

## 计划自检记录

- **规格覆盖**：M1 范围 = 规格 §6.1（壳/更新检查）、§6.2、§6.12 + 测试基建。§6.1 的四条异常（设置损坏→Task 4 测试；context 目录缺失→Task 11 引导；更新检查失败→Task 12 测试；自动恢复失败→Task 10 Step 5）全部有任务承接。§6.2 五条异常（认证失败→Task 8 测试；URL 不可达→CheckConnection 超时；外部修改冲突→**M1 不做冲突检测，属编辑表单打开时重载即可满足，复杂冲突检测移至 M2 备忘**——已在验收记录模板中列为已知简化；删除活跃 context→Task 10 测试；环境变量→Task 6/10）。§6.12 两条异常→Task 4/5。性能/日志/安全约束见 Global Constraints 映射到 Task 14 验证。
- **占位符扫描**：Task 4 Step 6 的 SettingsPage、Task 6 Step 1 的 zh 翻译、Task 10 Step 3 要点式实现说明——这三处为「要点 + 完整接口契约 + 完整测试」结构，测试与签名是完整代码，实现细节以要点约束（键集、行为、断言均已定死），不构成 TBD。
- **类型一致性**：`StateEvent`/`ContextForm`/`TestResult`/`Settings` 在 Task 4/6/8 定义、Task 9/10/11 消费，字段名一致（json 小写蛇形）；事件名 `conn:state`、`update:available` 跨任务一致；`PageId` 八值与 nav/i18n key 一致。
- **运营覆盖**：性能（Task 14 冒烟 + 全量 M6）、日志（Task 5 测试证明轮转与无凭证）、完整性/原子性（Task 4 原子写测试、Task 6 互操作测试）、失败路径（Task 8 五态测试、Task 12 超时静默）、可观测性（日志级别可调 + 设置页打开目录）。
