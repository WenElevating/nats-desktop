import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreamsPage } from "../src/features/streams/StreamsPage";
import { ConfirmProvider } from "../src/lib/confirm";
import {
  BackupStream,
  GetStreamDetail,
  GetSettings,
  ListStreams,
  PickBackupDirectory,
  RestoreBackup,
} from "../src/lib/bindings";
import type { StreamDetail, StreamSummary } from "../src/lib/bindings";
import { parseBackupProgress } from "../src/features/streams/BackupPanel";

// Task 13: backup/restore UI. Scenario assertions match user-visible
// (interpolated) English text, so this file uses the real i18n module like
// the other streams suites. Mocked: @wailsio/runtime Events (handler captured
// so tests can fire stream:backup), the bindings surface, sonner, and the
// connection state (hoisted `connState`).
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
  ListStreams: vi.fn(),
  GetStreamDetail: vi.fn(),
  GetSettings: vi.fn(),
  PickBackupDirectory: vi.fn(),
  BackupStream: vi.fn(),
  RestoreBackup: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";

// jsdom has no layout: the setup.ts ResizeObserver stub never reports a size,
// so @tanstack/react-virtual would measure a 0px viewport and render no rows.
// Report a 1024x280 border box on observe (like the streams-page suite).
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

// ---- fixtures (the brief's scenario stream is named "S") ----

const summary = (over: Partial<StreamSummary> = {}): StreamSummary => ({
  name: "S",
  description: "",
  internal_kind: "",
  subjects: ["s.>"],
  storage: "file",
  retention: "limits",
  messages: 10,
  bytes: 2048,
  consumers: 1,
  first_seq: 1,
  last_seq: 100,
  last_time_ms: 1_770_000_000_000,
  lost_msgs: 0,
  lost_bytes: 0,
  num_deleted: 0,
  is_mirror: false,
  is_source: false,
  leader_missing: false,
  unhealthy_replicas: 0,
  replica_count: 1,
  ...over,
});

const detailFixture = (): StreamDetail =>
  ({
    error_code: "",
    error: "",
    summary: summary(),
    form: {},
    created_ms: 1_770_000_000_000,
    state: {
      first_time_ms: 1_770_000_000_000,
      last_time_ms: 1_770_000_060_000,
      num_subjects: 1,
    },
    mirror: null,
    sources: [],
    cluster: null,
  }) as unknown as StreamDetail;

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

const listOk = (streams: StreamSummary[]) => ({
  error_code: "",
  error: "",
  streams,
  unavailable_reason: "",
});

const ok = { error_code: "", error: "" };

// ---- harness ----

const flush = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const fireBackup = (payload: unknown) =>
  act(() => runtime.handlers.get("stream:backup")?.({ data: payload }));

const openBackupForS = async () => {
  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();
  fireEvent.click(screen.getByTestId("stream-row-S"));
  await flush();
  fireEvent.click(screen.getByTestId("stream-op-backup"));
  await flush();
};

beforeEach(() => {
  connState.state = "connected";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  runtime.handlers.clear();
  runtime.offs.length = 0;
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListStreams).mockResolvedValue(listOk([summary()]) as never);
  vi.mocked(GetStreamDetail).mockResolvedValue(detailFixture() as never);
  vi.mocked(PickBackupDirectory).mockResolvedValue("/tmp/bk" as never);
  vi.mocked(BackupStream).mockResolvedValue(ok as never);
  vi.mocked(RestoreBackup).mockResolvedValue(ok as never);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- the brief's five scenarios ----

it("backup flow: picker → BackupStream(S, dir, false) → progress 50% → complete toasts + refresh", async () => {
  await openBackupForS();

  // The panel opened with include-consumers defaulting to OFF.
  const panel = screen.getByTestId("backup-panel");
  expect(panel).toBeTruthy();
  const checkbox = screen.getByTestId("backup-include-consumers");
  expect(checkbox.getAttribute("data-state")).toBe("unchecked");

  // Choose a directory: the binding gets the exact stream/dir/flag triple.
  fireEvent.click(screen.getByTestId("backup-pick-dir"));
  await flush();
  expect(PickBackupDirectory).toHaveBeenCalledTimes(1);
  expect(BackupStream).toHaveBeenCalledTimes(1);
  expect(BackupStream).toHaveBeenCalledWith("S", "/tmp/bk", false);

  // No events yet → indeterminate progress (no aria-valuenow).
  expect(screen.getByTestId("backup-progress")).toBeTruthy();
  expect(screen.getByTestId("backup-progress").getAttribute("aria-valuenow")).toBeNull();

  // A running event with byte totals drives the bar to 50%.
  fireBackup({ stream: "S", direction: "backup", phase: "running", bytes_done: 50, bytes_total: 100 });
  await flush();
  expect(screen.getByTestId("backup-progress").getAttribute("aria-valuenow")).toBe("50");

  // Phase complete → done state + success toast + one refresh (list reloaded).
  fireBackup({ stream: "S", direction: "backup", phase: "complete", bytes_done: 100, bytes_total: 100 });
  await flush();
  expect(screen.getByTestId("backup-done")).toBeTruthy();
  expect(toast.success).toHaveBeenCalledTimes(1);
  expect(toast.error).not.toHaveBeenCalled();
  expect(ListStreams).toHaveBeenCalledTimes(2);
});

it("phase incomplete → warning with the server原文 and never a success toast", async () => {
  vi.mocked(BackupStream).mockResolvedValue({
    error_code: "server",
    error: "nats: connection closed during backup",
  } as never);
  await openBackupForS();

  fireEvent.click(screen.getByTestId("backup-pick-dir"));
  await flush();
  expect(BackupStream).toHaveBeenCalledWith("S", "/tmp/bk", false);

  fireBackup({ stream: "S", direction: "backup", phase: "incomplete" });
  await flush();

  const warn = screen.getByTestId("backup-incomplete");
  expect(warn.textContent).toContain("Backup incomplete");
  expect(warn.textContent).toContain("nats: connection closed during backup");
  expect(screen.queryByTestId("backup-done")).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
});

it("restore flow: target exists → overwrite confirm gate → RestoreBackup(dir, true) → complete + refresh", async () => {
  vi.mocked(RestoreBackup)
    .mockResolvedValueOnce({
      error_code: "validation",
      error: "restore target stream already exists (confirm delete-and-recreate)",
    } as never)
    .mockResolvedValueOnce(ok as never);

  render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  // The toolbar Restore button opens the panel in restore mode.
  fireEvent.click(screen.getByTestId("streams-restore"));
  await flush();
  expect(screen.getByTestId("backup-panel")).toBeTruthy();

  fireEvent.click(screen.getByTestId("backup-pick-dir"));
  await flush();

  // First call probes without overwrite and gets the target-exists answer.
  expect(RestoreBackup).toHaveBeenCalledTimes(1);
  expect(RestoreBackup).toHaveBeenCalledWith("/tmp/bk", false);

  // Overwrite confirm sub-state: checkbox unchecked → confirm disabled.
  const check = screen.getByTestId("backup-overwrite-check");
  expect(check.getAttribute("data-state")).toBe("unchecked");
  const confirm = screen.getByTestId("backup-overwrite-confirm") as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);

  // Checking 删除并重建 enables the confirm, which retries with overwrite=true.
  fireEvent.click(check);
  await flush();
  expect((screen.getByTestId("backup-overwrite-confirm") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByTestId("backup-overwrite-confirm"));
  await flush();
  expect(RestoreBackup).toHaveBeenCalledTimes(2);
  expect(RestoreBackup).toHaveBeenCalledWith("/tmp/bk", true);

  // Restore progress events arrive (bytes-free, chunk-only) then complete.
  fireBackup({ stream: "S", direction: "restore", phase: "running", bytes_done: 0, bytes_total: 0, chunks_done: 3 });
  await flush();
  expect(screen.getByTestId("backup-progress")).toBeTruthy();

  fireBackup({ stream: "S", direction: "restore", phase: "complete", chunks_done: 5 });
  await flush();
  expect(screen.getByTestId("backup-done")).toBeTruthy();
  expect(toast.success).toHaveBeenCalledTimes(1);
  expect(ListStreams).toHaveBeenCalledTimes(2);
});

it("cancelled directory pick: no request, panel closes, subscription torn down on unmount", async () => {
  vi.mocked(PickBackupDirectory).mockResolvedValue("" as never);

  const view = render(
    <ConfirmProvider>
      <StreamsPage />
    </ConfirmProvider>,
  );
  await flush();

  fireEvent.click(screen.getByTestId("streams-restore"));
  await flush();
  fireEvent.click(screen.getByTestId("backup-pick-dir"));
  await flush();

  expect(PickBackupDirectory).toHaveBeenCalledTimes(1);
  expect(RestoreBackup).not.toHaveBeenCalled();
  expect(BackupStream).not.toHaveBeenCalled();
  expect(screen.queryByTestId("backup-panel")).toBeNull();

  // Unmounting the page tears down the stream:backup subscription.
  view.unmount();
  expect(runtime.offs).toContain("stream:backup");
});

it("busy mutex (ErrBackupBusy validation原文) → toast, panel returns to options", async () => {
  vi.mocked(BackupStream).mockResolvedValue({
    error_code: "validation",
    error: "another backup or restore is already running",
  } as never);
  await openBackupForS();

  fireEvent.click(screen.getByTestId("backup-pick-dir"));
  await flush();

  expect(BackupStream).toHaveBeenCalledTimes(1);
  expect(toast.error).toHaveBeenCalledTimes(1);
  expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain(
    "another backup or restore is already running",
  );
  expect(toast.success).not.toHaveBeenCalled();
  // No special UI: the panel is back at the options stage (pick button ready).
  expect(screen.getByTestId("backup-pick-dir")).toBeTruthy();
  expect(screen.queryByTestId("backup-done")).toBeNull();
  expect(screen.queryByTestId("backup-incomplete")).toBeNull();
});

it("parseBackupProgress whitelists fields and tolerates unknown ones", () => {
  expect(
    parseBackupProgress({
      stream: "S",
      direction: "backup",
      phase: "running",
      bytes_done: 50,
      bytes_total: 100,
      chunks_done: 2,
      future_field: { nested: true },
    }),
  ).toEqual({
    stream: "S",
    direction: "backup",
    phase: "running",
    bytesDone: 50,
    bytesTotal: 100,
    chunksDone: 2,
  });

  // Restore payloads carry chunk counts only; missing numerics default to 0.
  expect(
    parseBackupProgress({ stream: "S", direction: "restore", phase: "complete", chunks_done: 5 }),
  ).toEqual({
    stream: "S",
    direction: "restore",
    phase: "complete",
    bytesDone: 0,
    bytesTotal: 0,
    chunksDone: 5,
  });

  // Malformed payloads (bad direction/phase/missing stream) are rejected.
  expect(parseBackupProgress({ stream: "S", direction: "sideways", phase: "running" })).toBeNull();
  expect(parseBackupProgress({ stream: "S", direction: "backup", phase: "done" })).toBeNull();
  expect(parseBackupProgress({ direction: "backup", phase: "running" })).toBeNull();
  expect(parseBackupProgress(null)).toBeNull();
  expect(parseBackupProgress("garbage")).toBeNull();
});
