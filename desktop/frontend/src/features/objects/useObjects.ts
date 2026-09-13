import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import {
  CreateObjBucket,
  CreateObjWatch,
  DeleteObjBucket,
  DeleteObject,
  DownloadObject,
  GetObjBucketDetail,
  GetSettings,
  ListObjBuckets,
  ListObjects,
  PickDownloadDirectory,
  RenameObject,
  SealObjBucket,
  StopWatch,
  UpdateObjBucket,
  UploadObject,
  type ObjBucketForm,
  type ObjBucketSummary,
  type ObjectOut,
} from "../../lib/bindings";
import {
  basename,
  objBucketFormToWire,
  type ActionResult,
  type ObjBucketFormValues,
} from "./schema";

/**
 * One object-bucket watch event on the `obj:watch` wire (Go internal/buckets
 * ObjWatchEvent — snake JSON tags are a frozen contract; events are not part
 * of the bindings surface). name === "" is the initial-snapshot sentinel;
 * dropped_total is the emitter's cumulative drop counter.
 */
export interface ObjWatchEvent {
  watch_id: string;
  bucket: string;
  name: string;
  size: number;
  chunks: number;
  digest: string;
  mod_time_ms: number;
  deleted: boolean;
  dropped_total: number;
}

/**
 * One transfer event on the `obj:transfer` wire (Go ObjTransferEvent). Phase
 * is monotonic per transfer_id and the FIRST event is always "running"
 * (guaranteed by the backend); digest_match is null/absent while running and
 * true/false on download completion.
 */
export interface ObjTransferEvent {
  transfer_id: string;
  bucket: string;
  name: string;
  direction: "upload" | "download";
  phase: "running" | "complete" | "incomplete";
  bytes_done: number;
  bytes_total: number;
  digest_match: boolean | null;
  error: string;
}

/** Frontend display cap for the watch ring (kv 同款 bounded ring). */
export const WATCH_RING_CAP = 10_000;

/**
 * applyWatchEvent folds one `obj:watch` event into the ring, keeping at most
 * the newest `cap` events. Malformed payloads are dropped; returns prev
 * unchanged so React bails out of the re-render. Pure so the 10k bound is
 * unit-testable without React.
 */
export function applyWatchEvent(
  ring: ObjWatchEvent[],
  ev: unknown,
  cap: number = WATCH_RING_CAP,
): ObjWatchEvent[] {
  const e = ev as Partial<ObjWatchEvent> | null | undefined;
  if (!e || typeof e.watch_id !== "string") return ring;
  // name is omitempty on the Go wire: the sentinel ships without a "name"
  // field at all, so missing strings normalize to "" (sentinel).
  const norm: ObjWatchEvent = {
    watch_id: e.watch_id,
    bucket: typeof e.bucket === "string" ? e.bucket : "",
    name: typeof e.name === "string" ? e.name : "",
    size: typeof e.size === "number" ? e.size : 0,
    chunks: typeof e.chunks === "number" ? e.chunks : 0,
    digest: typeof e.digest === "string" ? e.digest : "",
    mod_time_ms: typeof e.mod_time_ms === "number" ? e.mod_time_ms : 0,
    deleted: e.deleted === true,
    dropped_total: typeof e.dropped_total === "number" ? e.dropped_total : 0,
  };
  const next = [...ring, norm];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Whitelist parse of one obj:transfer payload (connstate parseEvent style):
 * only known values are accepted, malformed → null. */
export function parseTransferEvent(data: unknown): ObjTransferEvent | null {
  const e = (data ?? {}) as Record<string, unknown> | null | undefined;
  if (!e || typeof e.transfer_id !== "string" || e.transfer_id === "") return null;
  if (e.direction !== "upload" && e.direction !== "download") return null;
  if (e.phase !== "running" && e.phase !== "complete" && e.phase !== "incomplete") return null;
  return {
    transfer_id: e.transfer_id,
    bucket: typeof e.bucket === "string" ? e.bucket : "",
    name: typeof e.name === "string" ? e.name : "",
    direction: e.direction,
    phase: e.phase,
    bytes_done: typeof e.bytes_done === "number" && e.bytes_done >= 0 ? e.bytes_done : 0,
    bytes_total: typeof e.bytes_total === "number" && e.bytes_total >= 0 ? e.bytes_total : 0,
    digest_match: typeof e.digest_match === "boolean" ? e.digest_match : null,
    error: typeof e.error === "string" ? e.error : "",
  };
}

/** One row of the upload queue. The ref-held list is the source of truth; the
 * React state mirrors it for rendering (the sequential runner must never read
 * a stale pending item between state flushes). */
export interface UploadQueueItem {
  id: string;
  path: string;
  /** Optional target name; "" keeps the file's basename (server-side rule). */
  rename: string;
  status: "pending" | "uploading" | "complete" | "incomplete";
  /** transfer_id linked from obj:transfer events once the upload starts. */
  transferId: string | null;
  /** Server原文 for an incomplete upload. */
  error: string;
}

/** Per-object download state, keyed by object name (one download at a time —
 * the backend is single-flight — so the name key is unambiguous). */
export interface ObjDownloadState {
  phase: "running" | "complete" | "incomplete";
  bytes_done: number;
  bytes_total: number;
  /** null/absent while running; true/false on completion. */
  digest_match: boolean | null;
  error: string;
  /** The directory the object was downloaded to (OpenInFileManager join). */
  dir: string;
}

/** The watch sub-surface consumed by ObjectWatchPanel. */
export interface ObjWatchApi {
  active: string | null;
  events: ObjWatchEvent[];
  dropped: number;
  /** True once the name="" sentinel (initial snapshot complete) arrived. */
  snapshotDone: boolean;
  start: (bucket: string) => Promise<void>;
  stop: () => void;
}

/** The upload queue sub-surface consumed by UploadPanel. */
export interface ObjUploadApi {
  items: UploadQueueItem[];
  /** True while the sequential runner is draining the queue. */
  running: boolean;
  add: (paths: string[]) => void;
  setRename: (id: string, rename: string) => void;
  remove: (id: string) => void;
  /** Drains pending items one UploadObject at a time (backend single-flight;
   * the UI owns the queue). */
  start: (bucket: string) => Promise<void>;
  /** Re-queue one incomplete item and drain again. */
  retry: (id: string, bucket: string) => Promise<void>;
  /** Drop every non-running item (queue reset when the panel closes). */
  clear: () => void;
}

/** The useObjects surface consumed by ObjectsPage / ObjectList / UploadPanel /
 * ObjectWatchPanel (brief contract). */
export interface ObjectsApi {
  buckets: ObjBucketSummary[];
  unavailableReason: string;
  loading: boolean;
  refresh: () => void;
  selected: string | null;
  select: (name: string | null) => void;
  /** Selected bucket's editable form echo + sealed flag (GetObjBucketDetail). */
  detail: { form: ObjBucketForm | null; sealed: boolean };
  detailLoading: boolean;
  objects: ObjectOut[];
  objectsLoading: boolean;
  /** All transfer events seen this session, keyed by transfer_id. */
  transfers: Map<string, ObjTransferEvent>;
  /** Frontend-diffed transfer rate per transfer_id (bytes/s). */
  rates: Map<string, number>;
  /** Download state per object name. */
  downloads: Map<string, ObjDownloadState>;
  downloadObject: (bucket: string, name: string) => Promise<void>;
  /** Sequential upload queue + per-file progress linkage. */
  uploads: ObjUploadApi;
  actions: {
    createBucket: (values: ObjBucketFormValues) => Promise<ActionResult>;
    updateBucket: (values: ObjBucketFormValues) => Promise<ActionResult>;
    deleteBucket: (name: string) => Promise<ActionResult>;
    sealBucket: (name: string) => Promise<ActionResult>;
    deleteObject: (bucket: string, name: string) => Promise<ActionResult>;
    renameObject: (bucket: string, name: string, newName: string) => Promise<ActionResult>;
  };
  watch: ObjWatchApi;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const byName = (a: ObjectOut, b: ObjectOut) => a.name.localeCompare(b.name);

const BUSY_TEXT = "another object transfer is already running";

const isBusyResult = (r: ActionResult): boolean =>
  r.error_code === "validation" && r.error.includes(BUSY_TEXT);

/**
 * Frontend state for the Objects page (spec §6.9). While the connection is
 * live and the document is visible (§20.2), one poll cadence drives the
 * bucket list and, for the selected bucket, its detail echo + object list.
 * Disconnecting stops the loop and clears everything.
 *
 * Error semantics (useKv/useConsumers 同款):
 * - list unavailable_reason → the page renders the guidance panel;
 * - detail/list `not_found` → toast「资源不存在」+ drop the selection + refresh;
 * - mutations: success → toast + refresh; `not_found` → toast + refresh;
 *   other failures → toast with the server原文.
 *
 * Transfers: obj:transfer events land in `transfers` keyed by transfer_id;
 * the upload queue links its active item to a fresh upload transfer_id (the
 * queue is strictly sequential, so the first unseen upload event for the
 * item's object name belongs to it) and downloads are tracked per object
 * name. Rates are frontend diffs of consecutive running events.
 */
export function useObjects(): ObjectsApi {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";

  const [buckets, setBuckets] = useState<ObjBucketSummary[]>([]);
  const [unavailableReason, setUnavailableReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ form: ObjBucketForm | null; sealed: boolean }>({
    form: null,
    sealed: false,
  });
  const [detailLoading, setDetailLoading] = useState(false);
  const [objects, setObjects] = useState<ObjectOut[]>([]);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [transfers, setTransfers] = useState<Map<string, ObjTransferEvent>>(new Map());
  const [rates, setRates] = useState<Map<string, number>>(new Map());
  const [downloads, setDownloads] = useState<Map<string, ObjDownloadState>>(new Map());

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
      const res = await ListObjBuckets();
      const list = res?.obj_buckets ?? [];
      setUnavailableReason(res?.unavailable_reason ?? "");
      setBuckets(list);
      if (res?.error_code && !res.unavailable_reason) {
        toast.error(t("objects.loadFailed", { error: res.error || res.error_code }));
      }
    } catch (err) {
      toast.error(t("objects.loadFailed", { error: errText(err) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const fetchDetail = useCallback(
    async (name: string) => {
      setDetailLoading(true);
      try {
        const d = await GetObjBucketDetail(name);
        if (selectedRef.current !== name) return; // selection moved on mid-flight
        if (d?.error_code) {
          if (d.error_code === "not_found") {
            // The bucket vanished under us: toast once, drop the stale
            // selection and refresh the list (useKv 同款).
            toast.error(t("objects.error.notFound"));
            selectedRef.current = null;
            setSelected(null);
            void fetchBuckets();
          } else {
            toast.error(t("objects.detailLoadFailed", { error: d.error || d.error_code }));
          }
          return;
        }
        setDetail({ form: d?.form ?? null, sealed: d?.sealed === true });
      } catch (err) {
        toast.error(t("objects.detailLoadFailed", { error: errText(err) }));
      } finally {
        setDetailLoading(false);
      }
    },
    [t, fetchBuckets],
  );

  const fetchObjects = useCallback(
    async (name: string) => {
      setObjectsLoading(true);
      try {
        const res = await ListObjects(name);
        if (selectedRef.current !== name) return;
        if (res?.error_code) {
          if (res.error_code === "not_found") {
            toast.error(t("objects.error.notFound"));
            selectedRef.current = null;
            setSelected(null);
            setObjects([]);
            void fetchBuckets();
          } else {
            toast.error(t("objects.objectsLoadFailed", { error: res.error || res.error_code }));
          }
          return;
        }
        setObjects([...(res?.objects ?? [])].sort(byName));
      } catch (err) {
        toast.error(t("objects.objectsLoadFailed", { error: errText(err) }));
      } finally {
        setObjectsLoading(false);
      }
    },
    [t, fetchBuckets],
  );

  const refresh = useCallback(() => {
    if (!connected) return;
    void fetchBuckets();
    const sel = selectedRef.current;
    if (sel) {
      void fetchDetail(sel);
      void fetchObjects(sel);
    }
  }, [connected, fetchBuckets, fetchDetail, fetchObjects]);

  // The poll loop: one cadence drives buckets + selected detail/objects.
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
        await fetchObjects(sel);
      }
      if (!alive) return;
      timer = setTimeout(() => void tick(), intervalMs.current);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [connected, visible, fetchBuckets, fetchDetail, fetchObjects]);

  // Selection change: reset the object area, immediate fetch of detail+objects.
  useEffect(() => {
    selectedRef.current = selected;
    setObjects([]);
    setDetail({ form: null, sealed: false });
    setDownloads(new Map());
    if (selected && connected) {
      void fetchDetail(selected);
      void fetchObjects(selected);
    }
  }, [selected, connected, fetchDetail, fetchObjects]);

  // 断连: stop happens via the gated loop above; clear everything so stale
  // data never masquerades as live (watch included — the Go manager stops its
  // watchers on conn:state, so no StopWatch round-trip here).
  useEffect(() => {
    if (connected) return;
    setBuckets([]);
    setUnavailableReason("");
    setDetail({ form: null, sealed: false });
    setObjects([]);
    setSelected(null);
    selectedRef.current = null;
    setTransfers(new Map());
    setRates(new Map());
    setDownloads(new Map());
    uploadClearRef.current();
    watchClearRef.current();
  }, [connected]);

  const select = useCallback((name: string | null) => {
    setSelected(name);
  }, []);

  // ---- mutation actions ----

  /** Shared mutation tail (useKv finishAction 同款). */
  const finishAction = useCallback(
    (res: ActionResult | null | undefined, okMsg: string): ActionResult => {
      const r: ActionResult = res ?? { error_code: "", error: "" };
      if (!r.error_code) {
        toast.success(okMsg);
        refresh();
      } else if (r.error_code === "not_found") {
        toast.error(t("objects.error.notFound"));
        refresh();
      } else {
        toast.error(t("objects.error.actionFailed", { error: r.error || r.error_code }));
      }
      return r;
    },
    [t, refresh],
  );

  /** Transport-level rejection (Wails promise threw). */
  const failLocal = useCallback(
    (err: unknown): ActionResult => {
      const msg = errText(err);
      toast.error(t("objects.error.actionFailed", { error: msg }));
      return { error_code: "server", error: msg };
    },
    [t],
  );

  const createBucket = useCallback(
    async (values: ObjBucketFormValues): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await CreateObjBucket(objBucketFormToWire(values))) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("objects.done.bucketCreated", { name: values.name }));
    },
    [t, finishAction, failLocal],
  );

  const updateBucket = useCallback(
    async (values: ObjBucketFormValues): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await UpdateObjBucket(objBucketFormToWire(values))) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("objects.done.bucketUpdated", { name: values.name }));
    },
    [t, finishAction, failLocal],
  );

  const deleteBucket = useCallback(
    async (name: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await DeleteObjBucket(name)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      if (!res?.error_code && selectedRef.current === name) {
        // Drop the selection BEFORE the refresh so the next poll never
        // 404-toasts on the just-deleted bucket (useKv 同款).
        selectedRef.current = null;
        setSelected(null);
      }
      return finishAction(res, t("objects.done.bucketDeleted", { name }));
    },
    [t, finishAction, failLocal],
  );

  const sealBucket = useCallback(
    async (name: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await SealObjBucket(name)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("objects.done.sealed", { name }));
    },
    [t, finishAction, failLocal],
  );

  const deleteObject = useCallback(
    async (bucket: string, name: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await DeleteObject(bucket, name)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("objects.done.objectDeleted", { name }));
    },
    [t, finishAction, failLocal],
  );

  const renameObject = useCallback(
    async (bucket: string, name: string, newName: string): Promise<ActionResult> => {
      let res: ActionResult | null;
      try {
        res = (await RenameObject(bucket, name, newName)) as ActionResult | null;
      } catch (err) {
        return failLocal(err);
      }
      return finishAction(res, t("objects.done.objectRenamed", { from: name, to: newName }));
    },
    [t, finishAction, failLocal],
  );

  // ---- download flow ----

  // Directories chosen per object name (OpenInFileManager join source); a ref
  // so the event handler can enrich download state without re-subscribing.
  const downloadDirsRef = useRef(new Map<string, string>());
  // Names whose download has produced at least one transfer event.
  const downloadSeenRef = useRef(new Set<string>());

  const downloadObject = useCallback(
    async (bucket: string, name: string) => {
      const dir = await PickDownloadDirectory();
      if (!dir) return; // user cancelled the native chooser — no request
      downloadDirsRef.current.set(name, dir);
      downloadSeenRef.current.delete(name);
      setDownloads((prev) =>
        new Map(prev).set(name, {
          phase: "running",
          bytes_done: 0,
          bytes_total: 0,
          digest_match: null,
          error: "",
          dir,
        }),
      );
      let res: ActionResult;
      try {
        res = ((await DownloadObject(bucket, name, dir)) as ActionResult | null) ?? {
          error_code: "server",
          error: "",
        };
      } catch (err) {
        res = { error_code: "server", error: errText(err) };
      }
      if (res.error_code) {
        // Blocked before start (disk gate / busy / not found …) → toast the
        // server原文; if no event ever arrived there is no row progress to
        // show, so clear the placeholder state.
        toast.error(t("objects.download.failed", { error: res.error || res.error_code }));
        if (!downloadSeenRef.current.has(name)) {
          setDownloads((prev) => {
            const m = new Map(prev);
            m.delete(name);
            return m;
          });
        }
      }
    },
    [t],
  );

  // ---- upload queue ----

  const [uploadItems, setUploadItems] = useState<UploadQueueItem[]>([]);
  const [uploadRunning, setUploadRunning] = useState(false);
  // Source of truth for the sequential runner (state is the render mirror).
  const uploadItemsRef = useRef<UploadQueueItem[]>([]);
  const uploadRunningRef = useRef(false);
  const activeUploadRef = useRef<string | null>(null);
  // itemId → linked transfer_id (first unseen upload event for the item's
  // object name while it is the active item).
  const itemTransferRef = useRef(new Map<string, string>());
  const uploadSeq = useRef(0);

  /** Patch one queue item in the ref list AND the render state atomically. */
  const patchUploadItem = useCallback((id: string, patch: Partial<UploadQueueItem>) => {
    uploadItemsRef.current = uploadItemsRef.current.map((it) =>
      it.id === id ? { ...it, ...patch } : it,
    );
    setUploadItems(uploadItemsRef.current);
  }, []);

  const uploadsAdd = useCallback(
    (paths: string[]) => {
      const items = paths
        .filter((p) => p)
        .map((path) => {
          uploadSeq.current += 1;
          return {
            id: `u-${uploadSeq.current}`,
            path,
            rename: "",
            status: "pending" as const,
            transferId: null,
            error: "",
          };
        });
      if (items.length === 0) return;
      uploadItemsRef.current = [...uploadItemsRef.current, ...items];
      setUploadItems(uploadItemsRef.current);
    },
    [],
  );

  const uploadsSetRename = useCallback(
    (id: string, rename: string) => patchUploadItem(id, { rename }),
    [patchUploadItem],
  );

  const uploadsRemove = useCallback((id: string) => {
    if (uploadItemsRef.current.some((it) => it.id === id && it.status === "uploading")) return;
    uploadItemsRef.current = uploadItemsRef.current.filter((it) => it.id !== id);
    setUploadItems(uploadItemsRef.current);
  }, []);

  const uploadsClear = useCallback(() => {
    if (uploadRunningRef.current) return;
    uploadItemsRef.current = [];
    setUploadItems([]);
  }, []);

  /** Drain the pending queue: one UploadObject at a time, next starts when
   * the previous resolves (backend single-flight — the queue IS the gate).
   * Per complete → refresh so the object list grows as files land. */
  const drainUploads = useCallback(
    async (bucket: string) => {
      if (uploadRunningRef.current) return;
      uploadRunningRef.current = true;
      setUploadRunning(true);
      try {
        for (;;) {
          const next = uploadItemsRef.current.find((it) => it.status === "pending");
          if (!next) break;
          activeUploadRef.current = next.id;
          itemTransferRef.current.delete(next.id);
          patchUploadItem(next.id, { status: "uploading", transferId: null, error: "" });
          let res: ActionResult;
          try {
            res = ((await UploadObject(bucket, next.path, next.rename.trim())) as
              | ActionResult
              | null) ?? { error_code: "server", error: "" };
          } catch (err) {
            res = { error_code: "server", error: errText(err) };
          }
          activeUploadRef.current = null;
          if (!res.error_code) {
            patchUploadItem(next.id, { status: "complete", error: "" });
            refresh();
          } else if (isBusyResult(res)) {
            // Another transfer (e.g. a download) holds the single-flight
            // mutex: toast the 原文 and re-queue; the runner stops so the
            // operator can retry when the device frees up.
            toast.error(t("objects.upload.failed", { error: res.error || res.error_code }));
            patchUploadItem(next.id, { status: "pending", transferId: null });
            break;
          } else {
            patchUploadItem(next.id, {
              status: "incomplete",
              error: res.error || res.error_code,
            });
          }
        }
      } finally {
        uploadRunningRef.current = false;
        setUploadRunning(false);
        activeUploadRef.current = null;
      }
    },
    [t, patchUploadItem, refresh],
  );

  const uploadsStart = useCallback(
    async (bucket: string) => {
      await drainUploads(bucket);
    },
    [drainUploads],
  );

  const uploadsRetry = useCallback(
    async (id: string, bucket: string) => {
      const item = uploadItemsRef.current.find((it) => it.id === id);
      if (!item || item.status !== "incomplete") return;
      patchUploadItem(id, { status: "pending", transferId: null, error: "" });
      await drainUploads(bucket);
    },
    [drainUploads, patchUploadItem],
  );

  const uploadClearRef = useRef<() => void>(() => {});
  uploadClearRef.current = () => {
    uploadItemsRef.current = [];
    uploadRunningRef.current = false;
    activeUploadRef.current = null;
    itemTransferRef.current.clear();
    setUploadItems([]);
    setUploadRunning(false);
  };

  // ---- transfer events (obj:transfer) ----

  // Last running sample per transfer_id for the frontend rate diff.
  const rateSampleRef = useRef(new Map<string, { bytes: number; t: number }>());

  useEffect(() => {
    const off = Events.On("obj:transfer", (e: { data?: unknown }) => {
      const ev = parseTransferEvent(e?.data);
      if (!ev) return;
      setTransfers((prev) => new Map(prev).set(ev.transfer_id, ev));
      // Rate = frontend diff of consecutive running events (bytes/s).
      if (ev.phase === "running") {
        const now = Date.now();
        const prevSample = rateSampleRef.current.get(ev.transfer_id);
        if (prevSample && now > prevSample.t && ev.bytes_done >= prevSample.bytes) {
          const bps = Math.round(((ev.bytes_done - prevSample.bytes) * 1000) / (now - prevSample.t));
          setRates((prev) => new Map(prev).set(ev.transfer_id, bps));
        }
        rateSampleRef.current.set(ev.transfer_id, { bytes: ev.bytes_done, t: now });
      }
      // Link the active queue item to its transfer (strictly sequential queue
      // + matching object name ⇒ unambiguous; retries delete the old link).
      if (ev.direction === "upload" && activeUploadRef.current) {
        const itemId = activeUploadRef.current;
        const item = uploadItemsRef.current.find((it) => it.id === itemId);
        const expected = item ? item.rename.trim() || basename(item.path) : "";
        if (!itemTransferRef.current.has(itemId) && ev.name === expected) {
          itemTransferRef.current.set(itemId, ev.transfer_id);
          patchUploadItem(itemId, { transferId: ev.transfer_id });
        }
      }
      // Download progress keyed by object name.
      if (ev.direction === "download") {
        downloadSeenRef.current.add(ev.name);
        setDownloads((prev) => {
          const dir = downloadDirsRef.current.get(ev.name) ?? prev.get(ev.name)?.dir ?? "";
          return new Map(prev).set(ev.name, {
            phase: ev.phase,
            bytes_done: ev.bytes_done,
            bytes_total: ev.bytes_total,
            digest_match: ev.digest_match,
            error: ev.error,
            dir,
          });
        });
      }
    });
    return () => {
      off();
    };
  }, [patchUploadItem]);

  // ---- watch ----

  const [watchActive, setWatchActive] = useState<string | null>(null);
  const [watchEvents, setWatchEvents] = useState<ObjWatchEvent[]>([]);
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

  // The obj:watch subscription lives for the hook's lifetime; events for
  // other/old watch ids are ignored by id so a stale delivery cannot leak in.
  useEffect(() => {
    const off = Events.On("obj:watch", (e: { data?: unknown }) => {
      const ev = e?.data as Partial<ObjWatchEvent> | undefined;
      if (!ev || typeof ev.watch_id !== "string" || ev.watch_id !== activeWatchRef.current) return;
      setWatchEvents((prev) => applyWatchEvent(prev, ev));
      setWatchDropped(typeof ev.dropped_total === "number" ? ev.dropped_total : 0);
      // The sentinel ships with name omitted (omitempty) or as "" — both mean
      // the initial snapshot is complete.
      if (typeof ev.name !== "string" || ev.name === "") setSnapshotDone(true);
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
    async (bucket: string) => {
      // One watcher per panel: stop the previous one first (idempotent).
      const prev = activeWatchRef.current;
      if (prev) StopWatch(prev).catch(() => {});
      try {
        const res = await CreateObjWatch(bucket);
        if (res?.error_code) {
          toast.error(t("objects.watch.startFailed", { error: res.error || res.error_code }));
          return;
        }
        activeWatchRef.current = res?.watch_id ?? null;
        setWatchActive(res?.watch_id ?? null);
        setWatchEvents([]);
        setWatchDropped(0);
        setSnapshotDone(false);
      } catch (err) {
        toast.error(t("objects.watch.startFailed", { error: errText(err) }));
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
    () => ({
      createBucket,
      updateBucket,
      deleteBucket,
      sealBucket,
      deleteObject,
      renameObject,
    }),
    [createBucket, updateBucket, deleteBucket, sealBucket, deleteObject, renameObject],
  );

  const uploads = useMemo<ObjUploadApi>(
    () => ({
      items: uploadItems,
      running: uploadRunning,
      add: uploadsAdd,
      setRename: uploadsSetRename,
      remove: uploadsRemove,
      start: uploadsStart,
      retry: uploadsRetry,
      clear: uploadsClear,
    }),
    [uploadItems, uploadRunning, uploadsAdd, uploadsSetRename, uploadsRemove, uploadsStart, uploadsRetry, uploadsClear],
  );

  const watch = useMemo<ObjWatchApi>(
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
    objects,
    objectsLoading,
    transfers,
    rates,
    downloads,
    downloadObject,
    actions,
    uploads,
    watch,
  };
}
