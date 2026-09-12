import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { StreamsPage } from "../src/features/streams/StreamsPage";
import {
  DeleteStream,
  GetStreamDetail,
  GetSettings,
  ListStreams,
  PurgeStream,
  SealStream,
} from "../src/lib/bindings";
import { ConfirmProvider } from "../src/lib/confirm";
import type { StreamDetail, StreamSummary } from "../src/lib/bindings";

// Real i18n (en resources); mocked: connstate (hoisted mutable), the Wails
// bindings, and sonner (toast text assertions).
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
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";

// jsdom has no layout: the setup.ts ResizeObserver stub never reports a size,
// so @tanstack/react-virtual would measure a 0px viewport and render no rows.
// Report a 1024x280 border box on observe (like the streams-page suite).
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

const listOk = (streams: StreamSummary[]) => ({
  error_code: "",
  error: "",
  streams,
  unavailable_reason: "",
});

const ok = { error_code: "", error: "" };

// Real timers; flush pending microtasks/timers inside act.
const flush = async (ms = 10) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

// Mount the page inside the app-wide ConfirmProvider and select ORDERS so the
// detail pane (and its op buttons) is on screen. Returns the ListStreams mock.
const setup = async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();
  fireEvent.click(screen.getByTestId("stream-row-ORDERS"));
  await flush();
  expect(screen.getByTestId("stream-detail")).toBeTruthy();
};

beforeEach(() => {
  connState.state = "connected";
  vi.clearAllMocks();
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListStreams).mockResolvedValue(listOk([summary()]) as never);
  vi.mocked(GetStreamDetail).mockResolvedValue(detailFixture() as never);
  vi.mocked(PurgeStream).mockResolvedValue({ ...ok, purged: 5 } as never);
  vi.mocked(SealStream).mockResolvedValue(ok as never);
  vi.mocked(DeleteStream).mockResolvedValue(ok as never);
});

// ---- brief scenarios (streams-danger.test.tsx 1–5, AC-010) ----

it("purge at standard level: L1 confirm first — cancel never calls PurgeStream, confirm calls it and toasts the purged count + refreshes", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("stream-op-purge"));
  await flush();
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toContain("ORDERS");
  expect(PurgeStream).not.toHaveBeenCalled();

  // Cancel: no call.
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
  await flush();
  expect(PurgeStream).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();

  // Confirm: PurgeStream(name, keep=0, upToSeq=0, subject="") + count toast.
  fireEvent.click(screen.getByTestId("stream-op-purge"));
  await flush();
  fireEvent.click(
    screen.getByRole("button", { name: /confirm/i }),
  );
  await flush();

  expect(PurgeStream).toHaveBeenCalledTimes(1);
  expect(PurgeStream).toHaveBeenCalledWith("ORDERS", 0, 0, "");
  expect(toast.success).toHaveBeenCalledWith(
    expect.stringContaining("Purged 5"),
  );
  // Success triggers a list refresh (Global Constraint: 操作后刷新).
  expect(ListStreams).toHaveBeenCalledTimes(2);
});

it("purge at relaxed level executes immediately without any dialog", async () => {
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture("relaxed") as never);
  await setup();

  fireEvent.click(screen.getByTestId("stream-op-purge"));
  await flush();

  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(PurgeStream).toHaveBeenCalledTimes(1);
  expect(PurgeStream).toHaveBeenCalledWith("ORDERS", 0, 0, "");
});

it("delete: wrong name keeps the dialog and never calls DeleteStream; the exact name deletes and refreshes the list", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("stream-op-delete"));
  await flush();
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("ORDERS");

  // Wrong name: confirm stays disabled and clicking does nothing.
  const input = screen.getByLabelText("name-match-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "orders" } });
  const confirmBtn = screen.getByRole("button", { name: /confirm/i });
  expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(confirmBtn);
  await flush();
  expect(DeleteStream).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeNull(); // still open

  // Exact name: deletes, toasts, refreshes, and drops the deleted selection.
  fireEvent.change(input, { target: { value: "ORDERS" } });
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
  await flush();

  expect(DeleteStream).toHaveBeenCalledTimes(1);
  expect(DeleteStream).toHaveBeenCalledWith("ORDERS");
  expect(ListStreams).toHaveBeenCalledTimes(2);
  // Selection cleared → detail pane back to the empty state.
  expect(screen.getByTestId("streams-detail-empty")).toBeTruthy();
});

it("seal: one level-1 confirm, then SealStream", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("stream-op-seal"));
  await flush();
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(SealStream).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
  await flush();

  expect(SealStream).toHaveBeenCalledTimes(1);
  expect(SealStream).toHaveBeenCalledWith("ORDERS");
  expect(ListStreams).toHaveBeenCalledTimes(2);
});

it("a not_found failure toasts 资源不存在 and auto-refreshes the list", async () => {
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture("relaxed") as never);
  vi.mocked(PurgeStream).mockResolvedValue({
    error_code: "not_found",
    error: "stream not found",
    purged: 0,
  } as never);
  await setup();

  fireEvent.click(screen.getByTestId("stream-op-purge"));
  await flush();

  expect(PurgeStream).toHaveBeenCalledTimes(1);
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("not found"),
  );
  expect(toast.success).not.toHaveBeenCalled();
  // not_found also triggers a refresh (§6.7 semantics on the stream side).
  expect(ListStreams).toHaveBeenCalledTimes(2);
});
