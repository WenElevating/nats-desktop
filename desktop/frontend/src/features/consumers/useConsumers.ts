import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import {
  CopyConsumer,
  CreateConsumer,
  DeleteConsumer,
  GetConsumerDetail,
  GetSettings,
  ListConsumers,
  ListStreams,
  PauseConsumer,
  ResetConsumer,
  ResumeConsumer,
  UpdateConsumer,
  type ConsumerDetail,
  type ConsumerSummary,
  type PauseResult,
  type StreamSummary,
} from "../../lib/bindings";
import { toWire, type ActionResult, type ConsumerFormValues } from "./schema";
import { RateSampler } from "../streams/rates";

/**
 * The useConsumers surface consumed by ConsumersPage (brief contract:
 * useConsumers(stream) → consumers / unavailableReason / detail / refresh /
 * actions). `streams` is the selector data from ListStreams; `rate` and
 * `series` are additive extensions fed by the detail RateSampler over the
 * `delivered_consumer_seq` series (natscli consumer graph 同口径). The
 * mutation actions resolve with the binding's CallResult/PauseResult so the
 * form can render error_code=validation原文 inline.
 */
export interface ConsumersApi {
  /** Stream selector data (ListStreams), refreshed per connection + refresh(). */
  streams: StreamSummary[];
  consumers: ConsumerSummary[];
  unavailableReason: string;
  loading: boolean;
  refresh: () => void;
  selected: string | null;
  select: (name: string | null) => void;
  detail: ConsumerDetail | null;
  detailLoading: boolean;
  /** Latest consumer msg/s from the RateSampler (NaN until the 2nd sample). */
  rate: number;
  /** Bucketed history from the sampler: (windowMs, buckets) → points. */
  series: (windowMs: number, buckets: number) => number[];
  create: (values: ConsumerFormValues) => Promise<ActionResult>;
  update: (values: ConsumerFormValues) => Promise<ActionResult>;
  copy: (stream: string, name: string, newName: string) => Promise<ActionResult>;
  remove: (stream: string, name: string) => Promise<ActionResult>;
  reset: (stream: string, name: string, toSeq: number) => Promise<ActionResult>;
  pause: (stream: string, name: string, seconds: number) => Promise<PauseResult>;
  resume: (stream: string, name: string) => Promise<ActionResult>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Frontend state for the Consumers page (spec §6.7). While the connection is
 * live, the document is visible (§20.2) and a stream is picked, polls
 * ListConsumers (and, for the selected consumer, GetConsumerDetail in the same
 * tick) every behavior.poll_interval_seconds (default 5s). Each detail answer
 * is pushed into a RateSampler keyed on `delivered_consumer_seq` for the
 * sparkline. Disconnecting stops the loop and clears everything; failures
 * toast with the server error.
 *
 * Error semantics (§6.7 异常表):
 * - List unavailable_reason → the page renders the guidance panel (never an
 *   empty list); a bare `not_found` (stream gone) is a deterministic answer →
 *   empty list, no toast spam.
 * - Detail `not_found` → toast「资源不存在」+ drop the selection + refresh the
 *   list (the consumer vanished under us).
 * - Mutations: success → toast + refresh; `not_found` → toast + refresh; any
 *   other failure → toast with the server原文.
 */
export function useConsumers(stream: string | null): ConsumersApi {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";

  const [streams, setStreams] = useState<StreamSummary[]>([]);
  const [consumers, setConsumers] = useState<ConsumerSummary[]>([]);
  const [unavailableReason, setUnavailableReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConsumerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [rate, setRate] = useState(Number.NaN);

  // Poll cadence from settings (default 5s until GetSettings answers); the
  // RateSampler accumulates the selected consumer's delivered-seq samples.
  // Selection is read through a ref so changing it does not restart the loop.
  const intervalMs = useRef(5_000);
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

  const fetchStreams = useCallback(async () => {
    try {
      // No server-side filter here: the §6.7 stream selector takes the capped,
      // messages-desc delivery surface as-is (Task 6 registers the revision).
      const res = await ListStreams("");
      setStreams(res?.streams ?? []);
    } catch (err) {
      toast.error(t("consumers.loadFailed", { error: errText(err) }));
    }
  }, [t]);

  const fetchConsumers = useCallback(
    async (st: string) => {
      setLoading(true);
      try {
        const res = await ListConsumers(st);
        setUnavailableReason(res?.unavailable_reason ?? "");
        setConsumers(res?.consumers ?? []);
        // unavailable_reason renders as the guidance panel; not_found is the
        // deterministic "stream gone" answer → empty list. Other failures toast.
        if (res?.error_code && !res.unavailable_reason && res.error_code !== "not_found") {
          toast.error(t("consumers.loadFailed", { error: res.error || res.error_code }));
        }
      } catch (err) {
        toast.error(t("consumers.loadFailed", { error: errText(err) }));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  const fetchDetail = useCallback(
    async (st: string, name: string) => {
      setDetailLoading(true);
      try {
        const d = await GetConsumerDetail(st, name);
        if (selectedRef.current !== name) return; // selection moved on mid-flight
        if (d?.error_code) {
          if (d.error_code === "not_found") {
            // §6.7 表 1: the consumer vanished under us → toast + drop the
            // stale selection + refresh the list.
            toast.error(t("consumers.error.notFound"));
            selectedRef.current = null;
            setSelected(null);
            void fetchConsumers(st);
          } else {
            toast.error(t("consumers.detailLoadFailed", { error: d.error || d.error_code }));
          }
          return;
        }
        const now = Date.now();
        sampler.current.push({
          t: now,
          lastSeq: d.summary.delivered_consumer_seq,
          firstSeq: 0,
        });
        setDetail(d);
        setRate(sampler.current.rate(now));
      } catch (err) {
        toast.error(t("consumers.detailLoadFailed", { error: errText(err) }));
      } finally {
        setDetailLoading(false);
      }
    },
    [t, fetchConsumers],
  );

  // The poll loop: one cadence drives the consumer list + selected detail.
  // The stream selector data (ListStreams) is fetched per connection, not per
  // tick — it changes far more slowly than consumer state.
  useEffect(() => {
    if (!connected || !visible || !stream) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await fetchConsumers(stream);
      const sel = selectedRef.current;
      if (sel) await fetchDetail(stream, sel);
      if (!alive) return;
      timer = setTimeout(() => void tick(), intervalMs.current);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [connected, visible, stream, fetchConsumers, fetchDetail]);

  useEffect(() => {
    if (connected) void fetchStreams();
  }, [connected, fetchStreams]);

  // A stream transition must not fire a detail fetch for the previous
  // stream's selected consumer: the selection effect below runs once more
  // with the stale `selected` before the cleared state applies. A sentinel —
  // set here (declared first, so it runs first within the flush) — makes the
  // selection effect swallow exactly that one stale invocation.
  const streamTransition = useRef(false);
  useEffect(() => {
    streamTransition.current = true;
    selectedRef.current = null;
    setSelected(null);
    setConsumers([]);
    setUnavailableReason("");
  }, [stream]);

  // Selection change: fresh sampler/detail, immediate fetch.
  useEffect(() => {
    if (streamTransition.current) {
      if (selected === null) {
        // The post-clear pass: reset the detail-derived state, fetch nothing.
        streamTransition.current = false;
        sampler.current.reset();
        setDetail(null);
        setRate(Number.NaN);
      }
      return;
    }
    selectedRef.current = selected;
    sampler.current.reset();
    setDetail(null);
    setRate(Number.NaN);
    if (selected && stream && connected) void fetchDetail(stream, selected);
  }, [selected, stream, connected, fetchDetail]);

  // 断连: stop happens via the gated loop above; clear everything so stale
  // data never masquerades as live (selection kept, like useStreams).
  useEffect(() => {
    if (connected) return;
    setStreams([]);
    setConsumers([]);
    setUnavailableReason("");
    setDetail(null);
    setRate(Number.NaN);
    sampler.current.reset();
  }, [connected]);

  const refresh = useCallback(() => {
    if (!connected) return;
    void fetchStreams();
    if (stream) {
      void fetchConsumers(stream);
      const sel = selectedRef.current;
      if (sel) void fetchDetail(stream, sel);
    }
  }, [connected, stream, fetchStreams, fetchConsumers, fetchDetail]);

  const select = useCallback((name: string | null) => {
    setSelected(name);
  }, []);

  const series = useCallback(
    (windowMs: number, buckets: number) => sampler.current.series(windowMs, Date.now(), buckets),
    [],
  );

  // ---- mutation actions ----

  /** Shared mutation tail. Success → toast + refresh(); not_found → the
   * resource vanished under us → toast「资源不存在」+ refresh() (§6.7); any
   * other failure → toast with the server原文. The result is always returned
   * so ConsumerForm can additionally render error_code=validation inline. */
  const finishAction = useCallback(
    (res: ActionResult | null | undefined, okMsg: string): ActionResult => {
      const r: ActionResult = res ?? { error_code: "", error: "" };
      if (!r.error_code) {
        toast.success(okMsg);
        refresh();
      } else if (r.error_code === "not_found") {
        toast.error(t("consumers.error.notFound"));
        refresh();
      } else {
        toast.error(t("consumers.error.actionFailed", { error: r.error || r.error_code }));
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
      toast.error(t("consumers.error.actionFailed", { error: msg }));
      return { error_code: "server", error: msg };
    },
    [t],
  );

  const create = useCallback(
    async (values: ConsumerFormValues): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await CreateConsumer(toWire(values))) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("consumers.done.created", { name: values.durable }));
    },
    [t, finishAction, failLocal],
  );

  const update = useCallback(
    async (values: ConsumerFormValues): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await UpdateConsumer(toWire(values))) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("consumers.done.updated", { name: values.durable }));
    },
    [t, finishAction, failLocal],
  );

  /** Direct server-side copy (CopyConsumer). The page's copy flow prefers the
   * form copy mode (prefill + cleared name submitted via CreateConsumer) so
   * the operator's tweaks travel with the new consumer — streams-page
   * precedent; this raw binding copy remains for API-complete use. */
  const copy = useCallback(
    async (st: string, name: string, newName: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await CopyConsumer(st, name, newName)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("consumers.done.created", { name: newName }));
    },
    [t, finishAction, failLocal],
  );

  const remove = useCallback(
    async (st: string, name: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await DeleteConsumer(st, name)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      if (!res?.error_code && selectedRef.current === name) {
        // Drop the selection BEFORE the refresh so the next detail poll never
        // 404-toasts on the just-deleted consumer.
        selectedRef.current = null;
        setSelected(null);
      }
      return finishAction(res, t("consumers.done.deleted", { name }));
    },
    [t, finishAction, failLocal],
  );

  const reset = useCallback(
    async (st: string, name: string, toSeq: number): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await ResetConsumer(st, name, toSeq)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("consumers.done.reset", { name }));
    },
    [t, finishAction, failLocal],
  );

  /** Pause returns the full PauseResult; the hook toasts the failure原文
   * (e.g. the 2.11 pause gate) and toasts+refreshes on success. */
  const pause = useCallback(
    async (st: string, name: string, seconds: number): Promise<PauseResult> => {
      let res: PauseResult;
      try {
        res = (await PauseConsumer(st, name, seconds)) as PauseResult;
      } catch (err) {
        const msg = errText(err);
        toast.error(t("consumers.error.actionFailed", { error: msg }));
        return { error_code: "server", error: msg, paused: false, until_ms: 0, remaining_ms: 0 };
      }
      if (!res?.error_code) {
        toast.success(t("consumers.done.paused", { name }));
        refresh();
      } else {
        toast.error(t("consumers.error.actionFailed", { error: res.error || res.error_code }));
      }
      return res;
    },
    [t, refresh],
  );

  const resume = useCallback(
    async (st: string, name: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await ResumeConsumer(st, name)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("consumers.done.resumed", { name }));
    },
    [t, finishAction, failLocal],
  );

  return {
    streams,
    consumers,
    unavailableReason,
    loading,
    refresh,
    selected,
    select,
    detail,
    detailLoading,
    rate,
    series,
    create,
    update,
    copy,
    remove,
    reset,
    pause,
    resume,
  };
}
