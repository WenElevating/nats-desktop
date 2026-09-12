import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import {
  CopyStream,
  CreateStream,
  DeleteStream,
  GetSettings,
  GetStreamDetail,
  ListStreams,
  PurgeStream,
  SealStream,
  UpdateStream,
  type StreamDetail,
  type StreamSummary,
} from "../../lib/bindings";
import { toWire, type ActionResult, type StreamFormValues } from "./schema";
import { computeListRates, RateSampler } from "./rates";

/** The useStreams surface consumed by StreamsPage / StreamList / StreamDetail
 * (brief contract; `rates` and `series` are additive extensions: the
 * per-stream list rates from computeListRates and the detail RateSampler's
 * bucketed history for the Sparkline. The mutation actions (Task 10) resolve
 * with the binding's CallResult/PurgeResult so the form can render
 * error_code=validation原文 inline). */
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
  create: (values: StreamFormValues) => Promise<ActionResult>;
  update: (values: StreamFormValues) => Promise<ActionResult>;
  copy: (src: string, newName: string) => Promise<ActionResult>;
  remove: (name: string) => Promise<ActionResult>;
  purge: (name: string, keep: number, upToSeq: number, subject: string) => Promise<ActionResult>;
  seal: (name: string) => Promise<ActionResult>;
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
          if (d.error_code === "not_found") {
            // The stream vanished under us (external delete / stale selection):
            // toast「资源不存在」once, drop the stale selection and refresh the
            // list — the poll loop then stops fetching detail entirely instead
            // of 404-toasting every tick (mirrors useConsumers §6.7 semantics).
            toast.error(t("streams.error.notFound"));
            selectedRef.current = null;
            setSelected(null);
            void fetchList();
          } else {
            toast.error(t("streams.detailLoadFailed", { error: d.error || d.error_code }));
          }
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
    [t, fetchList],
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

  // ---- mutation actions (Task 10) ----

  /** Shared mutation tail. Success → toast + refresh(); not_found → the
   * resource vanished under us → toast「资源不存在」+ refresh() (§6.7); any
   * other failure → toast with the server原文. The result is always returned
   * so StreamForm can additionally render error_code=validation inline. */
  const finishAction = useCallback(
    (res: ActionResult | null | undefined, okMsg: string): ActionResult => {
      const r: ActionResult = res ?? { error_code: "", error: "" };
      if (!r.error_code) {
        toast.success(okMsg);
        refresh();
      } else if (r.error_code === "not_found") {
        toast.error(t("streams.error.notFound"));
        refresh();
      } else {
        toast.error(t("streams.error.actionFailed", { error: r.error || r.error_code }));
      }
      return r;
    },
    [t, refresh],
  );

  /** Transport-level rejection (Wails promise threw): same toast semantics
   * with the raw error text, reported as a generic server failure. */
  const failLocal = useCallback(
    (err: unknown): ActionResult => {
      const msg = errText(err);
      toast.error(t("streams.error.actionFailed", { error: msg }));
      return { error_code: "server", error: msg };
    },
    [t],
  );

  const create = useCallback(
    async (values: StreamFormValues): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await CreateStream(toWire(values))) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("streams.done.created", { name: values.name }));
    },
    [t, finishAction, failLocal],
  );

  const update = useCallback(
    async (values: StreamFormValues): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await UpdateStream(toWire(values))) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("streams.done.updated", { name: values.name }));
    },
    [t, finishAction, failLocal],
  );

  const copy = useCallback(
    async (src: string, newName: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await CopyStream(src, newName)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("streams.done.created", { name: newName }));
    },
    [t, finishAction, failLocal],
  );

  const remove = useCallback(
    async (name: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await DeleteStream(name)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      if (!res?.error_code && selectedRef.current === name) {
        // Drop the selection BEFORE the refresh so the next detail poll never
        // 404-toasts on the just-deleted stream (the ref is updated in step
        // with the state — the selection effect only mirrors it).
        selectedRef.current = null;
        setSelected(null);
      }
      return finishAction(res, t("streams.done.deleted", { name }));
    },
    [t, finishAction, failLocal],
  );

  const purge = useCallback(
    async (name: string, keep: number, upToSeq: number, subject: string): Promise<ActionResult> => {
      let res: ActionResult & { purged?: number };
      try {
        res = (await PurgeStream(name, keep, upToSeq, subject)) as ActionResult & {
          purged?: number;
        };
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("streams.done.purged", { count: res?.purged ?? 0, name }));
    },
    [t, finishAction, failLocal],
  );

  const seal = useCallback(
    async (name: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await SealStream(name)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("streams.done.sealed", { name }));
    },
    [t, finishAction, failLocal],
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
    create,
    update,
    copy,
    remove,
    purge,
    seal,
  };
}
