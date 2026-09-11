import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";
import { Events } from "@wailsio/runtime";
import { ConnStateProvider } from "../src/app/connstate";
import { Shell } from "../src/app/shell";
import App from "../src/App";
import {
  ConnSnapshot,
  EnvWarnings,
  GetContextForm,
  GetSettings,
  ListContexts,
} from "../src/lib/bindings";

// The brief's assertions are against raw i18n keys (e.g. "conn.bannerReconnecting"),
// so t: k => k like the shell suite. Interpolation values (the failed
// banner's reason) are appended so reason-bearing messages surface their
// payload without the real i18n resources.
const { t } = vi.hoisted(() => ({
  t: (k: string, params?: Record<string, unknown>): string =>
    params && Object.keys(params).length > 0
      ? `${k} ${Object.values(params).map(String).join(" ")}`
      : k,
}));

vi.mock("../src/app/i18n", () => ({
  setLanguage: vi.fn(),
  useTranslation: () => ({ t }),
}));

vi.mock("@wailsio/runtime", () => ({
  Events: { On: vi.fn(() => () => {}) },
  System: { IsDarkMode: vi.fn(async () => false) },
}));

// The whole bindings surface is stubbed: ConnSnapshot for the provider's
// hydration, and the settings/connections services the App graph imports.
const { settingsFixture } = vi.hoisted(() => ({
  settingsFixture: {
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
  },
}));

vi.mock("../src/lib/bindings", () => ({
  Default: vi.fn(() => settingsFixture),
  GetSettings: vi.fn(),
  SaveSettings: vi.fn(),
  OpenLogsDir: vi.fn(),
  ListContexts: vi.fn(),
  SaveContext: vi.fn(),
  DeleteContext: vi.fn(),
  CopyContext: vi.fn(),
  CheckConnection: vi.fn(),
  Connect: vi.fn(),
  Disconnect: vi.fn(),
  ConnSnapshot: vi.fn(),
  EnvWarnings: vi.fn(),
  GetContextForm: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(ConnSnapshot).mockResolvedValue(undefined as never);
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture as never);
  vi.mocked(ListContexts).mockResolvedValue([]);
  vi.mocked(EnvWarnings).mockResolvedValue([]);
  vi.mocked(GetContextForm).mockResolvedValue(null as never);
});

/**
 * The brief's helper: intercepts the Events.On registration for `name` on the
 * @wailsio/runtime mock so a test can fire that event at a mounted provider.
 */
function captureEvents(name: string) {
  const on = Events.On as unknown as ReturnType<typeof vi.fn>;
  let handler: (e: { data: unknown }) => void = () => {};
  on.mockImplementation((n: string, h: (e: { data: unknown }) => void) => {
    if (n === name) handler = h;
    return () => {};
  });
  return {
    fire: (data: unknown) => act(() => handler({ data })),
  };
}

/** Shell mounted inside the real ConnStateProvider (the App wiring): the
 * brief's scenarios drive conn:state events and watch the shell react. */
const renderShell = (nav: (p: string) => void = () => {}) =>
  render(
    <ConnStateProvider>
      <Shell page="settings" onNavigate={nav}>
        <div />
      </Shell>
    </ConnStateProvider>,
  );

// ---- The brief's three UI state scenarios (§18.3) ----

it("shows reconnecting banner on conn:state event", () => {
  const off = captureEvents("conn:state");
  renderShell();
  off.fire({ context: "demo", state: "reconnecting", rtt_ms: 0 });
  expect(screen.getByText("conn.bannerReconnecting")).toBeTruthy();
  expect(screen.getByText("conn.reconnecting")).toBeTruthy();
});

it("failed banner shows reason and edit action", () => {
  const off = captureEvents("conn:state");
  const nav = vi.fn();
  renderShell(nav);
  off.fire({ context: "demo", state: "failed", rtt_ms: 0, reason: "authorization violation" });
  expect(screen.getByText(/conn\.bannerFailed/)).toBeTruthy();
  expect(screen.getByText(/authorization violation/)).toBeTruthy();
  fireEvent.click(screen.getByTestId("conn-fix"));
  expect(nav).toHaveBeenCalledWith("settings");
});

it("connected shows rtt in status footer", () => {
  const off = captureEvents("conn:state");
  renderShell();
  off.fire({ context: "demo", state: "connected", rtt_ms: 12 });
  expect(screen.getByTestId("conn-summary").textContent).toContain("12ms");
});

// ---- §18.3 gap fill: connecting shows the spinner in the status footer ----

it("shows a spinner in the status footer while connecting", () => {
  const off = captureEvents("conn:state");
  renderShell();
  off.fire({ context: "demo", state: "connecting", rtt_ms: 0 });
  const footer = screen.getByTestId("conn-summary");
  expect(footer.querySelector("svg.animate-spin")).toBeTruthy();
  expect(screen.getByText("conn.connecting")).toBeTruthy();
});

// ---- First-run guide (AC-001: no contexts → guidance view) ----

it("shows the guide card when no contexts exist; the sidebar stays navigable", async () => {
  render(<App />);
  const guide = await screen.findByTestId("first-run-guide");
  expect(within(guide).getByText("NATS Desktop")).toBeTruthy();
  expect(within(guide).getByText("guide.title")).toBeTruthy();
  expect(within(guide).getByText("guide.body")).toBeTruthy();

  // AC-001.2: the sidebar keeps working; other pages show the same guidance.
  fireEvent.click(screen.getByTestId("nav-streams"));
  expect(screen.getByTestId("nav-streams").getAttribute("aria-current")).toBe("page");
  expect(screen.getByTestId("first-run-guide")).toBeTruthy();
});

it("guide CTA navigates to Settings > Connections and opens the create dialog", async () => {
  render(<App />);
  const guide = await screen.findByTestId("first-run-guide");
  fireEvent.click(within(guide).getByTestId("guide-create"));

  expect(screen.getByTestId("settings-tab-connections").getAttribute("aria-selected")).toBe("true");
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("connections.new")).toBeTruthy();
});

it("create dialog does not reopen when revisiting the connections tab (signal consumed)", async () => {
  render(<App />);
  const guide = await screen.findByTestId("first-run-guide");
  fireEvent.click(within(guide).getByTestId("guide-create"));
  await screen.findByRole("dialog");

  fireEvent.click(screen.getByTestId("settings-tab-general"));
  fireEvent.click(screen.getByTestId("settings-tab-connections"));
  await waitFor(() => expect(screen.getByTestId("connections-page")).toBeTruthy());
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("renders the normal page flow (no guide) once a context exists", async () => {
  vi.mocked(ListContexts).mockResolvedValue([
    { name: "dev", description: "local", url: "nats://localhost:4222", auth_type: "none", color_scheme: "" },
  ]);
  const off = captureEvents("conn:state");
  render(<App />);
  // With a context stored (and connected) the app renders the page itself,
  // never the first-run guide.
  off.fire({ context: "dev", state: "connected", rtt_ms: 5 });
  await waitFor(() => expect(screen.getByTestId("page-dashboard")).toBeTruthy());
  expect(screen.queryByTestId("first-run-guide")).toBeNull();
});
