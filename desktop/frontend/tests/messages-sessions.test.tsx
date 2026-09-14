import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import { MessagesPage } from "../src/features/messages/MessagesPage";
import { SessionsPanel } from "../src/features/messages/SessionsPanel";
import type { MsgOut } from "../src/features/messages/useSessions";
import {
  CreateSession,
  ClearSession,
  CloseSession,
  ListSessions,
  PauseSession,
  ResumeSession,
  GetSettings,
  type PushMode,
  type SessionState,
} from "../src/lib/bindings";
import { toBase64, toBase64Bytes } from "../src/lib/base64";

// Scenario assertions match user-visible (interpolated) English text, so this
// file uses the real i18n module (en resources, synchronous init) like the
// publish suite. Mocked: @wailsio/runtime Events (handlers captured so tests
// can fire session:msgs / session:state), the bindings surface, sonner, and
// the connection state (hoisted `connState` mutated per test).
const connState = vi.hoisted(() => ({
  state: "connected",
  context: "dev",
  rttMs: 5,
  reason: "",
}));

// Event handler capture shared between the runtime mock and the fire helpers.
const runtime = vi.hoisted(() => ({
  handlers: new Map<string, (e: { data: unknown }) => void>(),
  offs: [] as string[],
}));

vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: (name: string, cb: (e: { data: unknown }) => void) => {
      runtime.handlers.set(name, cb);
      return () => {
        runtime.offs.push(name);
        runtime.handlers.delete(name);
      };
    },
  },
}));

vi.mock("../src/app/connstate", () => ({
  useConnState: () => connState,
}));

vi.mock("../src/lib/bindings", () => ({
  PushMode: { PushRealtime: "realtime", PushBatch: "batch" },
  CreateSession: vi.fn(),
  PauseSession: vi.fn(),
  ResumeSession: vi.fn(),
  ClearSession: vi.fn(),
  CloseSession: vi.fn(),
  ListSessions: vi.fn(),
  GetSettings: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// jsdom has no layout: the setup.ts ResizeObserver stub never reports a size,
// so @tanstack/react-virtual would measure a 0px viewport and render nothing.
// This replacement reports a 1024x280 border box on observe, giving the
// virtualizer a real window (280px / 28px rows = 10 visible + 2x8 overscan)
// so the virtualization assertions below are meaningful.
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

const state = (over: Partial<SessionState> = {}): SessionState => ({
  id: "s-1",
  subject: "telemetry.#",
  state: "running",
  push_mode: "realtime" as PushMode,
  rate_msg_s: 0,
  total: 0,
  dropped: 0,
  buffer_used: 0,
  ...over,
});

const msg = (seq: number, over: Partial<MsgOut> = {}): MsgOut => ({
  session_id: "s-1",
  seq,
  subject: "telemetry.a",
  payload_b64: toBase64(`m-${seq}`),
  payload_size: 3,
  timestamp: "2026-01-01T00:00:00Z",
  is_utf8: true,
  ...over,
});

const fireMsgs = (batch: MsgOut[]) =>
  act(() => runtime.handlers.get("session:msgs")?.({ data: batch }));

const fireState = (st: SessionState) =>
  act(() => runtime.handlers.get("session:state")?.({ data: st }));

const rows = () => document.querySelectorAll('[data-testid="session-row"]');

/** Renders the panel and materializes the default s-1 session over the state
 * event (the same path the Go manager uses), then waits for the view. */
const renderWithSession = async (over: Partial<SessionState> = {}) => {
  render(<SessionsPanel />);
  fireState(state(over));
  await screen.findByTestId("session-view");
};

beforeEach(() => {
  connState.state = "connected";
  runtime.handlers.clear();
  runtime.offs.length = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListSessions).mockResolvedValue(null as never);
  vi.mocked(CreateSession).mockResolvedValue(state({ id: "s-2", subject: "orders.>" }) as never);
  vi.mocked(PauseSession).mockResolvedValue(undefined as never);
  vi.mocked(ResumeSession).mockResolvedValue(undefined as never);
  vi.mocked(ClearSession).mockResolvedValue(undefined as never);
  vi.mocked(CloseSession).mockResolvedValue(undefined as never);
});

// ---- The brief's six scenarios ----

it("creates a session (realtime default from settings, core subscription) and shows it running", async () => {
  render(<SessionsPanel />);

  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "orders.>" } });
  fireEvent.click(screen.getByTestId("session-create"));

  await waitFor(() => expect(CreateSession).toHaveBeenCalledTimes(1));
  expect(vi.mocked(CreateSession).mock.calls[0][0]).toEqual({
    subject: "orders.>",
    push_mode: "realtime",
    buffer_size: 0,
    js_position: undefined,
  });

  const chip = await screen.findByTestId("session-chip-s-2");
  expect(chip.textContent).toContain("orders.>");
  expect(chip.querySelector('[data-state="running"]')).toBeTruthy();
});

it("builds the batch push mode and start_sequence JS position from the folded region", async () => {
  render(<SessionsPanel />);

  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "replay.>" } });
  fireEvent.click(screen.getByTestId("push-batch"));

  // The JS positioning region is folded by default; unfolding reveals the
  // five-way chooser and, for start_sequence, the sequence input.
  fireEvent.click(screen.getByTestId("js-position-toggle"));
  fireEvent.change(screen.getByTestId("js-position-mode"), { target: { value: "start_sequence" } });
  fireEvent.change(screen.getByTestId("js-start-seq"), { target: { value: "42" } });
  fireEvent.click(screen.getByTestId("session-create"));

  await waitFor(() => expect(CreateSession).toHaveBeenCalledTimes(1));
  const spec = vi.mocked(CreateSession).mock.calls[0][0];
  expect(spec.push_mode).toBe("batch");
  expect(spec.js_position).toEqual({ mode: "start_sequence", start_seq: 42 });
});

it("renders each single-message batch into the list and then only the virtual window", async () => {
  await renderWithSession();

  fireMsgs([msg(1)]);
  fireMsgs([msg(2)]);
  fireMsgs([msg(3)]);
  await waitFor(() => expect(rows()).toHaveLength(3));

  fireMsgs(Array.from({ length: 200 }, (_, i) => msg(i + 4)));
  await waitFor(() => {
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(200);
  });
});

it("refreshes rate/total/dropped from session:state and marks the paused state", async () => {
  await renderWithSession();

  fireState(state({ rate_msg_s: 42.5, total: 100, dropped: 3 }));
  // State events land via the Task 8 frame coalescer — poll for the fold.
  await waitFor(() =>
    expect(screen.getByTestId("session-chip-s-1").textContent).toContain("42.5 msg/s"),
  );
  expect(screen.getByTestId("session-chip-s-1").textContent).toContain("100 total");
  expect(screen.getByTestId("session-dropped").textContent).toContain("Dropped 3");

  fireState(state({ rate_msg_s: 42.5, total: 100, dropped: 3, state: "paused" }));
  await waitFor(() =>
    expect(screen.getByTestId("session-state").textContent).toContain("Paused"),
  );

  fireState(state({ dropped: 0 }));
  await waitFor(() => expect(screen.queryByTestId("session-dropped")).toBeNull());
});

it("shows the push-mode badge per mode in the status bar", async () => {
  await renderWithSession();
  expect(await screen.findByTestId("session-mode")).toBeTruthy();
  expect(screen.getByTestId("session-mode").textContent).toContain("Realtime");

  fireState(state({ push_mode: "batch" as PushMode }));
  await waitFor(() =>
    expect(screen.getByTestId("session-mode").textContent).toContain("Batch"),
  );

  fireState(state({ push_mode: "realtime" as PushMode }));
  await waitFor(() =>
    expect(screen.getByTestId("session-mode").textContent).toContain("Realtime"),
  );
});

it("pauses, resumes, clears and closes with immediate local feedback", async () => {
  await renderWithSession();
  fireMsgs([msg(1), msg(2)]);
  await waitFor(() => expect(rows()).toHaveLength(2));

  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(PauseSession).toHaveBeenCalledWith("s-1");
  // Optimistic: the status flips before any session:state event arrives.
  expect(screen.getByTestId("session-state").textContent).toContain("Paused");

  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(ResumeSession).toHaveBeenCalledWith("s-1");
  expect(screen.getByTestId("session-state").textContent).toContain("Running");

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(ClearSession).toHaveBeenCalledWith("s-1");
  expect(rows()).toHaveLength(0);
  expect(screen.getByTestId("msg-count").textContent).toContain("0");

  fireEvent.click(screen.getByRole("button", { name: "Close session" }));
  expect(CloseSession).toHaveBeenCalledWith("s-1");
  expect(screen.getByTestId("session-state").textContent).toContain("Closed");
});

it("shows binary rows as hex and offers the hex/text toggle plus a download", async () => {
  await renderWithSession();
  fireMsgs([
    msg(1, { is_utf8: false, payload_b64: toBase64Bytes(new Uint8Array([0x00, 0xff, 0x80])) }),
  ]);
  await waitFor(() => expect(rows()).toHaveLength(1));

  const row = rows()[0];
  expect(row.textContent).toContain("00ff80");

  fireEvent.click(row);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("00ff80")).toBeTruthy();

  fireEvent.click(within(dialog).getByRole("button", { name: "Text" }));
  expect(within(dialog).queryByText("00ff80")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Hex" }));
  expect(within(dialog).getByText("00ff80")).toBeTruthy();

  fireEvent.click(within(dialog).getByRole("button", { name: "Download" }));
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  const blob = createObjectURL.mock.calls[0][0] as Blob;
  expect(blob).toBeInstanceOf(Blob);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
});

it("expands the detail dialog with a headers table and a pretty-printed JSON payload", async () => {
  await renderWithSession();
  fireMsgs([
    msg(9, {
      headers: { "X-Test": ["v1", "v2"], "Content-Type": ["application/json"] },
      payload_b64: toBase64('{"b":1,"a":2}'),
    }),
  ]);
  await waitFor(() => expect(rows()).toHaveLength(1));

  fireEvent.click(rows()[0]);
  const dialog = await screen.findByRole("dialog");
  const headers = within(dialog).getByTestId("detail-headers");
  expect(headers.textContent).toContain("X-Test");
  expect(headers.textContent).toContain("v1, v2");
  expect(headers.textContent).toContain("Content-Type");

  const payload = within(dialog).getByTestId("detail-payload");
  expect(payload.textContent).toBe('{\n  "b": 1,\n  "a": 2\n}');
});

it("opens the row detail with Space as well as Enter (⑲)", async () => {
  await renderWithSession();
  fireMsgs([msg(1)]);
  await waitFor(() => expect(rows()).toHaveLength(1));

  fireEvent.keyDown(rows()[0], { key: " " });
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("m-1");

  // AC-022 Escape-close spot check: the radix Dialog closes on Escape and
  // focus returns to the row (the same dialog keyboard path the a11y
  // walkthrough exercises on the real app).
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

// ---- Task additions ----

it("disables creation with guidance while disconnected", () => {
  connState.state = "disconnected";
  render(<SessionsPanel />);

  const create = screen.getByTestId("session-create") as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  expect(screen.getByTestId("sessions-not-connected")).toBeTruthy();
});

it("caps the kept messages at the 10000 buffer and renders only the window", async () => {
  await renderWithSession();

  // 24 batched events x 500 msgs = 12000 total pushes; the hook must keep
  // only the newest 10000 (DEFAULT_BUFFER) and the virtualizer must render
  // just the visible window, never the full list.
  for (let b = 0; b < 24; b++) {
    fireMsgs(Array.from({ length: 500 }, (_, i) => msg(b * 500 + i + 1)));
  }
  await waitFor(() =>
    expect(screen.getByTestId("msg-count").textContent).toContain("10000"),
  );
  expect(rows().length).toBeGreaterThan(0);
  expect(rows().length).toBeLessThan(200);
});

it("hydrates existing sessions from ListSessions and selects the first", async () => {
  vi.mocked(ListSessions).mockResolvedValue([
    state({ id: "a", subject: "alpha.>" }),
    state({ id: "b", subject: "beta.>" }),
  ] as never);
  render(<SessionsPanel />);

  expect(await screen.findByTestId("session-chip-a")).toBeTruthy();
  expect(screen.getByTestId("session-chip-b")).toBeTruthy();
  expect(await screen.findByTestId("session-view")).toBeTruthy();
});

it("unsubscribes both events when the panel unmounts", () => {
  const { unmount } = render(<SessionsPanel />);
  expect(runtime.handlers.has("session:msgs")).toBe(true);
  expect(runtime.handlers.has("session:state")).toBe(true);

  unmount();
  expect(runtime.offs).toContain("session:msgs");
  expect(runtime.offs).toContain("session:state");
  expect(runtime.handlers.has("session:msgs")).toBe(false);
  expect(runtime.handlers.has("session:state")).toBe(false);
});

it("wires the sessions tab into the messages page (placeholder removed)", async () => {
  render(<MessagesPage />);
  await userEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  expect(await screen.findByTestId("sessions-panel")).toBeTruthy();
  expect(screen.queryByTestId("sessions-placeholder")).toBeNull();
});
