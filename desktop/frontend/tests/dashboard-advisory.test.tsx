import { render, screen, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { Events } from "@wailsio/runtime";
import {
  AdvisoryList,
  ADVISORY_TYPES,
  ADVISORY_RING_CAPACITY,
  pushAdvisory,
} from "../src/features/dashboard/AdvisoryList";
import { pushEvent, type SysWatchEvent } from "../src/features/monitoring/EventsPanel";
import { CreateSysWatch, StopSysWatch } from "../src/lib/bindings";

// Advisory list suite: real i18n (en resources); mocked connstate (hoisted
// mutable), Wails bindings, and @wailsio/runtime Events (handler capture) —
// the established M3+ test pattern (monitoring-events 同款).
const connState = vi.hoisted(() => ({
  state: "connected",
  context: "dev",
  rttMs: 5,
  reason: "",
}));

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

const ok = { error_code: "", error: "", watch_id: "w1" };

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const fireSysEvent = (data: unknown) =>
  act(() => {
    const h = runtime.handlers.get("sys:event");
    if (h) h({ data });
  });

/** SysWatchEvent wire shape (Go internal/monitor/types.go SysWatchEvent). */
const watchEvent = (over: {
  watch_id?: string;
  seq?: number;
  type?: string;
  subject?: string;
  summary?: string;
  server_name?: string;
  account?: string;
}): SysWatchEvent =>
  ({
    watch_id: over.watch_id ?? "w1",
    dropped_total: 0,
    filtered_total: 0,
    event: {
      seq: over.seq ?? 1,
      subject: over.subject ?? `$SYS.ACCOUNT.${over.seq ?? 1}.CONNECT`,
      type: over.type ?? "account_connect",
      occurred_ms: 1_700_000_000_000 + (over.seq ?? 1),
      server_name: over.server_name ?? "nats-a",
      server_cluster: "c1",
      account: over.account ?? "A",
      summary: over.summary ?? "alice connected",
      size_bytes: 128,
    },
  }) as never;

beforeEach(() => {
  connState.state = "connected";
  vi.mocked(CreateSysWatch).mockReset();
  vi.mocked(CreateSysWatch).mockResolvedValue(ok as never);
  vi.mocked(StopSysWatch).mockReset();
  vi.mocked(StopSysWatch).mockResolvedValue({ error_code: "", error: "" } as never);
});

// ---- ring helper (pure) ----

it("pushAdvisory keeps newest first and caps the ring at 100", () => {
  let ring: { seq: number }[] = [];
  for (let i = 1; i <= ADVISORY_RING_CAPACITY + 5; i++) {
    ring = pushAdvisory(ring, { seq: i });
  }
  expect(ADVISORY_RING_CAPACITY).toBe(100);
  expect(ring).toHaveLength(100);
  expect(ring[0].seq).toBe(105);
  expect(ring[99].seq).toBe(6); // the five oldest are dropped
});

it("pushAdvisory delegates to EventsPanel.pushEvent (㉛, cap parameterized)", () => {
  // Custom-cap parity with the primitive it delegates to.
  expect(pushAdvisory([3, 2, 1], 4, 3)).toEqual(pushEvent([3, 2, 1], 4, 3));
  expect(pushAdvisory([3, 2, 1], 4, 3)).toEqual([4, 3, 2]);
  // The default cap is the advisory 100, not pushEvent's 10k default.
  let ring: { seq: number }[] = [];
  for (let i = 0; i <= 150; i++) ring = pushAdvisory(ring, { seq: i });
  expect(ring).toHaveLength(100);
  expect(ring[0]).toEqual({ seq: 150 });
});

// ---- watch lifecycle ----

it("creates one watch with the four advisory types on mount and stops it on unmount", async () => {
  const { unmount } = render(<AdvisoryList degraded={false} />);
  await flush();

  expect(CreateSysWatch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(CreateSysWatch).mock.calls[0][0]).toEqual({
    types: [...ADVISORY_TYPES],
    regex: "",
  });

  unmount();
  expect(StopSysWatch).toHaveBeenCalledWith("w1");
});

it("does not create a watch while disconnected", async () => {
  connState.state = "disconnected";
  render(<AdvisoryList degraded={false} />);
  await flush();

  expect(CreateSysWatch).not.toHaveBeenCalled();
  expect(screen.getByTestId("advisory-empty").textContent).toContain("Connect");
});

// ---- rendering ----

it("renders rows newest first with time, type badge, server and summary", async () => {
  render(<AdvisoryList degraded={false} />);
  await flush();

  fireSysEvent(watchEvent({ seq: 1 }));
  fireSysEvent(
    watchEvent({
      seq: 2,
      type: "js_advisory",
      summary: "stream MIGRATED max age exceeded",
      server_name: "nats-b",
    }),
  );

  const rows = [...document.querySelectorAll('[data-testid^="advisory-row-"]')];
  expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
    "advisory-row-2",
    "advisory-row-1",
  ]);
  expect(rows[0].textContent).toContain("js_advisory");
  expect(rows[0].textContent).toContain("nats-b");
  expect(rows[0].textContent).toContain("stream MIGRATED max age exceeded");
  expect(rows[1].textContent).toContain("account_connect");
  expect(rows[1].textContent).toContain("alice connected");
});

it("falls back to the subject when the summary is empty", async () => {
  render(<AdvisoryList degraded={false} />);
  await flush();

  fireSysEvent(watchEvent({ seq: 3, summary: "", subject: "$SYS.SERVER.nats-a.STATSZ" }));
  const rowEl = screen.getByTestId("advisory-row-3");
  expect(rowEl.textContent).toContain("$SYS.SERVER.nats-a.STATSZ");
});

it("ignores payloads for a different watch id", async () => {
  render(<AdvisoryList degraded={false} />);
  await flush();

  fireSysEvent(watchEvent({ watch_id: "other", seq: 9 }));
  expect(screen.queryByTestId("advisory-row-9")).toBeNull();
  expect(screen.getByTestId("advisory-empty")).toBeTruthy();
});

it("degraded mode shows the permission explanation and never touches the watch", async () => {
  render(<AdvisoryList degraded={true} />);
  await flush();

  const card = screen.getByTestId("advisory-degraded");
  expect(card.textContent).toContain("System account");
  expect(card.textContent).toContain("keeps working");
  expect(CreateSysWatch).not.toHaveBeenCalled();
});
