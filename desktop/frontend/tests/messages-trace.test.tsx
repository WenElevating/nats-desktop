import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import { toast } from "sonner";
import { MessagesPage } from "../src/features/messages/MessagesPage";
import { TracePanel } from "../src/features/messages/TracePanel";
import { Trace, GetSettings } from "../src/lib/bindings";
import type { TraceHop } from "../src/lib/bindings";
import { toBase64 } from "../src/lib/base64";

// Scenario assertions match user-visible (interpolated) English text, so this
// file uses the real i18n module (en resources, synchronous init) like the
// publish/sessions suites. Mocked: the bindings surface, sonner, and the
// connection state (the hoisted `connState` object is mutated per test to pin
// disconnected).
const connState = vi.hoisted(() => ({
  state: "connected",
  context: "dev",
  rttMs: 5,
  reason: "",
}));

vi.mock("../src/app/connstate", () => ({
  useConnState: () => connState,
}));

vi.mock("@wailsio/runtime", () => ({
  Events: { On: vi.fn(() => () => {}) },
}));

vi.mock("../src/lib/bindings", () => ({
  // Trace is the surface under test; the rest of the messaging surface exists
  // because MessagesPage renders the publish + sessions panels too.
  PushMode: { PushRealtime: "realtime", PushBatch: "batch" },
  CreateSession: vi.fn(),
  PauseSession: vi.fn(),
  ResumeSession: vi.fn(),
  ClearSession: vi.fn(),
  CloseSession: vi.fn(),
  ListSessions: vi.fn(),
  Publish: vi.fn(),
  Request: vi.fn(),
  Trace: vi.fn(),
  GetSettings: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/** Settings fixture mirroring bindings Default(); only the request timeout
 * varies (it seeds the panel's timeout field on mount, like PubPanel). */
const settingsFixture = (requestTimeoutSeconds: number) => ({
  appearance: { theme: "system", language: "en" },
  behavior: {
    poll_interval_seconds: 5,
    request_timeout_seconds: requestTimeoutSeconds,
    confirm_level: "standard",
    session_push_batching: false,
    session_buffer_size: 10000,
    log_level: "info",
  },
  privacy: { crash_reports: false, update_check: true },
  last_active_context: "",
});

/** Two-level tree shaped like the Go traceTree output: an ingress root with
 * one egress child, which itself nests the next server's ingress hop. */
const twoLevelTree: TraceHop = {
  kind: "ingress",
  detail: 'Client "Nats Cli Trace" cid:5 server:"n1" version:"2.11.1"',
  children: [
    {
      kind: "egress",
      detail: 'Router "n2" cid:9 account:"A" subject:"foo"',
      children: [{ kind: "ingress", detail: 'Client "sub" cid:12 server:"n2" version:"2.11.1"' }],
    },
  ],
};

beforeEach(() => {
  connState.state = "connected";
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture(5) as never);
  vi.mocked(Trace).mockResolvedValue(twoLevelTree);
});

const setSubject = (v: string) =>
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: v } });
const setPayload = (v: string) =>
  fireEvent.change(screen.getByLabelText("Payload"), { target: { value: v } });

// ---- The brief's three scenarios + the disconnected gate ----

it("sends the wire form with the deliver toggle mapping and the seeded timeout", async () => {
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture(30) as never);
  render(<TracePanel />);

  // Timeout field is seeded from request_timeout_seconds (30s -> 30000 ms).
  const timeout = screen.getByLabelText("Timeout (ms)") as HTMLInputElement;
  await waitFor(() => expect(timeout.value).toBe("30000"));

  // "Trace only" defaults to ON (= not delivered, wire deliver: false).
  const traceOnly = screen.getByTestId("trace-only-switch") as HTMLButtonElement;
  expect(traceOnly.getAttribute("aria-checked") ?? traceOnly.getAttribute("data-state")).toBeTruthy();

  setSubject("telemetry");
  setPayload("probe");
  fireEvent.click(screen.getByRole("button", { name: "Add header" }));
  fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "X-Test" } });
  fireEvent.change(screen.getByLabelText("Header value"), { target: { value: "v1" } });
  fireEvent.click(screen.getByTestId("trace-run"));

  await waitFor(() => expect(Trace).toHaveBeenCalledTimes(1));
  const form = vi.mocked(Trace).mock.calls[0][0];
  expect(form.subject).toBe("telemetry");
  expect(form.payload).toBe(toBase64("probe"));
  expect(form.headers).toEqual({ "X-Test": ["v1"] });
  expect(form.deliver).toBe(false);
  expect(form.timeout_ms).toBe(30000);
});

it("maps the trace-only toggle off to deliver: true", async () => {
  render(<TracePanel />);
  fireEvent.click(screen.getByTestId("trace-only-switch"));
  setSubject("telemetry");
  fireEvent.click(screen.getByTestId("trace-run"));

  await waitFor(() => expect(Trace).toHaveBeenCalledTimes(1));
  expect(vi.mocked(Trace).mock.calls[0][0].deliver).toBe(true);
});

it("renders a two-level trace tree as nested hops", async () => {
  render(<TracePanel />);
  setSubject("telemetry");
  fireEvent.click(screen.getByTestId("trace-run"));

  const tree = await screen.findByTestId("trace-tree");
  const nodes = within(tree).getAllByTestId("trace-hop");
  expect(nodes).toHaveLength(3);

  // Root hop: uppercase mono kind badge + detail text. data-kind disambi-
  // guates a node's own kind from nested same-kind descendants.
  const root = nodes[0];
  expect(root.getAttribute("data-kind")).toBe("ingress");
  const rootBadge = within(root).getAllByText("INGRESS")[0];
  expect(rootBadge.textContent).toBe("INGRESS");
  expect(root.textContent).toContain('server:"n1"');

  // Level 2 (egress) nests inside the root; level 3 (remote ingress) inside it.
  const egress = within(root)
    .getAllByTestId("trace-hop")
    .find((n) => n.getAttribute("data-kind") === "egress");
  expect(egress).toBeTruthy();
  expect(within(egress!).getByText("EGRESS")).toBeTruthy();
  expect(egress!.textContent).toContain('subject:"foo"');
  expect(egress!.textContent).toContain('server:"n2"');
  expect(egress!.textContent).toContain("INGRESS");
});

it("toasts the server error text when the trace fails", async () => {
  vi.mocked(Trace).mockRejectedValue(
    new Error("tracing requires NATS Server 2.11 or newer"),
  );
  render(<TracePanel />);
  setSubject("telemetry");
  fireEvent.click(screen.getByTestId("trace-run"));

  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Trace failed: tracing requires NATS Server 2.11 or newer",
    ),
  );
  expect(screen.queryByTestId("trace-tree")).toBeNull();
});

it("disables the run button while disconnected", () => {
  connState.state = "disconnected";
  render(<TracePanel />);

  const run = screen.getByTestId("trace-run") as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  expect(screen.getByTestId("not-connected")).toBeTruthy();
});

// ---- Additional coverage beyond the brief's scenarios ----

it("intercepts an invalid subject inline without tracing", () => {
  render(<TracePanel />);
  setSubject("foo bar");
  fireEvent.click(screen.getByTestId("trace-run"));

  const err = screen.getByTestId("subject-error");
  expect(err.textContent).toContain("must not contain spaces");
  expect(Trace).not.toHaveBeenCalled();
});

it("sends an empty payload as base64 and no headers as null", async () => {
  render(<TracePanel />);
  setSubject("telemetry");
  fireEvent.click(screen.getByTestId("trace-run"));

  await waitFor(() => expect(Trace).toHaveBeenCalledTimes(1));
  const form = vi.mocked(Trace).mock.calls[0][0];
  expect(form.payload).toBe("");
  expect(form.headers).toBeNull();
});

it("falls back to the 5000 ms timeout when the settings load fails", async () => {
  vi.mocked(GetSettings).mockRejectedValue(new Error("offline"));
  render(<TracePanel />);

  const timeout = screen.getByLabelText("Timeout (ms)") as HTMLInputElement;
  expect(timeout.value).toBe("5000");

  setSubject("telemetry");
  fireEvent.click(screen.getByTestId("trace-run"));
  await waitFor(() => expect(Trace).toHaveBeenCalledTimes(1));
  expect(vi.mocked(Trace).mock.calls[0][0].timeout_ms).toBe(5000);
});

it("wires the trace panel into the messages page (placeholder removed)", async () => {
  render(<MessagesPage />);
  expect(screen.getByRole("tab", { name: "Trace" })).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "Trace" }));
  expect(await screen.findByTestId("trace-panel")).toBeTruthy();
  expect(screen.queryByTestId("trace-placeholder")).toBeNull();
});
