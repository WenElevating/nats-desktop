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

it("filters streams by name or subject substring", async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  const input = screen.getByLabelText("Search streams");
  fireEvent.change(input, { target: { value: "telemetry" } });
  expect(rows()).toHaveLength(1);
  expect(screen.getByTestId("stream-row-TELEMETRY")).toBeTruthy();

  fireEvent.change(input, { target: { value: "kv_buck" } });
  expect(rows()).toHaveLength(1);
  expect(screen.getByTestId("stream-row-KV_BUCKETS")).toBeTruthy();

  fireEvent.change(input, { target: { value: "zzz-no-match" } });
  expect(rows()).toHaveLength(0);
  expect(screen.getByTestId("streams-list-empty")).toBeTruthy();
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
