import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { ConsumersPage } from "../src/features/consumers/ConsumersPage";
import { ConfirmProvider } from "../src/lib/confirm";
import {
  CopyConsumer,
  CreateConsumer,
  DeleteConsumer,
  GetConsumerDetail,
  GetSettings,
  ListConsumers,
  ListStreams,
  PauseConsumer,
  PreviewNext,
  ResetConsumer,
  ResumeConsumer,
  UpdateConsumer,
} from "../src/lib/bindings";
import type {
  ConsumerDetail,
  ConsumerSummary,
  StreamSummary,
} from "../src/lib/bindings";

// Real i18n (en resources, synchronous init) like the other suites; mocked:
// connstate (hoisted mutable), the Wails bindings, and sonner.
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
  ListConsumers: vi.fn(),
  GetConsumerDetail: vi.fn(),
  CreateConsumer: vi.fn(),
  UpdateConsumer: vi.fn(),
  CopyConsumer: vi.fn(),
  DeleteConsumer: vi.fn(),
  ResetConsumer: vi.fn(),
  PauseConsumer: vi.fn(),
  ResumeConsumer: vi.fn(),
  PreviewNext: vi.fn(),
  GetSettings: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";

// jsdom has no layout: report a fixed border box so the (plain, non-virtual)
// consumer list renders normally.
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

const stream = (name: string): StreamSummary =>
  ({
    name,
    description: "",
    internal_kind: "",
    subjects: [`${name.toLowerCase()}.>`],
    storage: "file",
    retention: "limits",
    messages: 10,
    bytes: 2048,
    consumers: 2,
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
  }) as unknown as StreamSummary;

const consumer = (over: Partial<ConsumerSummary> = {}): ConsumerSummary =>
  ({
    name: "C1",
    stream: "ORDERS",
    is_pull: true,
    is_ephemeral: false,
    ack_policy: "explicit",
    deliver_policy: "all",
    filter_subjects: [],
    num_pending: 12,
    num_ack_pending: 3,
    ack_floor_consumer: 40,
    num_redelivered: 2,
    num_waiting: 1,
    delivered_consumer_seq: 43,
    paused: false,
    pause_remaining_ms: 0,
    created_ms: 1_770_000_000_000,
    leader_missing: false,
    unhealthy_replicas: 0,
    replica_count: 1,
    ...over,
  }) as unknown as ConsumerSummary;

const baseConsumers = (): ConsumerSummary[] => [
  consumer(),
  consumer({
    name: "C2",
    is_pull: false,
    num_pending: 7,
    num_ack_pending: 9,
    ack_floor_consumer: 5,
    num_redelivered: 4,
    num_waiting: 0,
    paused: true,
    pause_remaining_ms: 600_000,
    unhealthy_replicas: 1,
    replica_count: 3,
  }),
];

const formFixture = (over: Record<string, unknown> = {}) => ({
  stream: "ORDERS",
  durable: "C1",
  description: "orders consumer",
  deliver_mode: "pull",
  deliver_subject: "",
  deliver_group: "",
  filter_subjects: ["orders.1"],
  ack_policy: "explicit",
  ack_wait_seconds: 30,
  max_deliver: 5,
  max_waiting: 8,
  max_ack_pending: 1024,
  max_request_batch: 25,
  max_request_expires_seconds: 120,
  max_request_max_bytes: 0,
  backoff_seconds: [30, 60],
  replay_policy: "instant",
  deliver_policy: "all",
  opt_start_seq: 0,
  opt_start_time_ms: 0,
  priority_groups: [],
  headers_only: false,
  replicas: 1,
  memory_storage: false,
  inactive_threshold_seconds: 300,
  ...over,
});

const detailFixture = (
  overSummary: Partial<ConsumerSummary> = {},
  overForm: Record<string, unknown> = {},
): ConsumerDetail =>
  ({
    error_code: "",
    error: "",
    summary: consumer(overSummary),
    form: formFixture(overForm),
    cluster: null,
  }) as unknown as ConsumerDetail;

const pausedDetail = () =>
  detailFixture({ paused: true, pause_remaining_ms: 90_000, delivered_consumer_seq: 20 });

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

const listOk = (consumers: ConsumerSummary[]) => ({
  error_code: "",
  error: "",
  consumers,
  unavailable_reason: "",
});

const ok = { error_code: "", error: "" };

const previewMsg = {
  seq: 5,
  subject: "orders.1",
  headers: { X_Test: ["1"] },
  payload_b64: "aGVsbG8=", // "hello"
  payload_size: 5,
  timestamp_ms: 1_770_000_000_000,
  is_utf8: true,
  truncated: false,
  num_delivered: 2,
  num_pending: 7,
};

// Real timers; flush pending microtasks/timers inside act.
const flush = async (ms = 10) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const rows = () => document.querySelectorAll('[data-testid^="consumer-row-"]');

// Mount the page (auto-selects the first stream) and select consumer C1 so the
// detail pane is on screen.
const setup = async () => {
  render(
    <ConfirmProvider>
      <ConsumersPage />
    </ConfirmProvider>,
  );
  await flush();
  expect(ListConsumers).toHaveBeenCalledWith("ORDERS");
  fireEvent.click(screen.getByTestId("consumer-row-C1"));
  await flush();
  expect(screen.getByTestId("consumer-detail")).toBeTruthy();
};

beforeEach(() => {
  connState.state = "connected";
  vi.clearAllMocks();
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListStreams).mockResolvedValue({
    error_code: "",
    error: "",
    streams: [stream("ORDERS"), stream("TELEMETRY")],
    unavailable_reason: "",
  } as never);
  vi.mocked(ListConsumers).mockResolvedValue(listOk(baseConsumers()) as never);
  vi.mocked(GetConsumerDetail).mockResolvedValue(detailFixture() as never);
  vi.mocked(CreateConsumer).mockResolvedValue(ok as never);
  vi.mocked(UpdateConsumer).mockResolvedValue(ok as never);
  vi.mocked(CopyConsumer).mockResolvedValue(ok as never);
  vi.mocked(DeleteConsumer).mockResolvedValue(ok as never);
  vi.mocked(ResetConsumer).mockResolvedValue(ok as never);
  vi.mocked(PauseConsumer).mockResolvedValue({
    ...ok,
    paused: true,
    until_ms: Date.now() + 60_000,
    remaining_ms: 60_000,
  } as never);
  vi.mocked(ResumeConsumer).mockResolvedValue(ok as never);
  vi.mocked(PreviewNext).mockResolvedValue({
    ...ok,
    messages: [previewMsg],
  } as never);
});

// ---- brief scenario 1: stream selector → ListConsumers, list columns, filter ----

it("feeds the selector from ListStreams, calls ListConsumers for the picked stream, and renders the filter + all list columns", async () => {
  render(
    <ConfirmProvider>
      <ConsumersPage />
    </ConfirmProvider>,
  );
  await flush();

  // The selector is populated from ListStreams; the first stream is picked
  // automatically and ListConsumers queried for it.
  const sel = screen.getByTestId("consumers-stream-select") as HTMLSelectElement;
  expect(sel.value).toBe("ORDERS");
  expect(ListConsumers).toHaveBeenCalledWith("ORDERS");

  // Switching the selector queries the new stream.
  fireEvent.change(sel, { target: { value: "TELEMETRY" } });
  await flush();
  expect(ListConsumers).toHaveBeenCalledWith("TELEMETRY");

  // Switch back, select C1, then switch streams again: the stale selection
  // must never leak into a GetConsumerDetail(newStream, oldConsumer) call.
  fireEvent.change(sel, { target: { value: "ORDERS" } });
  await flush();
  fireEvent.click(screen.getByTestId("consumer-row-C1"));
  await flush();
  expect(GetConsumerDetail).toHaveBeenCalledWith("ORDERS", "C1");
  fireEvent.change(sel, { target: { value: "TELEMETRY" } });
  await flush();
  for (const call of vi.mocked(GetConsumerDetail).mock.calls) {
    expect(call).not.toEqual(["TELEMETRY", "C1"]);
  }
  // The stale selection is dropped: the detail pane shows the empty state.
  expect(screen.getByTestId("consumers-detail-empty")).toBeTruthy();

  // Columns: name / type pull-push / pending / unacked / acked / redelivered /
  // waiting / paused badge / replicas.
  const c1 = screen.getByTestId("consumer-row-C1");
  expect(c1.textContent).toContain("C1");
  expect(c1.textContent).toContain("pull");
  expect(c1.textContent).toContain("12"); // pending
  expect(c1.textContent).toContain("3"); // unacked
  expect(c1.textContent).toContain("40"); // ack floor
  expect(c1.textContent).toContain("2"); // redelivered
  expect(c1.textContent).toContain("1"); // waiting
  expect(c1.textContent).toContain("1"); // replicas
  expect(c1.querySelector('[data-testid="consumer-paused-C1"]')).toBeNull();

  const c2 = screen.getByTestId("consumer-row-C2");
  expect(c2.textContent).toContain("push");
  expect(c2.querySelector('[data-testid="consumer-paused-C2"]')).toBeTruthy();

  // Name filter (client-side): substring match, empty-state message otherwise.
  fireEvent.change(screen.getByLabelText("Search consumers"), {
    target: { value: "c2" },
  });
  expect(rows()).toHaveLength(1);
  expect(screen.getByTestId("consumer-row-C2")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search consumers"), {
    target: { value: "zzz-no-match" },
  });
  expect(rows()).toHaveLength(0);
  expect(screen.getByTestId("consumers-list-empty")).toBeTruthy();
});

it("replaces the list with the unavailable guidance panel (never an empty list)", async () => {
  vi.mocked(ListConsumers).mockResolvedValue({
    error_code: "js_unavailable",
    error: "nats: no responders available for request",
    consumers: [],
    unavailable_reason: "no_responders",
  } as never);
  render(
    <ConfirmProvider>
      <ConsumersPage />
    </ConfirmProvider>,
  );
  await flush();

  const panel = screen.getByTestId("consumers-unavailable");
  expect(panel.textContent).toContain("no responders");
  expect(panel.textContent).toContain("domain");
  expect(panel.textContent).toContain("API prefix");
  expect(screen.queryByTestId("consumers-table")).toBeNull();
});

// ---- brief scenario 2: detail — stats, config echo, sparkline, pause card ----

it("renders detail stats + config echo; a paused consumer shows the formatted remaining time and disables preview; resume re-enables it", async () => {
  vi.mocked(GetConsumerDetail)
    .mockResolvedValueOnce(pausedDetail() as never)
    .mockResolvedValue(detailFixture({ delivered_consumer_seq: 1020 }) as never);
  await setup();

  // Stats grid.
  for (const key of ["pending", "ackPending", "ackFloor", "redelivered", "waiting", "delivered", "created"]) {
    expect(screen.getByTestId(`consumer-stat-${key}`)).toBeTruthy();
  }
  expect(screen.getByTestId("consumer-stat-pending").textContent).toContain("12");
  // Config echo.
  expect(screen.getByTestId("consumer-config-ack_policy").textContent).toContain("explicit");
  expect(screen.getByTestId("consumer-config-deliver_policy").textContent).toContain("all");
  expect(screen.getByTestId("consumer-config-filter_subjects").textContent).toContain("orders.1");
  // Rate sparkline + window switch (5m default, 15m/1h toggleable).
  expect(screen.getByTestId("consumer-rate")).toBeTruthy();
  expect(screen.getByTestId("sparkline")).toBeTruthy();
  expect(screen.getByTestId("consumer-window-5m").getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByTestId("consumer-window-15m"));
  expect(screen.getByTestId("consumer-window-15m").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("consumer-window-5m").getAttribute("aria-pressed")).toBe("false");

  // Paused: formatted remaining countdown + preview disabled everywhere (AC-012).
  expect(screen.getByTestId("consumer-pause-card")).toBeTruthy();
  expect(screen.getByTestId("consumer-pause-remaining").textContent).toContain("1m 30s");
  expect((screen.getByTestId("consumer-op-preview") as HTMLButtonElement).disabled).toBe(true);

  // Resume: binding called, detail refreshed unpaused → preview re-enabled and
  // the rate computable from the two delivered-seq samples (20 → 1020).
  fireEvent.click(screen.getByTestId("consumer-op-resume"));
  await flush();
  expect(ResumeConsumer).toHaveBeenCalledWith("ORDERS", "C1");
  expect(screen.queryByTestId("consumer-pause-remaining")).toBeNull();
  expect((screen.getByTestId("consumer-op-preview") as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByTestId("consumer-rate").textContent).toContain("msg/s");
});

// ---- brief scenario 3: create form — mode switch, conditional inputs, inline zod ----

it("form: push mode requires deliver_subject; deliver_policy toggles conditional inputs; out-of-bounds numerics are blocked inline without any binding call; a legal submit sends the explicit wire payload", async () => {
  render(
    <ConfirmProvider>
      <ConsumersPage />
    </ConfirmProvider>,
  );
  await flush();

  fireEvent.click(screen.getByTestId("consumers-create"));
  await flush();
  expect(screen.getByTestId("consumer-form")).toBeTruthy();

  // Fill the durable first so its error never muddies the assertions.
  fireEvent.change(screen.getByTestId("consumer-form-durable"), {
    target: { value: "C9" },
  });

  // pull is the default; switching to push reveals the required deliver_subject.
  const mode = screen.getByTestId("consumer-form-deliver-mode") as HTMLSelectElement;
  expect(mode.value).toBe("pull");
  expect(screen.queryByTestId("consumer-form-deliver-subject")).toBeNull();
  fireEvent.change(mode, { target: { value: "push" } });
  expect(screen.getByTestId("consumer-form-deliver-subject")).toBeTruthy();

  fireEvent.click(screen.getByTestId("consumer-form-submit"));
  await flush();
  expect(screen.getByTestId("consumer-form-error-deliver_subject").textContent).toMatch(
    /deliver subject/i,
  );
  expect(CreateConsumer).not.toHaveBeenCalled();

  // Back to pull: the subject input disappears.
  fireEvent.change(mode, { target: { value: "pull" } });
  expect(screen.queryByTestId("consumer-form-deliver-subject")).toBeNull();

  // deliver_policy closed set: start_sequence reveals a seq input with min=1;
  // start_time reveals a datetime-local input.
  const policy = screen.getByTestId("consumer-form-deliver-policy") as HTMLSelectElement;
  fireEvent.change(policy, { target: { value: "start_sequence" } });
  const seqInput = screen.getByTestId("consumer-form-opt-start-seq") as HTMLInputElement;
  expect(seqInput.getAttribute("min")).toBe("1");
  fireEvent.change(policy, { target: { value: "start_time" } });
  expect(
    (screen.getByTestId("consumer-form-opt-start-time") as HTMLInputElement).type,
  ).toBe("datetime-local");

  // Out-of-bounds values are intercepted inline — no request leaves (§6.7 row 3).
  fireEvent.change(screen.getByTestId("consumer-form-ack-wait"), {
    target: { value: "-5" },
  });
  fireEvent.click(screen.getByTestId("consumer-form-submit"));
  await flush();
  expect(screen.getByTestId("consumer-form-error-ack_wait_seconds").textContent).toMatch(
    /≥ 0/,
  );
  expect(screen.getByTestId("consumer-form-error-opt_start_time_ms").textContent).toMatch(
    /start time/i,
  );
  expect(CreateConsumer).not.toHaveBeenCalled();

  // Fix everything: legal submit sends the full explicit wire payload.
  fireEvent.change(policy, { target: { value: "all" } });
  fireEvent.change(screen.getByTestId("consumer-form-ack-wait"), {
    target: { value: "30" },
  });
  fireEvent.click(screen.getByTestId("consumer-form-submit"));
  await flush();

  expect(CreateConsumer).toHaveBeenCalledTimes(1);
  expect(vi.mocked(CreateConsumer).mock.calls[0][0]).toEqual({
    stream: "ORDERS",
    durable: "C9",
    description: "",
    deliver_mode: "pull",
    deliver_subject: "",
    deliver_group: "",
    filter_subjects: [],
    ack_policy: "explicit",
    ack_wait_seconds: 30,
    max_deliver: 0,
    max_waiting: 0,
    max_ack_pending: 0,
    max_request_batch: 0,
    max_request_expires_seconds: 0,
    max_request_max_bytes: 0,
    backoff_seconds: [],
    replay_policy: "instant",
    deliver_policy: "all",
    opt_start_seq: 0,
    opt_start_time_ms: 0,
    priority_groups: [],
    headers_only: false,
    replicas: 1,
    memory_storage: false,
    inactive_threshold_seconds: 0,
  });
  expect(screen.queryByTestId("consumer-form")).toBeNull();
});

it("form: edit disables the server-immutable fields (durable, deliver_policy, opt_start_*) but keeps max_waiting editable; copy prefills with a cleared name", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("consumer-op-edit"));
  await flush();
  expect(
    (screen.getByTestId("consumer-form-durable") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByTestId("consumer-form-deliver-policy") as HTMLSelectElement).disabled,
  ).toBe(true);
  expect(screen.queryByTestId("consumer-form-opt-start-seq")).toBeNull(); // hidden unless start_sequence
  expect(
    (screen.getByTestId("consumer-form-max-waiting") as HTMLInputElement).disabled,
  ).toBe(false);
  expect(
    (screen.getByTestId("consumer-form-ack-wait") as HTMLInputElement).value,
  ).toBe("30");
  fireEvent.click(screen.getByTestId("consumer-form-cancel"));

  fireEvent.click(screen.getByTestId("consumer-op-copy"));
  await flush();
  expect(
    (screen.getByTestId("consumer-form-durable") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (screen.getByTestId("consumer-form-durable") as HTMLInputElement).disabled,
  ).toBe(false);
  expect(
    (screen.getByTestId("consumer-form-filter-subjects") as HTMLTextAreaElement).value,
  ).toBe("orders.1");
});

// ---- brief scenario 4: pull preview — batch closed set, auto-ack, message cards ----

it("preview: default batch 10 + ack off → PreviewNext(stream, name, 10, false); message cards show headers/payload/seq/num_delivered; batch outside 1–256 is rejected locally; ack on sends autoAck=true", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("consumer-op-preview"));
  await flush();
  expect(screen.getByTestId("next-preview")).toBeTruthy();

  const batch = screen.getByTestId("next-preview-batch") as HTMLInputElement;
  expect(batch.value).toBe("10");
  const ack = screen.getByTestId("next-preview-autoack") as HTMLInputElement;
  expect(ack.checked).toBe(false);

  fireEvent.click(screen.getByTestId("next-preview-fetch"));
  await flush();
  expect(PreviewNext).toHaveBeenCalledWith("ORDERS", "C1", 10, false);

  // Message card: headers table + payload + seq + delivery counters.
  const card = screen.getByTestId(`next-msg-${previewMsg.seq}`);
  expect(card.textContent).toContain("orders.1");
  expect(card.textContent).toContain("2"); // num_delivered
  expect(card.textContent).toContain("7"); // num_pending
  expect(card.textContent).toContain("X_Test");
  expect(screen.getByTestId(`next-payload-${previewMsg.seq}`).textContent).toContain("hello");

  // Batch is a closed 1–256 set, enforced before the call.
  fireEvent.change(batch, { target: { value: "0" } });
  fireEvent.click(screen.getByTestId("next-preview-fetch"));
  await flush();
  expect(screen.getByTestId("next-preview-error").textContent).toMatch(/1 and 256/);
  fireEvent.change(batch, { target: { value: "300" } });
  fireEvent.click(screen.getByTestId("next-preview-fetch"));
  await flush();
  expect(PreviewNext).toHaveBeenCalledTimes(1);

  // ack switch on → autoAck=true payload.
  fireEvent.click(ack);
  fireEvent.change(batch, { target: { value: "256" } });
  fireEvent.click(screen.getByTestId("next-preview-fetch"));
  await flush();
  expect(PreviewNext).toHaveBeenCalledWith("ORDERS", "C1", 256, true);
});

// ---- brief scenario 5: reset/delete L1 confirms; not_found → toast + refresh ----

it("reset and delete go through a level-1 confirm (cancel never calls, confirm calls + refreshes); not_found toasts and refreshes", async () => {
  await setup();
  expect(ListConsumers).toHaveBeenCalledTimes(1);

  // Reset: L1 dialog, cancel keeps everything untouched.
  fireEvent.click(screen.getByTestId("consumer-op-reset"));
  await flush();
  expect(screen.getByRole("alertdialog").textContent).toContain("C1");
  expect(ResetConsumer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
  await flush();
  expect(ResetConsumer).not.toHaveBeenCalled();

  // Confirm: ResetConsumer(stream, name, 0) + refresh.
  fireEvent.click(screen.getByTestId("consumer-op-reset"));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
  await flush();
  expect(ResetConsumer).toHaveBeenCalledWith("ORDERS", "C1", 0);
  expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("C1"));
  expect(ListConsumers).toHaveBeenCalledTimes(2);

  // Delete: L1 as well (brief: delete 走 L1).
  fireEvent.click(screen.getByTestId("consumer-op-delete"));
  await flush();
  expect(DeleteConsumer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
  await flush();
  expect(DeleteConsumer).toHaveBeenCalledWith("ORDERS", "C1");
  expect(ListConsumers).toHaveBeenCalledTimes(3);

  // not_found: toast「资源不存在」+ refresh (§6.7 row 1). Relaxed level skips
  // the confirm so the failure path is direct.
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture("relaxed") as never);
  vi.mocked(DeleteConsumer).mockResolvedValue({
    error_code: "not_found",
    error: "consumer not found",
  } as never);
  // Re-select: the successful delete above dropped the selection.
  fireEvent.click(screen.getByTestId("consumer-row-C1"));
  await flush();
  const successCalls = vi.mocked(toast.success).mock.calls.length;
  fireEvent.click(screen.getByTestId("consumer-op-delete"));
  await flush();
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("not found"));
  // No NEW success toast for the failed delete (earlier ops already succeeded).
  expect(vi.mocked(toast.success).mock.calls.length).toBe(successCalls);
  // not_found refreshed the list: 1 setup + reset + delete + not_found.
  expect(ListConsumers).toHaveBeenCalledTimes(4);
});

// ---- brief scenario 6: old-server pause gate shows the error 原文 ----

it("pause on an old server: the validation 原文 from PauseConsumer is toasted verbatim", async () => {
  vi.mocked(PauseConsumer).mockResolvedValue({
    error_code: "validation",
    error: "requires NATS Server 2.11 or newer",
    paused: false,
    until_ms: 0,
    remaining_ms: 0,
  } as never);
  await setup();

  // Unpaused consumer: the pause card offers a duration + pause button.
  const seconds = screen.getByTestId("consumer-pause-seconds") as HTMLInputElement;
  expect(seconds.value).toBe("3600");
  fireEvent.click(screen.getByTestId("consumer-op-pause"));
  await flush();

  expect(PauseConsumer).toHaveBeenCalledWith("ORDERS", "C1", 3600);
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("NATS Server 2.11"),
  );
  expect(toast.success).not.toHaveBeenCalled();
  // Still unpaused: the pause card stays in its "paused=false" branch.
  expect(screen.getByTestId("consumer-pause-seconds")).toBeTruthy();
});
