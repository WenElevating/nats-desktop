import { render, screen, fireEvent, act, within, cleanup } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { KeyValuePage, matchBuckets } from "../src/features/kv/KeyValuePage";
import { applyWatchEvent, type KvWatchEvent } from "../src/features/kv/useKv";
import {
  MAX_VALUE_BYTES,
  bucketFormSchema,
  bucketFormToWire,
  collectErrors,
  emptyBucketFormValues,
  isValidKeyName,
  keyEditorSchema,
  keyModeSchema,
} from "../src/features/kv/schema";
import {
  ListKvBuckets,
  GetKvBucketDetail,
  CreateKvBucket,
  UpdateKvBucket,
  DeleteKvBucket,
  CompactKvBucket,
  ListKeys,
  GetKeyValues,
  GetKeyHistory,
  PutKey,
  DeleteKey,
  RevertKey,
  CreateKvWatch,
  StopWatch,
  GetSettings,
  type KvBucketSummary,
  type KvBucketForm,
  type KeyMeta,
  type KeyValueOut,
  type KeyHistoryEntry,
} from "../src/lib/bindings";
import { toBase64 } from "../src/lib/base64";
import { ConfirmProvider } from "../src/lib/confirm";

// Real i18n (en resources); mocked: connstate (hoisted mutable), the Wails
// bindings, @wailsio/runtime Events (kv:watch handler capture), and sonner
// (toast text assertions) — the established M3 test pattern.
const connState = vi.hoisted(() => ({
  state: "connected",
  context: "dev",
  rttMs: 5,
  reason: "",
}));

// Event handler capture shared between the runtime mock and the fire helper.
const runtime = vi.hoisted(() => ({
  handlers: new Map<string, (e: { data: unknown }) => void>(),
  offs: [] as string[],
}));

vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: (name: string, cb: (e: { data: unknown }) => void) => {
      runtime.handlers.set(name, cb);
      return () => {
        runtime.offs.push(name);
        runtime.handlers.delete(name);
      };
    },
  },
}));

vi.mock("../src/app/connstate", () => ({
  useConnState: () => connState,
}));

vi.mock("../src/lib/bindings", () => ({
  ListKvBuckets: vi.fn(),
  GetKvBucketDetail: vi.fn(),
  CreateKvBucket: vi.fn(),
  UpdateKvBucket: vi.fn(),
  DeleteKvBucket: vi.fn(),
  CompactKvBucket: vi.fn(),
  ListKeys: vi.fn(),
  GetKeyValues: vi.fn(),
  GetKeyHistory: vi.fn(),
  PutKey: vi.fn(),
  DeleteKey: vi.fn(),
  RevertKey: vi.fn(),
  CreateKvWatch: vi.fn(),
  StopWatch: vi.fn(),
  GetSettings: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";

// jsdom has no layout: the setup.ts ResizeObserver stub never reports a size,
// so @tanstack/react-virtual would measure a 0px viewport and render no rows.
// Report a 1024x280 border box on observe (like the streams/sessions suites).
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

// ---- fixtures ----

const BUCKET = "ORDERS";

const bucketSummary = (over: Partial<KvBucketSummary> = {}): KvBucketSummary => ({
  name: BUCKET,
  description: "kv bucket",
  values: 2,
  history: 5,
  ttl_seconds: 60,
  bytes: 2048,
  max_bytes: -1,
  replicas: 1,
  is_compressed: false,
  ...over,
});

const detailForm = (over: Partial<KvBucketForm> = {}): KvBucketForm => ({
  name: BUCKET,
  description: "kv bucket",
  history: 5,
  ttl_seconds: 60,
  max_bytes: -1,
  replicas: 1,
  max_value_size: 0,
  ...over,
});

const keyMeta = (key: string, over: Partial<KeyMeta> = {}): KeyMeta => ({
  key,
  revision: 1,
  created_ms: 1_770_000_000_000,
  operation: "put",
  ...over,
});

const keyValue = (key: string, over: Partial<KeyValueOut> = {}): KeyValueOut => ({
  key,
  revision: 1,
  payload_b64: toBase64(`value-${key}`),
  payload_size: `value-${key}`.length,
  is_utf8: true,
  created_ms: 1_770_000_000_000,
  operation: "put",
  not_found: false,
  ...over,
});

const histEntry = (revision: number, over: Partial<KeyHistoryEntry> = {}): KeyHistoryEntry => ({
  revision,
  payload_b64: toBase64(`value-r${revision}`),
  payload_size: `value-r${revision}`.length,
  is_utf8: true,
  created_ms: 1_770_000_000_000 + revision * 1000,
  operation: "put",
  ...over,
});

const settingsFixture = () => ({
  appearance: { theme: "system", language: "en" },
  behavior: {
    poll_interval_seconds: 5,
    request_timeout_seconds: 5,
    confirm_level: "standard",
    session_push_batching: false,
    session_buffer_size: 10000,
    log_level: "info",
  },
  privacy: { crash_reports: false, update_check: true },
  last_active_context: "",
});

const listOk = (buckets: KvBucketSummary[]) => ({
  error_code: "",
  error: "",
  kv_buckets: buckets,
  obj_buckets: [],
  unavailable_reason: "",
});

const ok = { error_code: "", error: "" };

const watchEvent = (over: Partial<KvWatchEvent> = {}): KvWatchEvent => ({
  watch_id: "w-1",
  bucket: BUCKET,
  key: "k-1",
  revision: 1,
  operation: "put",
  payload_b64: toBase64("hello"),
  payload_size: 5,
  is_utf8: true,
  timestamp_ms: 1_770_000_000_000,
  dropped_total: 0,
  ...over,
});

// Real timers; flush pending microtasks/timers inside act.
const flush = async (ms = 10) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const fireWatch = (ev: KvWatchEvent) => {
  act(() => {
    runtime.handlers.get("kv:watch")?.({ data: ev });
  });
};

// Mount the page inside the app-wide ConfirmProvider, wait for the bucket
// list, then select ORDERS so the detail pane (and key area) is on screen.
const setup = async (keys: KeyMeta[] = [keyMeta("k-000")]) => {
  render(
    <ConfirmProvider>
      <KeyValuePage />
    </ConfirmProvider>,
  );
  await flush();
  fireEvent.click(screen.getByTestId(`kv-bucket-row-${BUCKET}`));
  await flush();
  expect(screen.getByTestId("kv-bucket-detail")).toBeTruthy();
  return keys;
};

beforeEach(() => {
  connState.state = "connected";
  vi.clearAllMocks();
  runtime.handlers.clear();
  runtime.offs = [];
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListKvBuckets).mockResolvedValue(listOk([bucketSummary()]) as never);
  vi.mocked(GetKvBucketDetail).mockResolvedValue({
    ...ok,
    form: detailForm(),
    created_ms: 0,
  } as never);
  vi.mocked(ListKeys).mockResolvedValue({
    ...ok,
    keys: [keyMeta("k-000")],
    total: 1,
    truncated: false,
  } as never);
  vi.mocked(GetKeyValues).mockResolvedValue({
    ...ok,
    values: [keyValue("k-000")],
  } as never);
  vi.mocked(GetKeyHistory).mockResolvedValue({
    ...ok,
    entries: [histEntry(1)],
  } as never);
  vi.mocked(PutKey).mockResolvedValue({ ...ok, revision: 2, current_revision: 1 } as never);
  vi.mocked(DeleteKey).mockResolvedValue(ok as never);
  vi.mocked(RevertKey).mockResolvedValue({ ...ok, revision: 3, current_revision: 2 } as never);
  vi.mocked(CreateKvWatch).mockResolvedValue({ ...ok, watch_id: "w-1" } as never);
  vi.mocked(StopWatch).mockResolvedValue(ok as never);
  vi.mocked(CreateKvBucket).mockResolvedValue(ok as never);
  vi.mocked(UpdateKvBucket).mockResolvedValue(ok as never);
  vi.mocked(DeleteKvBucket).mockResolvedValue(ok as never);
  vi.mocked(CompactKvBucket).mockResolvedValue(ok as never);
});

// ---- brief scenario 1: bucket list + detail echo + L2 delete ----

it("renders the bucket list, echoes the selected bucket config, and L2 delete refuses a wrong name / deletes on the exact name", async () => {
  await setup();

  // Left rail shows the bucket row with its summary columns.
  const row = screen.getByTestId(`kv-bucket-row-${BUCKET}`);
  expect(row.textContent).toContain(BUCKET);
  expect(row.textContent).toContain("2"); // keys
  expect(row.textContent).toContain("2.0 KiB"); // bytes

  // Detail pane echoes the editable config (GetKvBucketDetail.form).
  const detail = screen.getByTestId("kv-bucket-detail");
  expect(detail.textContent).toContain(BUCKET);
  expect(detail.textContent).toContain("kv bucket");
  expect(detail.textContent).toContain("60"); // ttl seconds

  // L2 delete: wrong name keeps the dialog, never calls the binding.
  fireEvent.click(screen.getByTestId("kv-bucket-op-delete"));
  await flush();
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain(BUCKET);
  const input = screen.getByLabelText("name-match-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "orders" } });
  const confirmBtn = screen.getByRole("button", { name: /confirm/i });
  expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(confirmBtn);
  await flush();
  expect(DeleteKvBucket).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeNull();

  // Exact name: deletes, toasts, refreshes, drops the selection.
  fireEvent.change(input, { target: { value: BUCKET } });
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
  await flush();

  expect(DeleteKvBucket).toHaveBeenCalledTimes(1);
  expect(DeleteKvBucket).toHaveBeenCalledWith(BUCKET);
  expect(toast.success).toHaveBeenCalled();
  expect(ListKvBuckets).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("kv-detail-empty")).toBeTruthy();
});

// ---- brief scenario 2: key pagination + filter + value batch args ----

it("paginates 100 keys 50 per page, filters by name, and fetches the current page's values with the page's key names", async () => {
  const keys = Array.from({ length: 100 }, (_, i) =>
    keyMeta(`k-${String(i).padStart(3, "0")}`, { revision: i + 1 }),
  );
  vi.mocked(ListKeys).mockResolvedValue({ ...ok, keys } as never);
  vi.mocked(GetKeyValues).mockResolvedValue({
    ...ok,
    values: keys.slice(0, 50).map((k) => keyValue(k.key)),
  } as never);
  await setup(keys);

  // Page 1 = first 50 keys (client-side sorted): the value batch carries the
  // current page's key names.
  expect(GetKeyValues).toHaveBeenLastCalledWith(
    BUCKET,
    keys.slice(0, 50).map((k) => k.key),
  );
  expect(screen.getByTestId("kv-keys-page").textContent).toContain("1 / 2");
  const rowCount = () =>
    screen.getByTestId("kv-key-list").querySelectorAll('[data-testid^="kv-key-row-"]').length;
  expect(rowCount()).toBe(50);

  // Next page → values batch for keys 50..99.
  fireEvent.click(screen.getByTestId("kv-keys-next"));
  await flush();
  expect(GetKeyValues).toHaveBeenLastCalledWith(
    BUCKET,
    keys.slice(50, 100).map((k) => k.key),
  );
  expect(screen.getByTestId("kv-keys-page").textContent).toContain("2 / 2");

  // Name filter narrows client-side and resets to the first page.
  fireEvent.change(screen.getByTestId("kv-key-filter"), { target: { value: "k-09" } });
  await flush();
  expect(rowCount()).toBe(10);
  expect(GetKeyValues).toHaveBeenLastCalledWith(
    BUCKET,
    keys
      .filter((k) => k.key.includes("k-09"))
      .map((k) => k.key),
  );
});

// ---- brief scenario 3: editor modes + conflict handling ----

it("KeyEditor: update conflict refreshes the displayed revision and keeps the draft; create conflict shows the banner with a one-click switch to put", async () => {
  vi.mocked(ListKeys).mockResolvedValue({
    ...ok,
    keys: [keyMeta("k-000", { revision: 5 })],
  } as never);
  vi.mocked(GetKeyValues).mockResolvedValue({
    ...ok,
    values: [keyValue("k-000", { revision: 5 })],
  } as never);
  await setup();

  fireEvent.click(screen.getByTestId("kv-key-row-k-000"));
  await flush();
  fireEvent.click(screen.getByTestId("kv-key-edit"));
  await flush();

  expect(screen.getByTestId("kv-editor")).toBeTruthy();
  const textarea = screen.getByTestId("kv-editor-value") as HTMLTextAreaElement;
  expect(textarea.value).toBe("value-k-000");

  // update mode locks the expected revision display (the key's current one).
  fireEvent.change(screen.getByTestId("kv-editor-mode"), { target: { value: "update" } });
  expect(screen.getByTestId("kv-editor-expected").textContent).toContain("5");

  // Update conflict: inline banner with X vs Y, revision refreshed to Y,
  // draft textarea untouched.
  vi.mocked(PutKey).mockResolvedValue({
    error_code: "conflict",
    error: "revision mismatch",
    revision: 0,
    current_revision: 7,
  } as never);
  fireEvent.click(screen.getByTestId("kv-editor-submit"));
  await flush();

  expect(PutKey).toHaveBeenLastCalledWith(BUCKET, "k-000", toBase64("value-k-000"), "update", 5);
  const banner = screen.getByTestId("kv-editor-conflict");
  expect(banner.textContent).toContain("5");
  expect(banner.textContent).toContain("7");
  expect(screen.getByTestId("kv-editor-expected").textContent).toContain("7");
  expect((screen.getByTestId("kv-editor-value") as HTMLTextAreaElement).value).toBe(
    "value-k-000",
  );

  // create mode on the existing key → conflict banner + one-click switch to
  // put (draft preserved).
  fireEvent.change(screen.getByTestId("kv-editor-mode"), { target: { value: "create" } });
  fireEvent.click(screen.getByTestId("kv-editor-submit"));
  await flush();
  expect(PutKey).toHaveBeenLastCalledWith(BUCKET, "k-000", toBase64("value-k-000"), "create", 7);
  expect(screen.getByTestId("kv-editor-conflict").textContent).toContain("already exists");
  fireEvent.click(screen.getByTestId("kv-editor-switch-put"));
  expect((screen.getByTestId("kv-editor-mode") as HTMLSelectElement).value).toBe("put");
  expect((screen.getByTestId("kv-editor-value") as HTMLTextAreaElement).value).toBe(
    "value-k-000",
  );

  // Success closes the dialog and toasts.
  vi.mocked(PutKey).mockResolvedValue({ ...ok, revision: 8, current_revision: 7 } as never);
  fireEvent.click(screen.getByTestId("kv-editor-submit"));
  await flush();
  expect(PutKey).toHaveBeenLastCalledWith(BUCKET, "k-000", toBase64("value-k-000"), "put", 7);
  expect(toast.success).toHaveBeenCalled();
  expect(screen.queryByTestId("kv-editor")).toBeNull();
});

// ---- brief scenario 4: revert disable/enable ----

it("revert is disabled with the tooltip at revision 1, and enabled at revision ≥2 where it calls RevertKey", async () => {
  vi.mocked(ListKeys).mockResolvedValue({
    ...ok,
    keys: [keyMeta("k-000", { revision: 1 }), keyMeta("k-001", { revision: 2 })],
  } as never);
  vi.mocked(GetKeyValues).mockResolvedValue({
    ...ok,
    values: [keyValue("k-000"), keyValue("k-001")],
  } as never);
  // k-001 carries two valid (put) revisions so its revert has a target.
  vi.mocked(GetKeyHistory).mockImplementation(((_bucket: string, key: string) =>
    Promise.resolve({
      ...ok,
      entries: key === "k-001" ? [histEntry(1), histEntry(2)] : [histEntry(1)],
    }) as never) as never);
  await setup();

  // revision 1 → disabled + tooltip text.
  fireEvent.click(screen.getByTestId("kv-key-row-k-000"));
  await flush();
  const revert1 = screen.getByTestId("kv-key-revert") as HTMLButtonElement;
  expect(revert1.disabled).toBe(true);
  expect(revert1.title.length).toBeGreaterThan(0);
  expect(RevertKey).not.toHaveBeenCalled();

  // revision 2 with two valid revisions → enabled; click calls RevertKey.
  fireEvent.click(screen.getByTestId("kv-key-row-k-001"));
  await flush();
  expect(screen.getByTestId("kv-key-revert")).toBeTruthy();
  const revert2 = screen.getByTestId("kv-key-revert") as HTMLButtonElement;
  expect(revert2.disabled).toBe(false);
  fireEvent.click(revert2);
  await flush();
  expect(RevertKey).toHaveBeenCalledTimes(1);
  expect(RevertKey).toHaveBeenCalledWith(BUCKET, "k-001");
  expect(toast.success).toHaveBeenCalled();
});

// ---- brief scenario 5: watch events + sentinel + stop + 10k ring ----

it("watch: pushed events render as rows with the sentinel, Stop calls StopWatch, and the ring caps at 10k", async () => {
  await setup();

  // Start with an empty filter → whole-bucket watch.
  fireEvent.click(screen.getByTestId("kv-watch-start"));
  await flush();
  expect(CreateKvWatch).toHaveBeenCalledWith(BUCKET, "");

  for (let i = 1; i <= 5; i++) {
    fireWatch(watchEvent({ key: `k-${i}`, revision: i }));
  }
  fireWatch(watchEvent({ key: "", revision: 0, operation: "" })); // sentinel

  const list = screen.getByTestId("kv-watch-list");
  expect(screen.getAllByTestId("kv-watch-row").length).toBe(5);
  expect(within(list).getByTestId("kv-watch-sentinel").textContent).toContain(
    "Initial snapshot complete",
  );

  // Wire tolerance: the Go sentinel omits "key" entirely (omitempty) — it
  // must still register as the initial-snapshot marker, not be dropped.
  const sentinelEv = watchEvent({ key: "", revision: 0, operation: "" }) as Record<string, unknown>;
  delete sentinelEv.key;
  delete sentinelEv.operation;
  fireWatch(sentinelEv as unknown as KvWatchEvent);
  expect(screen.getAllByTestId("kv-watch-sentinel").length).toBe(2);

  // dropped_total from the latest event shows on the chip.
  fireWatch(watchEvent({ key: "k-6", revision: 6, dropped_total: 3 }));
  expect(screen.getByTestId("kv-watch-dropped").textContent).toContain("3");

  // Stop → StopWatch(watch_id) and the panel resets.
  fireEvent.click(screen.getByTestId("kv-watch-stop"));
  await flush();
  expect(StopWatch).toHaveBeenCalledWith("w-1");

  // A non-empty filter goes to the binding verbatim (ValidateWatchFilter).
  fireEvent.change(screen.getByTestId("kv-watch-filter"), { target: { value: "k-*" } });
  fireEvent.click(screen.getByTestId("kv-watch-start"));
  await flush();
  expect(CreateKvWatch).toHaveBeenLastCalledWith(BUCKET, "k-*");

  // 10k ring cap: pushing 10_005 keeps the LAST 10_000 (pure state machine —
  // the sessionsLogic precedent; the hook folds events through this fn).
  let ring: KvWatchEvent[] = [];
  for (let i = 1; i <= 10_005; i++) {
    ring = applyWatchEvent(ring, watchEvent({ key: `k-${i}`, revision: i }));
  }
  expect(ring.length).toBe(10_000);
  expect(ring[0].revision).toBe(6);
  expect(ring[ring.length - 1].revision).toBe(10_005);
});

// ---- brief scenario 6: unavailable guidance panel ----

it("unavailable_reason renders the guidance panel with non-empty guidance instead of the table", async () => {
  vi.mocked(ListKvBuckets).mockResolvedValue({
    error_code: "",
    error: "",
    kv_buckets: [],
    obj_buckets: [],
    unavailable_reason: "timeout",
  } as never);

  render(
    <ConfirmProvider>
      <KeyValuePage />
    </ConfirmProvider>,
  );
  await flush();

  const panel = screen.getByTestId("kv-unavailable");
  expect(panel.textContent.length).toBeGreaterThan(0);
  expect(panel.textContent).toContain("timed out");
  // The troubleshooting checklist is present and non-empty.
  const items = within(panel).getAllByRole("listitem");
  expect(items.length).toBe(2);
  expect(ListKeys).not.toHaveBeenCalled();
});

// =====================================================================
// M5 Task 14 — coverage remediation (features/kv baseline 68.03% < 70%).
// Falsifying tests for the three big gaps the M4 report named:
// BucketForm (submit paths / validation errors / edit refill),
// KeyValuePage (selection flows / confirm-gated ops / disconnect stop),
// schema (every rule's boundary values). No product code changed.
// =====================================================================

// ---- schema.ts: bucketFormSchema boundary values (mirror of Go ValidateKvBucketForm) ----

it("schema: bucketFormSchema accepts the documented boundaries and rejects each rule with its i18n key", () => {
  const base = emptyBucketFormValues();
  const ok = (over: Record<string, unknown>) =>
    bucketFormSchema.safeParse({ ...base, ...over }).success;
  const bad = (over: Record<string, unknown>) => {
    const r = bucketFormSchema.safeParse({ ...base, ...over });
    return r.success ? null : collectErrors(r.error.issues);
  };

  // Boundaries: history 0 (server default) and 64 (max); replicas 0 and 5;
  // limits -1 (unlimited); name charset ^[a-zA-Z0-9_-]+$.
  expect(ok({ name: "A-z_09", history: 0, ttl_seconds: 0, max_bytes: -1, replicas: 0, max_value_size: -1 })).toBe(true);
  expect(ok({ history: 64, replicas: 5, ttl_seconds: 1, max_bytes: 0, max_value_size: 0, name: "B" })).toBe(true);

  expect(bad({ name: "bad name" })?.name).toBe("kv.form.nameIllegal");
  expect(bad({ name: "" })?.name).toBe("kv.form.nameIllegal");
  expect(bad({ history: 65 })?.history).toBe("kv.form.historyInvalid");
  expect(bad({ history: -1 })?.history).toBe("kv.form.historyInvalid");
  expect(bad({ history: 1.5 })?.history).toBe("kv.form.numericInvalid");
  expect(bad({ ttl_seconds: -1 })?.ttl_seconds).toBe("kv.form.ttlInvalid");
  expect(bad({ ttl_seconds: 2.5 })?.ttl_seconds).toBe("kv.form.numericInvalid");
  expect(bad({ max_bytes: -2 })?.max_bytes).toBe("kv.form.limitsInvalid");
  expect(bad({ max_value_size: -2 })?.max_value_size).toBe("kv.form.limitsInvalid");
  expect(bad({ replicas: 6 })?.replicas).toBe("kv.form.replicasInvalid");
  expect(bad({ replicas: -1 })?.replicas).toBe("kv.form.replicasInvalid");
  // NaN (parseNum of non-numeric input) must not slip through as a number.
  expect(bad({ ttl_seconds: Number.NaN })).not.toBeNull();
});

it("schema: keyEditorSchema and the key rules reject every §6.8-banned shape; the wire mapper normalizes", () => {
  // Key name truth table (Go ValidateKeyName mirror).
  expect(isValidKeyName("")).toBe(false);
  expect(isValidKeyName("a")).toBe(true);
  expect(isValidKeyName(".lead")).toBe(false);
  expect(isValidKeyName("trail.")).toBe(false);
  expect(isValidKeyName("a..b")).toBe(false);
  expect(isValidKeyName("has space")).toBe(false);
  expect(isValidKeyName("a/b_c-d.e=f")).toBe(true); // '/' legal for natscli interop
  expect(isValidKeyName("键")).toBe(false); // non-ASCII

  // Mode enum is a closed set.
  expect(keyModeSchema.safeParse("put").success).toBe(true);
  expect(keyModeSchema.safeParse("del").success).toBe(false);

  // Editor payload: the 8 MiB cap is byte-accurate (raw pre-base64 length).
  const editor = (over: Record<string, unknown>) =>
    keyEditorSchema.safeParse({ key: "k", mode: "put", value: "v", expected_revision: 0, ...over });
  expect(editor({}).success).toBe(true);
  expect(editor({ value: "x".repeat(MAX_VALUE_BYTES) }).success).toBe(true);
  expect(editor({ value: "x".repeat(MAX_VALUE_BYTES + 1) }).success).toBe(false);
  expect(editor({ key: "" }).success).toBe(false);
  expect(editor({ key: "a..b" }).success).toBe(false);
  expect(editor({ expected_revision: -1 }).success).toBe(false);
  expect(editor({ expected_revision: 0 }).success).toBe(true);
  expect(editor({ mode: "cas" }).success).toBe(false);

  // Wire mapper: every numeric field is sent explicitly; non-finite → 0,
  // fractions truncated (the Go validator re-normalizes 0 → defaults).
  expect(
    bucketFormToWire({
      ...emptyBucketFormValues(),
      name: "N",
      history: 1.9,
      max_bytes: Number.NaN,
    }),
  ).toEqual({
    name: "N",
    description: "",
    history: 1,
    ttl_seconds: 0,
    max_bytes: 0,
    replicas: 1,
    max_value_size: 0,
  });
  // Create-mode defaults: replicas 1, everything else unset.
  expect(emptyBucketFormValues()).toEqual({
    name: "",
    description: "",
    history: 0,
    ttl_seconds: 0,
    max_bytes: 0,
    replicas: 1,
    max_value_size: 0,
  });
  // collectErrors: first issue wins per field; empty paths are dropped.
  expect(
    collectErrors([
      { path: ["history"], message: "first" },
      { path: ["history"], message: "second" },
      { path: [], message: "orphan" },
      { path: ["name"], message: "n1" },
    ]),
  ).toEqual({ history: "first", name: "n1" });
  // matchBuckets: substring on name or description, case-insensitive.
  const a = bucketSummary();
  const b = bucketSummary({ name: "SESSIONS", description: "session state" });
  expect(matchBuckets([a, b], " sess ")).toEqual([b]);
  expect(matchBuckets([a, b], "KV BUCK")).toEqual([a]);
  expect(matchBuckets([a, b], "")).toEqual([a, b]);
  expect(matchBuckets([a, b], "zzz")).toEqual([]);
});

// ---- BucketForm: create submit path ----

it("BucketForm create: parsed+validated values go to CreateKvBucket and success closes the dialog", async () => {
  await setup();
  fireEvent.click(screen.getByTestId("kv-create"));
  await flush();
  expect(screen.getByTestId("kv-bucket-form-title").textContent).toBe("Create bucket");

  fireEvent.change(screen.getByTestId("kv-bucket-form-name"), { target: { value: "NEWORDERS" } });
  fireEvent.change(screen.getByTestId("kv-bucket-form-description"), {
    target: { value: "made by test" },
  });
  fireEvent.change(screen.getByTestId("kv-bucket-form-history"), { target: { value: "32" } });
  fireEvent.change(screen.getByTestId("kv-bucket-form-ttl"), { target: { value: "120" } });
  fireEvent.change(screen.getByTestId("kv-bucket-form-max-bytes"), { target: { value: "-1" } });
  fireEvent.change(screen.getByTestId("kv-bucket-form-max-value-size"), {
    target: { value: "1024" },
  });
  fireEvent.change(screen.getByTestId("kv-bucket-form-replicas"), { target: { value: "2" } });
  fireEvent.click(screen.getByTestId("kv-bucket-form-submit"));
  await flush();

  expect(CreateKvBucket).toHaveBeenCalledTimes(1);
  expect(CreateKvBucket).toHaveBeenCalledWith({
    name: "NEWORDERS",
    description: "made by test",
    history: 32,
    ttl_seconds: 120,
    max_bytes: -1,
    replicas: 2,
    max_value_size: 1024,
  });
  expect(toast.success).toHaveBeenCalledWith("Bucket NEWORDERS created");
  expect(screen.queryByTestId("kv-bucket-form")).toBeNull();
});

// ---- BucketForm: validation errors block the submit ----

it("BucketForm: client validation renders inline field errors and never reaches the binding", async () => {
  await setup();
  fireEvent.click(screen.getByTestId("kv-create"));
  await flush();

  // Empty name (the only initially-invalid field).
  fireEvent.click(screen.getByTestId("kv-bucket-form-submit"));
  await flush();
  expect(screen.getByTestId("kv-bucket-form-error-name")).toBeTruthy();
  expect(CreateKvBucket).not.toHaveBeenCalled();

  // One violation per numeric rule + illegal name.
  fireEvent.change(screen.getByTestId("kv-bucket-form-name"), { target: { value: "bad name" } });
  fireEvent.change(screen.getByTestId("kv-bucket-form-history"), { target: { value: "65" } });
  fireEvent.change(screen.getByTestId("kv-bucket-form-ttl"), { target: { value: "-1" } });
  fireEvent.change(screen.getByTestId("kv-bucket-form-max-bytes"), { target: { value: "-2" } });
  fireEvent.change(screen.getByTestId("kv-bucket-form-max-value-size"), {
    target: { value: "-2" },
  });
  fireEvent.change(screen.getByTestId("kv-bucket-form-replicas"), { target: { value: "6" } });
  fireEvent.click(screen.getByTestId("kv-bucket-form-submit"));
  await flush();

  expect(screen.getByTestId("kv-bucket-form-error-name").textContent).toContain(
    "^[a-zA-Z0-9_-]+$",
  );
  expect(screen.getByTestId("kv-bucket-form-error-history").textContent).toContain("1 and 64");
  expect(screen.getByTestId("kv-bucket-form-error-ttl").textContent).toContain("≥ 0");
  expect(screen.getByTestId("kv-bucket-form-error-bytes").textContent).toContain(
    "-1 = unlimited",
  );
  expect(screen.getByTestId("kv-bucket-form-error-size").textContent).toContain(
    "-1 = unlimited",
  );
  expect(screen.getByTestId("kv-bucket-form-error-replicas").textContent).toContain(
    "between 0",
  );
  expect(CreateKvBucket).not.toHaveBeenCalled();

  // Non-numeric input (parseNum → NaN) also blocks.
  fireEvent.change(screen.getByTestId("kv-bucket-form-name"), { target: { value: "GOOD" } });
  fireEvent.change(screen.getByTestId("kv-bucket-form-history"), { target: { value: "abc" } });
  fireEvent.click(screen.getByTestId("kv-bucket-form-submit"));
  await flush();
  expect(screen.getByTestId("kv-bucket-form-error-history")).toBeTruthy();
  expect(CreateKvBucket).not.toHaveBeenCalled();
});

// ---- BucketForm: edit refill + frozen name + server validation原文 inline ----

it("BucketForm edit: refills the detail echo, freezes the name, renders server validation inline and stays open", async () => {
  await setup();
  vi.mocked(UpdateKvBucket).mockResolvedValue({
    error_code: "validation",
    error: "history above server cap",
  } as never);
  fireEvent.click(screen.getByTestId("kv-bucket-op-edit"));
  await flush();

  expect(screen.getByTestId("kv-bucket-form-title").textContent).toBe("Edit bucket");
  const name = screen.getByTestId("kv-bucket-form-name") as HTMLInputElement;
  expect(name.value).toBe(BUCKET);
  expect(name.disabled).toBe(true);
  expect((screen.getByTestId("kv-bucket-form-history") as HTMLInputElement).value).toBe("5");
  expect((screen.getByTestId("kv-bucket-form-ttl") as HTMLInputElement).value).toBe("60");
  expect((screen.getByTestId("kv-bucket-form-max-bytes") as HTMLInputElement).value).toBe("-1");
  expect((screen.getByTestId("kv-bucket-form-replicas") as HTMLInputElement).value).toBe("1");
  expect((screen.getByTestId("kv-bucket-form-max-value-size") as HTMLInputElement).value).toBe(
    "",
  );

  fireEvent.change(screen.getByTestId("kv-bucket-form-replicas"), { target: { value: "2" } });
  fireEvent.click(screen.getByTestId("kv-bucket-form-submit"));
  await flush();

  // The wire mapper ran (explicit numerics; empty maxValueSize → 0).
  expect(UpdateKvBucket).toHaveBeenCalledTimes(1);
  expect(UpdateKvBucket).toHaveBeenCalledWith({
    name: BUCKET,
    description: "kv bucket",
    history: 5,
    ttl_seconds: 60,
    max_bytes: -1,
    replicas: 2,
    max_value_size: 0,
  });
  // error_code=validation renders the 原文 inline; dialog stays open.
  expect(screen.getByTestId("kv-bucket-form-server-error").textContent).toContain(
    "history above server cap",
  );
  expect(screen.queryByTestId("kv-bucket-form")).not.toBeNull();
  expect(toast.success).not.toHaveBeenCalled();

  // A clean resubmit succeeds and closes.
  vi.mocked(UpdateKvBucket).mockResolvedValue(ok as never);
  fireEvent.click(screen.getByTestId("kv-bucket-form-submit"));
  await flush();
  expect(toast.success).toHaveBeenCalledWith("Bucket ORDERS updated");
  expect(screen.queryByTestId("kv-bucket-form")).toBeNull();
});

// ---- BucketForm: cancel + pending double-click guard ----

it("BucketForm: cancel closes without submitting; a pending submit disables the buttons and absorbs double clicks", async () => {
  await setup();
  fireEvent.click(screen.getByTestId("kv-create"));
  await flush();
  fireEvent.click(screen.getByTestId("kv-bucket-form-cancel"));
  await flush();
  expect(screen.queryByTestId("kv-bucket-form")).toBeNull();
  expect(CreateKvBucket).not.toHaveBeenCalled();

  let resolve!: (v: unknown) => void;
  vi.mocked(CreateKvBucket).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  fireEvent.click(screen.getByTestId("kv-create"));
  await flush();
  fireEvent.change(screen.getByTestId("kv-bucket-form-name"), { target: { value: "PENDING" } });
  fireEvent.click(screen.getByTestId("kv-bucket-form-submit"));
  await flush();
  const submit = screen.getByTestId("kv-bucket-form-submit") as HTMLButtonElement;
  expect(submit.textContent).toContain("Working…");
  expect(submit.disabled).toBe(true);
  expect((screen.getByTestId("kv-bucket-form-cancel") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(submit);
  await flush();
  expect(CreateKvBucket).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolve({ error_code: "", error: "" });
  });
  await flush();
  expect(toast.success).toHaveBeenCalledWith("Bucket PENDING created");
  expect(screen.queryByTestId("kv-bucket-form")).toBeNull();
});

// ---- KeyValuePage: compact (L1) ----

it("compact: L1 cancel never calls the binding; confirm compacts and toasts", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("kv-bucket-op-compact"));
  await flush();
  const dlg = screen.getByRole("alertdialog");
  expect(dlg.textContent).toContain("Compact bucket");
  expect(dlg.textContent).toContain(BUCKET);
  fireEvent.click(within(dlg).getByRole("button", { name: /cancel/i }));
  await flush();
  expect(CompactKvBucket).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("kv-bucket-op-compact"));
  await flush();
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: /confirm/i }),
  );
  await flush();
  expect(CompactKvBucket).toHaveBeenCalledTimes(1);
  expect(CompactKvBucket).toHaveBeenCalledWith(BUCKET);
  expect(toast.success).toHaveBeenCalledWith("Bucket ORDERS compacted");
});

// ---- KeyValuePage: key delete/purge (L1 each) ----

it("key delete/purge: the L1 dialogs gate both bindings and pass the right mode", async () => {
  await setup();
  fireEvent.click(screen.getByTestId("kv-key-row-k-000"));
  await flush();

  // Delete: L1 cancel → never called.
  fireEvent.click(screen.getByTestId("kv-key-del"));
  await flush();
  expect(screen.getByRole("alertdialog").textContent).toContain("Delete key");
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /cancel/i }));
  await flush();
  expect(DeleteKey).not.toHaveBeenCalled();

  // Purge: L1 confirm → mode "purge".
  fireEvent.click(screen.getByTestId("kv-key-purge"));
  await flush();
  expect(screen.getByRole("alertdialog").textContent).toContain("Purge key");
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: /confirm/i }),
  );
  await flush();
  expect(DeleteKey).toHaveBeenLastCalledWith(BUCKET, "k-000", "purge");
  expect(toast.success).toHaveBeenCalledWith("Key k-000 purged");

  // Delete: L1 confirm → mode "delete".
  fireEvent.click(screen.getByTestId("kv-key-del"));
  await flush();
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: /confirm/i }),
  );
  await flush();
  expect(DeleteKey).toHaveBeenLastCalledWith(BUCKET, "k-000", "delete");
  expect(toast.success).toHaveBeenCalledWith("Key k-000 deleted");
});

// ---- KeyValuePage/KeyDetail: value fallback + history view toggle ----

it("key detail: the current value falls back to the newest valid history entry and the history view toggle shows/hides payloads", async () => {
  // The page batch misses the selected key → history fallback (rev 2 is a
  // delete marker, so the newest VALID entry is revision 1).
  vi.mocked(GetKeyValues).mockResolvedValue({ ...ok, values: [] } as never);
  vi.mocked(GetKeyHistory).mockResolvedValue({
    ...ok,
    entries: [histEntry(1), histEntry(2, { operation: "delete" })],
  } as never);
  await setup();
  fireEvent.click(screen.getByTestId("kv-key-row-k-000"));
  await flush();

  expect(screen.getByTestId("kv-key-detail-value").textContent).toContain("value-r1");
  // History renders newest-first; the delete-marker row has no view button.
  expect(screen.getByTestId("kv-history-row-2").textContent).toContain("delete");
  expect(screen.queryByTestId("kv-history-view-2")).toBeNull();

  fireEvent.click(screen.getByTestId("kv-history-view-1"));
  expect(screen.getByTestId("kv-history-payload-1").textContent).toContain("value-r1");
  fireEvent.click(screen.getByTestId("kv-history-view-1")); // toggle off
  expect(screen.queryByTestId("kv-history-payload-1")).toBeNull();
});

it("key detail: a deleted key shows the marker note, revert targets the valid history, and a fully-deleted key opens the editor with an empty draft", async () => {
  vi.mocked(ListKeys).mockResolvedValue({
    ...ok,
    keys: [
      keyMeta("k-000", { operation: "delete", revision: 3 }),
      keyMeta("k-001", { operation: "purge", revision: 5 }),
    ],
  } as never);
  vi.mocked(GetKeyValues).mockResolvedValue({ ...ok, values: [] } as never);
  vi.mocked(GetKeyHistory).mockImplementation(((_bucket: string, key: string) =>
    Promise.resolve({
      ...ok,
      // k-000: two revisions with one valid under the delete marker;
      // k-001: purge wiped everything — delete markers only.
      entries:
        key === "k-000"
          ? [histEntry(1), histEntry(3, { operation: "delete" })]
          : [histEntry(4, { operation: "delete" }), histEntry(5, { operation: "purge" })],
    }) as never) as never);
  await setup();
  fireEvent.click(screen.getByTestId("kv-key-row-k-000"));
  await flush();

  expect(screen.getByTestId("kv-key-detail-deleted").textContent).toContain("delete");
  // One valid revision under the marker → a revert target exists.
  expect(((screen.getByTestId("kv-key-revert") as HTMLButtonElement).disabled)).toBe(false);

  // A purged key has no current value anywhere → the editor opens empty
  // (never mojibake); the key name is frozen from the meta.
  fireEvent.click(screen.getByTestId("kv-key-row-k-001"));
  await flush();
  fireEvent.click(screen.getByTestId("kv-key-edit"));
  await flush();
  expect(screen.getByTestId("kv-editor-title").textContent).toContain("Edit key");
  expect((screen.getByTestId("kv-editor-key") as HTMLInputElement).value).toBe("k-001");
  expect((screen.getByTestId("kv-editor-value") as HTMLTextAreaElement).value).toBe("");
  fireEvent.click(screen.getByTestId("kv-editor-cancel"));
  await flush();
  expect(screen.queryByTestId("kv-editor")).toBeNull();
});

it("KeyEditor: a non-UTF-8 current value shows the binary note instead of prefilling mojibake", async () => {
  vi.mocked(GetKeyValues).mockResolvedValue({
    ...ok,
    values: [keyValue("k-000", { is_utf8: false, payload_b64: toBase64("\u00ff\u00fe") })],
  } as never);
  await setup();
  fireEvent.click(screen.getByTestId("kv-key-row-k-000"));
  await flush();
  fireEvent.click(screen.getByTestId("kv-key-edit"));
  await flush();
  expect(screen.getByTestId("kv-editor-binary-note")).toBeTruthy();
  expect((screen.getByTestId("kv-editor-value") as HTMLTextAreaElement).value).toBe("");
});

// ---- KeyList: empty state, page-size change, prev/next gating ----

it("key list: the page-size select refetches the page batch and the empty filter state renders", async () => {
  const keys = Array.from({ length: 30 }, (_, i) => keyMeta(`k-${String(i).padStart(3, "0")}`));
  vi.mocked(ListKeys).mockResolvedValue({ ...ok, keys } as never);
  vi.mocked(GetKeyValues).mockImplementation(
    ((_bucket: string, ks: string[]) =>
      Promise.resolve({ ...ok, values: ks.map((k) => keyValue(k)) }) as never) as never,
  );
  await setup(keys);

  expect(((screen.getByTestId("kv-keys-prev") as HTMLButtonElement).disabled)).toBe(true);
  fireEvent.change(screen.getByTestId("kv-keys-size"), { target: { value: "20" } });
  await flush();
  expect(screen.getByTestId("kv-keys-page").textContent).toContain("1 / 2");
  expect(GetKeyValues).toHaveBeenLastCalledWith(
    BUCKET,
    keys.slice(0, 20).map((k) => k.key),
  );
  fireEvent.click(screen.getByTestId("kv-keys-next"));
  await flush();
  expect(GetKeyValues).toHaveBeenLastCalledWith(
    BUCKET,
    keys.slice(20, 30).map((k) => k.key),
  );
  expect(((screen.getByTestId("kv-keys-prev") as HTMLButtonElement).disabled)).toBe(false);

  fireEvent.change(screen.getByTestId("kv-key-filter"), { target: { value: "nope" } });
  await flush();
  expect(screen.getByTestId("kv-keys-empty").textContent).toContain("No keys match");
});

// ---- Leak B fix 2 (part 4): KV keys truncation banner ----

it("truncated ListKeys renders the kv-truncated-banner; an untruncated list renders none", async () => {
  vi.mocked(ListKeys).mockResolvedValue({
    ...ok,
    keys: [keyMeta("k-000")],
    total: 100_000,
    truncated: true,
  } as never);
  await setup();
  const banner = screen.getByTestId("kv-truncated-banner");
  expect(banner.textContent).toContain("Showing first 1000 keys");
  expect(banner.textContent).toContain("more not listed");

  // The untruncated answer (the beforeEach default shape) carries no banner —
  // no noise when the whole bucket is listed.
  cleanup();
  vi.mocked(ListKeys).mockResolvedValue({
    ...ok,
    keys: [keyMeta("k-000")],
    total: 1,
    truncated: false,
  } as never);
  await setup();
  expect(screen.queryByTestId("kv-truncated-banner")).toBeNull();
});

// ---- KeyEditor: fresh-key entry + key validation ----

it("KeyEditor fresh key: opens empty from the Put entry, key validation blocks submit, a valid put succeeds", async () => {
  await setup();
  fireEvent.click(screen.getByTestId("kv-keys-put"));
  await flush();
  expect(screen.getByTestId("kv-editor-title").textContent).toContain("Put key into");
  expect((screen.getByTestId("kv-editor-key") as HTMLInputElement).value).toBe("");

  fireEvent.change(screen.getByTestId("kv-editor-key"), { target: { value: "bad..key" } });
  fireEvent.click(screen.getByTestId("kv-editor-submit"));
  await flush();
  expect(screen.getByTestId("kv-editor-error-key")).toBeTruthy();
  expect(PutKey).not.toHaveBeenCalled();

  fireEvent.change(screen.getByTestId("kv-editor-key"), { target: { value: "fresh-key" } });
  fireEvent.click(screen.getByTestId("kv-editor-submit"));
  await flush();
  expect(PutKey).toHaveBeenLastCalledWith(BUCKET, "fresh-key", toBase64(""), "put", 0);
  expect(toast.success).toHaveBeenCalledWith("Key fresh-key written (revision 2)");
  expect(screen.queryByTestId("kv-editor")).toBeNull();
});

// ---- useKv: load failures (list transport, vanished bucket, history) ----

it("a vanished bucket (detail not_found) toasts once, drops the selection and refreshes the list", async () => {
  await setup();
  vi.mocked(GetKvBucketDetail).mockResolvedValue({
    error_code: "not_found",
    error: "gone",
    form: null,
    created_ms: 0,
  } as never);
  fireEvent.click(screen.getByTestId("kv-refresh"));
  await flush();
  expect(toast.error).toHaveBeenCalledWith(
    "Resource not found — the view has been refreshed",
  );
  expect(screen.getByTestId("kv-detail-empty")).toBeTruthy();
});

it("transport failures toast the raw error for the list and the key history; an empty history renders its note", async () => {
  vi.mocked(ListKvBuckets).mockRejectedValue(new Error("rpc exploded"));
  render(
    <ConfirmProvider>
      <KeyValuePage />
    </ConfirmProvider>,
  );
  await flush();
  expect(toast.error).toHaveBeenCalledWith("Failed to load buckets: rpc exploded");

  vi.mocked(ListKvBuckets).mockResolvedValue(listOk([bucketSummary()]) as never);
  vi.mocked(ListKeys).mockResolvedValue({
    ...ok,
    keys: [keyMeta("k-000"), keyMeta("k-001")],
  } as never);
  vi.mocked(GetKeyHistory).mockResolvedValue({
    error_code: "server",
    error: "hist boom",
    entries: [],
  } as never);
  await setup();
  fireEvent.click(screen.getByTestId("kv-key-row-k-000"));
  await flush();
  expect(toast.error).toHaveBeenCalledWith("Failed to load history: hist boom");

  vi.mocked(GetKeyHistory).mockResolvedValue({ ...ok, entries: [] } as never);
  fireEvent.click(screen.getByTestId("kv-key-row-k-001"));
  await flush();
  expect(screen.getByTestId("kv-key-detail").textContent).toContain("No revisions recorded.");
});

// ---- useKv: watch start failures + unmount release ----

it("watch start failures toast and leave the panel idle (error_code and thrown paths)", async () => {
  await setup();
  vi.mocked(CreateKvWatch).mockResolvedValue({
    error_code: "server",
    error: "watch refused",
  } as never);
  fireEvent.click(screen.getByTestId("kv-watch-start"));
  await flush();
  expect(toast.error).toHaveBeenCalledWith("Watch failed to start: watch refused");
  expect(screen.queryByTestId("kv-watch-stop")).toBeNull();

  vi.mocked(CreateKvWatch).mockRejectedValue(new Error("transport down"));
  fireEvent.click(screen.getByTestId("kv-watch-start"));
  await flush();
  expect(toast.error).toHaveBeenCalledWith("Watch failed to start: transport down");
  expect(screen.queryByTestId("kv-watch-stop")).toBeNull();
});

it("unmount while watching releases the server-side watcher", async () => {
  const view = render(
    <ConfirmProvider>
      <KeyValuePage />
    </ConfirmProvider>,
  );
  await flush();
  fireEvent.click(screen.getByTestId(`kv-bucket-row-${BUCKET}`));
  await flush();
  fireEvent.click(screen.getByTestId("kv-watch-start"));
  await flush();
  expect(screen.getByTestId("kv-watch-stop")).toBeTruthy();
  view.unmount();
  await flush();
  expect(StopWatch).toHaveBeenCalledWith("w-1");
});

// ---- useKv: disconnect stops the poll surface and clears everything ----

it("disconnect: the rail shows the not-connected panel, the watch resets locally (no StopWatch round-trip) and the selection clears", async () => {
  const view = render(
    <ConfirmProvider>
      <KeyValuePage />
    </ConfirmProvider>,
  );
  await flush();
  fireEvent.click(screen.getByTestId(`kv-bucket-row-${BUCKET}`));
  await flush();
  fireEvent.click(screen.getByTestId("kv-watch-start"));
  await flush();
  expect(screen.getByTestId("kv-watch-stop")).toBeTruthy();

  connState.state = "disconnected";
  view.rerender(
    <ConfirmProvider>
      <KeyValuePage />
    </ConfirmProvider>,
  );
  await flush();
  expect(screen.getByTestId("kv-not-connected")).toBeTruthy();
  expect(((screen.getByTestId("kv-refresh") as HTMLButtonElement).disabled)).toBe(true);
  expect(screen.queryByTestId("kv-watch-stop")).toBeNull();
  expect(StopWatch).not.toHaveBeenCalled(); // the Go manager stops watchers on conn:state
  expect(screen.getByTestId("kv-detail-empty")).toBeTruthy();
});

// ---- KeyValuePage: rail branches (search, Enter select, badges, stat branches) ----

it("bucket search filters client-side on name or description and renders the no-match empty state", async () => {
  vi.mocked(ListKvBuckets).mockResolvedValue(
    listOk([
      bucketSummary(),
      bucketSummary({ name: "SESSIONS", description: "session state", values: 9 }),
    ]) as never,
  );
  render(
    <ConfirmProvider>
      <KeyValuePage />
    </ConfirmProvider>,
  );
  await flush();
  expect(screen.getByTestId(`kv-bucket-row-${BUCKET}`)).toBeTruthy();
  expect(screen.getByTestId("kv-bucket-row-SESSIONS")).toBeTruthy();

  fireEvent.change(screen.getByTestId("kv-search"), { target: { value: "sess" } });
  await flush();
  expect(screen.queryByTestId(`kv-bucket-row-${BUCKET}`)).toBeNull();
  expect(screen.getByTestId("kv-bucket-row-SESSIONS")).toBeTruthy();

  fireEvent.change(screen.getByTestId("kv-search"), { target: { value: "KV BUCK" } });
  await flush();
  expect(screen.getByTestId(`kv-bucket-row-${BUCKET}`)).toBeTruthy();
  expect(screen.queryByTestId("kv-bucket-row-SESSIONS")).toBeNull();

  fireEvent.change(screen.getByTestId("kv-search"), { target: { value: "zzz-nothing" } });
  await flush();
  expect(screen.getByTestId("kv-list-empty")).toBeTruthy();
});

it("an unknown unavailable_reason falls back to the generic guidance text", async () => {
  vi.mocked(ListKvBuckets).mockResolvedValue({
    error_code: "",
    error: "",
    kv_buckets: [],
    obj_buckets: [],
    unavailable_reason: "weird-code",
  } as never);
  render(
    <ConfirmProvider>
      <KeyValuePage />
    </ConfirmProvider>,
  );
  await flush();
  expect(screen.getByTestId("kv-unavailable").textContent).toContain(
    "The bucket list request failed.",
  );
});

it("bucket rows select on Enter; compressed badge, ttl dash and the detail stat branches render", async () => {
  vi.mocked(ListKvBuckets).mockResolvedValue(
    listOk([bucketSummary({ ttl_seconds: 0, is_compressed: true })]) as never,
  );
  vi.mocked(GetKvBucketDetail).mockResolvedValue({
    ...ok,
    form: detailForm({ ttl_seconds: 0, max_bytes: 0, max_value_size: -1 }),
    created_ms: 0,
  } as never);
  render(
    <ConfirmProvider>
      <KeyValuePage />
    </ConfirmProvider>,
  );
  await flush();

  // Enter selects (keyboard path), like the click in setup().
  fireEvent.keyDown(screen.getByTestId(`kv-bucket-row-${BUCKET}`), { key: "Enter" });
  await flush();
  expect(screen.getByTestId("kv-bucket-detail")).toBeTruthy();

  const row = screen.getByTestId(`kv-bucket-row-${BUCKET}`);
  expect(row.textContent).toContain("compressed");
  expect(row.textContent).toContain("—"); // ttl 0 → dash

  expect(screen.getByTestId("kv-stat-ttl").textContent).toContain("—");
  expect(screen.getByTestId("kv-stat-max-bytes").textContent).toContain("default");
  expect(screen.getByTestId("kv-stat-max-value-size").textContent).toContain("unlimited");
  expect(screen.getByTestId("kv-stat-history").textContent).toContain("5");
});

it("bucket and key rows activate on Space as well as Enter (⑲)", async () => {
  await setup();

  // Bucket row: Space alone selects (falsifies the Enter-only handler).
  fireEvent.keyDown(screen.getByTestId(`kv-bucket-row-${BUCKET}`), { key: " " });
  await flush();
  expect(screen.getByTestId("kv-bucket-detail")).toBeTruthy();

  // Key row: Space alone selects and loads the values.
  fireEvent.keyDown(screen.getByTestId("kv-key-row-k-000"), { key: " " });
  await flush();
  expect(screen.getByTestId("kv-key-detail")).toBeTruthy();

  // Unrelated keys stay inert.
  fireEvent.keyDown(screen.getByTestId("kv-key-row-k-000"), { key: "Escape" });
  await flush();
  expect(screen.getByTestId("kv-key-detail")).toBeTruthy(); // no error/blank
});
