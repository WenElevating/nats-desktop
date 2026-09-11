import { test } from "vitest";
import {
  applyMsgsBatch,
  DEFAULT_BUFFER,
  type MsgOut,
} from "../../src/features/messages/sessionsLogic";

// Frontend throughput sampling (Task 11 Step 2): the useSessions state machine
// ingest path (applyMsgsBatch) fed the brief's flood profile — 10,000 events in
// 500x20 batches. jsdom-logic-only: no drawing/frame cost here (帧率验证走
// Task 13 实测); the wall-clock gate for the full React path lives in
// tests/messages-perf.test.ts.
//
// vitest 5 benchmark API: benchmarks are registered on the test context
// (ctx.bench) and executed by `vitest bench --run` (npm run bench). This file
// (*.bench.ts) is excluded from the regular `vitest run` suite.

const msg = (seq: number): MsgOut => ({
  session_id: "bench-1",
  seq,
  subject: "bench.flood.a",
  payload_b64: "cGVyZi0x",
  payload_size: 6,
  timestamp: "2026-01-01T00:00:00Z",
  is_utf8: true,
});

const caps = { "bench-1": DEFAULT_BUFFER };
const batch500 = Array.from({ length: 500 }, (_, i) => msg(i + 1));

// Steady-state working set: a full 10k buffer, so every append evicts the
// oldest message (the production steady case under flood).
const atCap: Record<string, MsgOut[]> = {};
{
  let state: Record<string, MsgOut[]> = {};
  for (let b = 0; b < 20; b++) state = applyMsgsBatch(state, batch500, caps);
  atCap["bench-1"] = state["bench-1"];
}

test("session:msgs ingest (spec §6.4 状态机, 10k cap)", async (ctx) => {
  await ctx.bench.compare(
    ctx.bench("cold flood: 10,000 msgs as 500x20 batches (one op = full flood)", () => {
      let state: Record<string, MsgOut[]> = {};
      for (let b = 0; b < 20; b++) {
        state = applyMsgsBatch(state, batch500, caps);
      }
    }),
    ctx.bench("steady flood: one 500-msg batch into a full 10k buffer", () => {
      applyMsgsBatch(atCap, batch500, caps);
    }),
  );
});
