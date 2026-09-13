import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { MonitoringPage } from "../src/features/monitoring/MonitoringPage";
import { ServerTable, GRID_COLS } from "../src/features/monitoring/ServerTable";
import {
  GetMonitoringSnapshot,
  GetSettings,
  StartMonitoring,
  StopMonitoring,
} from "../src/lib/bindings";

// Table + page shell suite: real i18n (en resources); mocked connstate
// (hoisted mutable), the Wails bindings, and @wailsio/runtime Events
// (handler capture) — the established M3+ test pattern.
const connState = vi.hoisted(() => ({
  state: "connected",
  context: "dev",
  rttMs: 5,
  reason: "",
}));

const runtime = vi.hoisted(() => ({
  handlers: new Map<string, (e: { data: unknown }) => void>(),
}));

vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: (name: string, cb: (e: { data: unknown }) => void) => {
      runtime.handlers.set(name, cb);
      return () => {
        runtime.handlers.delete(name);
      };
    },
  },
}));

vi.mock("../src/app/connstate", () => ({
  useConnState: () => connState,
}));

vi.mock("../src/lib/bindings", () => ({
  GetSettings: vi.fn(),
  StartMonitoring: vi.fn(),
  StopMonitoring: vi.fn(),
  GetMonitoringSnapshot: vi.fn(),
}));

// jsdom has no layout: the setup.ts ResizeObserver stub never reports a size,
// so @tanstack/react-virtual would measure a 0px viewport and render no rows.
// Report a 1024x280 border box on observe (280px / 28px rows = 10 visible).
class ResizeObserverFire {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(): void {
    this.cb(
      [{ borderBoxSize: [{ inlineSize: 1024, blockSize: 280 }] }] as unknown as ResizeObserverEntry[],
      this as unknown as ResizeObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverFire;

// ---- fixtures (MonitorSnapshot wire shape, Go internal/monitor/types.go) ----

const row = (over: Record<string, unknown> = {}) => ({
  name: "nats1",
  id: "id-1",
  host: "127.0.0.1:4222",
  cluster: "c1",
  domain: "",
  version: "2.10.0",
  online: true,
  offline_since_ms: 0,
  uptime_seconds: 120,
  cpu: 12.5,
  mem_bytes: 2048,
  cores: 4,
  connections: 3,
  total_connections: 30,
  routes: 0,
  gateways: 0,
  active_accounts: 1,
  slow_consumers: 0,
  js_enabled: true,
  js_role: "voter",
  js_streams: 2,
  js_streams_leader: 1,
  js_consumers: 4,
  js_memory_bytes: 0,
  js_store_bytes: 0,
  js_max_memory_bytes: -1,
  js_max_store_bytes: -1,
  error: "",
  ...over,
});

const threeServers = () => [
  row({ name: "nats-a", connections: 5, js_role: "meta_leader" }),
  row({ name: "nats-b", connections: 9, js_role: "voter" }),
  row({ name: "nats-c", connections: 1, js_enabled: false, js_role: "disabled" }),
];

const snapshot = (over: Record<string, unknown> = {}) => ({
  servers: threeServers(),
  sys_available: true,
  sys_reason: "",
  polled_at_ms: 4_200,
  cycle_ms: 20,
  rtt_ms: 3,
  poll_interval_seconds: 5,
  ...over,
});

const settingsFixture = () => ({
  appearance: { theme: "system", language: "en" },
  behavior: {
    poll_interval_seconds: 5,
    request_timeout_seconds: 5,
    confirm_level: "standard",
    session_push_batching: false,
    session_buffer_size: 10000,
    log_level: "info",
  },
  privacy: { crash_reports: false, update_check: true },
  last_active_context: "",
});

const ok = { error_code: "", error: "" };

// Drain useMonitor's queued start/stop ops (promise-chain serializer) plus
// the awaited reads inside each op — several microtask hops each.
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  });

const table = (servers: Record<string, unknown>[], polledAt = 4_200) =>
  render(
    <ServerTable
      snapshot={snapshot({ servers, polled_at_ms: polledAt }) as never}
      selected={null}
      onSelect={vi.fn()}
    />,
  );

const rowIds = () =>
  [...document.querySelectorAll('[data-testid^="monitor-row-"]')].map((el) =>
    el.getAttribute("data-testid"),
  );

beforeEach(() => {
  connState.state = "connected";
  vi.mocked(GetSettings).mockReset();
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(StartMonitoring).mockReset();
  vi.mocked(StartMonitoring).mockResolvedValue(ok as never);
  vi.mocked(StopMonitoring).mockReset();
  vi.mocked(StopMonitoring).mockResolvedValue(ok as never);
  vi.mocked(GetMonitoringSnapshot).mockReset();
  vi.mocked(GetMonitoringSnapshot).mockResolvedValue(snapshot() as never);
});

// ---- ServerTable ----

it("renders three rows with formatted columns and the polled-at anchor", () => {
  table(threeServers());

  expect(rowIds()).toHaveLength(3);
  const root = screen.getByTestId("monitor-table");
  expect(root.getAttribute("data-polled-at")).toBe("4200");

  const a = screen.getByTestId("monitor-row-nats-a");
  // Shared grid template between header and rows (StreamList 同款, §18.2).
  expect(a.className).toContain(GRID_COLS);
  expect(a.className).toContain("grid");
  expect(a.textContent).toContain("nats-a");
  expect(a.textContent).toContain("2.10.0"); // version
  expect(a.textContent).toContain("2m0s"); // uptime
  expect(a.textContent).toContain("12.5%"); // cpu, monospaced tabular
  expect(a.textContent).toContain("2.0 KiB"); // humanized memory
  expect(a.textContent).toContain("5"); // connections
  // meta_leader renders the highlighted role badge.
  expect(screen.getByTestId("monitor-role-leader").textContent).toBe("Meta leader");
  expect(screen.getByTestId("monitor-role-nats-b").textContent).toBe("Voter");
  expect(screen.getByTestId("monitor-role-nats-c").textContent).toBe("JS off");
});

it("marks the offline row: data-offline, red dot, error title, dimmed", () => {
  table([
    row(),
    row({ name: "nats-dead", online: false, error: "connection refused", cpu: 0, uptime_seconds: 0 }),
  ]);

  const dead = screen.getByTestId("monitor-row-nats-dead");
  expect(dead.getAttribute("data-offline")).toBe("true");
  expect(dead.getAttribute("title")).toBe("connection refused");
  expect(dead.querySelector('[data-testid="monitor-offline-dot"]')).toBeTruthy();
  expect(dead.className).toContain("opacity-");

  const live = screen.getByTestId("monitor-row-nats1");
  expect(live.getAttribute("data-offline")).toBe("false");
  expect(live.getAttribute("title")).toBeNull();
  expect(live.querySelector('[data-testid="monitor-online-dot"]')).toBeTruthy();
});

it("header click on connections toggles asc/desc row order", () => {
  table(threeServers());

  // Default: name ascending.
  expect(rowIds()).toEqual(["monitor-row-nats-a", "monitor-row-nats-b", "monitor-row-nats-c"]);

  fireEvent.click(screen.getByTestId("monitor-sort-connections"));
  expect(rowIds()).toEqual(["monitor-row-nats-c", "monitor-row-nats-a", "monitor-row-nats-b"]);
  expect(screen.getByTestId("monitor-col-connections").getAttribute("aria-sort")).toBe("ascending");

  // Second click on the same column flips to descending (asc/desc state machine).
  fireEvent.click(screen.getByTestId("monitor-sort-connections"));
  expect(rowIds()).toEqual(["monitor-row-nats-b", "monitor-row-nats-a", "monitor-row-nats-c"]);
  expect(screen.getByTestId("monitor-col-connections").getAttribute("aria-sort")).toBe("descending");
});

it("renders the empty-state guidance for a snapshot with no servers", () => {
  table([], 9_001);

  const empty = screen.getByTestId("monitor-table-empty");
  expect(empty.textContent).toContain("first poll");
  expect(rowIds()).toHaveLength(0);
});

it("reports row selection to onSelect", () => {
  const onSelect = vi.fn();
  render(
    <ServerTable
      snapshot={snapshot() as never}
      selected="nats-b"
      onSelect={onSelect}
    />,
  );

  expect(screen.getByTestId("monitor-row-nats-b").getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByTestId("monitor-row-nats-c"));
  expect(onSelect).toHaveBeenCalledWith("nats-c");
});

// ---- MonitoringPage shell ----

it("renders toolbar, degradation banner, and the table anchor", async () => {
  vi.mocked(GetMonitoringSnapshot).mockResolvedValue(
    snapshot({
      sys_available: false,
      sys_reason: "system account required",
      // Degraded frames carry no rows — Go emits the non-nil empty slice
      // ("servers":[]) on every sys_available=false path (final review I-1).
      servers: [],
    }) as never,
  );
  render(<MonitoringPage />);
  await flush();

  const page = screen.getByTestId("monitoring-page");
  expect(page.getAttribute("data-polled-at")).toBe("4200");

  // Toolbar: interval chip + pause/resume + refresh-now.
  expect(screen.getByTestId("monitor-interval").textContent).toBe("5s");
  expect(screen.getByTestId("monitor-pause").getAttribute("aria-label")).toBe("Pause");
  expect(screen.getByTestId("monitor-refresh")).toBeTruthy();

  // sys_available=false → ShieldOff banner with the expandable reason 原文.
  const banner = screen.getByTestId("monitor-no-permission");
  expect(banner.textContent).toContain("System account");
  expect(banner.textContent).toContain("system account required");

  // A degraded snapshot has no server rows → the empty-state guidance.
  expect(screen.getByTestId("monitor-table-empty")).toBeTruthy();

  // Task 11/12 tab placeholders below the table.
  for (const id of ["connections", "events", "accounts", "danger"]) {
    expect(screen.getByTestId(`monitor-tab-${id}`)).toBeTruthy();
  }
});

it("toolbar pause stops monitoring; refresh restarts for a fresh cycle", async () => {
  render(<MonitoringPage />);
  await flush();
  expect(StartMonitoring).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByTestId("monitor-refresh"));
  await flush();
  expect(StopMonitoring).toHaveBeenCalledTimes(1);
  expect(StartMonitoring).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByTestId("monitor-pause"));
  await flush();
  expect(StopMonitoring).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("monitor-pause").getAttribute("aria-label")).toBe("Resume");
  expect(screen.getByTestId("monitor-refresh").hasAttribute("disabled")).toBe(true);

  fireEvent.click(screen.getByTestId("monitor-pause"));
  await flush();
  expect(StartMonitoring).toHaveBeenCalledTimes(3);
});
