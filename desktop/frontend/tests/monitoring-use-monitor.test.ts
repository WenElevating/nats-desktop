import { renderHook, act } from "@testing-library/react";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMonitor } from "../src/features/monitoring/useMonitor";
import {
  GetMonitoringSnapshot,
  GetSettings,
  StartMonitoring,
  StopMonitoring,
} from "../src/lib/bindings";

// Hook-level suite: mocked connstate (hoisted mutable), the Wails bindings,
// and @wailsio/runtime Events (monitor:snapshot handler capture) — the
// established M3+ test pattern. No i18n needed (the hook never translates).
const connState = vi.hoisted(() => ({
  state: "connected",
  context: "dev",
  rttMs: 5,
  reason: "",
}));

// Event handler capture shared between the runtime mock and the fire helper.
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
  js_role: "meta_leader",
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

const snapshot = (over: Record<string, unknown> = {}) => ({
  servers: [row()],
  sys_available: true,
  sys_reason: "",
  polled_at_ms: 1_000,
  cycle_ms: 20,
  rtt_ms: 3,
  poll_interval_seconds: 5,
  ...over,
});

const settingsFixture = (poll: number) => ({
  appearance: { theme: "system", language: "en" },
  behavior: {
    poll_interval_seconds: poll,
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

// Drain the hook module's queued start/stop ops (promise-chain serializer)
// plus the awaited reads inside each op — several microtask hops each.
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  });

const fireSnapshot = (data: unknown) =>
  act(() => {
    runtime.handlers.get("monitor:snapshot")?.({ data });
  });

const setVisibility = (v: string) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: v,
  });
};

beforeEach(() => {
  connState.state = "connected";
  vi.mocked(GetSettings).mockReset();
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture(5) as never);
  vi.mocked(StartMonitoring).mockReset();
  vi.mocked(StartMonitoring).mockResolvedValue(ok as never);
  vi.mocked(StopMonitoring).mockReset();
  vi.mocked(StopMonitoring).mockResolvedValue(ok as never);
  vi.mocked(GetMonitoringSnapshot).mockReset();
  vi.mocked(GetMonitoringSnapshot).mockResolvedValue(snapshot() as never);
});

afterEach(async () => {
  // Drop the visibilityState own-property override (jsdom's prototype getter
  // takes over again).
  Reflect.deleteProperty(document, "visibilityState");
  // Drain the hook module's op queue so a lifecycle transition left pending
  // by this test cannot leak Start/Stop calls into the next test's counts.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
});

// ---- lifecycle ----

it("starts monitoring on mount and paints the initial GetMonitoringSnapshot frame", async () => {
  const { result } = renderHook(() => useMonitor());
  await flush();

  expect(StartMonitoring).toHaveBeenCalledTimes(1);
  expect(GetMonitoringSnapshot).toHaveBeenCalledTimes(1);
  expect(result.current.snapshot?.polled_at_ms).toBe(1_000);
  expect(result.current.snapshot?.servers).toHaveLength(1);
  expect(result.current.sysAvailable).toBe(true);
  expect(result.current.sysReason).toBe("");
});

it("applies monitor:snapshot events to the state", async () => {
  const { result } = renderHook(() => useMonitor());
  await flush();

  // Healthy frames carry the merged server rows.
  await fireSnapshot(
    snapshot({
      polled_at_ms: 2_000,
      servers: [row(), row({ name: "nats2", connections: 9 })],
    }),
  );

  expect(result.current.snapshot?.polled_at_ms).toBe(2_000);
  expect(result.current.snapshot?.servers).toHaveLength(2);
  expect(result.current.sysAvailable).toBe(true);
});

it("parses degraded event frames with servers null/[] (sys_available=false survives)", async () => {
  const { result } = renderHook(() => useMonitor());
  await flush();

  // "servers":null — the nil-slice JSON shape Go emitted on degraded paths
  // before the I-1 fix (legacy/zero-value frames still cross the wire this
  // way). The gate must land the frame as an empty table, not drop it.
  await fireSnapshot(
    snapshot({
      polled_at_ms: 2_000,
      servers: null,
      sys_available: false,
      sys_reason: "nats: insufficient system privileges",
    }),
  );
  expect(result.current.snapshot?.polled_at_ms).toBe(2_000);
  expect(result.current.snapshot?.servers).toHaveLength(0);
  expect(result.current.sysAvailable).toBe(false);
  expect(result.current.sysReason).toBe("nats: insufficient system privileges");

  // "servers":[] — the post-fix degraded wire shape (non-nil empty slice);
  // the per-cycle §8.3.1 reason keeps refreshing the banner.
  await fireSnapshot(
    snapshot({
      polled_at_ms: 3_000,
      servers: [],
      sys_available: false,
      sys_reason: "no responders on $SYS.A",
    }),
  );
  expect(result.current.snapshot?.polled_at_ms).toBe(3_000);
  expect(result.current.snapshot?.servers).toHaveLength(0);
  expect(result.current.sysAvailable).toBe(false);
  expect(result.current.sysReason).toBe("no responders on $SYS.A");
});

it("drops malformed event payloads", async () => {
  const { result } = renderHook(() => useMonitor());
  await flush();
  expect(result.current.snapshot?.polled_at_ms).toBe(1_000);

  await fireSnapshot({ nonsense: true });
  await fireSnapshot(
    snapshot({ servers: [{ no_name: true }, { name: "ok" }] }),
  );
  expect(result.current.snapshot?.polled_at_ms).toBe(1_000);
});

it("stops monitoring when the connection drops and clears the snapshot", async () => {
  const view = renderHook(() => useMonitor());
  await flush();
  expect(StopMonitoring).not.toHaveBeenCalled();

  // Mutate the hoisted conn state and re-render: the derived `connected`
  // boolean flips so the gate effect re-syncs.
  connState.state = "disconnected";
  view.rerender();
  await flush();

  expect(StopMonitoring).toHaveBeenCalledTimes(1);
  expect(view.result.current.snapshot).toBeNull();
});

it("stops on hidden and restarts with the visible resume", async () => {
  const { result } = renderHook(() => useMonitor());
  await flush();
  expect(StartMonitoring).toHaveBeenCalledTimes(1);

  setVisibility("hidden");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush();
  expect(StopMonitoring).toHaveBeenCalledTimes(1);
  // Paused by visibility keeps the last frame (no stale-live confusion: the
  // loop is stopped, the data stays for the immediate repaint on return).
  expect(result.current.snapshot?.polled_at_ms).toBe(1_000);

  setVisibility("visible");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush();
  expect(StartMonitoring).toHaveBeenCalledTimes(2);
});

it("stops monitoring while paused and restarts on resume", async () => {
  const { result } = renderHook(() => useMonitor());
  await flush();

  act(() => {
    result.current.setPaused(true);
  });
  await flush();
  expect(StopMonitoring).toHaveBeenCalledTimes(1);

  act(() => {
    result.current.setPaused(false);
  });
  await flush();
  expect(StartMonitoring).toHaveBeenCalledTimes(2);
});

it("stops monitoring on unmount", async () => {
  const { unmount } = renderHook(() => useMonitor());
  await flush();
  vi.mocked(StopMonitoring).mockClear();

  unmount();
  await flush(); // the stop is queued now — drain it before asserting
  expect(StopMonitoring).toHaveBeenCalledTimes(1);
});

it("page-switch stop/start inversion drains to a started loop for the new page", async () => {
  // Page A mounts and starts the shared Go poller.
  const a = renderHook(() => useMonitor());
  await flush();
  expect(StartMonitoring).toHaveBeenCalledTimes(1);

  // Page switch: A's unmount enqueues the stop, B's mount enqueues the
  // start — the exact pair that raced inside Go at the IPC layer (final
  // review I-2).
  a.unmount();
  const b = renderHook(() => useMonitor());
  await flush();

  // A's stale stop elided (its intent no longer matches the desired state B
  // mounted with) and the loop is up for B.
  expect(StopMonitoring).not.toHaveBeenCalled();
  expect(StartMonitoring).toHaveBeenCalledTimes(2);

  // B is live: snapshot events still reach the freshly mounted page.
  await fireSnapshot(snapshot({ polled_at_ms: 9_000 }));
  expect(b.result.current.snapshot?.polled_at_ms).toBe(9_000);

  // B's final unmount is the last intent — its stop must land.
  b.unmount();
  await flush();
  expect(StopMonitoring).toHaveBeenCalledTimes(1);
});

it("refreshNow restarts the Go loop for an immediate fresh cycle", async () => {
  const { result } = renderHook(() => useMonitor());
  await flush();
  expect(StartMonitoring).toHaveBeenCalledTimes(1);

  await act(async () => {
    await result.current.refreshNow();
  });
  expect(StopMonitoring).toHaveBeenCalledTimes(1);
  expect(StartMonitoring).toHaveBeenCalledTimes(2);
});

it("refreshNow is a no-op while paused", async () => {
  const { result } = renderHook(() => useMonitor());
  await flush();
  act(() => {
    result.current.setPaused(true);
  });
  await flush();
  vi.mocked(StartMonitoring).mockClear();
  vi.mocked(StopMonitoring).mockClear();

  await act(async () => {
    await result.current.refreshNow();
  });
  expect(StartMonitoring).not.toHaveBeenCalled();
  expect(StopMonitoring).not.toHaveBeenCalled();
});

// ---- additive surface ----

it("shows the settings cadence and refines it from the snapshot", async () => {
  // Real startup: the initial cache read is the zero-value snapshot (loop not
  // running yet, poll_interval_seconds 0 → no refinement), so the settings
  // value stands until the first event reports the Go-clamped cadence.
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture(10) as never);
  vi.mocked(GetMonitoringSnapshot).mockResolvedValue(
    snapshot({ poll_interval_seconds: 0 }) as never,
  );
  const { result } = renderHook(() => useMonitor());
  await flush();
  expect(result.current.intervalSeconds).toBe(10);

  // Go clamps 2..60 and reports the effective cadence per snapshot.
  await fireSnapshot(snapshot({ poll_interval_seconds: 2 }));
  expect(result.current.intervalSeconds).toBe(2);
});

it("tracks the selected server name", async () => {
  const { result } = renderHook(() => useMonitor());
  await flush();
  expect(result.current.selected).toBeNull();

  act(() => {
    result.current.setSelected("nats1");
  });
  expect(result.current.selected).toBe("nats1");

  act(() => {
    result.current.setSelected(null);
  });
  expect(result.current.selected).toBeNull();
});
