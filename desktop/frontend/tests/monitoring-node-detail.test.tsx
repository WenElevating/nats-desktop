import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { NodeDetail } from "../src/features/monitoring/NodeDetail";
import { MonitoringPage } from "../src/features/monitoring/MonitoringPage";
import { ConfirmProvider } from "../src/lib/confirm";
import {
  GetMonitoringSnapshot,
  GetServerDetail,
  GetSettings,
  ListAccounts,
  ListServerConnections,
  StartMonitoring,
  StopMonitoring,
} from "../src/lib/bindings";

// NodeDetail suite: real i18n (en resources); mocked connstate (hoisted
// mutable) and the Wails bindings — the established M3+ test pattern
// (monitoring-server-table 同款).
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
  GetServerDetail: vi.fn(),
  ListServerConnections: vi.fn(),
  ListAccounts: vi.fn(),
}));

// jsdom has no layout: the setup.ts ResizeObserver stub never reports a size,
// so @tanstack/react-virtual would measure a 0px viewport and render no rows.
// Report a 1024x280 border box on observe (280px / 28px rows = 10 visible) —
// monitoring-server-table.test.tsx 同款.
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

// ---- fixtures (ServerDetail wire shape, Go internal/monitor/types.go) ----

const row = (over: Record<string, unknown> = {}) => ({
  name: "nats1",
  id: "id-1",
  host: "127.0.0.1:4222",
  cluster: "c1",
  domain: "",
  version: "2.10.0",
  online: true,
  offline_since_ms: 0,
  uptime_seconds: 90061, // 1d1h1m1s
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
  js_max_store_bytes: 1_073_741_824,
  error: "",
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  row: row(),
  start_ms: 1_770_000_000_000,
  leaf_nodes: 2,
  num_subs: 42,
  sent_msgs: 1_000_000,
  sent_bytes: 123_456_789,
  recv_msgs: 900_000,
  recv_bytes: 987_654_321,
  health_status: "ok",
  health_error: "",
  health_detail: "",
  ...over,
});

const ok = { error_code: "", error: "" };

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

const snapshot = () => ({
  servers: [row()],
  sys_available: true,
  sys_reason: "",
  polled_at_ms: 4_200,
  cycle_ms: 20,
  rtt_ms: 3,
  poll_interval_seconds: 5,
});

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

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
  vi.mocked(GetServerDetail).mockReset();
  vi.mocked(GetServerDetail).mockResolvedValue({ ...ok, detail: detail() } as never);
  vi.mocked(ListServerConnections).mockReset();
  vi.mocked(ListServerConnections).mockResolvedValue({
    ...ok,
    rows: [],
    offset: 0,
    limit: 20,
    total: 0,
  } as never);
  vi.mocked(ListAccounts).mockReset();
  vi.mocked(ListAccounts).mockResolvedValue({ ...ok, accounts: [] } as never);
});

// ---- NodeDetail ----

it("renders the varz stats, JS config, role badge, and the green health badge", async () => {
  render(<NodeDetail server="nats1" />);
  await flush();

  expect(GetServerDetail).toHaveBeenCalledWith("nats1");
  expect(screen.getByTestId("node-detail")).toBeTruthy();

  // Stats: cpu/mem/cores/subs/leaf/sent/recv/uptime/start (§18.2 numeric mono).
  expect(screen.getByTestId("node-stat-cpu").textContent).toContain("12.5%");
  expect(screen.getByTestId("node-stat-mem").textContent).toContain("2.0 KiB");
  expect(screen.getByTestId("node-stat-cores").textContent).toContain("4");
  expect(screen.getByTestId("node-stat-subs").textContent).toContain("42");
  expect(screen.getByTestId("node-stat-leaf").textContent).toContain("2");
  expect(screen.getByTestId("node-stat-sent-msgs").textContent).toContain("1,000,000");
  expect(screen.getByTestId("node-stat-sent-bytes").textContent).toContain("MiB");
  expect(screen.getByTestId("node-stat-recv-msgs").textContent).toContain("900,000");
  expect(screen.getByTestId("node-stat-recv-bytes").textContent).toContain("MiB");
  expect(screen.getByTestId("node-stat-uptime").textContent).toContain("1d1h");
  expect(screen.getByTestId("node-stat-start")).toBeTruthy();

  // JS config: role badge, streams/consumers, unlimited memory vs 1 GiB store.
  expect(screen.getByTestId("node-js").textContent).toContain("Voter");
  expect(screen.getByTestId("node-js").textContent).toContain("2");
  expect(screen.getByTestId("node-js").textContent).toContain("4");
  expect(screen.getByTestId("node-js").textContent).toContain("Unlimited");
  expect(screen.getByTestId("node-js").textContent).toContain("GiB");

  // healthz ok → green badge, no detail expander.
  expect(screen.getByTestId("node-health").getAttribute("data-status")).toBe("ok");
  expect(screen.queryByTestId("node-health-detail")).toBeNull();
});

it("renders the red health badge with the expandable health_detail 原文", async () => {
  vi.mocked(GetServerDetail).mockResolvedValue({
    ...ok,
    detail: detail({
      health_status: "error",
      health_error: "health check failed",
      health_detail: "RTT check: timeout after 2s",
    }),
  } as never);
  render(<NodeDetail server="nats1" />);
  await flush();

  expect(screen.getByTestId("node-health").getAttribute("data-status")).toBe("error");
  expect(screen.getByTestId("node-health").textContent).toContain("health check failed");
  const det = screen.getByTestId("node-health-detail");
  expect(det.textContent).toContain("RTT check: timeout after 2s");
});

it("hides a rejected report and shows the panel error card with the 原文", async () => {
  vi.mocked(GetServerDetail).mockResolvedValue({
    error_code: "server",
    error: "no permissions for $SYS.REQ.SERVER.PING VARZ",
    detail: null,
  } as never);
  render(<NodeDetail server="nats1" />);
  await flush();

  const err = screen.getByTestId("node-error");
  expect(err.textContent).toContain("no permissions for $SYS.REQ.SERVER.PING VARZ");
  // Global 3: the rejected report is hidden, the error card explains.
  expect(screen.queryByTestId("node-detail")).toBeNull();
});

it("the error card's retry button reuses the refresh entry and recovers the report", async () => {
  vi.mocked(GetServerDetail).mockResolvedValueOnce({
    error_code: "server",
    error: "request timed out",
    detail: null,
  } as never);
  render(<NodeDetail server="nats1" />);
  await flush();
  expect(screen.getByTestId("node-error")).toBeTruthy();

  // M6 Task 8 ㉓: the card offers a retry that drives the same load path.
  fireEvent.click(screen.getByTestId("node-error-retry"));
  await flush();
  await flush();

  expect(vi.mocked(GetServerDetail).mock.calls.length).toBe(2);
  expect(screen.queryByTestId("node-error")).toBeNull();
  expect(screen.getByTestId("node-detail")).toBeTruthy();
});

it("shows the empty hint without a selection and refetches when the selection changes", async () => {
  const view = render(<NodeDetail server={null} />);
  await flush();
  expect(screen.getByTestId("node-empty")).toBeTruthy();
  expect(GetServerDetail).not.toHaveBeenCalled();

  view.rerender(<NodeDetail server="nats-a" />);
  await flush();
  view.rerender(<NodeDetail server="nats-b" />);
  await flush();

  expect(vi.mocked(GetServerDetail).mock.calls.map((c) => c[0])).toEqual([
    "nats-a",
    "nats-b",
  ]);
  expect(screen.getByTestId("node-detail")).toBeTruthy();
});

// ---- MonitoringPage integration: the tab area hosts the panels ----

it("the page's tab area renders NodeDetail for the selected server and ConnectionsTop on demand", async () => {
  // The app shell hosts ConfirmProvider above every page (App.tsx); the
  // connections panel needs it for the kick L1 dialog.
  render(
    <ConfirmProvider>
      <MonitoringPage />
    </ConfirmProvider>,
  );
  await flush();

  // Default tab: node report, empty until a server is picked.
  expect(screen.getByTestId("monitor-tab-node")).toBeTruthy();
  expect(screen.getByTestId("node-empty")).toBeTruthy();

  // Selecting a row in the server table feeds the report panel.
  fireEvent.click(screen.getByTestId("monitor-row-nats1"));
  await flush();
  expect(GetServerDetail).toHaveBeenCalledWith("nats1");
  expect(screen.getByTestId("node-detail")).toBeTruthy();

  // Switching tabs mounts ConnectionsTop, which queries the same selection.
  fireEvent.click(screen.getByTestId("monitor-tab-connections"));
  await flush();
  expect(ListServerConnections).toHaveBeenCalledWith("nats1", "cid", 0, 20);
  expect(screen.getByTestId("conn-table")).toBeTruthy();

  // The accounts tab mounts AccountsPanel (cluster-wide, no selection needed).
  fireEvent.click(screen.getByTestId("monitor-tab-accounts"));
  await flush();
  expect(ListAccounts).toHaveBeenCalled();
  expect(screen.getByTestId("accounts-panel")).toBeTruthy();
});
