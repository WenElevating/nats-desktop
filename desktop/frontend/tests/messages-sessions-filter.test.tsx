import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { SessionsPanel } from "../src/features/messages/SessionsPanel";
import type { MsgOut } from "../src/features/messages/useSessions";
import {
  CreateSession,
  ListSessions,
  GetSettings,
  type PushMode,
  type SessionState,
} from "../src/lib/bindings";
import { toBase64 } from "../src/lib/base64";

// Task 7 (会话 header 过滤, frontend half): the folded "Header filters" region
// submits header_filters on create (empty rows stripped, 8-row cap), the
// SessionView shows the filtered chip (missing field → 0), and creation stays
// gated on the live connection. Assertions match user-visible (interpolated)
// English text via the real i18n module; the bindings module is mocked so the
// create payload can be captured (same pattern as messages-sessions.test.tsx).
const connState = vi.hoisted(() => ({
  state: "connected",
  context: "dev",
  rttMs: 5,
  reason: "",
}));

const runtime = vi.hoisted(() => ({
  handlers: new Map<string, (e: { data: unknown }) => void>(),
}));

// jsdom has no layout: the setup.ts ResizeObserver stub never reports a size,
// so @tanstack/react-virtual would measure a 0px viewport and render nothing.
// Reports a 1024x280 border box so delivered-message rows actually mount.
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

// Data-plane capture: message batches arrive through the mocked msgChannel
// (useSessions connects after the DataChannel binding resolves), so the
// sanity test below fires onData directly.
const channel = vi.hoisted(() => ({
  onData: null as null | ((data: unknown) => void),
}));

vi.mock("../src/lib/msgChannel", () => ({
  connectMsgChannel: (_url: string, _token: string, onData: (data: unknown) => void) => {
    channel.onData = onData;
    return {
      close: () => {
        channel.onData = null;
      },
    };
  },
}));

vi.mock("../src/lib/bindings", () => ({
  PushMode: { PushRealtime: "realtime", PushBatch: "batch" },
  CreateSession: vi.fn(),
  DataChannel: async () => ({ url: "ws://127.0.0.1:1/messaging/data", token: "test-token" }),
  PauseSession: vi.fn(),
  ResumeSession: vi.fn(),
  ClearSession: vi.fn(),
  CloseSession: vi.fn(),
  ListSessions: vi.fn(),
  GetSettings: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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

// No `filtered` by default: older state events may omit the field entirely,
// which the chip must tolerate as 0.
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

const fireState = (st: SessionState) =>
  act(() => runtime.handlers.get("session:state")?.({ data: st }));

const filterRows = () => document.querySelectorAll('[data-testid="filter-row"]');

const addRow = () => fireEvent.click(screen.getByTestId("filter-add"));

/** Fills the n-th filter row (0-based) via its labeled key/value inputs. */
const fillRow = (n: number, key: string, value: string) => {
  fireEvent.change(screen.getAllByLabelText("Header")[n], { target: { value: key } });
  fireEvent.change(screen.getAllByLabelText("Value")[n], { target: { value } });
};

const fillSubject = (subject: string) =>
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: subject } });

const openFilters = () => fireEvent.click(screen.getByTestId("filters-toggle"));

beforeEach(() => {
  connState.state = "connected";
  runtime.handlers.clear();
  channel.onData = null;
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListSessions).mockResolvedValue(null as never);
  vi.mocked(CreateSession).mockResolvedValue(state({ id: "s-2", subject: "orders.>" }) as never);
});

// ---- (a) filter rows render and submit header_filters ----

it("submits header_filters from the filter rows, stripping empty rows", async () => {
  render(<SessionsPanel />);
  openFilters();
  addRow();
  fillRow(0, "Env", "prod");
  addRow(); // left empty → must not reach the wire
  fillSubject("orders.>");
  fireEvent.click(screen.getByTestId("session-create"));

  await waitFor(() => expect(CreateSession).toHaveBeenCalledTimes(1));
  expect(vi.mocked(CreateSession).mock.calls[0][0]).toEqual({
    subject: "orders.>",
    push_mode: "realtime",
    buffer_size: 0,
    js_position: undefined,
    header_filters: { Env: "prod" },
  });
});

it("omits header_filters entirely when no usable row is filled", async () => {
  render(<SessionsPanel />);
  openFilters();
  addRow(); // stays empty
  fillSubject("orders.>");
  fireEvent.click(screen.getByTestId("session-create"));

  await waitFor(() => expect(CreateSession).toHaveBeenCalledTimes(1));
  const spec = vi.mocked(CreateSession).mock.calls[0][0] as { header_filters?: unknown };
  expect(spec.header_filters).toBeUndefined();
});

it("keeps surviving rows intact when a row is removed (stable row identity)", async () => {
  render(<SessionsPanel />);
  openFilters();
  addRow();
  addRow();
  fillRow(0, "Env", "prod");
  fillRow(1, "Svc", "orders");

  fireEvent.click(screen.getAllByLabelText("Remove header")[0]);

  expect(filterRows()).toHaveLength(1);
  const keys = screen.getAllByLabelText("Header") as HTMLInputElement[];
  const values = screen.getAllByLabelText("Value") as HTMLInputElement[];
  expect(keys[0].value).toBe("Svc");
  expect(values[0].value).toBe("orders");

  fillSubject("orders.>");
  fireEvent.click(screen.getByTestId("session-create"));
  await waitFor(() => expect(CreateSession).toHaveBeenCalledTimes(1));
  expect(vi.mocked(CreateSession).mock.calls[0][0]).toEqual(
    expect.objectContaining({ header_filters: { Svc: "orders" } }),
  );
});

// ---- (b) 8-row cap ----

it("caps the filter region at 8 rows and disables further adds", () => {
  render(<SessionsPanel />);
  openFilters();
  for (let i = 0; i < 8; i++) addRow();

  expect(filterRows()).toHaveLength(8);
  const add = screen.getByTestId("filter-add") as HTMLButtonElement;
  expect(add.disabled).toBe(true);

  addRow(); // no-op at the cap (belt and braces behind the disabled state)
  expect(filterRows()).toHaveLength(8);
});

// ---- (c) SessionView filtered chip ----

it("renders the filtered chip and tolerates a missing filtered field", async () => {
  render(<SessionsPanel />);
  // First snapshot carries no `filtered` at all (older event shape): the chip
  // must show 0, never NaN/undefined.
  fireState(state({ total: 13 }));
  await screen.findByTestId("session-view");
  expect(screen.getByTestId("session-filtered").textContent).toContain("Filtered 0");

  fireState(state({ filtered: 7, total: 13 }));
  await waitFor(() =>
    expect(screen.getByTestId("session-filtered").textContent).toContain("Filtered 7"),
  );
});

// ---- (d) create gating on the live connection ----

it("disables creation while disconnected and revives it once connected", () => {
  connState.state = "disconnected";
  const { rerender } = render(<SessionsPanel />);

  const create = () => screen.getByTestId("session-create") as HTMLButtonElement;
  expect(create().disabled).toBe(true);
  expect((screen.getByLabelText("Subject") as HTMLInputElement).disabled).toBe(true);

  // M2 legacy §6-1 revival path: after the manager reconnects (state returns
  // to "connected") the form — including the create button — comes back.
  connState.state = "connected";
  rerender(<SessionsPanel />);
  fillSubject("orders.>");
  expect(create().disabled).toBe(false);
});

// Sanity: the msgs path itself is untouched by this task (session:msgs
// contract unchanged) — one batch still lands in the list.
it("still renders delivered session messages after the filter additions", async () => {
  render(<SessionsPanel />);
  fireState(state({ filtered: 1 }));
  await screen.findByTestId("session-view");

  act(() =>
    channel.onData?.([
      {
        session_id: "s-1",
        seq: 1,
        subject: "telemetry.a",
        payload_b64: toBase64("hit"),
        payload_size: 3,
        timestamp: "2026-01-01T00:00:00Z",
        is_utf8: true,
      } satisfies MsgOut,
    ]),
  );
  await waitFor(() =>
    expect(document.querySelectorAll('[data-testid="session-row"]').length).toBeGreaterThan(0),
  );
});
