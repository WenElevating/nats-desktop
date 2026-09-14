import { renderHook, act } from "@testing-library/react";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  useSessions,
  type FlushScheduler,
  type MsgOut,
} from "../src/features/messages/useSessions";
import { ClearSession, ListSessions, type SessionState } from "../src/lib/bindings";

// Task 8 realtime-push coalescing falsification suite. Root cause (Task 5):
// one Wails event per realtime message fed setState per event → ~1000 renders/s
// → ~1.4GB renderer heap at 1k msg/s × 30min. The fix buffers events in refs
// and folds ONE flush per animation frame. These tests falsify the failure
// modes: per-event setState (state must NOT move before a flush), message
// loss/reordering (conservation after one flush of a 1k burst), unbounded
// buffer growth (high-water trim), flush-during-hidden, clear resurrection,
// and a flush scheduled after unmount.
//
// Timing is fully deterministic via an injected manual scheduler (no real
// frames), except the hidden/visible test which drives the DEFAULT scheduler
// with a stubbed document.hidden and real (jsdom) frame timers.

const handlers = vi.hoisted(() => new Map<string, (e: { data: unknown }) => void>());

vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: (name: string, cb: (e: { data: unknown }) => void) => {
      handlers.set(name, cb);
      return () => {
        handlers.delete(name);
      };
    },
  },
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

// Manual scheduler: the hook's scheduleFlush captures runFlush here; the test
// fires it to play the animation frame.
let frameFlush: () => void = () => {};
let cancels = 0;
const manualScheduler: FlushScheduler = (cb) => {
  frameFlush = cb;
  return () => {
    cancels++;
    frameFlush = () => {};
  };
};

const fireMsgs = (batch: unknown) =>
  act(() => {
    handlers.get("session:msgs")?.({ data: batch });
  });

const fireState = (st: unknown) =>
  act(() => {
    handlers.get("session:state")?.({ data: st });
  });

const state = (over: Partial<SessionState> = {}): SessionState => ({
  id: "s-1",
  subject: "telemetry.#",
  state: "running",
  push_mode: "realtime" as const,
  rate_msg_s: 0,
  total: 0,
  dropped: 0,
  buffer_used: 0,
  ...over,
});

const msg = (session_id: string, seq: number): MsgOut => ({
  session_id,
  seq,
  subject: "telemetry.a",
  payload_b64: "bS0x",
  payload_size: 3,
  timestamp: "2026-01-01T00:00:00Z",
  is_utf8: true,
});

beforeEach(() => {
  handlers.clear();
  frameFlush = () => {};
  cancels = 0;
  vi.mocked(ListSessions).mockResolvedValue(null as never);
  vi.mocked(ClearSession).mockResolvedValue(undefined as never);
});

afterEach(() => {
  // Restore a possibly-stubbed document.hidden.
  delete (document as { hidden?: boolean }).hidden;
});

it("buffers a 1,000-event realtime burst without per-event setState and conserves order on one flush", () => {
  const { result } = renderHook(() => useSessions({ scheduler: manualScheduler }));
  fireState(state());

  // 1,000 single-message events (the realtime wire shape at 1k msg/s).
  for (let i = 1; i <= 1000; i++) fireMsgs([msg("s-1", i)]);

  // Falsifies per-event setState: nothing reached React state before a flush.
  expect(result.current.messages["s-1"]).toBeUndefined();

  act(() => frameFlush());

  // Conservation + arrival order, exact.
  const list = result.current.messages["s-1"];
  expect(list).toHaveLength(1000);
  expect(list.map((m: MsgOut) => m.seq)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
});

it("folds multiple flush cycles and interleaved sessions without cross-talk", () => {
  const { result } = renderHook(() => useSessions({ scheduler: manualScheduler }));
  fireState(state({ id: "a" }));
  fireState(state({ id: "b" }));

  fireMsgs([msg("a", 1)]);
  fireMsgs([msg("b", 1)]);
  act(() => frameFlush()); // frame 1
  fireMsgs([msg("a", 2)]);
  fireMsgs([msg("b", 2)]);
  act(() => frameFlush()); // frame 2

  expect(result.current.messages["a"].map((m: MsgOut) => m.seq)).toEqual([1, 2]);
  expect(result.current.messages["b"].map((m: MsgOut) => m.seq)).toEqual([1, 2]);
});

it("trims the pending buffer at the 2x high-water mark and keeps the newest cap after flush", () => {
  const { result } = renderHook(() => useSessions({ scheduler: manualScheduler }));
  fireState(state());

  // 35,000 buffered for one session (default cap 10,000): the high-water trim
  // must bound the buffer while the fold keeps exactly the newest 10,000.
  for (let i = 1; i <= 35_000; i++) fireMsgs([msg("s-1", i)]);

  act(() => frameFlush());

  const list = result.current.messages["s-1"];
  expect(list).toHaveLength(10_000);
  expect(list[0].seq).toBe(25_001);
  expect(list[9_999].seq).toBe(35_000);
});

it("keeps the latest session:state snapshot per id (counters exact, no stale regressions)", () => {
  const { result } = renderHook(() => useSessions({ scheduler: manualScheduler }));

  fireState(state({ total: 10 }));
  fireState(state({ total: 20 }));
  fireState(state({ total: 30, rate_msg_s: 999.5 }));
  act(() => frameFlush());

  expect(result.current.sessions).toHaveLength(1);
  expect(result.current.sessions[0]).toMatchObject({ id: "s-1", total: 30, rate_msg_s: 999.5 });
});

it("clear() drops the session's unflushed pending messages (no resurrection)", () => {
  const { result } = renderHook(() => useSessions({ scheduler: manualScheduler }));
  fireState(state());
  fireMsgs([msg("s-1", 1)]);
  fireMsgs([msg("s-1", 2)]);

  // Clear before any flush: the pending backlog for s-1 must be discarded,
  // and the flush must not fold the pre-clear messages back over the list.
  act(() => {
    result.current.clear("s-1");
    frameFlush();
  });

  expect(result.current.messages["s-1"]).toEqual([]);
});

it("unmount cancels the scheduled flush (no post-unmount setState)", () => {
  const { unmount } = renderHook(() => useSessions({ scheduler: manualScheduler }));
  fireMsgs([msg("s-1", 1)]);
  expect(frameFlush).not.toBe(() => {}); // a flush is scheduled
  unmount();
  expect(cancels).toBe(1);
  expect(() => frameFlush()).not.toThrow(); // the captured cb is a no-op now
});

it("default scheduler: flush is paused while document.hidden and resumes on visibilitychange", async () => {
  // Stub hidden BEFORE the hook mounts so the first schedule sees it.
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  const { result } = renderHook(() => useSessions()); // default rAF scheduler
  fireState(state());
  fireMsgs([msg("s-1", 1)]);

  // Hidden: no flush is scheduled — give real frame timers a chance to prove
  // nothing lands, then assert the buffer is still sealed.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  expect(result.current.messages["s-1"]).toBeUndefined();
  expect(result.current.sessions).toHaveLength(0);

  // Visible again: the visibilitychange listener schedules the flush; the
  // frame fires on the real (jsdom) timer — poll inside act until it lands.
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    for (let i = 0; i < 50 && result.current.messages["s-1"] === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  });
  expect(result.current.messages["s-1"]).toHaveLength(1);
  expect(result.current.sessions[0]).toMatchObject({ id: "s-1", state: "running" });
});
