import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { ObjectsPage } from "../src/features/objects/ObjectsPage";
import { applyWatchEvent, type ObjWatchEvent } from "../src/features/objects/useObjects";
import {
  ListObjBuckets,
  GetObjBucketDetail,
  CreateObjBucket,
  UpdateObjBucket,
  DeleteObjBucket,
  SealObjBucket,
  ListObjects,
  DeleteObject,
  RenameObject,
  PickUploadFiles,
  PickDownloadDirectory,
  UploadObject,
  DownloadObject,
  OpenInFileManager,
  CreateObjWatch,
  StopWatch,
  GetSettings,
  type ObjBucketSummary,
  type ObjBucketForm,
  type ObjectOut,
} from "../src/lib/bindings";
import { ConfirmProvider } from "../src/lib/confirm";

// Real i18n (en resources); mocked: connstate (hoisted mutable), the Wails
// bindings, @wailsio/runtime Events (obj:watch + obj:transfer capture), and
// sonner (toast text assertions) — the established M3/M4 test pattern.
const connState = vi.hoisted(() => ({
  state: "connected",
  context: "dev",
  rttMs: 5,
  reason: "",
}));

// Event handler capture shared between the runtime mock and the fire helpers.
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
  ListObjBuckets: vi.fn(),
  GetObjBucketDetail: vi.fn(),
  CreateObjBucket: vi.fn(),
  UpdateObjBucket: vi.fn(),
  DeleteObjBucket: vi.fn(),
  SealObjBucket: vi.fn(),
  ListObjects: vi.fn(),
  DeleteObject: vi.fn(),
  RenameObject: vi.fn(),
  PickUploadFiles: vi.fn(),
  PickDownloadDirectory: vi.fn(),
  UploadObject: vi.fn(),
  DownloadObject: vi.fn(),
  OpenInFileManager: vi.fn(),
  CreateObjWatch: vi.fn(),
  StopWatch: vi.fn(),
  GetSettings: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";

// jsdom has no layout: the setup.ts ResizeObserver stub never reports a size,
// so @tanstack/react-virtual would measure a 0px viewport and render no rows.
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

const BUCKET = "PHOTOS";
const SEALED = "ARCHIVE";

const bucketSummary = (over: Partial<ObjBucketSummary> = {}): ObjBucketSummary => ({
  name: BUCKET,
  description: "object bucket",
  size: 2048,
  sealed: false,
  replicas: 1,
  ttl_seconds: 0,
  ...over,
});

const detailForm = (over: Partial<ObjBucketForm> = {}): ObjBucketForm => ({
  name: BUCKET,
  description: "object bucket",
  max_bytes: -1,
  replicas: 1,
  ...over,
});

const objOut = (name: string, over: Partial<ObjectOut> = {}): ObjectOut => ({
  name,
  size: 100,
  chunks: 1,
  digest: "SHA-256=abc",
  mod_time_ms: 1_770_000_000_000,
  deleted: false,
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

const listOk = (buckets: ObjBucketSummary[]) => ({
  error_code: "",
  error: "",
  kv_buckets: [],
  obj_buckets: buckets,
  unavailable_reason: "",
});

const ok = { error_code: "", error: "" };

const transferEvent = (over: Record<string, unknown>) => ({
  transfer_id: "t-1",
  bucket: BUCKET,
  name: "f.bin",
  direction: "upload",
  phase: "running",
  bytes_done: 0,
  bytes_total: 100,
  ...over,
});

// Real timers; flush pending microtasks/timers inside act.
const flush = async (ms = 10) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const fireTransfer = (ev: Record<string, unknown>) => {
  act(() => {
    runtime.handlers.get("obj:transfer")?.({ data: ev });
  });
};

const fireWatch = (ev: ObjWatchEvent) => {
  act(() => {
    runtime.handlers.get("obj:watch")?.({ data: ev });
  });
};

// Mount the page inside the app-wide ConfirmProvider, wait for the bucket
// list, then select PHOTOS so the detail pane is on screen.
const setup = async (objects: ObjectOut[] = [objOut("f.bin")]) => {
  render(
    <ConfirmProvider>
      <ObjectsPage />
    </ConfirmProvider>,
  );
  await flush();
  fireEvent.click(screen.getByTestId(`objects-bucket-row-${BUCKET}`));
  await flush();
  expect(screen.getByTestId("objects-bucket-detail")).toBeTruthy();
  return objects;
};

beforeEach(() => {
  connState.state = "connected";
  vi.clearAllMocks();
  runtime.handlers.clear();
  runtime.offs = [];
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListObjBuckets).mockResolvedValue(listOk([bucketSummary()]) as never);
  vi.mocked(GetObjBucketDetail).mockImplementation(((name: string) =>
    Promise.resolve({
      ...ok,
      form: detailForm(name === SEALED ? { name: SEALED } : {}),
      sealed: name === SEALED,
    }) as never) as never);
  vi.mocked(ListObjects).mockResolvedValue({ ...ok, objects: [objOut("f.bin")] } as never);
  vi.mocked(CreateObjBucket).mockResolvedValue(ok as never);
  vi.mocked(UpdateObjBucket).mockResolvedValue(ok as never);
  vi.mocked(DeleteObjBucket).mockResolvedValue(ok as never);
  vi.mocked(SealObjBucket).mockResolvedValue(ok as never);
  vi.mocked(DeleteObject).mockResolvedValue(ok as never);
  vi.mocked(RenameObject).mockResolvedValue(ok as never);
  vi.mocked(PickUploadFiles).mockResolvedValue([] as never);
  vi.mocked(PickDownloadDirectory).mockResolvedValue("" as never);
  vi.mocked(UploadObject).mockResolvedValue(ok as never);
  vi.mocked(DownloadObject).mockResolvedValue(ok as never);
  vi.mocked(OpenInFileManager).mockResolvedValue(ok as never);
  vi.mocked(CreateObjWatch).mockResolvedValue({ ...ok, watch_id: "w-1" } as never);
  vi.mocked(StopWatch).mockResolvedValue(ok as never);
});

// ---- brief scenario 1: bucket/object list render + sealed bucket disables ----

it("renders bucket and object lists with badges; a sealed bucket disables upload/edit, keeps delete, and shows the sealed hint", async () => {
  vi.mocked(ListObjBuckets).mockResolvedValue(
    listOk([bucketSummary(), bucketSummary({ name: SEALED, sealed: true })]) as never,
  );
  render(
    <ConfirmProvider>
      <ObjectsPage />
    </ConfirmProvider>,
  );
  await flush();

  // Left rail rows show name / size / sealed badge.
  const row = screen.getByTestId(`objects-bucket-row-${BUCKET}`);
  expect(row.textContent).toContain(BUCKET);
  expect(row.textContent).toContain("2.0 KiB");
  expect(within(row).queryByTestId("objects-sealed-badge")).toBeNull();
  const sealedRow = screen.getByTestId(`objects-bucket-row-${SEALED}`);
  expect(within(sealedRow).getByTestId("objects-sealed-badge")).toBeTruthy();

  // Select the open bucket → object list renders with size / chunks.
  fireEvent.click(row);
  await flush();
  const objRow = screen.getByTestId("objects-object-row-f.bin");
  expect(objRow.textContent).toContain("f.bin");
  expect(objRow.textContent).toContain("100 B");

  // Select the sealed bucket → sealed badge + hint, upload/edit disabled,
  // delete stays enabled (server accepts deletes on sealed buckets).
  fireEvent.click(sealedRow);
  await flush();
  expect(screen.getByTestId("objects-bucket-detail-name").textContent).toBe(SEALED);
  expect(screen.getByTestId("objects-sealed-detail-badge")).toBeTruthy();
  expect(screen.getByTestId("objects-sealed-hint").textContent.length).toBeGreaterThan(0);
  expect((screen.getByTestId("objects-op-upload") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("objects-bucket-op-edit") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("objects-bucket-op-delete") as HTMLButtonElement).disabled).toBe(false);

  // Deleted objects keep their row with the deleted badge.
  vi.mocked(ListObjects).mockResolvedValue({
    ...ok,
    objects: [objOut("gone.bin", { deleted: true })],
  } as never);
  fireEvent.click(row);
  await flush();
  fireEvent.click(sealedRow);
  await flush();
  const goneRow = screen.getByTestId("objects-object-row-gone.bin");
  expect(goneRow.textContent).toContain("gone.bin");
  expect(within(goneRow).getByTestId("objects-object-deleted-badge")).toBeTruthy();
});

// ---- brief scenario 2: upload flow — queue → sequential args → events → refresh / retry ----

it("upload flow: picks 2 files into the queue, uploads them sequentially with (bucket, path, rename), drives the 50% progress bar from transfer events, refreshes on complete, and offers retry on incomplete", async () => {
  await setup();

  // Two picked paths → two queue rows; the second carries a rename.
  vi.mocked(PickUploadFiles).mockResolvedValue(["C:\\tmp\\a.txt", "C:\\tmp\\b.txt"] as never);
  vi.mocked(UploadObject).mockImplementation((async (_bucket: string, path: string) => {
    if (path.endsWith("a.txt")) {
      fireTransfer(
        transferEvent({ transfer_id: "t-1", name: "a.txt", bytes_done: 50, bytes_total: 100 }),
      );
      return ok as never;
    }
    fireTransfer(
      transferEvent({ transfer_id: "t-2", name: "renamed.txt", bytes_done: 100, bytes_total: 100 }),
    );
    fireTransfer(
      transferEvent({
        transfer_id: "t-2",
        name: "renamed.txt",
        phase: "complete",
        bytes_done: 100,
        bytes_total: 100,
      }),
    );
    return ok as never;
  }) as never);

  fireEvent.click(screen.getByTestId("objects-op-upload"));
  await flush();
  fireEvent.click(screen.getByTestId("objects-upload-pick"));
  await flush();

  expect(PickUploadFiles).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("objects-upload-item-0").textContent).toContain("a.txt");
  expect(screen.getByTestId("objects-upload-item-1").textContent).toContain("b.txt");

  // Optional per-file rename for the second item.
  fireEvent.change(screen.getByTestId("objects-upload-rename-1"), {
    target: { value: "renamed.txt" },
  });

  fireEvent.click(screen.getByTestId("objects-upload-start"));
  await flush(30);

  // Sequential: one UploadObject in flight at a time, wire args verbatim.
  expect(UploadObject).toHaveBeenCalledTimes(2);
  expect(UploadObject).toHaveBeenNthCalledWith(1, BUCKET, "C:\\tmp\\a.txt", "");
  expect(UploadObject).toHaveBeenNthCalledWith(2, BUCKET, "C:\\tmp\\b.txt", "renamed.txt");

  // 50% progress was rendered for the first item while it ran.
  expect(screen.getByTestId("objects-upload-progress-0").getAttribute("aria-valuenow")).toBe("50");

  // All complete → status flips and the objects list refreshed (per item).
  expect(screen.getByTestId("objects-upload-status-0").textContent).toContain("Complete");
  expect(screen.getByTestId("objects-upload-status-1").textContent).toContain("Complete");
  expect(ListObjects.mock.calls.length).toBeGreaterThanOrEqual(3);

  // Incomplete path: a third file fails mid-flight → red row + retry button
  // re-calls UploadObject with the same args and completes on the second try.
  vi.mocked(PickUploadFiles).mockResolvedValue(["C:\\tmp\\c.txt"] as never);
  let cAttempts = 0;
  vi.mocked(UploadObject).mockImplementation((async (_bucket: string, path: string) => {
    if (path.endsWith("c.txt")) {
      cAttempts += 1;
      fireTransfer(
        transferEvent({
          transfer_id: `t-c${cAttempts}`,
          name: "c.txt",
          phase: cAttempts === 1 ? "incomplete" : "complete",
          bytes_done: 40,
          bytes_total: 100,
          error: cAttempts === 1 ? "connection closed during upload" : undefined,
        }),
      );
      return cAttempts === 1
        ? ({ error_code: "server", error: "connection closed during upload" } as never)
        : (ok as never);
    }
    return ok as never;
  }) as never);

  fireEvent.click(screen.getByTestId("objects-upload-pick"));
  await flush();
  fireEvent.click(screen.getByTestId("objects-upload-start"));
  await flush(30);

  const status2 = screen.getByTestId("objects-upload-status-2");
  expect(status2.textContent).toContain("Incomplete");
  // The server原文 renders on the item row (red) next to the retry button.
  expect(screen.getByTestId("objects-upload-item-2").textContent).toContain(
    "connection closed during upload",
  );
  const retry = screen.getByTestId("objects-upload-retry-2");
  expect(retry).toBeTruthy();
  fireEvent.click(retry);
  await flush(30);
  expect(UploadObject).toHaveBeenLastCalledWith(BUCKET, "C:\\tmp\\c.txt", "");
  expect(screen.getByTestId("objects-upload-status-2").textContent).toContain("Complete");
  expect(cAttempts).toBe(2);
});

// ---- brief scenario 2b: busy transfer error → toast with the server text ----

it("upload hit by a concurrent transfer shows the busy server text as a toast and re-queues the file", async () => {
  await setup();
  vi.mocked(PickUploadFiles).mockResolvedValue(["C:\\tmp\\a.txt"] as never);
  vi.mocked(UploadObject).mockResolvedValue({
    error_code: "validation",
    error: "another object transfer is already running",
  } as never);

  fireEvent.click(screen.getByTestId("objects-op-upload"));
  await flush();
  fireEvent.click(screen.getByTestId("objects-upload-pick"));
  await flush();
  fireEvent.click(screen.getByTestId("objects-upload-start"));
  await flush(30);

  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("another object transfer is already running"),
  );
  // The file is back to queued (start can be pressed again), not failed.
  expect(screen.getByTestId("objects-upload-status-0").textContent).toContain("Queued");
});

// ---- brief scenario 3: download flow — dir pick → args → progress → digest chip → open dir; disk gate toast ----

it("download flow: picks a directory, calls DownloadObject with (bucket, name, dir), shows progress, then the digest chip and OpenInFileManager; disk-space refusal toasts the server text", async () => {
  await setup();

  // Progress events land while DownloadObject is in flight.
  vi.mocked(PickDownloadDirectory).mockResolvedValue("C:\\dl" as never);
  vi.mocked(DownloadObject).mockImplementation((async () => {
    fireTransfer(
      transferEvent({
        transfer_id: "t-d1",
        direction: "download",
        name: "f.bin",
        bytes_done: 50,
        bytes_total: 100,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    return ok as never;
  }) as never);

  fireEvent.click(screen.getByTestId("objects-obj-download-f.bin"));
  await flush(20);

  expect(PickDownloadDirectory).toHaveBeenCalledTimes(1);
  expect(DownloadObject).toHaveBeenCalledWith(BUCKET, "f.bin", "C:\\dl");
  expect(screen.getByTestId("objects-dl-progress-f.bin").getAttribute("aria-valuenow")).toBe("50");

  // Terminal event with digest_match=true → ✓ chip + open-directory button.
  fireTransfer(
    transferEvent({
      transfer_id: "t-d1",
      direction: "download",
      name: "f.bin",
      phase: "complete",
      bytes_done: 100,
      bytes_total: 100,
      digest_match: true,
    }),
  );
  await flush();
  const chip = screen.getByTestId("objects-dl-digest-f.bin");
  expect(chip.textContent).toContain("✓");
  const openBtn = screen.getByTestId("objects-dl-open-f.bin");
  fireEvent.click(openBtn);
  expect(OpenInFileManager).toHaveBeenCalledWith("C:\\dl\\f.bin");

  // Disk gate (validation + ErrDiskSpace text): blocked before any transfer
  // event — the server text surfaces as a toast and no row state sticks.
  vi.mocked(DownloadObject).mockResolvedValue({
    error_code: "validation",
    error: "insufficient disk space at download target",
  } as never);
  vi.mocked(PickDownloadDirectory).mockResolvedValue("C:\\dl" as never);
  fireEvent.click(screen.getByTestId("objects-obj-download-f.bin"));
  await flush(20);
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("insufficient disk space at download target"),
  );
  expect(screen.queryByTestId("objects-dl-progress-f.bin")).toBeNull();
});

// ---- brief scenario 4: L1 object delete + L2 bucket delete name-match ----

it("deletes an object behind an L1 confirm, and the L2 bucket delete refuses a wrong name then deletes on the exact name", async () => {
  await setup();

  // L1 object delete: cancel keeps the object, confirm calls the binding.
  fireEvent.click(screen.getByTestId("objects-obj-delete-f.bin"));
  await flush();
  expect(screen.getAllByRole("alertdialog").length).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
  await flush();
  expect(DeleteObject).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("objects-obj-delete-f.bin"));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
  await flush();
  expect(DeleteObject).toHaveBeenCalledWith(BUCKET, "f.bin");
  expect(toast.success).toHaveBeenCalled();

  // L2 bucket delete: wrong name keeps the dialog, never calls the binding.
  fireEvent.click(screen.getByTestId("objects-bucket-op-delete"));
  await flush();
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain(BUCKET);
  const input = screen.getByLabelText("name-match-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "photos" } });
  const confirmBtn = screen.getByRole("button", { name: /confirm/i });
  expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(confirmBtn);
  await flush();
  expect(DeleteObjBucket).not.toHaveBeenCalled();

  // Exact name: deletes and drops the selection.
  fireEvent.change(input, { target: { value: BUCKET } });
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
  await flush();
  expect(DeleteObjBucket).toHaveBeenCalledTimes(1);
  expect(DeleteObjBucket).toHaveBeenCalledWith(BUCKET);
  expect(toast.success).toHaveBeenCalled();
  expect(screen.getByTestId("objects-detail-empty")).toBeTruthy();
});

// ---- brief scenario 5: object rename (L1-lite) ----

it("renames an object through the rename dialog and calls RenameObject with (bucket, name, newName)", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("objects-obj-rename-f.bin"));
  await flush();
  const confirmBtn = screen.getByTestId("objects-rename-confirm") as HTMLButtonElement;
  // Empty / unchanged name keeps confirm disabled.
  expect(confirmBtn.disabled).toBe(true);
  fireEvent.change(screen.getByTestId("objects-rename-input"), { target: { value: "f.bin" } });
  expect((screen.getByTestId("objects-rename-confirm") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByTestId("objects-rename-input"), { target: { value: "g.bin" } });
  fireEvent.click(screen.getByTestId("objects-rename-confirm"));
  await flush();
  expect(RenameObject).toHaveBeenCalledWith(BUCKET, "f.bin", "g.bin");
  expect(toast.success).toHaveBeenCalled();
});

// ---- brief scenario 6: watch events render + Stop + ring cap ----

it("watch: pushed obj events render with the sentinel, Stop calls StopWatch, and the ring caps at 10k", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("objects-watch-start"));
  await flush();
  expect(CreateObjWatch).toHaveBeenCalledWith(BUCKET);

  const ev = (over: Partial<ObjWatchEvent>): ObjWatchEvent => ({
    watch_id: "w-1",
    bucket: BUCKET,
    name: "n-1",
    size: 10,
    chunks: 1,
    digest: "SHA-256=abc",
    mod_time_ms: 1_770_000_000_000,
    deleted: false,
    dropped_total: 0,
    ...over,
  });
  for (let i = 1; i <= 3; i++) fireWatch(ev({ name: `n-${i}`, size: i * 10 }));
  fireWatch(ev({ name: "" })); // sentinel

  const list = screen.getByTestId("objects-watch-list");
  expect(screen.getAllByTestId("objects-watch-row").length).toBe(3);
  expect(within(list).getByTestId("objects-watch-sentinel").textContent).toContain("snapshot");

  // The Go sentinel omits "name" entirely (omitempty) — still a sentinel.
  const bare = ev({ name: "" }) as Record<string, unknown>;
  delete bare.name;
  fireWatch(bare as unknown as ObjWatchEvent);
  expect(screen.getAllByTestId("objects-watch-sentinel").length).toBe(2);

  // dropped_total from the latest event shows on the chip.
  fireWatch(ev({ name: "n-9", dropped_total: 4 }));
  expect(screen.getByTestId("objects-watch-dropped").textContent).toContain("4");

  // Stop → StopWatch(watch_id) and the panel resets.
  fireEvent.click(screen.getByTestId("objects-watch-stop"));
  await flush();
  expect(StopWatch).toHaveBeenCalledWith("w-1");
  expect(screen.getByTestId("objects-watch-start")).toBeTruthy();

  // 10k ring cap: pushing 10_005 keeps the LAST 10_000.
  let ring: ObjWatchEvent[] = [];
  for (let i = 1; i <= 10_005; i++) ring = applyWatchEvent(ring, ev({ name: `k-${i}` }));
  expect(ring.length).toBe(10_000);
  expect(ring[0].name).toBe("k-6");
  expect(ring[ring.length - 1].name).toBe("k-10005");
});

// ---- brief scenario 7: unavailable guidance panel ----

it("unavailable_reason renders the guidance panel with non-empty guidance instead of the table", async () => {
  vi.mocked(ListObjBuckets).mockResolvedValue({
    error_code: "",
    error: "",
    kv_buckets: [],
    obj_buckets: [],
    unavailable_reason: "timeout",
  } as never);

  render(
    <ConfirmProvider>
      <ObjectsPage />
    </ConfirmProvider>,
  );
  await flush();

  const panel = screen.getByTestId("objects-unavailable");
  expect(panel.textContent.length).toBeGreaterThan(0);
  expect(panel.textContent).toContain("timed out");
  const items = within(panel).getAllByRole("listitem");
  expect(items.length).toBe(2);
  expect(ListObjects).not.toHaveBeenCalled();
});
