import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import {
  GetSettings,
  GetStreamDetail,
  ListStreams,
  type StreamDetail,
  type StreamSummary,
} from "../../lib/bindings";
import { computeListRates, RateSampler } from "./rates";

/** The useStreams surface consumed by StreamsPage / StreamList / StreamDetail
 * (brief contract; `rates` and `series` are additive extensions: the
 * per-stream list rates from computeListRates and the detail RateSampler's
 * bucketed history for the Sparkline). */
export interface StreamsApi {
  list: StreamSummary[];
  unavailableReason: string;
  loading: boolean;
  refresh: () => void;
  selected: string | null;
  select: (name: string | null) => void;
  detail: StreamDetail | null;
  detailLoading: boolean;
  rate: number;
  /** name → msg/s from the latest list refresh (empty until the 2nd). */
  rates: Map<string, number>;
  series: (windowMs: number, buckets: number) => number[];
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Frontend state for the Streams page (spec §6.6). Polls ListStreams (and, for
 * the selected stream, GetStreamDetail in the same tick) every
 * behavior.poll_interval_seconds (default 5s) while the connection is live and
 * the document is visible (§20.2: hidden pauses, visible resumes immediately).
 *
 * Per refresh the previous list snapshot (kept in a ref) feeds
 * computeListRates for the rate column, and each detail answer is pushed into
 * a per-stream RateSampler for the sparkline. Disconnecting stops the loop and
 * clears everything (brief: 停止并置空); failures toast with the server error.
 */
export function useStreams(): StreamsApi {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";

  const [list, setList] = useState<StreamSummary[]>([]);
  const [unavailableReason, setUnavailableReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [rates, setRates] = useState<Map<string, number>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<StreamDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [rate, setRate] = useState(Number.NaN);

  // Poll cadence from settings (default 5s until GetSettings answers); the
  // previous list snapshot + wall-clock anchor for the per-refresh Δt; the
  // RateSampler accumulates the selected stream's detail samples.
  const intervalMs = useRef(5_000);
  const prevSnapshot = useRef(new Map<string, StreamSummary>());
  const lastListAt = useRef(0);
  const sampler = useRef(new RateSampler());
  const selectedRef = useRef<string | null>(null);

  // §20.2 失焦暂停轮询: visibilitychange gates the poll loop.
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    let alive = true;
    GetSettings()
      .then((s) => {
        const secs = s?.behavior?.poll_interval_seconds ?? 0;
        if (alive && secs > 0) intervalMs.current = secs * 1000;
      })
      .catch(() => {
        /* default cadence stands */
      });
    return () => {
      alive = false;
    };
  }, []);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ListStreams();
      const streams = res?.streams ?? [];
      const now = Date.now();
      setUnavailableReason(res?.unavailable_reason ?? "");
      setRates(computeListRates(prevSnapshot.current, streams, now - lastListAt.current));
      prevSnapshot.current = new Map(streams.map((s) => [s.name, s]));
      lastListAt.current = now;
      setList(streams);
      // unavailable_reason renders as the guidance panel; other failures toast.
      if (res?.error_code && !res.unavailable_reason) {
        toast.error(t("streams.loadFailed", { error: res.error || res.error_code }));
      }
    } catch (err) {
      toast.error(t("streams.loadFailed", { error: errText(err) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const fetchDetail = useCallback(
    async (name: string) => {
      setDetailLoading(true);
      try {
        const d = await GetStreamDetail(name);
        if (selectedRef.current !== name) return; // selection moved on mid-flight
        if (d?.error_code) {
          toast.error(t("streams.detailLoadFailed", { error: d.error || d.error_code }));
          return;
        }
        const now = Date.now();
        sampler.current.push({
          t: now,
          lastSeq: d.summary.last_seq,
          firstSeq: d.summary.first_seq,
        });
        setDetail(d);
        setRate(sampler.current.rate(now));
      } catch (err) {
        toast.error(t("streams.detailLoadFailed", { error: errText(err) }));
      } finally {
        setDetailLoading(false);
      }
    },
    [t],
  );

  // The poll loop: one cadence drives list + selected detail. Selection is
  // read through a ref so changing it does not restart the loop.
  useEffect(() => {
    if (!connected || !visible) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await fetchList();
      const sel = selectedRef.current;
      if (sel) await fetchDetail(sel);
      if (!alive) return;
      timer = setTimeout(() => void tick(), intervalMs.current);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [connected, visible, fetchList, fetchDetail]);

  // Selection change: fresh sampler/detail, immediate fetch.
  useEffect(() => {
    selectedRef.current = selected;
    sampler.current.reset();
    setDetail(null);
    setRate(Number.NaN);
    if (selected && connected) void fetchDetail(selected);
  }, [selected, connected, fetchDetail]);

  // 断连: stop happens via the gated loop above; clear everything so stale
  // data never masquerades as live.
  useEffect(() => {
    if (connected) return;
    setList([]);
    setUnavailableReason("");
    setRates(new Map());
    setDetail(null);
    setRate(Number.NaN);
    prevSnapshot.current = new Map();
    lastListAt.current = 0;
    sampler.current.reset();
  }, [connected]);

  const refresh = useCallback(() => {
    if (!connected) return;
    void fetchList();
    const sel = selectedRef.current;
    if (sel) void fetchDetail(sel);
  }, [connected, fetchList, fetchDetail]);

  const select = useCallback((name: string | null) => {
    setSelected(name);
  }, []);

  const series = useCallback(
    (windowMs: number, buckets: number) => sampler.current.series(windowMs, Date.now(), buckets),
    [],
  );

  return {
    list,
    unavailableReason,
    loading,
    refresh,
    selected,
    select,
    detail,
    detailLoading,
    rate,
    rates,
    series,
  };
}
