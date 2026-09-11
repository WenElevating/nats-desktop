import { render, act } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";
import { Browser, Events } from "@wailsio/runtime";
import { toast } from "sonner";
import { CheckUpdate, GetSettings } from "../src/lib/bindings";
import { useUpdateNotice } from "../src/app/update";

vi.mock("@wailsio/runtime", () => ({
  Events: { On: vi.fn(() => () => {}) },
  Browser: { OpenURL: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { message: vi.fn() } }));
vi.mock("../src/lib/bindings", () => ({
  GetSettings: vi.fn(),
  CheckUpdate: vi.fn(),
}));

const payload = {
  current: "0.1.0",
  latest: "v0.2.0",
  url: "https://github.com/WenElevating/nats-desktop/releases/v0.2.0",
  has_update: true,
};

const getSettings = GetSettings as unknown as ReturnType<typeof vi.fn>;
const checkUpdate = CheckUpdate as unknown as ReturnType<typeof vi.fn>;

const Probe = () => {
  useUpdateNotice();
  return null;
};

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: update checks opted in, backend reports no update — tests opt
  // into the paths they exercise by overriding these.
  getSettings.mockResolvedValue({ privacy: { update_check: true } });
  checkUpdate.mockResolvedValue({ ...payload, has_update: false });
});

/** Flushes the mount-time fallback's pending microtasks. */
const flush = () => act(async () => {});

it("shows the update toast once even if the event fires twice", async () => {
  const on = Events.On as unknown as ReturnType<typeof vi.fn>;
  let handler: (e: { data: unknown }) => void = () => {};
  on.mockImplementation((_name: string, h: (e: { data: unknown }) => void) => {
    handler = h;
    return () => {};
  });

  render(<Probe />);
  await flush();

  act(() => {
    handler({ data: payload });
  });
  act(() => {
    handler({ data: payload });
  });

  expect(toast.message).toHaveBeenCalledTimes(1);
  const [title, opts] = vi.mocked(toast.message).mock.calls[0] as [
    string,
    { action: { label: string; onClick: () => void }; description: string },
  ];
  expect(title).toContain("v0.2.0");
  expect(opts.description).toBe(payload.url);
  expect(opts.action.label).toBeTruthy();

  // The Download action opens the release page via the runtime browser API.
  act(() => {
    opts.action.onClick();
  });
  expect(Browser.OpenURL).toHaveBeenCalledWith(payload.url);
});

it("ignores malformed payloads", async () => {
  const on = Events.On as unknown as ReturnType<typeof vi.fn>;
  let handler: (e: { data: unknown }) => void = () => {};
  on.mockImplementation((_name: string, h: (e: { data: unknown }) => void) => {
    handler = h;
    return () => {};
  });

  render(<Probe />);
  await flush();

  act(() => {
    handler({ data: { latest: 42 } });
  });

  expect(toast.message).not.toHaveBeenCalled();
});

it("mount fallback toasts once when CheckUpdate reports an update", async () => {
  checkUpdate.mockResolvedValue(payload);

  render(<Probe />);
  await flush();

  expect(toast.message).toHaveBeenCalledTimes(1);
  const [title] = vi.mocked(toast.message).mock.calls[0] as [string];
  expect(title).toContain("v0.2.0");
});

it("mount fallback never double-toasts when the event also fires", async () => {
  checkUpdate.mockResolvedValue(payload);
  const on = Events.On as unknown as ReturnType<typeof vi.fn>;
  let handler: (e: { data: unknown }) => void = () => {};
  on.mockImplementation((_name: string, h: (e: { data: unknown }) => void) => {
    handler = h;
    return () => {};
  });

  render(<Probe />);
  await flush(); // fallback path showed the toast
  act(() => {
    handler({ data: payload });
  });

  expect(toast.message).toHaveBeenCalledTimes(1);
});

it("mount fallback respects the update-check opt-out", async () => {
  getSettings.mockResolvedValue({ privacy: { update_check: false } });

  render(<Probe />);
  await flush();

  expect(checkUpdate).not.toHaveBeenCalled();
  expect(toast.message).not.toHaveBeenCalled();
});

it("mount fallback stays silent when the check fails", async () => {
  getSettings.mockRejectedValue(new Error("boom"));

  render(<Probe />);
  await flush();

  expect(toast.message).not.toHaveBeenCalled();
});
