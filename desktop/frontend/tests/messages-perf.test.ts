import { renderHook, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { useSessions, DEFAULT_BUFFER, type MsgOut } from "../src/features/messages/useSessions";
import { ListSessions, type SessionState } from "../src/lib/bindings";

// Frontend perf gate (Task 11, spec §6.4 / §12; jsdom-logic-only — no NATS
// server, no drawing: frame-rate validation is Task 13's live measurement).
// The full production path is exercised: useSessions' session:msgs handler
// (applyMsgsBatch through the setState updater) + React commit, driven by
// act-batched event firing in the brief's flood profile (500 msgs x 20
// batches = 10,000 events). Gate: the whole ingest lands in < 2s wall with an
// exact final buffer (10,000 kept, seq-continuous).
//
// Mocks mirror tests/messages-sessions.test.tsx: @wailsio/runtime Events
// (handlers captured), the bindings surface, sonner. i18n is real.

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

const state = (): SessionState => ({
  id: "perf-1",
  subject: "perf.flood.#",
  state: "running",
  push_mode: "realtime" as const,
  rate_msg_s: 0,
  total: 0,
  dropped: 0,
  buffer_used: 0,
});

const msg = (seq: number): MsgOut => ({
  session_id: "perf-1",
  seq,
  subject: "perf.flood.a",
  payload_b64: "cGVyZi0x", // "perf-1"
  payload_size: 6,
  timestamp: "2026-01-01T00:00:00Z",
  is_utf8: true,
});

const fire = (name: string, data: unknown) =>
  act(() => {
    handlers.get(name)?.({ data });
  });

beforeEach(() => {
  handlers.clear();
  vi.mocked(ListSessions).mockResolvedValue(null as never);
});

it("ingests 10,000 session:msgs (500x20 batches) in < 2s with an exact final buffer", async () => {
  const { result } = renderHook(() => useSessions());
  fire("session:state", state());

  // The brief's flood profile: 20 batches of 500 realtime messages.
  const batches: MsgOut[][] = Array.from({ length: 20 }, (_, b) =>
    Array.from({ length: 500 }, (_, i) => msg(b * 500 + i + 1)),
  );

  const t0 = performance.now();
  for (const batch of batches) fire("session:msgs", batch);
  const elapsedMs = performance.now() - t0;

  // Gate: 10k events through the reducer + React commits inside 2s wall.
  expect(elapsedMs).toBeLessThan(2000);

  // Conservation of the ingest: exactly the default buffer kept, oldest
  // dropped beyond it, seq-continuous, and the session chip present.
  const list = result.current.messages["perf-1"];
  expect(list).toHaveLength(DEFAULT_BUFFER);
  expect(list[0].seq).toBe(1);
  expect(list[DEFAULT_BUFFER - 1].seq).toBe(DEFAULT_BUFFER);
  expect(result.current.sessions).toHaveLength(1);
  expect(result.current.sessions[0]).toMatchObject({ id: "perf-1", state: "running" });

  console.info(`frontend perf: 10,000 msgs ingested in ${elapsedMs.toFixed(0)}ms (gate < 2000ms)`);
});
