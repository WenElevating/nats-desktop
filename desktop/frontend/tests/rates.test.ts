import { describe, expect, it } from "vitest";
import { RateSampler, computeListRates } from "@/features/streams/rates";

describe("RateSampler", () => {
  it("computes msg/s from lastSeq deltas (natscli calculateRate parity: hold-last on zero)", () => {
    const s = new RateSampler();
    s.push({ t: 0, lastSeq: 100, firstSeq: 1 });
    s.push({ t: 5_000, lastSeq: 350, firstSeq: 1 }); // Δ250 / 5s = 50/s
    expect(s.rate(5_000)).toBe(50);
    s.push({ t: 10_000, lastSeq: 350, firstSeq: 1 }); // 无新增 → 保持上一值不抖动
    expect(s.rate(10_000)).toBe(50);
  });

  it("prunes samples outside the largest window", () => {
    const s = new RateSampler();
    for (let i = 0; i < 100; i++) s.push({ t: i * 1_000, lastSeq: i, firstSeq: 0 });
    s.push({ t: 3_700_000, lastSeq: 5_000, firstSeq: 0 }); // 1h 窗口外样本应被清理
    expect(s.count()).toBeLessThan(100);
  });

  it("series buckets a window into points", () => {
    const s = new RateSampler();
    for (let i = 0; i <= 60; i++) s.push({ t: i * 1_000, lastSeq: i * 10, firstSeq: 0 });
    const ser = s.series(60_000, 60_000, 12);
    expect(ser).toHaveLength(12);
    expect(ser.every((v) => v >= 0)).toBe(true);
  });

  it("computeListRates derives per-stream rates from list snapshots", () => {
    const prev = new Map([["A", { last_seq: 100 }], ["B", { last_seq: 50 }]]);
    const cur = [
      { name: "A", last_seq: 350 },
      { name: "B", last_seq: 50 },
      { name: "C", last_seq: 9 },
    ];
    const rates = computeListRates(prev, cur as never, 5_000);
    expect(rates.get("A")).toBe(50);
    expect(rates.get("B")).toBe(0);
    expect(rates.has("C")).toBe(false); // 无历史 → 缺席，渲染 "—"
  });
});
