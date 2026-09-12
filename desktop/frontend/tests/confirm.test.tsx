import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Like connections-page.test.tsx, this suite uses the real i18n module
// (en resources, synchronous init) and mocks only the Wails bindings.
const getSettings = vi.fn();
vi.mock("@/lib/bindings", () => ({
  GetSettings: () => getSettings(),
  SaveSettings: () => Promise.resolve(),
}));

import { ConfirmProvider, useConfirm } from "@/lib/confirm";

function Probe({ onResult }: { onResult: (v: boolean) => void }) {
  const { confirmL1 } = useConfirm();
  return <button onClick={() => confirmL1({ titleKey: "streams.purgeTitle" }).then(onResult)}>go</button>;
}

function NameProbe({ onResult }: { onResult: (v: boolean) => void }) {
  const { confirmNameMatch } = useConfirm();
  return <button onClick={() => confirmNameMatch("ORDERS").then(onResult)}>go</button>;
}

// Give unhandled promises a macrotask to settle before asserting "not resolved".
const flush = () => new Promise((r) => setTimeout(r, 10));

describe("confirm primitives", () => {
  beforeEach(() => getSettings.mockReset());

  it("standard level shows the dialog and honors confirm", async () => {
    getSettings.mockResolvedValue({ behavior: { confirm_level: "standard" } });
    const onResult = vi.fn();
    render(<ConfirmProvider><Probe onResult={onResult} /></ConfirmProvider>);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true)); // 必须断言 resolve 值，不只是对话框关闭
  });

  it("relaxed level skips level-1 dialogs entirely", async () => {
    getSettings.mockResolvedValue({ behavior: { confirm_level: "relaxed" } });
    const onResult = vi.fn();
    render(<ConfirmProvider><Probe onResult={onResult} /></ConfirmProvider>);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("read failure falls back to standard and still shows the dialog", async () => {
    // Once-variant: with this vitest version a persistent rejecting
    // implementation set after mockReset() is misreported as unhandled.
    getSettings.mockRejectedValueOnce(new Error("boom"));
    const onResult = vi.fn();
    render(<ConfirmProvider><Probe onResult={onResult} /></ConfirmProvider>);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  // AC-010: the name-match dialog shows at any confirm level and only a
  // character-exact input lets the destructive action through.
  it("name match: wrong name keeps the dialog open and the promise pending", async () => {
    getSettings.mockResolvedValue({ behavior: { confirm_level: "relaxed" } }); // even relaxed must show it
    const onResult = vi.fn();
    render(<ConfirmProvider><NameProbe onResult={onResult} /></ConfirmProvider>);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("ORDERS"); // {{name}} interpolated into the title
    fireEvent.change(screen.getByLabelText("name-match-input"), { target: { value: "orders " } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await flush();
    expect(onResult).not.toHaveBeenCalled(); // promise still unresolved
    expect(screen.queryByRole("dialog")).not.toBeNull(); // dialog stays open
  });

  it("name match: typing the exact name resolves true and closes", async () => {
    getSettings.mockResolvedValue({ behavior: { confirm_level: "standard" } });
    const onResult = vi.fn();
    render(<ConfirmProvider><NameProbe onResult={onResult} /></ConfirmProvider>);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("name-match-input"), { target: { value: "ORDERS" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
