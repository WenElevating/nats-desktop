import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { DangerZone } from "../src/features/monitoring/DangerZone";
import {
  MetaPeerRemove,
  MetaStepDown,
  StreamBalance,
  StreamPeerRemove,
  StreamStepDown,
} from "../src/lib/bindings";
import type { ClusterOpResult, MonitorSnapshot, MonitorServerRow } from "../src/lib/bindings";

// DangerZone suite: real i18n (en resources); mocked connstate (hoisted
// mutable), the Wails cluster-op bindings, and sonner — the M4 danger-suite
// pattern (confirmNameMatch semantics live in the L2 DangerOpDialog here).
const connState = vi.hoisted(() => ({
  state: "connected",
  context: "dev",
  rttMs: 5,
  reason: "",
}));

vi.mock("../src/app/connstate", () => ({
  useConnState: () => connState,
}));

vi.mock("../src/lib/bindings", () => ({
  MetaStepDown: vi.fn(),
  MetaPeerRemove: vi.fn(),
  StreamStepDown: vi.fn(),
  StreamPeerRemove: vi.fn(),
  StreamBalance: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";

// ---- fixtures (MonitorSnapshot / ClusterOpResult wire shapes) ----

const row = (over: Partial<MonitorServerRow> = {}): MonitorServerRow =>
  ({
    name: "nats-a",
    id: "id-a",
    host: "127.0.0.1:4222",
    cluster: "c1",
    domain: "",
    version: "2.10.0",
    online: true,
    offline_since_ms: 0,
    uptime_seconds: 120,
    cpu: 1,
    mem_bytes: 1,
    cores: 4,
    connections: 0,
    total_connections: 0,
    routes: 0,
    gateways: 0,
    active_accounts: 1,
    slow_consumers: 0,
    js_enabled: true,
    js_role: "meta_leader",
    js_streams: 0,
    js_streams_leader: 0,
    js_consumers: 0,
    js_memory_bytes: 0,
    js_store_bytes: 0,
    js_max_memory_bytes: -1,
    js_max_store_bytes: -1,
    error: "",
    ...over,
  }) as unknown as MonitorServerRow;

const snap = (servers: MonitorServerRow[]): MonitorSnapshot =>
  ({
    servers,
    sys_available: true,
    sys_reason: "",
    polled_at_ms: 1_000,
    cycle_ms: 20,
    rtt_ms: 3,
    poll_interval_seconds: 5,
  }) as unknown as MonitorSnapshot;

const clusterSnap = () =>
  snap([row({ name: "nats-a", js_role: "meta_leader" }), row({ name: "nats-b", js_role: "voter" })]);

const okRes = (over: Partial<ClusterOpResult> = {}): ClusterOpResult =>
  ({
    error_code: "",
    error: "",
    old_leader: "nats-a",
    new_leader: "nats-b",
    streams_balanced: 0,
    note: "",
    elapsed_ms: 1500,
    ...over,
  }) as unknown as ClusterOpResult;

const flush = async (ms = 10) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const setup = async (s: MonitorSnapshot = clusterSnap()) => {
  render(<DangerZone snapshot={s} />);
  await flush();
};

/** The exact-name confirm flow of the shared L2 dialog. */
const confirmWith = async (expected: string, typed?: string) => {
  const input = screen.getByTestId("danger-op-input");
  fireEvent.change(input, { target: { value: typed ?? expected } });
  fireEvent.click(screen.getByTestId("danger-op-confirm"));
  await flush();
};

beforeEach(() => {
  connState.state = "connected";
  vi.clearAllMocks();
  vi.mocked(MetaStepDown).mockResolvedValue(okRes() as never);
  vi.mocked(StreamStepDown).mockResolvedValue(okRes() as never);
  vi.mocked(StreamBalance).mockResolvedValue(okRes({ streams_balanced: 5, elapsed_ms: 800 }) as never);
  vi.mocked(MetaPeerRemove).mockResolvedValue(okRes() as never);
  vi.mocked(StreamPeerRemove).mockResolvedValue(okRes() as never);
});

// ---- section + cards ----

it("renders the red-separated section with the four op cards and the snapshot's meta leader", async () => {
  await setup();

  expect(screen.getByTestId("danger-zone")).toBeTruthy();
  for (const card of ["meta-step-down", "stream-step-down", "stream-balance", "peer-remove"]) {
    expect(screen.getByTestId(`danger-card-${card}`)).toBeTruthy();
  }
  expect(screen.getByTestId("danger-meta-leader").textContent).toBe("nats-a");
  // Stream/peer targets are empty → those cards start disabled.
  expect((screen.getByTestId("danger-btn-stream-step-down") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("danger-btn-stream-balance") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("danger-btn-peer-remove") as HTMLButtonElement).disabled).toBe(true);
});

it("disables the meta step-down card when the snapshot has no meta leader", async () => {
  await setup(snap([row({ name: "nats-a", js_role: "voter" })]));

  expect(screen.getByTestId("danger-meta-leader").textContent).toBe("—");
  expect((screen.getByTestId("danger-btn-meta-step-down") as HTMLButtonElement).disabled).toBe(true);
});

// ---- meta step-down: the full L2 flow ----

it("meta step-down: mismatch keeps the dialog with the hint and never calls the binding", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("danger-btn-meta-step-down"));
  await flush();

  const dialog = screen.getByTestId("danger-op-dialog");
  expect(dialog.textContent).toContain("Step down meta leader");
  expect(dialog.textContent).toContain("re-election"); // impact explanation list
  expect(MetaStepDown).not.toHaveBeenCalled();

  fireEvent.change(screen.getByTestId("danger-op-input"), { target: { value: "nats" } });
  const confirmBtn = screen.getByTestId("danger-op-confirm") as HTMLButtonElement;
  expect(confirmBtn.disabled).toBe(true);
  expect(screen.getByTestId("danger-op-mismatch").textContent).toContain("does not match");

  fireEvent.click(confirmBtn);
  await flush();
  expect(MetaStepDown).not.toHaveBeenCalled();
  expect(screen.queryByTestId("danger-op-dialog")).not.toBeNull(); // dialog stays
});

it("meta step-down: esc and cancel close the dialog without calling the binding", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("danger-btn-meta-step-down"));
  await flush();
  expect(screen.queryByTestId("danger-op-dialog")).not.toBeNull();

  fireEvent.keyDown(screen.getByTestId("danger-op-input"), { key: "Escape" });
  await flush();
  expect(screen.queryByTestId("danger-op-dialog")).toBeNull();
  expect(MetaStepDown).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("danger-btn-meta-step-down"));
  await flush();
  fireEvent.click(screen.getByTestId("danger-op-cancel"));
  await flush();
  expect(screen.queryByTestId("danger-op-dialog")).toBeNull();
  expect(MetaStepDown).not.toHaveBeenCalled();
});

it("meta step-down: the matching name executes exactly once and toasts old→new + elapsed", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("danger-btn-meta-step-down"));
  await flush();
  await confirmWith("nats-a");

  expect(MetaStepDown).toHaveBeenCalledTimes(1);
  expect(toast.success).toHaveBeenCalledWith(
    expect.stringContaining("nats-a → nats-b"),
  );
  expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("1.5s"));
  // The dialog closes after the result toast landed.
  expect(screen.queryByTestId("danger-op-dialog")).toBeNull();
});

it("a server failure toasts the 原文; a conflict toasts the in-progress message", async () => {
  await setup();

  vi.mocked(MetaStepDown).mockResolvedValue(
    okRes({ error_code: "server", error: "raft peer not available" }) as never,
  );
  fireEvent.click(screen.getByTestId("danger-btn-meta-step-down"));
  await flush();
  await confirmWith("nats-a");
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("raft peer not available"));
  expect(toast.success).not.toHaveBeenCalled();

  await flush();
  vi.mocked(MetaStepDown).mockResolvedValue(
    okRes({ error_code: "conflict", error: "operation in progress" }) as never,
  );
  fireEvent.click(screen.getByTestId("danger-btn-meta-step-down"));
  await flush();
  await confirmWith("nats-a");
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("already in progress"));
});

it("in-flight disables confirm and cancel with a spinner until the result lands", async () => {
  await setup();

  let release!: (v: ClusterOpResult) => void;
  vi.mocked(MetaStepDown).mockImplementation(
    () => new Promise<ClusterOpResult>((r) => (release = r)) as never,
  );
  fireEvent.click(screen.getByTestId("danger-btn-meta-step-down"));
  await flush();
  await confirmWith("nats-a");

  const confirmBtn = screen.getByTestId("danger-op-confirm") as HTMLButtonElement;
  const cancelBtn = screen.getByTestId("danger-op-cancel") as HTMLButtonElement;
  expect(MetaStepDown).toHaveBeenCalledTimes(1);
  expect(confirmBtn.disabled).toBe(true);
  expect(cancelBtn.disabled).toBe(true);
  expect(confirmBtn.querySelector(".animate-spin")).toBeTruthy(); // spinner
  expect(screen.queryByTestId("danger-op-dialog")).not.toBeNull(); // stays open mid-flight

  await act(async () => {
    release(okRes());
  });
  await flush();
  expect(screen.queryByTestId("danger-op-dialog")).toBeNull();
  expect(toast.success).toHaveBeenCalled();
});

// ---- stream step-down / balance / peer remove ----

it("stream step-down takes the card input as the L2 target and calls StreamStepDown", async () => {
  await setup();

  fireEvent.change(screen.getByTestId("danger-stream-stepdown-input"), {
    target: { value: "ORDERS" },
  });
  fireEvent.click(screen.getByTestId("danger-btn-stream-step-down"));
  await flush();

  expect(screen.getByTestId("danger-op-dialog").textContent).toContain("ORDERS");
  await confirmWith("ORDERS");

  expect(StreamStepDown).toHaveBeenCalledTimes(1);
  expect(StreamStepDown).toHaveBeenCalledWith("ORDERS");
  expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("nats-a → nats-b"));
});

it("balance toasts the balanced count and elapsed", async () => {
  await setup();

  fireEvent.change(screen.getByTestId("danger-balance-input"), { target: { value: "ORDERS" } });
  fireEvent.click(screen.getByTestId("danger-btn-stream-balance"));
  await flush();
  await confirmWith("ORDERS");

  expect(StreamBalance).toHaveBeenCalledTimes(1);
  expect(StreamBalance).toHaveBeenCalledWith("ORDERS");
  expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("5"));
  expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("0.8s"));
});

it("meta peer remove carries the natscli restart/R1 warnings and calls MetaPeerRemove", async () => {
  await setup();

  fireEvent.change(screen.getByTestId("danger-peer-input"), { target: { value: "nats-b" } });
  fireEvent.click(screen.getByTestId("danger-btn-peer-remove"));
  await flush();

  const impact = screen.getByTestId("danger-op-impact").textContent;
  expect(impact).toContain("ENTIRE cluster is restarted");
  expect(impact).toContain("R1");
  expect(impact).toContain("consumer state");

  await confirmWith("nats-b");
  expect(MetaPeerRemove).toHaveBeenCalledTimes(1);
  expect(MetaPeerRemove).toHaveBeenCalledWith("nats-b");
  expect(StreamPeerRemove).not.toHaveBeenCalled();
  expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("nats-b"));
});

it("stream peer remove (scope switch) calls StreamPeerRemove with stream + peer", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("danger-peer-scope-stream"));
  fireEvent.change(screen.getByTestId("danger-peer-stream-input"), { target: { value: "ORDERS" } });
  fireEvent.change(screen.getByTestId("danger-peer-input"), { target: { value: "nats-c" } });
  fireEvent.click(screen.getByTestId("danger-btn-peer-remove"));
  await flush();

  expect(screen.getByTestId("danger-op-dialog").getAttribute("data-op")).toBe("stream_peer_remove");
  await confirmWith("nats-c");

  expect(StreamPeerRemove).toHaveBeenCalledTimes(1);
  expect(StreamPeerRemove).toHaveBeenCalledWith("ORDERS", "nats-c");
  expect(MetaPeerRemove).not.toHaveBeenCalled();
});

it("every op is gated behind the L2 dialog — the bindings never fire without a name match", async () => {
  await setup();

  // Open each of the four cards' dialogs, click confirm with a WRONG name, and
  // assert the binding stays untouched (four ops → four L2 gates).
  fireEvent.click(screen.getByTestId("danger-btn-meta-step-down"));
  await flush();
  await confirmWith("nats-a", "wrong");
  expect(MetaStepDown).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("danger-op-cancel"));
  await flush();

  fireEvent.change(screen.getByTestId("danger-stream-stepdown-input"), { target: { value: "ORDERS" } });
  fireEvent.click(screen.getByTestId("danger-btn-stream-step-down"));
  await flush();
  await confirmWith("ORDERS", "wrong");
  expect(StreamStepDown).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("danger-op-cancel"));
  await flush();

  fireEvent.change(screen.getByTestId("danger-balance-input"), { target: { value: "ORDERS" } });
  fireEvent.click(screen.getByTestId("danger-btn-stream-balance"));
  await flush();
  await confirmWith("ORDERS", "wrong");
  expect(StreamBalance).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("danger-op-cancel"));
  await flush();

  fireEvent.change(screen.getByTestId("danger-peer-input"), { target: { value: "nats-b" } });
  fireEvent.click(screen.getByTestId("danger-btn-peer-remove"));
  await flush();
  await confirmWith("nats-b", "wrong");
  expect(MetaPeerRemove).not.toHaveBeenCalled();
});
