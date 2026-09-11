import { render, act } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";
import { Browser, Events } from "@wailsio/runtime";
import { toast } from "sonner";
import { useUpdateNotice } from "../src/app/update";

vi.mock("@wailsio/runtime", () => ({
  Events: { On: vi.fn(() => () => {}) },
  Browser: { OpenURL: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { message: vi.fn() } }));

const payload = {
  current: "0.1.0",
  latest: "v0.2.0",
  url: "https://github.com/WenElevating/nats-desktop/releases/v0.2.0",
  has_update: true,
};

const Probe = () => {
  useUpdateNotice();
  return null;
};

beforeEach(() => {
  vi.clearAllMocks();
});

it("shows the update toast once even if the event fires twice", () => {
  const on = Events.On as unknown as ReturnType<typeof vi.fn>;
  let handler: (e: { data: unknown }) => void = () => {};
  on.mockImplementation((_name: string, h: (e: { data: unknown }) => void) => {
    handler = h;
    return () => {};
  });

  render(<Probe />);

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

it("ignores malformed payloads", () => {
  const on = Events.On as unknown as ReturnType<typeof vi.fn>;
  let handler: (e: { data: unknown }) => void = () => {};
  on.mockImplementation((_name: string, h: (e: { data: unknown }) => void) => {
    handler = h;
    return () => {};
  });

  render(<Probe />);

  act(() => {
    handler({ data: { latest: 42 } });
  });

  expect(toast.message).not.toHaveBeenCalled();
});
