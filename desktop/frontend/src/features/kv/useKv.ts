import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import {
  CompactKvBucket,
  CreateKvBucket,
  CreateKvWatch,
  DeleteKey,
  DeleteKvBucket,
  GetKeyHistory,
  GetKeyValues,
  GetKvBucketDetail,
  GetSettings,
  ListKeys,
  ListKvBuckets,
  PutKey,
  RevertKey,
  StopWatch,
  UpdateKvBucket,
  type KeyHistoryEntry,
  type KeyMeta,
  type KeyValueOut,
  type KvBucketForm,
  type KvBucketSummary,
  type PutKeyResult,
} from "../../lib/bindings";
import { bucketFormToWire, type ActionResult, type BucketFormValues } from "./schema";

/**
 * One KV watch event on the `kv:watch` wire (Go internal/buckets KvWatchEvent
 * — snake JSON tags are a frozen contract; events are not part of the
 * bindings surface, same as the messaging MsgOut). key === "" is the
 * initial-snapshot sentinel; dropped_total is the emitter's cumulative drop
 * counter (§6.4 丢弃计数显示的 wire 来源).
 */
export interface KvWatchEvent {
  watch_id: string;
  bucket: string;
  key: string;
  revision: number;
  operation: string;
  payload_b64: string;
  payload_size: number;
  is_utf8: boolean;
  timestamp_ms: number;
  dropped_total: number;
}

/** Frontend display cap for the watch ring (§6.4: bounded ring, sessions 同款). */
export const WATCH_RING_CAP = 10_000;

/**
 * applyWatchEvent folds one `kv:watch` event into the ring, keeping at most
 * the newest `cap` events. Malformed payloads (anything crossing the Wails
 * event bridge) are dropped; returns prev unchanged so React bails out of the
 * re-render. Pure so the 10k bound is unit-testable without React.
 */
export function applyWatchEvent(
  ring: KvWatchEvent[],
  ev: unknown,
  cap: number = WATCH_RING_CAP,
): KvWatchEvent[] {
  const e = ev as Partial<KvWatchEvent> | null | undefined;
  if (!e || typeof e.watch_id !== "string") return ring;
  // key/operation are omitempty on the Go wire: the sentinel ships without a
  // "key" field at all, so missing strings normalize to "" (sentinel) rather
  // than getting dropped as malformed.
  const norm: KvWatchEvent = {
    watch_id: e.watch_id,
    bucket: typeof e.bucket === "string" ? e.bucket : "",
    key: typeof e.key === "string" ? e.key : "",
    revision: typeof e.revision === "number" ? e.revision : 0,
    operation: typeof e.operation === "string" ? e.operation : "",
    payload_b64: typeof e.payload_b64 === "string" ? e.payload_b64 : "",
    payload_size: typeof e.payload_size === "number" ? e.payload_size : 0,
    is_utf8: e.is_utf8 === true,
    timestamp_ms: typeof e.timestamp_ms === "number" ? e.timestamp_ms : 0,
    dropped_total: typeof e.dropped_total === "number" ? e.dropped_total : 0,
  };
  const next = [...ring, norm];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export interface PutKeyArgs {
  bucket: string;
  key: string;
  payloadB64: string;
  mode: "put" | "create" | "update";
  expectedRevision: number;
}

/** The watch sub-surface consumed by WatchPanel. */
export interface KvWatchApi {
  /** Registered watch id, or null while not watching. */
  active: string | null;
  events: KvWatchEvent[];
  /** Cumulative dropped_total from the latest event (0 until one arrives). */
  dropped: number;
  /** True once the key="" sentinel (initial snapshot complete) arrived. */
  snapshotDone: boolean;
  start: (bucket: string, keys: string) => Promise<void>;
  stop: () => void;
}

/** The useKv surface consumed by KeyValuePage / KeyList / KeyDetail /
 * KeyEditor / WatchPanel (brief contract; pageSize / pagedKeys / selectedKey /
 * history are additive extensions — the client-side pagination and key-detail
 * state live here so every component stays presentational). */
export interface KvApi {
  buckets: KvBucketSummary[];
  unavailableReason: string;
  loading: boolean;
  refresh: () => void;
  selected: string | null;
  select: (name: string | null) => void;
  /** Selected bucket's editable form echo (GetKvBucketDetail.form). */
  detail: KvBucketForm | null;
  detailLoading: boolean;
  keys: KeyMeta[];
  keysLoading: boolean;
  /** ListKeys hit the 1000-key wire cap → the list shows the truncation
   * banner (leak B fix 2). */
  keysTruncated: boolean;
  filter: string;
  setFilter: (s: string) => void;
  page: number;
  setPage: (n: number) => void;
  pageSize: number;
  setPageSize: (n: number) => void;
  filteredCount: number;
  /** Current page slice of the filtered keys (client-side pagination). */
  pagedKeys: KeyMeta[];
  /** Batch-fetched values for the current page, keyed by key name. */
  pageValues: Map<string, KeyValueOut>;
  loadValues: (keys: string[]) => Promise<void>;
  selectedKey: KeyMeta | null;
  selectKey: (k: KeyMeta | null) => void;
  history: KeyHistoryEntry[];
  historyLoading: boolean;
  actions: {
    createBucket: (values: BucketFormValues) => Promise<ActionResult>;
    updateBucket: (values: BucketFormValues) => Promise<ActionResult>;
    deleteBucket: (name: string) => Promise<ActionResult>;
    compactBucket: (name: string) => Promise<ActionResult>;
    putKey: (args: PutKeyArgs) => Promise<PutKeyResult>;
    deleteKey: (bucket: string, key: string, mode: "delete" | "purge") => Promise<ActionResult>;
    revertKey: (bucket: string, key: string) => Promise<ActionResult>;
  };
  watch: KvWatchApi;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const byKey = (a: KeyMeta, b: KeyMeta) => a.key.localeCompare(b.key);

/** Client-side key filter: case-insensitive substring on the key name. */
export function filterKeys(keys: KeyMeta[], query: string): KeyMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return keys;
  return keys.filter((k) => k.key.toLowerCase().includes(q));
}

/**
 * Frontend state for the KV page (spec §6.8). While the connection is live
 * and the document is visible (§20.2), one poll cadence
 * (behavior.poll_interval_seconds, default 5s) drives the bucket list and,
 * for the selected bucket, its detail echo + key list; the current page's
 * values are batch-filled through GetKeyValues. Disconnecting stops the loop
 * and clears everything.
 *
 * Error semantics (useConsumers §6.7 同款):
 * - list unavailable_reason → the page renders the guidance panel;
 * - detail/list `not_found` → toast「资源不存在」+ drop the selection + refresh;
 * - mutations: success → toast + refresh; `not_found` → toast + refresh;
 *   other failures → toast with the server原文. putKey conflicts are
 *   returned untouched so KeyEditor can render the §6.8 inline banners.
 */
export function useKv(): KvApi {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";

  const [buckets, setBuckets] = useState<KvBucketSummary[]>([]);
  const [unavailableReason, setUnavailableReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<KvBucketForm | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysTruncated, setKeysTruncated] = useState(false);
  const [filter, setFilterState] = useState("");
  const [page, setPageState] = useState(0);
  const [pageSize, setPageSizeState] = useState(50);
  const [pageValues, setPageValues] = useState<Map<string, KeyValueOut>>(new Map());
  const [selectedKey, setSelectedKey] = useState<KeyMeta | null>(null);
  const [history, setHistory] = useState<KeyHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  // Bumped per poll/refresh so the current page's values re-fetch even when
  // the page's key set is unchanged.
  const [valuesNonce, setValuesNonce] = useState(0);

  const intervalMs = useRef(5_000);
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

  const fetchBuckets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ListKvBuckets();
      const list = res?.kv_buckets ?? [];
      setUnavailableReason(res?.unavailable_reason ?? "");
      setBuckets(list);
      if (res?.error_code && !res.unavailable_reason) {
        toast.error(t("kv.loadFailed", { error: res.error || res.error_code }));
      }
    } catch (err) {
      toast.error(t("kv.loadFailed", { error: errText(err) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const fetchDetail = useCallback(
    async (name: string) => {
      setDetailLoading(true);
      try {
        const d = await GetKvBucketDetail(name);
        if (selectedRef.current !== name) return; // selection moved on mid-flight
        if (d?.error_code) {
          if (d.error_code === "not_found") {
            // The bucket vanished under us: toast once, drop the stale
            // selection and refresh the list (useStreams/useConsumers 同款).
            toast.error(t("kv.error.notFound"));
            selectedRef.current = null;
            setSelected(null);
            void fetchBuckets();
          } else {
            toast.error(t("kv.detailLoadFailed", { error: d.error || d.error_code }));
          }
          return;
        }
        setDetail(d?.form ?? null);
      } catch (err) {
        toast.error(t("kv.detailLoadFailed", { error: errText(err) }));
      } finally {
        setDetailLoading(false);
      }
    },
    [t, fetchBuckets],
  );

  const fetchKeys = useCallback(
    async (name: string) => {
      setKeysLoading(true);
      try {
        const res = await ListKeys(name);
        if (selectedRef.current !== name) return;
        if (res?.error_code) {
          if (res.error_code === "not_found") {
            toast.error(t("kv.error.notFound"));
            selectedRef.current = null;
            setSelected(null);
            setKeys([]);
            setKeysTruncated(false);
            void fetchBuckets();
          } else {
            toast.error(t("kv.keysLoadFailed", { error: res.error || res.error_code }));
          }
          return;
        }
        setKeys([...(res?.keys ?? [])].sort(byKey));
        setKeysTruncated(res?.truncated ?? false);
      } catch (err) {
        toast.error(t("kv.keysLoadFailed", { error: errText(err) }));
      } finally {
        setKeysLoading(false);
      }
    },
    [t, fetchBuckets],
  );

  const loadValues = useCallback(async (keyNames: string[]) => {
    const bucket = selectedRef.current;
    if (!bucket || keyNames.length === 0) {
      setPageValues(new Map());
      return;
    }
    try {
      const res = await GetKeyValues(bucket, keyNames);
      if (selectedRef.current !== bucket) return;
      setPageValues(new Map((res?.values ?? []).map((v) => [v.key, v])));
    } catch {
      /* value fill is best-effort; the metadata columns stay usable */
    }
  }, []);

  const refresh = useCallback(() => {
    if (!connected) return;
    void fetchBuckets();
    const sel = selectedRef.current;
    if (sel) {
      void fetchDetail(sel);
      void fetchKeys(sel);
      setValuesNonce((n) => n + 1);
    }
  }, [connected, fetchBuckets, fetchDetail, fetchKeys]);

  // The poll loop: one cadence drives buckets + selected detail/keys/values.
  // Selection is read through a ref so changing it does not restart the loop.
  useEffect(() => {
    if (!connected || !visible) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await fetchBuckets();
      const sel = selectedRef.current;
      if (sel) {
        await fetchDetail(sel);
        await fetchKeys(sel);
        setValuesNonce((n) => n + 1);
      }
      if (!alive) return;
      timer = setTimeout(() => void tick(), intervalMs.current);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [connected, visible, fetchBuckets, fetchDetail, fetchKeys]);

  // Client-side pagination over the (sorted) key list.
  const filteredKeys = useMemo(() => filterKeys(keys, filter), [keys, filter]);
  const pageCount = Math.max(1, Math.ceil(filteredKeys.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pagedKeys = useMemo(
    () => filteredKeys.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [filteredKeys, safePage, pageSize],
  );
  const pagedKeyJoin = useMemo(() => pagedKeys.map((k) => k.key).join("\n"), [pagedKeys]);

  // Batch-fill the current page's values whenever the page set changes or a
  // poll/refresh bumps the nonce.
  useEffect(() => {
    void loadValues(pagedKeyJoin === "" ? [] : pagedKeyJoin.split("\n"));
  }, [pagedKeyJoin, valuesNonce, loadValues]);

  // Selection change: reset the key area, immediate fetch of detail + keys.
  useEffect(() => {
    selectedRef.current = selected;
    setSelectedKey(null);
    setHistory([]);
    setKeys([]);
    setKeysTruncated(false);
    setPageValues(new Map());
    setPageState(0);
    setDetail(null);
    if (selected && connected) {
      void fetchDetail(selected);
      void fetchKeys(selected);
      setValuesNonce((n) => n + 1);
    }
  }, [selected, connected, fetchDetail, fetchKeys]);

  // Selected key → full revision history (values included, ascending).
  useEffect(() => {
    const bucket = selectedRef.current;
    const key = selectedKey?.key ?? null;
    if (!key || !bucket) {
      setHistory([]);
      return;
    }
    let alive = true;
    setHistoryLoading(true);
    GetKeyHistory(bucket, key)
      .then((res) => {
        if (!alive || selectedKey?.key !== key) return;
        if (res?.error_code) {
          if (res.error_code === "not_found") {
            toast.error(t("kv.error.notFound"));
            setSelectedKey(null);
            void fetchKeys(bucket);
          } else {
            toast.error(t("kv.keyDetail.historyLoadFailed", { error: res.error || res.error_code }));
          }
          setHistory([]);
          return;
        }
        setHistory(res?.entries ?? []);
      })
      .catch((err) => {
        if (alive) toast.error(t("kv.keyDetail.historyLoadFailed", { error: errText(err) }));
      })
      .finally(() => {
        if (alive) setHistoryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedKey, t, fetchKeys]);

  // ---- watch ----

  const [watchActive, setWatchActive] = useState<string | null>(null);
  const [watchEvents, setWatchEvents] = useState<KvWatchEvent[]>([]);
  const [watchDropped, setWatchDropped] = useState(0);
  const [snapshotDone, setSnapshotDone] = useState(false);
  const activeWatchRef = useRef<string | null>(null);

  /** Local reset only (no StopWatch round-trip). */
  const watchClearRef = useRef<() => void>(() => {});
  watchClearRef.current = () => {
    activeWatchRef.current = null;
    setWatchActive(null);
    setWatchEvents([]);
    setWatchDropped(0);
    setSnapshotDone(false);
  };

  // 断连: stop happens via the gated loop above; clear everything so stale
  // data never masquerades as live (watch included — the Go manager stops
  // its watchers on conn:state, so no StopWatch round-trip here).
  useEffect(() => {
    if (connected) return;
    setBuckets([]);
    setUnavailableReason("");
    setDetail(null);
    setKeys([]);
    setKeysTruncated(false);
    setPageValues(new Map());
    setSelected(null);
    selectedRef.current = null;
    setSelectedKey(null);
    setHistory([]);
    watchClearRef.current();
  }, [connected]);

  const select = useCallback((name: string | null) => {
    setSelected(name);
  }, []);

  const setFilter = useCallback((s: string) => {
    setFilterState(s);
    setPageState(0);
  }, []);

  const setPageSize = useCallback((n: number) => {
    setPageSizeState(n);
    setPageState(0);
  }, []);

  const selectKey = useCallback((k: KeyMeta | null) => {
    setSelectedKey(k);
  }, []);

  // ---- mutation actions ----

  /** Shared mutation tail. Success → toast + refresh(); not_found → the
   * resource vanished under us → toast「资源不存在」+ refresh(); any other
   * failure → toast with the server原文. The result is always returned so a
   * form/dialog can additionally render error_code=validation inline. */
  const finishAction = useCallback(
    (res: ActionResult | null | undefined, okMsg: string): ActionResult => {
      const r: ActionResult = res ?? { error_code: "", error: "" };
      if (!r.error_code) {
        toast.success(okMsg);
        refresh();
      } else if (r.error_code === "not_found") {
        toast.error(t("kv.error.notFound"));
        refresh();
      } else {
        toast.error(t("kv.error.actionFailed", { error: r.error || r.error_code }));
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
      toast.error(t("kv.error.actionFailed", { error: msg }));
      return { error_code: "server", error: msg };
    },
    [t],
  );

  const createBucket = useCallback(
    async (values: BucketFormValues): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await CreateKvBucket(bucketFormToWire(values))) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("kv.done.bucketCreated", { name: values.name }));
    },
    [t, finishAction, failLocal],
  );

  const updateBucket = useCallback(
    async (values: BucketFormValues): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await UpdateKvBucket(bucketFormToWire(values))) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("kv.done.bucketUpdated", { name: values.name }));
    },
    [t, finishAction, failLocal],
  );

  const deleteBucket = useCallback(
    async (name: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await DeleteKvBucket(name)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      if (!res?.error_code && selectedRef.current === name) {
        // Drop the selection BEFORE the refresh so the next poll never
        // 404-toasts on the just-deleted bucket (useStreams 同款).
        selectedRef.current = null;
        setSelected(null);
      }
      return finishAction(res, t("kv.done.bucketDeleted", { name }));
    },
    [t, finishAction, failLocal],
  );

  const compactBucket = useCallback(
    async (name: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await CompactKvBucket(name)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("kv.done.compacted", { name }));
    },
    [t, finishAction, failLocal],
  );

  const putKey = useCallback(
    async (args: PutKeyArgs): Promise<PutKeyResult> => {
      let res: PutKeyResult | null;
      try {
        res = await PutKey(args.bucket, args.key, args.payloadB64, args.mode, args.expectedRevision);
      } catch (err) {
        const r = failLocal(err);
        return { ...r, revision: 0, current_revision: 0 };
      }
      const r: PutKeyResult = res ?? { error_code: "server", error: "", revision: 0, current_revision: 0 };
      if (!r.error_code) {
        toast.success(t("kv.done.keyPut", { key: args.key, revision: r.revision }));
        refresh();
      } else if (r.error_code === "conflict") {
        // §6.8 异常 1/2: the editor renders the inline banner (create) /
        // revision refresh (update) — no toast, the dialog stays open.
      } else if (r.error_code === "not_found") {
        toast.error(t("kv.error.notFound"));
        refresh();
      } else {
        toast.error(t("kv.error.actionFailed", { error: r.error || r.error_code }));
      }
      return r;
    },
    [t, refresh, failLocal],
  );

  const deleteKey = useCallback(
    async (bucket: string, key: string, mode: "delete" | "purge"): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await DeleteKey(bucket, key, mode)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(
        res,
        mode === "purge"
          ? t("kv.done.keyPurged", { key })
          : t("kv.done.keyDeleted", { key }),
      );
    },
    [t, finishAction, failLocal],
  );

  const revertKey = useCallback(
    async (bucket: string, key: string): Promise<ActionResult> => {
      let res: PutKeyResult | null;
      try {
        res = await RevertKey(bucket, key);
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("kv.done.keyReverted", { key }));
    },
    [t, finishAction, failLocal],
  );

  // ---- watch control ----

  // The kv:watch subscription lives for the hook's lifetime; events for
  // other/old watch ids are ignored by id so a stale delivery cannot leak in.
  useEffect(() => {
    const off = Events.On("kv:watch", (e: { data?: unknown }) => {
      const ev = e?.data as Partial<KvWatchEvent> | undefined;
      if (!ev || typeof ev.watch_id !== "string" || ev.watch_id !== activeWatchRef.current) return;
      setWatchEvents((prev) => applyWatchEvent(prev, ev));
      setWatchDropped(typeof ev.dropped_total === "number" ? ev.dropped_total : 0);
      // The sentinel ships with key omitted (omitempty) or as "" — both mean
      // the initial snapshot is complete.
      if (typeof ev.key !== "string" || ev.key === "") setSnapshotDone(true);
    });
    return () => {
      off();
    };
  }, []);

  // Unmount while watching → release the server-side watcher silently.
  useEffect(() => {
    return () => {
      const id = activeWatchRef.current;
      if (id) StopWatch(id).catch(() => {});
    };
  }, []);

  const watchStart = useCallback(
    async (bucket: string, keysFilter: string) => {
      // One watcher per panel: stop the previous one first (idempotent —
      // an unknown id lands as not_found and is swallowed below).
      const prev = activeWatchRef.current;
      if (prev) StopWatch(prev).catch(() => {});
      try {
        const res = await CreateKvWatch(bucket, keysFilter);
        if (res?.error_code) {
          toast.error(t("kv.watch.startFailed", { error: res.error || res.error_code }));
          return;
        }
        activeWatchRef.current = res?.watch_id ?? null;
        setWatchActive(res?.watch_id ?? null);
        setWatchEvents([]);
        setWatchDropped(0);
        setSnapshotDone(false);
      } catch (err) {
        toast.error(t("kv.watch.startFailed", { error: errText(err) }));
      }
    },
    [t],
  );

  const watchStop = useCallback(() => {
    const id = activeWatchRef.current;
    watchClearRef.current();
    if (id) StopWatch(id).catch(() => {});
  }, []);

  const actions = useMemo(
    () => ({ createBucket, updateBucket, deleteBucket, compactBucket, putKey, deleteKey, revertKey }),
    [createBucket, updateBucket, deleteBucket, compactBucket, putKey, deleteKey, revertKey],
  );

  const watch = useMemo<KvWatchApi>(
    () => ({
      active: watchActive,
      events: watchEvents,
      dropped: watchDropped,
      snapshotDone,
      start: watchStart,
      stop: watchStop,
    }),
    [watchActive, watchEvents, watchDropped, snapshotDone, watchStart, watchStop],
  );

  return {
    buckets,
    unavailableReason,
    loading,
    refresh,
    selected,
    select,
    detail,
    detailLoading,
    keys,
    keysLoading,
    keysTruncated,
    filter,
    setFilter,
    page: safePage,
    setPage: setPageState,
    pageSize,
    setPageSize,
    filteredCount: filteredKeys.length,
    pagedKeys,
    pageValues,
    loadValues,
    selectedKey,
    selectKey,
    history,
    historyLoading,
    actions,
    watch,
  };
}
