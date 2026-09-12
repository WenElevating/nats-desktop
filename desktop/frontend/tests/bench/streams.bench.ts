import { createElement } from "react";
import { expect, test } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { StreamList } from "../../src/features/streams/StreamList";
import type { StreamSummary } from "../../src/lib/bindings";

// Frontend render-cost sampling for the streams table (M3 Task 14): the
// StreamList virtualized grid at the spec's 10k-stream working set (§6.6),
// mirroring M2's sessions.bench.ts structure. jsdom-logic-only: React commit
// cost without real layout/paint (帧率验证走 Task 13 实测).
//
// Virtualization-window correctness at 10k rows (DOM rows < 100) is asserted
// as a REGULAR test in tests/streams-page.test.tsx ("renders only the virtual
// window of a 10k-stream list") — referenced, not duplicated, here.
//
// vitest 5 benchmark API: benchmarks are registered on the test context
// (ctx.bench) and executed by `vitest bench --run` (npm run bench). This file
// (*.bench.ts) is excluded from the regular `vitest run` suite.
//
// createElement (not JSX) keeps the brief-mandated .bench.ts filename — JSX
// syntax would require .tsx.

// setup.ts's ResizeObserver stub never reports a size, so react-virtual would
// measure a 0px viewport and render zero rows (a bench of nothing). Fire one
// 1024x280 border box on observe, exactly like streams-page.test.tsx (280px /
// 28px rows = 10 visible + 2x8 overscan → 26 DOM rows per render).
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

const summary = (i: number): StreamSummary => ({
  name: `S${String(i).padStart(5, "0")}`,
  description: "",
  internal_kind: "",
  subjects: [`bench.${i}.>`],
  storage: i % 2 === 0 ? "memory" : "file",
  retention: "limits",
  messages: (i * 7919) % 50_000,
  bytes: (i * 104_729) % 5_000_000,
  consumers: i % 5,
  first_seq: 1,
  last_seq: (i * 7919) % 50_000,
  last_time_ms: 1_770_000_000_000 + i * 1000,
  lost_msgs: 0,
  lost_bytes: 0,
  num_deleted: 0,
  is_mirror: false,
  is_source: false,
  leader_missing: false,
  unhealthy_replicas: 0,
  replica_count: 1,
});

const streams10k: StreamSummary[] = Array.from({ length: 10_000 }, (_, i) => summary(i));
const noop = (): void => {};

const streamList = () =>
  createElement(StreamList, { streams: streams10k, selected: null, onSelect: noop });

// Cold mount: a fresh container per iteration; teardown (unmount) is excluded
// by design — the unit is the React commit of the initial 26-row window over a
// 10k-row client sort. Containers are removed after each commit; the bounded
// iteration count (warmup 5 + ~0.5s of ops) keeps the leak immaterial.
const coldMount = (): void => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(streamList(), { container });
  container.remove();
};

// Persistent mount for the interaction bench (must survive across iterations;
// coldMount's containers are its own, so nothing unmounts it mid-bench).
const mounted = render(streamList());
const sortMessages = (): void => {
  // First click re-keys to messages/asc, later clicks toggle desc — identical
  // cost either way: one full 10k client sort + window re-render.
  fireEvent.click(mounted.getByTestId("stream-sort-messages"));
};

// Guard: the fixture must actually render the virtual window (26 rows) — a
// ResizeObserver regression would silently bench an empty list.
expect(document.querySelectorAll('[data-testid^="stream-row-"]').length).toBeGreaterThan(0);
expect(document.querySelectorAll('[data-testid^="stream-row-"]').length).toBeLessThan(100);

test("streams:list render + sort toggle (10k rows, virtualized window)", async (ctx) => {
  await ctx.bench.compare(
    ctx.bench("cold mount: 10k-row StreamList render (one op = React commit of the virtual window)", coldMount),
    ctx.bench("sort toggle: messages column on mounted 10k list (one op = client sort + re-render)", sortMessages),
  );
});
