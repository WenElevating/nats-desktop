import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { ConnectionsTop } from "../src/features/monitoring/ConnectionsTop";
import { ConfirmProvider } from "../src/lib/confirm";
import { GetSettings, KickConnection, ListServerConnections } from "../src/lib/bindings";
import type { ConnRow } from "../src/lib/bindings";

// ConnectionsTop suite: real i18n (en resources); mocked connstate (hoisted
// mutable), the Wails bindings, and sonner — the consumers-page pattern.
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
  GetSettings: vi.fn(),
  ListServerConnections: vi.fn(),
  KickConnection: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";

// ---- fixtures (ConnRow/ConnPageResult wire shape, Go internal/monitor/types.go) ----

const conn = (over: Partial<ConnRow> = {}): ConnRow =>
  ({
    cid: 7,
    kind: "nats",
    ip: "10.0.0.9",
    port: 52134,
    account: "APP",
    user: "u7",
    name: "uploader",
    lang: "go",
    version: "1.2.3",
    start_ms: 1_770_000_000_000,
    uptime: "1h2m3s",
    idle: "4s",
    rtt: "1.2ms",
    in_msgs: 10,
    out_msgs: 20,
    in_bytes: 2048,
    out_bytes: 4096,
    num_subs: 5,
    pending: 0,
    ...over,
  }) as unknown as ConnRow;

const baseRows = (): ConnRow[] => [
  conn({ cid: 7, num_subs: 5, pending: 0 }),
  conn({ cid: 8, num_subs: 9, pending: 3, user: "u8" }),
  conn({ cid: 9, num_subs: 1, pending: 6, user: "u9" }),
];

const page = (rows: ConnRow[], over: Record<string, unknown> = {}) => ({
  error_code: "",
  error: "",
  rows,
  offset: 0,
  limit: 20,
  total: 42,
  ...over,
});

const settingsFixture = (confirmLevel = "standard") => ({
  appearance: { theme: "system", language: "en" },
  behavior: {
    poll_interval_seconds: 5,
    request_timeout_seconds: 5,
    confirm_level: confirmLevel,
    session_push_batching: false,
    session_buffer_size: 10000,
    log_level: "info",
  },
  privacy: { crash_reports: false, update_check: true },
  last_active_context: "",
});

const ok = { error_code: "", error: "" };

const flush = async (ms = 10) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const rowIds = () =>
  [...document.querySelectorAll('[data-testid^="conn-row-"]')].map((el) =>
    el.getAttribute("data-testid"),
  );

const setup = async () => {
  render(
    <ConfirmProvider>
      <ConnectionsTop server="nats1" />
    </ConfirmProvider>,
  );
  await flush();
};

beforeEach(() => {
  connState.state = "connected";
  vi.clearAllMocks();
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListServerConnections).mockResolvedValue(page(baseRows()) as never);
  vi.mocked(KickConnection).mockResolvedValue(ok as never);
});

// ---- data fetch: paging/sort params pass through ----

it("queries the selected server with default cid/0/20 and renders all columns with the total", async () => {
  await setup();

  expect(ListServerConnections).toHaveBeenCalledWith("nats1", "cid", 0, 20);
  expect(screen.getByTestId("conn-table")).toBeTruthy();
  expect(screen.getByTestId("conn-total").textContent).toBe("42");

  const r7 = screen.getByTestId("conn-row-7");
  expect(r7.textContent).toContain("7"); // cid
  expect(r7.textContent).toContain("10.0.0.9"); // ip
  expect(r7.textContent).toContain("52134"); // port
  expect(r7.textContent).toContain("u7"); // user
  expect(r7.textContent).toContain("APP"); // account
  expect(r7.textContent).toContain("1h2m3s"); // uptime
  expect(r7.textContent).toContain("4s"); // idle
  expect(r7.textContent).toContain("1.2ms"); // rtt
  expect(r7.textContent).toContain("2.0 KiB"); // in bytes, humanized
  expect(r7.textContent).toContain("4.0 KiB"); // out bytes
  // Numeric cells are monospaced tabular (§18.2).
  expect(r7.textContent).toContain("5"); // subs
  expect(r7.textContent).toContain("0"); // pending

  // Default sort column marked ascending, arrow shown.
  expect(screen.getByTestId("conn-col-cid").getAttribute("aria-sort")).toBe("ascending");
});

it("header-click sorts by whitelisted keys; repeating the click flips direction locally without refetching", async () => {
  await setup();

  // First click: sort key passes through to the binding, page resets.
  fireEvent.click(screen.getByTestId("conn-sort-subs"));
  await flush();
  expect(ListServerConnections).toHaveBeenLastCalledWith("nats1", "subs", 0, 20);
  expect(screen.getByTestId("conn-col-subs").getAttribute("aria-sort")).toBe("ascending");

  // Server returns rows in cid order; ascending shows them as-is.
  expect(rowIds()).toEqual(["conn-row-7", "conn-row-8", "conn-row-9"]);

  // Second click on the same column: local flip to descending, no new call —
  // the Go whitelist (Global 11) accepts bare keys only, so the direction is
  // applied within the fetched page.
  const calls = vi.mocked(ListServerConnections).mock.calls.length;
  fireEvent.click(screen.getByTestId("conn-sort-subs"));
  await flush();
  expect(vi.mocked(ListServerConnections).mock.calls.length).toBe(calls);
  expect(screen.getByTestId("conn-col-subs").getAttribute("aria-sort")).toBe("descending");
  expect(rowIds()).toEqual(["conn-row-9", "conn-row-8", "conn-row-7"]);

  // A different column goes through the binding again (offset reset to 0).
  fireEvent.click(screen.getByTestId("conn-sort-pending"));
  await flush();
  expect(ListServerConnections).toHaveBeenLastCalledWith("nats1", "pending", 0, 20);
});

it("pages with offset, resets on limit change, and disables the buttons at the edges", async () => {
  await setup();

  expect(screen.getByTestId("conn-next")).toBeTruthy();
  expect((screen.getByTestId("conn-prev") as HTMLButtonElement).disabled).toBe(true);

  // total=42, limit=20 → page 2 offset 20; a third page still exists.
  fireEvent.click(screen.getByTestId("conn-next"));
  await flush();
  expect(ListServerConnections).toHaveBeenLastCalledWith("nats1", "cid", 20, 20);
  expect((screen.getByTestId("conn-prev") as HTMLButtonElement).disabled).toBe(false);

  // Page 3 (offset 40) is the last: next is now disabled at the edge.
  fireEvent.click(screen.getByTestId("conn-next"));
  await flush();
  expect(ListServerConnections).toHaveBeenLastCalledWith("nats1", "cid", 40, 20);
  expect((screen.getByTestId("conn-next") as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(screen.getByTestId("conn-prev"));
  await flush();
  expect(ListServerConnections).toHaveBeenLastCalledWith("nats1", "cid", 20, 20);

  // Limit select (20/50/100): changing it resets to offset 0.
  fireEvent.change(screen.getByTestId("conn-limit"), { target: { value: "50" } });
  await flush();
  expect(ListServerConnections).toHaveBeenLastCalledWith("nats1", "cid", 0, 50);
});

it("kicks a connection only after the level-1 confirm; success toasts the cid and refreshes", async () => {
  await setup();

  fireEvent.click(screen.getByTestId("conn-kick-7"));
  await flush();

  // L1 gate: the dialog is up, the binding is NOT called yet.
  expect(screen.getByRole("alertdialog").textContent).toContain("7");
  expect(KickConnection).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
  await flush();
  expect(KickConnection).not.toHaveBeenCalled();

  // Confirm path: KickConnection(server, cid) + success toast + page refresh.
  fireEvent.click(screen.getByTestId("conn-kick-7"));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
  await flush();

  expect(KickConnection).toHaveBeenCalledWith("nats1", 7);
  expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("7"));
  // 1 initial + 1 refresh after the kick.
  expect(ListServerConnections).toHaveBeenCalledTimes(2);
});

it("toasts the failure 原文 when the kick is rejected (gone cid)", async () => {
  vi.mocked(KickConnection).mockResolvedValue({
    error_code: "server",
    error: "connection no longer exists",
  } as never);
  await setup();

  fireEvent.click(screen.getByTestId("conn-kick-8"));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
  await flush();

  expect(KickConnection).toHaveBeenCalledWith("nats1", 8);
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("connection no longer exists"),
  );
  expect(toast.success).not.toHaveBeenCalled();
});

it("replaces the table with the panel error card (原文) when the report is rejected", async () => {
  vi.mocked(ListServerConnections).mockResolvedValue({
    error_code: "server",
    error: "connection list requires system privileges",
    rows: [],
    offset: 0,
    limit: 20,
    total: 0,
  } as never);
  await setup();

  const err = screen.getByTestId("conn-error");
  expect(err.textContent).toContain("connection list requires system privileges");
  expect(screen.queryByTestId("conn-table")).toBeNull();
});

it("shows the empty hint when the server has no connections", async () => {
  vi.mocked(ListServerConnections).mockResolvedValue(page([], { total: 0 }) as never);
  await setup();

  expect(screen.getByTestId("conn-empty")).toBeTruthy();
  expect(rowIds()).toHaveLength(0);
});
