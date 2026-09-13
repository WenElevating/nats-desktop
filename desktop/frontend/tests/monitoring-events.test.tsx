import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { EventsPanel, EVENT_TYPES, EVENT_RING_CAPACITY, pushEvent, formatEventTime } from "../src/features/monitoring/EventsPanel";
import type { SysEvent, SysWatchEvent } from "../src/features/monitoring/EventsPanel";
import { CreateSysWatch, StopSysWatch } from "../src/lib/bindings";

// EventsPanel suite: real i18n (en resources); mocked connstate (hoisted
// mutable), @wailsio/runtime Events (sys:event handler capture), the Wails
// bindings and sonner — the established M3+ test pattern. Real timers: the
// regex debounce (400ms) is driven with plain sleeps.
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
  CreateSysWatch: vi.fn(),
  StopSysWatch: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";

// jsdom has no layout: the setup.ts ResizeObserver stub never reports a size,
// so @tanstack/react-virtual would measure a 0px viewport and render no rows.
// Report a 1024x280 border box on observe (like the streams/kv suites).
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

// ---- fixtures (SysWatchEvent wire shape, Go internal/monitor/types.go) ----

let watchCounter = 0;

const ev = (
  seq: number,
  over: Partial<SysEvent> = {},
  wrapper: Partial<SysWatchEvent> = {},
): SysWatchEvent => ({
  watch_id: `w${watchCounter}`,
  dropped_total: 0,
  filtered_total: 0,
  event: {
    seq,
    subject: `$SYS.ACCOUNT.APP.CONNECT.${seq}`,
    type: "account_connect",
    occurred_ms: 1_770_000_000_000 + seq,
    server_name: `nats-${seq}`,
    server_cluster: "c1",
    account: "APP",
    summary: `client ${seq} connected`,
    size_bytes: 120 * seq,
    ...over,
  },
  ...wrapper,
});

const flush = async (ms = 10) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const fire = (payload: unknown) =>
  act(() => {
    runtime.handlers.get("sys:event")?.({ data: payload });
  });

const rows = () =>
  [...document.querySelectorAll('[data-testid^="sys-event-row-"]')].map(
    (el) => el.getAttribute("data-testid"),
  );

const setup = async () => {
  const view = render(<EventsPanel />);
  await flush(); // watch create resolves
  return view;
};

beforeEach(() => {
  connState.state = "connected";
  watchCounter = 0;
  vi.clearAllMocks();
  vi.mocked(CreateSysWatch).mockImplementation(
    async () =>
      ({ error_code: "", error: "", watch_id: `w${++watchCounter}` }) as never,
  );
  vi.mocked(StopSysWatch).mockResolvedValue({ error_code: "", error: "" } as never);
});

// ---- watch lifecycle ----

it("creates one watch on mount with all five types and no regex, and stops it on unmount", async () => {
  const view = await setup();

  expect(CreateSysWatch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(CreateSysWatch).mock.calls[0][0]).toEqual({
    types: [...EVENT_TYPES],
    regex: "",
  });
  expect(StopSysWatch).not.toHaveBeenCalled();

  view.unmount();
  expect(StopSysWatch).toHaveBeenCalledTimes(1);
  expect(StopSysWatch).toHaveBeenCalledWith("w1");
});

it("renders events newest-first with time, type/server badges, account, summary, subject and size", async () => {
  await setup();

  fire(ev(1));
  fire(ev(2));
  fire(ev(3, { type: "js_advisory", account: "SYS", summary: "max payload exceeded" }));
  await flush();

  // Newest first.
  expect(rows()[0]).toBe("sys-event-row-3");
  expect(rows()).toEqual(["sys-event-row-3", "sys-event-row-2", "sys-event-row-1"]);

  const top = screen.getByTestId("sys-event-row-3");
  expect(top.textContent).toContain(formatEventTime(1_770_000_000_003));
  expect(top.textContent).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}/); // HH:mm:ss.SSS
  expect(top.textContent).toContain("js_advisory"); // type badge
  expect(top.textContent).toContain("nats-3"); // server badge
  expect(top.textContent).toContain("SYS · max payload exceeded"); // account + summary
  expect(top.textContent).toContain("$SYS.ACCOUNT.APP.CONNECT.3"); // subject mono
  expect(top.textContent).toContain("360"); // size bytes

  expect(screen.getByTestId("sys-event-total").textContent).toContain("3");
  // Virtualized: 200 rows never render in full.
  for (let i = 4; i <= 200; i++) fire(ev(i));
  await flush();
  expect(rows().length).toBeLessThan(100);
});

it("passes dropped_total/filtered_total through; the dropped chip flags non-zero drops", async () => {
  await setup();

  fire(ev(1, {}, { dropped_total: 7, filtered_total: 13 }));
  await flush();

  expect(screen.getByTestId("sys-event-dropped").textContent).toContain("7");
  expect(screen.getByTestId("sys-event-filtered").textContent).toContain("13");
  expect(screen.getByTestId("sys-event-dropped").getAttribute("data-variant")).toBe("destructive");

  fire(ev(2, {}, { dropped_total: 0, filtered_total: 0 }));
  await flush();
  expect(screen.getByTestId("sys-event-dropped").textContent).toContain("0");
});

it("a type-chip change stops the old watch before creating the new one", async () => {
  await setup();
  expect(CreateSysWatch).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByTestId("sys-event-type-js_metric"));
  await flush();

  expect(StopSysWatch).toHaveBeenCalledTimes(1);
  expect(StopSysWatch).toHaveBeenCalledWith("w1");
  expect(CreateSysWatch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(CreateSysWatch).mock.calls[1][0]).toEqual({
    types: EVENT_TYPES.filter((ty) => ty !== "js_metric"),
    regex: "",
  });
  // Stop(old) strictly precedes Create(new).
  const stopOrder = vi.mocked(StopSysWatch).mock.invocationCallOrder[0];
  const createOrder = vi.mocked(CreateSysWatch).mock.invocationCallOrder[1];
  expect(stopOrder).toBeLessThan(createOrder);
});

it("deselecting every type stops the watch; an empty set never rebuilds", async () => {
  await setup();

  // Shrinking 5 → 1 rebuilds on every change (type change → Stop → Create).
  for (const ty of EVENT_TYPES.slice(0, 4)) {
    fireEvent.click(screen.getByTestId(`sys-event-type-${ty}`));
    await flush();
  }
  expect(CreateSysWatch).toHaveBeenCalledTimes(5); // 1 initial + 4 rebuilds
  expect(StopSysWatch).toHaveBeenCalledTimes(4);
  expect(vi.mocked(CreateSysWatch).mock.calls[4][0]?.types).toEqual(["js_metric"]);

  // The final deselect empties the set: stop, no create, need-type hint.
  fireEvent.click(screen.getByTestId("sys-event-type-js_metric"));
  await flush();
  expect(StopSysWatch).toHaveBeenCalledTimes(5);
  expect(CreateSysWatch).toHaveBeenCalledTimes(5);
  expect(screen.getByText("Select at least one event type.")).toBeTruthy();

  // Re-selecting one type rebuilds the watch with just that type.
  fireEvent.click(screen.getByTestId("sys-event-type-auth_error"));
  await flush();
  expect(CreateSysWatch).toHaveBeenCalledTimes(6);
  expect(vi.mocked(CreateSysWatch).mock.calls[5][0]?.types).toEqual(["auth_error"]);
});

it("an invalid regex shows inline red text and does NOT rebuild the watch; a valid one rebuilds after the debounce", async () => {
  await setup();

  fireEvent.change(screen.getByTestId("sys-event-regex"), { target: { value: "(" } });
  await flush(450 + 50); // > 400ms debounce

  const err = screen.getByTestId("sys-event-regex-error");
  expect(err.textContent).toContain("Invalid regular expression");
  expect(err.textContent).toContain("(");
  expect(CreateSysWatch).toHaveBeenCalledTimes(1); // watch untouched
  expect(StopSysWatch).not.toHaveBeenCalled();

  // A valid pattern still rebuilds (Stop old → Create with the regex).
  fireEvent.change(screen.getByTestId("sys-event-regex"), { target: { value: "orders\\.>" } });
  await flush(450 + 50);

  expect(screen.queryByTestId("sys-event-regex-error")).toBeNull();
  expect(StopSysWatch).toHaveBeenCalledWith("w1");
  expect(CreateSysWatch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(CreateSysWatch).mock.calls[1][0]).toEqual({
    types: [...EVENT_TYPES],
    regex: "orders\\.>",
  });
});

it("the clear button empties the ring and resets the total (emit-side counters stay)", async () => {
  await setup();

  fire(ev(1, {}, { dropped_total: 4, filtered_total: 2 }));
  // Every payload carries the emit-side totals — ev(2) reports the same ones.
  fire(ev(2, {}, { dropped_total: 4, filtered_total: 2 }));
  await flush();
  expect(rows()).toHaveLength(2);

  fireEvent.click(screen.getByTestId("sys-event-clear"));
  await flush();

  expect(rows()).toHaveLength(0);
  expect(screen.getByTestId("sys-event-total").textContent).toContain("0");
  expect(screen.getByTestId("sys-event-empty")).toBeTruthy();
  // dropped/filtered are emit-side counters — a clear is local only.
  expect(screen.getByTestId("sys-event-dropped").textContent).toContain("4");
  expect(screen.getByTestId("sys-event-filtered").textContent).toContain("2");
});

it("ignores payloads from other/stale watch ids and toasts a failed create", async () => {
  const view = await setup();

  fire({ ...ev(1), watch_id: "w-other" });
  fire({ ...ev(2), watch_id: "" });
  fire(null);
  await flush();
  expect(rows()).toHaveLength(0);
  view.unmount();

  vi.clearAllMocks();
  vi.mocked(CreateSysWatch).mockResolvedValue({
    error_code: "validation",
    error: "types must not be empty",
  } as never);
  const view2 = render(<EventsPanel />);
  await flush();

  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("types must not be empty"),
  );
  view2.unmount();
});

// ---- ring helper (10k truncation, driven directly) ----

it("the ring caps at 10,000 entries with the newest first", () => {
  let ring: number[] = [];
  for (let i = 0; i <= EVENT_RING_CAPACITY; i++) {
    ring = pushEvent(ring, i);
  }
  expect(ring).toHaveLength(10_000);
  expect(ring[0]).toBe(10_000); // newest first
  expect(ring[9_999]).toBe(1); // oldest survivor
  // Below the cap it just prepends.
  expect(pushEvent([2, 1], 3)).toEqual([3, 2, 1]);
});
