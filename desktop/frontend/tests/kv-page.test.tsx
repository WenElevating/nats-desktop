import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { KeyValuePage } from "../src/features/kv/KeyValuePage";
import { applyWatchEvent, type KvWatchEvent } from "../src/features/kv/useKv";
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
  vi.mocked(ListKeys).mockResolvedValue({ ...ok, keys: [keyMeta("k-000")] } as never);
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
