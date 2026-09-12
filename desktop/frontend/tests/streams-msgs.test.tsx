import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { computePrevStart, detectHoles, StreamMsgs } from "../src/features/streams/StreamMsgs";
import { StreamsPage } from "../src/features/streams/StreamsPage";
import {
  BrowseStream,
  GetStreamDetail,
  GetStreamMessage,
  GetSettings,
  ListStreams,
  RemoveStreamMessage,
} from "../src/lib/bindings";
import { ConfirmProvider } from "../src/lib/confirm";
import { toBase64, toBase64Bytes } from "../src/lib/base64";
import type { BrowserMsg, StreamDetail, StreamSummary } from "../src/lib/bindings";

// Real i18n (en resources); mocked: connstate (hoisted mutable), the Wails
// bindings, and sonner (toast assertions).
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
  CreateStream: vi.fn(),
  UpdateStream: vi.fn(),
  CopyStream: vi.fn(),
  DeleteStream: vi.fn(),
  PurgeStream: vi.fn(),
  SealStream: vi.fn(),
  BrowseStream: vi.fn(),
  GetStreamMessage: vi.fn(),
  RemoveStreamMessage: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// jsdom has no layout: the StreamsPage wiring test renders StreamList whose
// virtualizer needs a real border-box report to render any rows.
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

// jsdom does not implement Blob URLs; the download button needs both.
const createObjectURL = vi.fn(() => "blob:mock-url");
const revokeObjectURL = vi.fn();

// ---- fixtures ----

const msg = (seq: number, over: Partial<BrowserMsg> = {}): BrowserMsg => ({
  seq,
  subject: `ORDERS.new.${seq}`,
  headers: {},
  payload_b64: toBase64(`payload-${seq}`),
  payload_size: 10,
  timestamp_ms: 1_770_000_000_000 + seq * 1000,
  is_utf8: true,
  truncated: false,
  ...over,
});

const page = (msgs: BrowserMsg[], over: Record<string, unknown> = {}) => ({
  error_code: "",
  error: "",
  messages: msgs,
  next_start_seq: msgs.length > 0 ? msgs[msgs.length - 1].seq + 1 : 1,
  has_more: false,
  ...over,
});

const range = (from: number, to: number): BrowserMsg[] =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));

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

const detailFixture = (): StreamDetail =>
  ({
    error_code: "",
    error: "",
    summary: summary(),
    form: {
      name: "ORDERS",
      description: "",
      subjects: ["orders.>"],
      storage: "file",
      retention: "limits",
      max_msgs: 0,
      max_bytes: -1,
      max_age_seconds: 0,
      max_msgs_per_subject: 0,
      replicas: 1,
      placement_cluster: "",
      placement_tags: [],
      mirror: null,
      sources: [],
    },
    created_ms: 1_770_000_000_000,
    state: {
      first_time_ms: 1_770_000_000_000,
      last_time_ms: 1_770_000_060_000,
      num_subjects: 1,
    },
    mirror: null,
    sources: [],
    cluster: null,
  }) as unknown as StreamDetail;

const settingsFixture = (confirmLevel = "standard") => ({
  appearance: { theme: "system", language: "en" },
  behavior: {
    poll_interval_seconds: 5,
    request_timeout_seconds: 5,
    confirm_level: confirmLevel,
    session_push_batching: false,
    session_buffer_size: 10000,
    log_level: "info",
  },
  privacy: { crash_reports: false, update_check: true },
  last_active_context: "",
});

// Real timers; flush pending microtasks/timers inside act.
const flush = async (ms = 10) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

let onClose: ReturnType<typeof vi.fn>;

/** Mounts the browser panel inside the app-wide ConfirmProvider. */
const setup = async () => {
  onClose = vi.fn();
  render(
    <ConfirmProvider>
      <StreamMsgs stream="ORDERS" summary={{ firstSeq: 1, lastSeq: 100 }} onClose={onClose} />
    </ConfirmProvider>,
  );
  await flush();
};

beforeEach(() => {
  connState.state = "connected";
  vi.clearAllMocks();
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListStreams).mockResolvedValue({
    error_code: "",
    error: "",
    streams: [summary()],
    unavailable_reason: "",
  } as never);
  vi.mocked(GetStreamDetail).mockResolvedValue(detailFixture() as never);
  vi.mocked(GetStreamMessage).mockResolvedValue({ error_code: "", error: "", msg: null } as never);
  vi.mocked(RemoveStreamMessage).mockResolvedValue({ error_code: "", error: "" } as never);
  // Default answer: one full page 1..50, more available.
  vi.mocked(BrowseStream).mockResolvedValue(page(range(1, 50), { has_more: true }) as never);
});

// ---- pure functions (brief: 单测) ----

it("computePrevStart steps back a full page and clamps to the stream's first seq", () => {
  // Page starting at 45, page size 20 → prev start 25.
  expect(computePrevStart(range(45, 64), 20, 1)).toBe(25);
  // First page: clamped to firstSeq, never negative.
  expect(computePrevStart(range(1, 20), 20, 1)).toBe(1);
  expect(computePrevStart(range(10, 29), 20, 1)).toBe(1);
  // Purged stream (first_seq advanced): clamp to 100.
  expect(computePrevStart(range(110, 129), 20, 100)).toBe(100);
});

it("detectHoles lists the missing seqs between the page's first and last row", () => {
  const holes = detectHoles([1, 2, 4, 7].map((s) => msg(s)));
  expect(holes).toEqual([3, 5, 6]);
  expect(detectHoles(range(1, 5))).toEqual([]);
});

// ---- brief scenarios (streams-msgs.test.tsx 1–6, AC-029 / AC-009) ----

it("requests {start_seq:1, count:50} on open; next uses next_start_seq; prev/first/last/jump compute their starts", async () => {
  vi.mocked(BrowseStream)
    .mockResolvedValueOnce(page(range(1, 50), { has_more: true }) as never) // open
    .mockResolvedValueOnce(page(range(51, 100), { has_more: false }) as never) // next
    .mockResolvedValueOnce(page(range(1, 50), { has_more: true }) as never); // prev / first
  await setup();

  expect(BrowseStream).toHaveBeenLastCalledWith({
    stream: "ORDERS",
    start_seq: 1,
    count: 50,
    subject_filter: "",
  });

  // Next page: stateless, straight from the response's next_start_seq.
  fireEvent.click(screen.getByTestId("msgs-next"));
  await flush();
  expect(BrowseStream).toHaveBeenLastCalledWith({
    stream: "ORDERS",
    start_seq: 51,
    count: 50,
    subject_filter: "",
  });
  expect((screen.getByTestId("msgs-next") as HTMLButtonElement).disabled).toBe(true); // has_more=false

  // Prev page: computePrevStart = max(firstSeq, msgs[0].seq - pageSize) = max(1, 51-50).
  fireEvent.click(screen.getByTestId("msgs-prev"));
  await flush();
  expect(BrowseStream).toHaveBeenLastCalledWith({
    stream: "ORDERS",
    start_seq: 1,
    count: 50,
    subject_filter: "",
  });

  // Last page: max(firstSeq, lastSeq - pageSize + 1) = max(1, 100-50+1) = 51.
  fireEvent.click(screen.getByTestId("msgs-last"));
  await flush();
  expect(BrowseStream).toHaveBeenLastCalledWith(
    expect.objectContaining({ start_seq: 51 }),
  );

  // First page + jump-to-seq.
  fireEvent.click(screen.getByTestId("msgs-first"));
  await flush();
  expect(BrowseStream).toHaveBeenLastCalledWith(
    expect.objectContaining({ start_seq: 1 }),
  );
  fireEvent.change(screen.getByTestId("msgs-jump"), { target: { value: "60" } });
  fireEvent.click(screen.getByTestId("msgs-jump-go"));
  await flush();
  expect(BrowseStream).toHaveBeenLastCalledWith(
    expect.objectContaining({ start_seq: 60 }),
  );
});

it("page size is a closed 20/50/100/200 set and switching re-requests with the new count", async () => {
  await setup();

  const sel = screen.getByTestId("msgs-page-size");
  const opts = Array.from(sel.querySelectorAll("option")).map((o) => o.value);
  expect(opts).toEqual(["20", "50", "100", "200"]);

  fireEvent.change(sel, { target: { value: "20" } });
  await flush();
  expect(BrowseStream).toHaveBeenLastCalledWith({
    stream: "ORDERS",
    start_seq: 1,
    count: 20,
    subject_filter: "",
  });

  fireEvent.change(sel, { target: { value: "200" } });
  await flush();
  expect(BrowseStream).toHaveBeenLastCalledWith(
    expect.objectContaining({ count: 200 }),
  );
});

it("subject filter travels in the request and disables the prev button (stateless paging cannot reverse under filter)", async () => {
  await setup();
  expect((screen.getByTestId("msgs-prev") as HTMLButtonElement).disabled).toBe(false);

  fireEvent.change(screen.getByTestId("msgs-filter"), {
    target: { value: "orders.paid" },
  });
  fireEvent.click(screen.getByTestId("msgs-filter-apply"));
  await flush();

  expect(BrowseStream).toHaveBeenLastCalledWith({
    stream: "ORDERS",
    start_seq: 1,
    count: 50,
    subject_filter: "orders.paid",
  });
  expect((screen.getByTestId("msgs-prev") as HTMLButtonElement).disabled).toBe(true);
});

it("utf-8 rows render the page payload directly (no GetStreamMessage) with a headers table", async () => {
  vi.mocked(BrowseStream).mockResolvedValue(
    page([
      msg(9, {
        headers: { "X-Test": ["v1", "v2"], "Content-Type": ["application/json"] },
        payload_b64: toBase64('{"b":1,"a":2}'),
      }),
    ]) as never,
  );
  await setup();

  fireEvent.click(screen.getByTestId("msg-row-9"));
  await flush();

  expect(GetStreamMessage).not.toHaveBeenCalled();
  const headers = screen.getByTestId("msg-detail-headers");
  expect(headers.textContent).toContain("X-Test");
  expect(headers.textContent).toContain("v1, v2");
  expect(headers.textContent).toContain("Content-Type");
  const pre = screen.getByTestId("msg-detail-payload");
  expect(pre.textContent).toBe('{\n  "b": 1,\n  "a": 2\n}');
});

it("binary rows render a hex preview and a download button (b64 → Blob URL)", async () => {
  vi.mocked(BrowseStream).mockResolvedValue(
    page([
      msg(2, {
        is_utf8: false,
        payload_b64: toBase64Bytes(new Uint8Array([0x00, 0xff, 0x80])),
      }),
    ]) as never,
  );
  await setup();

  fireEvent.click(screen.getByTestId("msg-row-2"));
  await flush();

  expect(GetStreamMessage).not.toHaveBeenCalled();
  expect(screen.getByTestId("msg-detail-payload").textContent).toContain("00ff80");

  const btn = screen.getByTestId("msg-detail-payload-download");
  expect(btn.getAttribute("aria-label")).toBe("Download");
  fireEvent.click(btn);
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
});

it("truncated rows (>1MB) fetch the FULL payload through GetStreamMessage before rendering", async () => {
  vi.mocked(BrowseStream).mockResolvedValue(
    page([
      msg(3, { truncated: true, payload_b64: toBase64("PREVIEW"), payload_size: 2_000_000 }),
    ]) as never,
  );
  vi.mocked(GetStreamMessage).mockResolvedValue({
    error_code: "",
    error: "",
    msg: msg(3, { payload_b64: toBase64("FULL-PAYLOAD"), payload_size: 2_000_000 }),
  } as never);
  await setup();

  fireEvent.click(screen.getByTestId("msg-row-3"));
  await flush();

  expect(GetStreamMessage).toHaveBeenCalledTimes(1);
  expect(GetStreamMessage).toHaveBeenCalledWith("ORDERS", 3);
  expect(screen.getByTestId("msg-detail-payload").textContent).toContain("FULL-PAYLOAD");
  expect(screen.getByTestId("msg-detail-payload").textContent).not.toContain("PREVIEW");
});

it("delete asks the L1 confirm first, then RemoveStreamMessage + page refresh renders the hole marker", async () => {
  // Page 1..4 before delete; after the delete the refreshed page misses seq 2.
  vi.mocked(BrowseStream)
    .mockResolvedValueOnce(page(range(1, 4)) as never)
    .mockResolvedValue(page([msg(1), msg(3), msg(4)]) as never);
  await setup();

  fireEvent.click(screen.getByTestId("msg-row-2"));
  await flush();
  fireEvent.click(screen.getByTestId("msg-delete"));
  await flush();

  // Level-1 confirm gate: dialog first, no call yet.
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toContain("2");
  expect(RemoveStreamMessage).not.toHaveBeenCalled();

  // Cancel keeps everything intact.
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
  await flush();
  expect(RemoveStreamMessage).not.toHaveBeenCalled();

  // Confirm → RemoveStreamMessage + refresh of the current page.
  fireEvent.click(screen.getByTestId("msg-delete"));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
  await flush();

  expect(RemoveStreamMessage).toHaveBeenCalledTimes(1);
  expect(RemoveStreamMessage).toHaveBeenCalledWith("ORDERS", 2);
  // Refresh re-fetched the same page window.
  expect(BrowseStream).toHaveBeenLastCalledWith({
    stream: "ORDERS",
    start_seq: 1,
    count: 50,
    subject_filter: "",
  });
  // detectHoles renders the「已删除 seq 2」marker row.
  expect(screen.getByTestId("msg-hole").textContent).toContain("deleted seq 2");
});

it("empty pages show the empty state and pending loads show skeleton rows", async () => {
  vi.mocked(BrowseStream).mockResolvedValue(
    page([], { next_start_seq: 1, has_more: false }) as never,
  );
  await setup();
  expect(screen.getByTestId("msgs-empty")).toBeTruthy();

  // A never-resolving request keeps the skeleton on screen.
  vi.mocked(BrowseStream).mockReturnValue(new Promise(() => {}) as never);
  render(
    <ConfirmProvider>
      <StreamMsgs stream="TELEMETRY" summary={{ firstSeq: 1, lastSeq: 100 }} onClose={onClose} />
    </ConfirmProvider>,
  );
  expect(screen.getByTestId("msgs-loading")).toBeTruthy();
});

// ---- wiring: StreamDetail's Messages op opens the browser panel (Task 10 slot) ----

it("StreamsPage wires stream-op-messages to the browser panel and close returns to the detail pane", async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();
  fireEvent.click(screen.getByTestId("stream-row-ORDERS"));
  await flush();
  expect(screen.getByTestId("stream-detail")).toBeTruthy();
  expect(screen.queryByTestId("msgs-panel")).toBeNull();

  fireEvent.click(screen.getByTestId("stream-op-messages"));
  await flush();

  expect(screen.getByTestId("msgs-panel")).toBeTruthy();
  expect(screen.getByTestId("msgs-stream-name").textContent).toBe("ORDERS");
  expect(BrowseStream).toHaveBeenCalledWith({
    stream: "ORDERS",
    start_seq: 1,
    count: 50,
    subject_filter: "",
  });

  fireEvent.click(screen.getByTestId("msgs-close"));
  await flush();
  expect(screen.queryByTestId("msgs-panel")).toBeNull();
  expect(screen.getByTestId("stream-detail")).toBeTruthy();
});
