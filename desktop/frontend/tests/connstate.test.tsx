import { render, act, waitFor } from "@testing-library/react";
import { vi, it, expect } from "vitest";
import { Events } from "@wailsio/runtime";
import { ConnStateProvider, useConnState } from "../src/app/connstate";
import { ConnSnapshot } from "../src/lib/bindings";

vi.mock("@wailsio/runtime", () => ({
  Events: { On: vi.fn(() => () => {}) },
}));
vi.mock("../src/lib/bindings", () => ({
  ConnSnapshot: vi.fn(),
}));

it("starts disconnected and applies conn:state event payloads", async () => {
  const on = Events.On as unknown as ReturnType<typeof vi.fn>;
  let handler: (e: { data: unknown }) => void = () => {};
  on.mockImplementation((_name: string, h: (e: { data: unknown }) => void) => {
    handler = h;
    return () => {};
  });
  vi.mocked(ConnSnapshot).mockResolvedValue({
    context: "",
    state: "disconnected",
    since: "2026-09-11T00:00:00Z",
    rtt_ms: 0,
  });

  const seen: ReturnType<typeof useConnState>[] = [];
  const Probe = () => {
    seen.push(useConnState());
    return null;
  };
  render(
    <ConnStateProvider>
      <Probe />
    </ConnStateProvider>,
  );

  // Initial snapshot: disconnected until an event or the hydration binding
  // says otherwise.
  expect(seen[0]).toEqual({ state: "disconnected", context: "", rttMs: 0, reason: "" });
  // Wire format is the Go StateEvent (snake_case rtt_ms); the hook maps it.
  act(() => {
    handler({ data: { context: "dev", state: "connected", since: "2026-09-11T00:00:00Z", rtt_ms: 17, reason: "" } });
  });
  expect(seen[seen.length - 1]).toEqual({ state: "connected", context: "dev", rttMs: 17, reason: "" });

  act(() => {
    handler({ data: { context: "dev", state: "failed", since: "2026-09-11T00:00:01Z", rtt_ms: 0, reason: "auth violation" } });
  });
  expect(seen[seen.length - 1]).toEqual({ state: "failed", context: "dev", rttMs: 0, reason: "auth violation" });
});

it("hydrates the initial state from ConnSnapshot (Task 10 seam)", async () => {
  const on = Events.On as unknown as ReturnType<typeof vi.fn>;
  on.mockImplementation(() => () => {});
  vi.mocked(ConnSnapshot).mockResolvedValue({
    context: "dev",
    state: "connected",
    since: "2026-09-11T00:00:00Z",
    rtt_ms: 9,
  });

  const seen: ReturnType<typeof useConnState>[] = [];
  const Probe = () => {
    seen.push(useConnState());
    return null;
  };
  render(
    <ConnStateProvider>
      <Probe />
    </ConnStateProvider>,
  );

  await waitFor(() =>
    expect(seen[seen.length - 1]).toEqual({ state: "connected", context: "dev", rttMs: 9, reason: "" }),
  );
});
