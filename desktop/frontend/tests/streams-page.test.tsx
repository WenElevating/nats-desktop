import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreamsPage } from "../src/features/streams/StreamsPage";
import { ConfirmProvider } from "../src/lib/confirm";
import { GRID_COLS } from "../src/features/streams/StreamList";
import { ListStreams, GetStreamDetail, GetSettings } from "../src/lib/bindings";
import type { StreamDetail, StreamSummary } from "../src/lib/bindings";
import { toast } from "sonner";

// Scenario assertions match user-visible (interpolated) English text, so this
// file uses the real i18n module (en resources, synchronous init) like the
// messages suite. Mocked: the connection state (hoisted object mutated per
// test), the bindings surface, and sonner.
const connState = vi.hoisted(() => ({
  state: "connected",
  context: "dev",
  rttMs: 5,
  reason: "",
}));

vi.mock("../src/app/connstate", () => ({
  useConnState: () => connState,
}));

vi.mock("../src/lib/bindings", () => ({
  ListStreams: vi.fn(),
  GetStreamDetail: vi.fn(),
  GetSettings: vi.fn(),
  StreamStepDown: vi.fn(),
  StreamPeerRemove: vi.fn(),
  StreamBalance: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// jsdom has no layout: the setup.ts ResizeObserver stub never reports a size,
// so @tanstack/react-virtual would measure a 0px viewport and render nothing.
// Like the messages suite, report a 1024x280 border box on observe (280px /
// 28px rows = 10 visible + 2x8 overscan).
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

// ---- fixtures ----

const summary = (over: Partial<StreamSummary> = {}): StreamSummary => ({
  name: "ORDERS",
  description: "",
  internal_kind: "",
  subjects: ["orders.>"],
  storage: "file",
  retention: "limits",
  messages: 10,
  bytes: 2048,
  consumers: 1,
  first_seq: 1,
  last_seq: 100,
  last_time_ms: 1_770_000_000_000,
  lost_msgs: 0,
  lost_bytes: 0,
  num_deleted: 0,
  is_mirror: false,
  is_source: false,
  leader_missing: false,
  unhealthy_replicas: 0,
  replica_count: 1,
  ...over,
});

const baseList = (): StreamSummary[] => [
  summary({ name: "ORDERS" }),
  summary({
    name: "KV_BUCKETS",
    internal_kind: "kv",
    subjects: ["kv.>"],
    messages: 3,
    last_seq: 7,
  }),
  summary({
    name: "TELEMETRY",
    subjects: ["telemetry.#"],
    messages: 500,
    bytes: 5 * 1024 * 1024,
    consumers: 4,
    unhealthy_replicas: 2,
    replica_count: 3,
    last_seq: 42,
  }),
];

const detailFixture = (over: Partial<StreamSummary> = {}): StreamDetail =>
  ({
    error_code: "",
    error: "",
    summary: summary({ name: "ORDERS", ...over }),
    form: {},
    created_ms: 1_770_000_000_000,
    state: {
      first_time_ms: 1_770_000_000_000,
      last_time_ms: 1_770_000_060_000,
      num_subjects: 3,
    },
    mirror: null,
    sources: [],
    cluster: null,
  }) as unknown as StreamDetail;

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

const listOk = (streams: StreamSummary[]) => ({
  error_code: "",
  error: "",
  streams,
  unavailable_reason: "",
  // Leak B fix 2: ListStreamsResult carries the pre-cap survivor total and the
  // truncation marker (top-500, messages desc).
  total: streams.length,
  truncated: false,
});

// ---- harness ----

const flush = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const rows = () => document.querySelectorAll('[data-testid^="stream-row-"]');

const setVisibility = (v: string) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: v,
  });
};

beforeEach(() => {
  connState.state = "connected";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListStreams).mockReset();
  vi.mocked(ListStreams).mockResolvedValue(listOk(baseList()) as never);
  vi.mocked(GetStreamDetail).mockReset();
  vi.mocked(GetStreamDetail).mockResolvedValue(detailFixture() as never);
});

afterEach(() => {
  vi.useRealTimers();
  // Drop the visibilityState own-property override (jsdom's prototype getter
  // takes over again).
  Reflect.deleteProperty(document, "visibilityState");
});

// ---- the brief's six scenarios ----

it("renders the list (formatted columns) and fills the rate column after the second refresh", async () => {
  vi.mocked(ListStreams)
    .mockResolvedValueOnce(listOk(baseList()) as never)
    .mockResolvedValue(
      listOk([summary({ name: "ORDERS", last_seq: 350 })]) as never,
    );
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  // First frame: three streams, rate column shows the "—" placeholder.
  expect(rows()).toHaveLength(3);
  const row = screen.getByTestId("stream-row-ORDERS");
  expect(row.textContent).toContain("ORDERS");
  expect(row.textContent).toContain("orders.>");
  expect(row.textContent).toContain("10"); // messages
  expect(row.textContent).toContain("2.0 KiB"); // formatBytes (M2)
  expect(screen.getByTestId("stream-rate-ORDERS").textContent).toBe("—");

  // Second refresh 5s later: ΔLastSeq 250 over 5s → 50 msg/s.
  await flush(5_000);
  expect(screen.getByTestId("stream-rate-ORDERS").textContent).toContain(
    "50 msg/s",
  );
});

it("lays out header and virtual rows on one shared grid template", async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  // Review fix: the row must be a real grid container ("grid" class) and the
  // header row + virtual rows must reference the SAME column template
  // constant, so the two geometries can never drift. jsdom cannot resolve
  // Tailwind utilities to computed styles, so this is asserted at the
  // class/constant level. Also: no gap utility on the row — track-gap pixels
  // would desync it from the gap-free header.
  const row = screen.getByTestId("stream-row-ORDERS");
  expect(row.classList.contains("grid")).toBe(true);
  const header = document.querySelector(
    '[data-testid="streams-table-header"]',
  ) as HTMLElement | null;
  expect(header).toBeTruthy();
  expect(header?.className).toContain(GRID_COLS);
  expect(row.className).toContain(GRID_COLS);
  expect(row.className).not.toMatch(/(^|\s)gap-\S/);
});

it("marks the KV internal kind and unhealthy replicas", async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  expect(screen.getByTestId("stream-kind-KV_BUCKETS").textContent).toBe("KV");
  const tele = screen.getByTestId("stream-row-TELEMETRY");
  expect(tele.querySelector('[data-testid="stream-unhealthy"]')).toBeTruthy();
  expect(
    screen.getByTestId("stream-row-ORDERS").querySelector('[data-testid="stream-unhealthy"]'),
  ).toBeNull();
});

it("replaces the table with the unavailable guidance panel (never an empty table)", async () => {
  vi.mocked(ListStreams).mockResolvedValue({
    error_code: "js_unavailable",
    error: "nats: no responders available for request",
    streams: [],
    unavailable_reason: "no_responders",
  } as never);
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  const panel = screen.getByTestId("streams-unavailable");
  expect(panel.textContent).toContain("no responders");
  // Domain / api_prefix troubleshooting copy (spec §6.6).
  expect(panel.textContent).toContain("domain");
  expect(panel.textContent).toContain("API prefix");
  expect(document.querySelector('[data-testid="streams-table"]')).toBeNull();
  expect(rows()).toHaveLength(0);
});

it("filters streams by name or subject substring via the server round-trip", async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();
  expect(rows()).toHaveLength(3);

  // Filtering is server-side now: after the 300ms debounce the refetch must
  // carry the raw query, and the subset the server answers with is what
  // renders — there is no client-side matchStreams anymore.
  vi.mocked(ListStreams).mockResolvedValue(
    listOk([summary({ name: "TELEMETRY", subjects: ["telemetry.#"] })]) as never,
  );
  fireEvent.change(screen.getByLabelText("Search streams"), {
    target: { value: "telemetry" },
  });
  await flush(300);
  expect(ListStreams).toHaveBeenCalledWith("telemetry");
  await flush();
  expect(rows()).toHaveLength(1);
  expect(screen.getByTestId("stream-row-TELEMETRY")).toBeTruthy();
});

it("passes the filter box input to ListStreams (server-side filter)", async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();
  expect(screen.getByTestId("stream-row-ORDERS")).toBeTruthy();
  expect(ListStreams).toHaveBeenCalledWith("");

  // Typing only flips the debounced hook filter; the binding receives the
  // query (the unfiltered mock answer still renders all three rows).
  fireEvent.change(screen.getByLabelText("Search streams"), {
    target: { value: "orders" },
  });
  await flush(300);
  await flush();
  expect(ListStreams).toHaveBeenLastCalledWith("orders");
});

it("shows the truncation banner and slows polling while truncated", async () => {
  vi.mocked(ListStreams).mockResolvedValue({
    ...listOk([summary({ name: "cap-s-1", messages: 60 })]),
    total: 10000,
    truncated: true,
  } as never);
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  const banner = screen.getByTestId("streams-truncated-banner");
  expect(banner.textContent).toContain("Showing first 500 of 10000 streams");
  expect(banner.textContent).toContain("by message count");
  expect(rows()).toHaveLength(1);

  // While truncated the poll re-arms at 6× the base cadence: nothing lands at
  // 5s, the second tick arrives at 30s (and keeps the unfiltered query).
  await flush(5_000);
  expect(ListStreams).toHaveBeenCalledTimes(1);
  await flush(25_000);
  expect(ListStreams).toHaveBeenCalledTimes(2);
  expect(ListStreams).toHaveBeenLastCalledWith("");
});

it("polls the selected stream detail and switches the rate window", async () => {
  vi.mocked(GetStreamDetail)
    .mockResolvedValueOnce(detailFixture({ last_seq: 1000 }) as never)
    .mockResolvedValue(detailFixture({ last_seq: 1500 }) as never);
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  // Right pane shows the empty-state guidance before a selection.
  expect(screen.getByTestId("streams-detail-empty")).toBeTruthy();

  // ⑲: Space alone activates the focused row (Enter-only handler falsified).
  fireEvent.keyDown(screen.getByTestId("stream-row-ORDERS"), { key: " " });
  await flush();
  expect(GetStreamDetail).toHaveBeenCalledWith("ORDERS");
  expect(screen.getByTestId("stream-detail")).toBeTruthy();

  fireEvent.click(screen.getByTestId("stream-row-ORDERS"));
  await flush();
  expect(GetStreamDetail).toHaveBeenCalledTimes(1);
  expect(GetStreamDetail).toHaveBeenCalledWith("ORDERS");
  expect(screen.getByTestId("stream-detail")).toBeTruthy();
  for (const key of ["msgs", "bytes", "first", "last", "lost", "consumers", "deleted"]) {
    expect(screen.getByTestId(`stream-stat-${key}`)).toBeTruthy();
  }
  // First sample → rate not yet computable.
  expect(screen.getByTestId("stream-rate").textContent).toBe("—");

  // One poll interval later the second sample lands: Δ500 / 5s = 100 msg/s.
  await flush(5_000);
  expect(GetStreamDetail).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("stream-rate").textContent).toContain("100 msg/s");
  const title = document.querySelector('[data-testid="sparkline"] title');
  expect(title?.textContent).toContain("msg/s");

  // Window switch 5m / 15m / 1h.
  expect(screen.getByTestId("stream-window-5m").getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByTestId("stream-window-15m"));
  expect(screen.getByTestId("stream-window-15m").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("stream-window-5m").getAttribute("aria-pressed")).toBe("false");
});

it("detail not_found drops the stale selection once and refreshes — no per-tick toast", async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();
  fireEvent.click(screen.getByTestId("stream-row-ORDERS"));
  await flush();
  expect(screen.getByTestId("stream-detail")).toBeTruthy();

  // The stream is deleted externally: every subsequent detail answer is
  // not_found (§6.6, mirroring the useConsumers stale-selection semantics).
  vi.mocked(GetStreamDetail).mockResolvedValue({
    error_code: "not_found",
    error: "stream not found",
  } as never);
  vi.mocked(ListStreams).mockClear();
  vi.mocked(toast.error).mockClear();

  // First poll tick after the external delete: one not_found toast, the stale
  // selection is dropped (detail pane → empty state) and the list re-fetched
  // (the tick's own fetchList + the not_found refresh = 2 calls).
  await flush(5_000);
  expect(toast.error).toHaveBeenCalledTimes(1);
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("not found"));
  expect(screen.getByTestId("streams-detail-empty")).toBeTruthy();
  expect(ListStreams).toHaveBeenCalledTimes(2);

  // Second tick: no new toast, no detail re-fetch — the loop stopped tracking
  // the vanished stream.
  await flush(5_000);
  expect(toast.error).toHaveBeenCalledTimes(1);
  expect(GetStreamDetail).toHaveBeenCalledTimes(2); // initial + the not_found one
});

it("shows the connect banner and stops polling while disconnected", async () => {
  connState.state = "disconnected";
  const off = render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush(20_000);

  expect(screen.getByTestId("streams-not-connected")).toBeTruthy();
  expect(ListStreams).not.toHaveBeenCalled();
  off.unmount();

  // Transition: a live page stops polling (and clears) when the connection drops.
  connState.state = "connected";
  const live = render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();
  expect(ListStreams).toHaveBeenCalledTimes(1);
  expect(rows()).toHaveLength(3);
  connState.state = "disconnected";
  live.rerender(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush(20_000);
  expect(ListStreams).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("streams-not-connected")).toBeTruthy();
  expect(rows()).toHaveLength(0);
});

it("pauses polling while the document is hidden and resumes when visible", async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();
  expect(ListStreams).toHaveBeenCalledTimes(1);

  setVisibility("hidden");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush(20_000);
  expect(ListStreams).toHaveBeenCalledTimes(1);

  setVisibility("visible");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush();
  expect(ListStreams).toHaveBeenCalledTimes(2);
});

it("renders only the virtual window of a 10k-stream list", async () => {
  vi.mocked(ListStreams).mockResolvedValue(
    listOk(
      Array.from({ length: 10_000 }, (_, i) =>
        summary({ name: `S${i}`, last_seq: i }),
      ),
    ) as never,
  );
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  expect(rows().length).toBeGreaterThan(0);
  expect(rows().length).toBeLessThan(100);
});

// ---- cluster ops entry (M3 deferral, closed in Task 12) ----

const clusteredDetail = (): StreamDetail =>
  ({
    ...detailFixture(),
    cluster: {
      name: "c1",
      raft_group: "ORDERS",
      leader: "nats-a",
      leader_since_ms: 1_000,
      peers: [
        { name: "nats-a", current: true, offline: false, active_ms: 100, lag: 0 },
        { name: "nats-b", current: false, offline: false, active_ms: 100, lag: 0 },
      ],
    },
  }) as unknown as StreamDetail;

it("renders the cluster-ops row (three L2 entry buttons) only for clustered streams", async () => {
  vi.mocked(GetStreamDetail).mockResolvedValue(clusteredDetail() as never);
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();
  fireEvent.click(screen.getByTestId("stream-row-ORDERS"));
  await flush();

  expect(screen.getByTestId("stream-cluster-ops").textContent).toContain("Cluster ops");
  expect((screen.getByTestId("stream-cluster-stepdown") as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByTestId("stream-cluster-peer-remove") as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByTestId("stream-cluster-balance") as HTMLButtonElement).disabled).toBe(false);

  // Single-node stream (cluster === null): neither the cluster section nor the
  // ops row renders.
  vi.mocked(GetStreamDetail).mockResolvedValue(detailFixture() as never);
  fireEvent.click(screen.getByTestId("stream-row-KV_BUCKETS"));
  await flush();
  expect(screen.queryByTestId("stream-cluster-ops")).toBeNull();
  expect(screen.queryByTestId("stream-detail-cluster")).toBeNull();
});

it("a clustered stream without an observed leader keeps step-down disabled", async () => {
  const c = clusteredDetail();
  vi.mocked(GetStreamDetail).mockResolvedValue({
    ...c,
    cluster: { ...(c.cluster as object), leader: "" },
  } as never);
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();
  fireEvent.click(screen.getByTestId("stream-row-ORDERS"));
  await flush();

  expect((screen.getByTestId("stream-cluster-stepdown") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("stream-cluster-balance") as HTMLButtonElement).disabled).toBe(false);
});

it("peer remove opens the shared L2 dialog with the peer picker and calls StreamPeerRemove", async () => {
  const { StreamPeerRemove } = await import("../src/lib/bindings");
  vi.mocked(StreamPeerRemove).mockResolvedValue({
    error_code: "",
    error: "",
    old_leader: "",
    new_leader: "",
    streams_balanced: 0,
    note: "",
    elapsed_ms: 700,
  } as never);
  vi.mocked(GetStreamDetail).mockResolvedValue(clusteredDetail() as never);
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();
  fireEvent.click(screen.getByTestId("stream-row-ORDERS"));
  await flush();

  fireEvent.click(screen.getByTestId("stream-cluster-peer-remove"));
  await flush();

  const dialog = screen.getByTestId("danger-op-dialog");
  expect(dialog.getAttribute("data-op")).toBe("stream_peer_remove");
  // The picker defaults to the first non-leader peer; confirm stays gated on
  // the exact name.
  const select = screen.getByTestId("stream-cluster-peer") as HTMLSelectElement;
  expect(select.value).toBe("nats-b");
  expect((screen.getByTestId("danger-op-confirm") as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(screen.getByTestId("danger-op-input"), { target: { value: "nats-b" } });
  fireEvent.click(screen.getByTestId("danger-op-confirm"));
  await flush();

  expect(StreamPeerRemove).toHaveBeenCalledTimes(1);
  expect(StreamPeerRemove).toHaveBeenCalledWith("ORDERS", "nats-b");
  expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("nats-b"));
});
