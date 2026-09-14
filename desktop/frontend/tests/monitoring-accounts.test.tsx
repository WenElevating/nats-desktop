import { render, screen, fireEvent, act } from "@testing-library/react";
import { it, expect, vi, beforeEach } from "vitest";
import { AccountsPanel } from "../src/features/monitoring/AccountsPanel";
import { GetSettings, ListAccounts } from "../src/lib/bindings";
import type { AccountRow } from "../src/lib/bindings";
import { toast } from "sonner";

// AccountsPanel suite: real i18n (en resources); mocked connstate (hoisted
// mutable) and the Wails bindings — the monitoring test pattern.
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
  ListAccounts: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// ---- fixtures (AccountRow/AccountListResult wire shape, Go internal/monitor/types.go) ----

const acct = (over: Partial<AccountRow> = {}): AccountRow =>
  ({
    name: "APP",
    id: "acct_app",
    streams: 2,
    consumers: 5,
    memory_bytes: 1024,
    store_bytes: 8192,
    reserved_memory_bytes: 2048,
    reserved_store_bytes: 16384,
    stream_names: ["ORDERS", "EVENTS"],
    ...over,
  }) as unknown as AccountRow;

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

const ok = { error_code: "", error: "" };

const flush = async (ms = 10) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

beforeEach(() => {
  connState.state = "connected";
  vi.mocked(GetSettings).mockReset();
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture() as never);
  vi.mocked(ListAccounts).mockReset();
  vi.mocked(ListAccounts).mockResolvedValue({
    ...ok,
    accounts: [acct(), acct({ name: "SYS", id: "acct_sys", streams: 0, stream_names: [] })],
  } as never);
});

it("renders account cards with stats, reserved bytes, and stream-name chips", async () => {
  render(<AccountsPanel />);
  await flush();

  expect(ListAccounts).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("accounts-panel")).toBeTruthy();

  const card = screen.getByTestId("account-card-APP");
  expect(card.textContent).toContain("APP");
  expect(card.textContent).toContain("acct_app");
  expect(card.textContent).toContain("2"); // streams
  expect(card.textContent).toContain("5"); // consumers
  expect(card.textContent).toContain("1.0 KiB"); // memory
  expect(card.textContent).toContain("8.0 KiB"); // store
  expect(card.textContent).toContain("2.0 KiB"); // reserved memory
  expect(card.textContent).toContain("16 KiB"); // reserved store
  // Stream-name chips (the Go side caps the array at 50 names).
  expect(card.textContent).toContain("ORDERS");
  expect(card.textContent).toContain("EVENTS");

  expect(screen.getByTestId("account-card-SYS")).toBeTruthy();
});

it("manual refresh re-queries the cluster-wide report", async () => {
  render(<AccountsPanel />);
  await flush();
  expect(ListAccounts).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByTestId("accounts-refresh"));
  await flush();
  expect(ListAccounts).toHaveBeenCalledTimes(2);
});

it("keeps the loaded cards + toasts when the transport throws (no blank-out)", async () => {
  render(<AccountsPanel />);
  await flush();
  expect(screen.getByTestId("account-card-APP")).toBeTruthy();

  // Transport-level rejection on refresh: M6 Task 8 ㉒ — the existing cards
  // stay and the failure surfaces as a toast (never a silent empty list).
  vi.mocked(ListAccounts).mockRejectedValueOnce(new Error("pipe closed") as never);
  fireEvent.click(screen.getByTestId("accounts-refresh"));
  await flush();

  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("pipe closed"));
  expect(screen.getByTestId("account-card-APP")).toBeTruthy();
  expect(screen.getByTestId("account-card-SYS")).toBeTruthy();
});

it("shows the degraded reason card with the 原文 when the report fails", async () => {
  // Partial-permission degradation: Ok envelope + error 原文 + empty list
  // (Go ListAccounts 降级面, §8.3.1).
  vi.mocked(ListAccounts).mockResolvedValue({
    error_code: "",
    error: "no resolver for account queries: system account required",
    accounts: [],
  } as never);
  render(<AccountsPanel />);
  await flush();

  const card = screen.getByTestId("accounts-degraded");
  expect(card.textContent).toContain("no resolver for account queries: system account required");
  expect(screen.queryByTestId("account-card-APP")).toBeNull();

  // not_connected follows the same reason-card face (never an empty list).
  vi.mocked(ListAccounts).mockResolvedValue({
    error_code: "not_connected",
    error: "not connected",
    accounts: [],
  } as never);
  fireEvent.click(screen.getByTestId("accounts-refresh"));
  await flush();
  expect(screen.getByTestId("accounts-degraded").textContent).toContain("not connected");
});

it("shows the empty hint when no accounts are reported", async () => {
  vi.mocked(ListAccounts).mockResolvedValue({ ...ok, accounts: [] } as never);
  render(<AccountsPanel />);
  await flush();

  expect(screen.getByTestId("accounts-empty")).toBeTruthy();
  expect(screen.queryByTestId("accounts-degraded")).toBeNull();
});
