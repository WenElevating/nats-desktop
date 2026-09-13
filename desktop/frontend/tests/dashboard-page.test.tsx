import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { DashboardPage, aggregate, pickRtt } from "../src/features/dashboard/DashboardPage";
import {
  CreateSysWatch,
  GetMonitoringSnapshot,
  GetSettings,
  StartMonitoring,
  StopMonitoring,
  StopSysWatch,
} from "../src/lib/bindings";

// Dashboard overview suite: real i18n (en resources); mocked connstate
// (hoisted mutable), the Wails bindings, and @wailsio/runtime Events
// (handler capture) — the established M3+ test pattern (monitoring 同款).
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
  CreateSysWatch: vi.fn(),
  StopSysWatch: vi.fn(),
}));

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

// 3 servers / 2 online; JS memory 768 MiB of 2 GiB → 38%; JS store 4/8 GiB → 50%.
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const threeServers = () => [
  row({
    name: "nats-a",
    connections: 5,
    js_memory_bytes: 256 * MiB,
    js_max_memory_bytes: GiB,
    js_store_bytes: 2 * GiB,
    js_max_store_bytes: 4 * GiB,
  }),
  row({
    name: "nats-b",
    connections: 9,
    js_memory_bytes: 512 * MiB,
    js_max_memory_bytes: GiB,
    js_store_bytes: 2 * GiB,
    js_max_store_bytes: 4 * GiB,
  }),
  row({
    name: "nats-c",
    online: false,
    connections: 1,
    error: "connection refused",
    js_memory_bytes: 0,
    js_max_memory_bytes: -1, // unlimited → clamped out of the denominator
    js_store_bytes: 0,
    js_max_store_bytes: -1,
  }),
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

const ok = { error_code: "", error: "", watch_id: "w1" };

// Drain useMonitor's queued start/stop ops (promise-chain serializer, final
// review I-2) plus the awaited reads inside each op — several microtask hops.
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  });

beforeEach(() => {
  connState.state = "connected";
  connState.rttMs = 5;
  vi.mocked(GetSettings).mockReset();
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(StartMonitoring).mockReset();
  vi.mocked(StartMonitoring).mockResolvedValue(ok as never);
  vi.mocked(StopMonitoring).mockReset();
  vi.mocked(StopMonitoring).mockResolvedValue({ error_code: "", error: "" } as never);
  vi.mocked(GetMonitoringSnapshot).mockReset();
  vi.mocked(GetMonitoringSnapshot).mockResolvedValue(snapshot() as never);
  vi.mocked(CreateSysWatch).mockReset();
  vi.mocked(CreateSysWatch).mockResolvedValue(ok as never);
  vi.mocked(StopSysWatch).mockReset();
  vi.mocked(StopSysWatch).mockResolvedValue({ error_code: "", error: "" } as never);
});

// ---- pure helpers ----

it("aggregate sums online/connections and clamps unlimited (-1) JS maxima out of the ratios", () => {
  const a = aggregate(threeServers() as never);
  expect(a.online).toBe(2);
  expect(a.total).toBe(3);
  expect(a.offline).toBe(1);
  expect(a.connections).toBe(15);
  expect(a.jsMemRatio).toBeCloseTo(0.375, 6);
  expect(a.jsStoreRatio).toBeCloseTo(0.5, 6);
});

it("aggregate yields null ratios when the JS denominators are 0", () => {
  const servers = [
    row({ js_memory_bytes: 100, js_max_memory_bytes: 0, js_store_bytes: 5, js_max_store_bytes: 0 }),
  ];
  const a = aggregate(servers as never);
  expect(a.jsMemRatio).toBeNull();
  expect(a.jsStoreRatio).toBeNull();
});

it("pickRtt prefers the fresher snapshot sample and falls back to conn rtt", () => {
  expect(pickRtt(5, 3)).toBe(3); // snapshot polls every cycle → fresher
  expect(pickRtt(5, 0)).toBe(5); // no snapshot sample yet → conn state
  expect(pickRtt(0, 0)).toBeNull(); // not measured anywhere
});

// ---- page ----

it("renders the card group with the aggregated values", async () => {
  render(<DashboardPage onNavigate={vi.fn()} />);
  await flush();

  expect(screen.getByTestId("dash-servers-value").textContent).toBe("2/3");
  // Offline marker only appears when at least one server is down.
  const offline = screen.getByTestId("dash-servers-offline");
  expect(offline.textContent).toContain("1");
  expect(offline.className).toContain("danger");

  expect(screen.getByTestId("dash-connections-value").textContent).toBe("15");

  expect(screen.getByTestId("dash-js-memory-value").textContent).toBe("38%");
  expect(screen.getByTestId("dash-js-memory-bar").getAttribute("data-pct")).toBe("38");
  expect(screen.getByTestId("dash-js-store-value").textContent).toBe("50%");
  expect(screen.getByTestId("dash-js-store-bar").getAttribute("data-pct")).toBe("50");

  // Snapshot rtt_ms (fresh per cycle) wins over the conn:state sample.
  expect(screen.getByTestId("dash-rtt-value").textContent).toBe("3 ms");
});

it("renders '-' for the JS ratio cards when the denominator is 0", async () => {
  vi.mocked(GetMonitoringSnapshot).mockResolvedValue(
    snapshot({
      servers: [row({ js_max_memory_bytes: 0, js_max_store_bytes: 0 })],
    }) as never,
  );
  render(<DashboardPage onNavigate={vi.fn()} />);
  await flush();

  expect(screen.getByTestId("dash-js-memory-value").textContent).toBe("-");
  expect(screen.getByTestId("dash-js-store-value").textContent).toBe("-");
  expect(screen.queryByTestId("dash-js-memory-bar")).toBeNull();
  expect(screen.queryByTestId("dash-js-store-bar")).toBeNull();
});

it("hides the bar until the first snapshot lands", async () => {
  vi.mocked(GetMonitoringSnapshot).mockResolvedValue(null as never);
  render(<DashboardPage onNavigate={vi.fn()} />);
  await flush();

  expect(screen.getByTestId("dash-waiting")).toBeTruthy();
  expect(screen.queryByTestId("dash-cards")).toBeNull();
});

it("degradation replaces the card group and degrades the advisory list too", async () => {
  vi.mocked(GetMonitoringSnapshot).mockResolvedValue(
    snapshot({ sys_available: false, sys_reason: "system account required" }) as never,
  );
  render(<DashboardPage onNavigate={vi.fn()} />);
  await flush();

  const card = screen.getByTestId("dashboard-no-permission");
  expect(card.textContent).toContain("System account");
  expect(card.textContent).toContain("keeps working");
  expect(screen.queryByTestId("dash-cards")).toBeNull();

  // §6.5: 其余功能不受影响 — the advisory area degrades to the same copy.
  expect(screen.getByTestId("advisory-degraded")).toBeTruthy();
});

it("cards navigate: servers/connections/rtt → monitoring, JS cards → streams", async () => {
  const nav = vi.fn();
  render(<DashboardPage onNavigate={nav} />);
  await flush();

  fireEvent.click(screen.getByTestId("dash-card-servers"));
  fireEvent.click(screen.getByTestId("dash-card-connections"));
  fireEvent.click(screen.getByTestId("dash-card-rtt"));
  fireEvent.click(screen.getByTestId("dash-card-js-memory"));
  fireEvent.click(screen.getByTestId("dash-card-js-store"));

  expect(nav).toHaveBeenNthCalledWith(1, "monitoring");
  expect(nav).toHaveBeenNthCalledWith(2, "monitoring");
  expect(nav).toHaveBeenNthCalledWith(3, "monitoring");
  expect(nav).toHaveBeenNthCalledWith(4, "streams");
  expect(nav).toHaveBeenNthCalledWith(5, "streams");
});

it("mount starts the monitor loop; unmount stops it", async () => {
  const { unmount } = render(<DashboardPage onNavigate={vi.fn()} />);
  await flush();
  expect(StartMonitoring).toHaveBeenCalledTimes(1);
  unmount();
  await flush(); // the stop is queued now (I-2 serializer) — drain before asserting
  expect(StopMonitoring).toHaveBeenCalled();
});
