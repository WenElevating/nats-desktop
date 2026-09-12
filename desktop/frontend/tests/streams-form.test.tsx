import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { StreamsPage } from "../src/features/streams/StreamsPage";
import { ConfirmProvider } from "../src/lib/confirm";
import {
  CreateStream,
  GetStreamDetail,
  GetSettings,
  ListStreams,
} from "../src/lib/bindings";
import type { StreamDetail, StreamSummary } from "../src/lib/bindings";

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

const formFixture = (over: Record<string, unknown> = {}) => ({
  name: "ORDERS",
  description: "order events",
  subjects: ["orders.>"],
  storage: "file",
  retention: "limits",
  max_msgs: 0,
  max_bytes: -1,
  max_age_seconds: 3600,
  max_msgs_per_subject: 0,
  replicas: 1,
  placement_cluster: "",
  placement_tags: [],
  mirror: null,
  sources: [],
  ...over,
});

const detailFixture = (): StreamDetail =>
  ({
    error_code: "",
    error: "",
    summary: summary(),
    form: formFixture(),
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

// Real timers; flush pending microtasks/timers inside act.
const flush = async (ms = 10) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

beforeEach(() => {
  connState.state = "connected";
  vi.clearAllMocks();
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListStreams).mockResolvedValue(listOk([summary()]) as never);
  vi.mocked(GetStreamDetail).mockResolvedValue(detailFixture() as never);
  vi.mocked(CreateStream).mockResolvedValue({ error_code: "", error: "" } as never);
});

// ---- brief scenarios (streams-form.test.tsx 1–3) ----

it("create: empty subjects submit shows the inline zod error and never calls CreateStream; a legal submit sends the full explicit wire payload", async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  fireEvent.click(screen.getByTestId("streams-create"));
  await flush();
  expect(screen.getByTestId("stream-form")).toBeTruthy();

  // Name filled, subjects left empty.
  fireEvent.change(screen.getByTestId("stream-form-name"), {
    target: { value: "ORDERS2" },
  });
  fireEvent.click(screen.getByTestId("stream-form-submit"));
  await flush();

  expect(screen.getByTestId("stream-form-error-subjects").textContent).toMatch(
    /subject/i,
  );
  expect(CreateStream).not.toHaveBeenCalled();
  expect(screen.getByTestId("stream-form")).toBeTruthy(); // form stays open

  // Legal submit: one subject line.
  fireEvent.change(screen.getByTestId("stream-form-subjects"), {
    target: { value: "orders.>" },
  });
  fireEvent.click(screen.getByTestId("stream-form-submit"));
  await flush();

  expect(CreateStream).toHaveBeenCalledTimes(1);
  // The wire payload must carry EVERY field explicitly — 0 stays 0 and the
  // enums are explicit non-empty strings (Go zero-value constraint).
  expect(vi.mocked(CreateStream).mock.calls[0][0]).toEqual({
    name: "ORDERS2",
    description: "",
    subjects: ["orders.>"],
    storage: "file",
    retention: "limits",
    max_msgs: 0,
    max_bytes: 0,
    max_age_seconds: 0,
    max_msgs_per_subject: 0,
    replicas: 1,
    placement_cluster: "",
    placement_tags: [],
    mirror: null,
    sources: [],
  });
  // Success: form closes.
  expect(screen.queryByTestId("stream-form")).toBeNull();
});

it("edit prefills and disables the name; copy prefills everything but the name", async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  fireEvent.click(screen.getByTestId("stream-row-ORDERS"));
  await flush();
  expect(screen.getByTestId("stream-detail")).toBeTruthy();

  // Edit: full prefill, frozen name.
  fireEvent.click(screen.getByTestId("stream-op-edit"));
  await flush();
  const nameInput = screen.getByTestId("stream-form-name") as HTMLInputElement;
  expect(nameInput.value).toBe("ORDERS");
  expect(nameInput.disabled).toBe(true);
  expect(
    (screen.getByTestId("stream-form-subjects") as HTMLTextAreaElement).value,
  ).toBe("orders.>");
  expect(
    (screen.getByTestId("stream-form-max-bytes") as HTMLInputElement).value,
  ).toBe("-1");
  fireEvent.click(screen.getByTestId("stream-form-cancel"));

  // Copy: same prefill but the name is cleared for the operator to fill.
  fireEvent.click(screen.getByTestId("stream-op-copy"));
  await flush();
  const copyName = screen.getByTestId("stream-form-name") as HTMLInputElement;
  expect(copyName.value).toBe("");
  expect(copyName.disabled).toBe(false);
  expect(
    (screen.getByTestId("stream-form-subjects") as HTMLTextAreaElement).value,
  ).toBe("orders.>");
  expect(
    (screen.getByTestId("stream-form-max-bytes") as HTMLInputElement).value,
  ).toBe("-1");
});

it("server validation rejection renders the server原文 inline at the top of the form", async () => {
  vi.mocked(CreateStream).mockResolvedValue({
    error_code: "validation",
    error: "subjects overlap",
  } as never);

  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  fireEvent.click(screen.getByTestId("streams-create"));
  await flush();
  fireEvent.change(screen.getByTestId("stream-form-name"), {
    target: { value: "ORDERS2" },
  });
  fireEvent.change(screen.getByTestId("stream-form-subjects"), {
    target: { value: "orders.>" },
  });
  fireEvent.click(screen.getByTestId("stream-form-submit"));
  await flush();

  // Verbatim server text (spec §8.2.1), not translated.
  expect(screen.getByTestId("stream-form-server-error").textContent).toBe(
    "subjects overlap",
  );
  // The form stays open so the operator can fix the payload.
  expect(screen.getByTestId("stream-form")).toBeTruthy();
});
