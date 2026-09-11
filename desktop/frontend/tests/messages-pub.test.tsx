import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import { toast } from "sonner";
import { MessagesPage } from "../src/features/messages/MessagesPage";
import { PubPanel } from "../src/features/messages/PubPanel";
import { Publish, Request, GetSettings } from "../src/lib/bindings";
import { toBase64, toBase64Bytes } from "../src/lib/base64";

// Scenario assertions match user-visible (interpolated) text — "Waited
// 1234 ms", "exceeds the 8 MiB limit (9.0 MB)" — so this file uses the real
// i18n module (en resources, synchronous init) like the connections suite.
// Mocked: the bindings surface, sonner, and the connection state (the
// hoisted `connState` object is mutated per test to pin disconnected).
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
  Publish: vi.fn(),
  Request: vi.fn(),
  GetSettings: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/** Settings fixture mirroring bindings Default(); only the request timeout
 * varies (it seeds the panel's timeout field on mount). */
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

beforeEach(() => {
  connState.state = "connected";
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture(5) as never);
  vi.mocked(Publish).mockResolvedValue({ ok: true, jetstream: false, elapsed_ms: 7 });
  vi.mocked(Request).mockResolvedValue({
    ok: true,
    payload: toBase64("pong"),
    headers: null,
    elapsed_ms: 42,
    no_responder: false,
  });
});

const setSubject = (v: string) =>
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: v } });
const setPayload = (v: string) =>
  fireEvent.change(screen.getByLabelText("Payload"), { target: { value: v } });

// ---- The brief's seven scenarios ----

it("intercepts a subject containing spaces inline without publishing", () => {
  render(<PubPanel />);
  setSubject("foo bar");
  fireEvent.click(screen.getByTestId("send-button"));

  const err = screen.getByTestId("subject-error");
  expect(err.textContent).toContain("must not contain spaces");
  expect(Publish).not.toHaveBeenCalled();
});

it("warns on a 5 MB payload and only publishes after confirmation", async () => {
  render(<PubPanel />);
  setSubject("telemetry");
  setPayload("a".repeat(5 * 1024 * 1024));
  fireEvent.click(screen.getByTestId("send-button"));

  // Confirmation dialog first; nothing is sent before it is accepted.
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/Large payload/)).toBeTruthy();
  expect(within(dialog).getByText(/5\.0 MiB/)).toBeTruthy();
  expect(Publish).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(Publish).toHaveBeenCalledTimes(1));
  const form = vi.mocked(Publish).mock.calls[0][0];
  expect(form.subject).toBe("telemetry");
  expect(form.jetstream).toBe(false);
});

it("rejects a 9 MB payload outright with the size notice", async () => {
  render(<PubPanel />);
  setSubject("telemetry");
  setPayload("a".repeat(9 * 1024 * 1024));
  fireEvent.click(screen.getByTestId("send-button"));

  const reject = await screen.findByTestId("size-reject");
  expect(reject.textContent).toContain("8 MiB limit");
  expect(reject.textContent).toContain("9.0 MiB");
  expect(Publish).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("renders a request response with payload and waited duration", async () => {
  render(<PubPanel />);
  fireEvent.click(screen.getByTestId("mode-request"));
  setSubject("ping");
  setPayload("ping-body");
  fireEvent.click(screen.getByTestId("send-button"));

  const res = await screen.findByTestId("req-result");
  expect(res.textContent).toContain("pong");
  expect(res.textContent).toContain("42 ms");
  expect(screen.queryByTestId("no-responder")).toBeNull();

  const form = vi.mocked(Request).mock.calls[0][0];
  expect(form.subject).toBe("ping");
  expect(form.payload).toBe(toBase64("ping-body"));
});

it("shows the no-responder notice with the waited duration", async () => {
  vi.mocked(Request).mockResolvedValue({
    ok: false,
    payload: null,
    headers: null,
    elapsed_ms: 1234,
    no_responder: true,
  });
  render(<PubPanel />);
  fireEvent.click(screen.getByTestId("mode-request"));
  setSubject("ping");
  fireEvent.click(screen.getByTestId("send-button"));

  const notice = await screen.findByTestId("no-responder");
  expect(notice.textContent).toContain("No responders");
  expect(notice.textContent).toContain("Waited 1234 ms");
});

it("records each send in the in-memory history", async () => {
  render(<PubPanel />);
  setSubject("telemetry");
  setPayload("hello");
  fireEvent.click(screen.getByTestId("send-button"));
  await screen.findByTestId("pub-result");

  const history = screen.getByTestId("pub-history");
  expect(within(history).getAllByTestId("history-item")).toHaveLength(1);
  expect(within(history).getByText("telemetry")).toBeTruthy();
});

it("disables the send button while disconnected", () => {
  connState.state = "disconnected";
  render(<PubPanel />);

  const send = screen.getByTestId("send-button") as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  expect(screen.getByTestId("not-connected")).toBeTruthy();
});

it("seeds the timeout field from the request_timeout_seconds setting and sends it", async () => {
  vi.mocked(GetSettings).mockResolvedValue(settingsFixture(30) as never);
  render(<PubPanel />);

  const timeout = screen.getByLabelText("Timeout (ms)") as HTMLInputElement;
  await waitFor(() => expect(timeout.value).toBe("30000"));

  setSubject("telemetry");
  fireEvent.click(screen.getByTestId("send-button"));
  await waitFor(() => expect(Publish).toHaveBeenCalledTimes(1));
  expect(vi.mocked(Publish).mock.calls[0][0].timeout_ms).toBe(30000);
});

// ---- Additional coverage beyond the brief's scenarios ----

it("publishes the wire form with base64 payload and grouped headers", async () => {
  render(<PubPanel />);
  setSubject("telemetry");
  setPayload("你好");
  fireEvent.click(screen.getByRole("button", { name: "Add header" }));
  fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "X-Test" } });
  fireEvent.change(screen.getByLabelText("Header value"), { target: { value: "v1" } });
  fireEvent.click(screen.getByTestId("send-button"));

  await waitFor(() => expect(Publish).toHaveBeenCalledTimes(1));
  const form = vi.mocked(Publish).mock.calls[0][0];
  expect(form.payload).toBe(toBase64("你好"));
  expect(form.headers).toEqual({ "X-Test": ["v1"] });
  expect(form.timeout_ms).toBe(5000);
});

it("formats valid JSON in place and toasts on invalid JSON", () => {
  render(<PubPanel />);
  setPayload('{"a":1}');
  fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
  expect((screen.getByLabelText("Payload") as HTMLTextAreaElement).value).toBe(
    '{\n  "a": 1\n}',
  );

  setPayload("{nope");
  fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
  expect(toast.error).toHaveBeenCalledWith("Payload is not valid JSON");
});

it("reveals the Nats-Msg-Id hint with JetStream and shows the ack badges", async () => {
  vi.mocked(Publish).mockResolvedValue({
    ok: true,
    jetstream: true,
    stream: "ORDERS",
    sequence: 42,
    duplicate: true,
    elapsed_ms: 12,
  });
  render(<PubPanel />);
  expect(screen.queryByTestId("msgid-hint")).toBeNull();

  fireEvent.click(screen.getByTestId("js-switch"));
  expect(screen.getByTestId("msgid-hint").textContent).toContain("Nats-Msg-Id");
  expect(screen.getByLabelText("Nats-Msg-Id")).toBeTruthy();

  setSubject("orders.new");
  fireEvent.click(screen.getByTestId("send-button"));
  await screen.findByTestId("pub-result");

  expect(vi.mocked(Publish).mock.calls[0][0].jetstream).toBe(true);
  const result = screen.getByTestId("pub-result");
  expect(result.textContent).toContain("Stream ORDERS");
  expect(result.textContent).toContain("seq 42");
  expect(result.textContent).toContain("duplicate");
});

it("sends a msgId through the Nats-Msg-Id header", async () => {
  render(<PubPanel />);
  fireEvent.click(screen.getByTestId("js-switch"));
  fireEvent.change(screen.getByLabelText("Nats-Msg-Id"), { target: { value: "abc-1" } });
  setSubject("orders.new");
  fireEvent.click(screen.getByTestId("send-button"));

  await waitFor(() => expect(Publish).toHaveBeenCalledTimes(1));
  expect(vi.mocked(Publish).mock.calls[0][0].headers).toEqual({ "Nats-Msg-Id": ["abc-1"] });
});

it("shows the publish failure with the server error", async () => {
  vi.mocked(Publish).mockResolvedValue({
    ok: false,
    jetstream: false,
    elapsed_ms: 3,
    error: "nats: timeout",
  });
  render(<PubPanel />);
  setSubject("telemetry");
  fireEvent.click(screen.getByTestId("send-button"));

  const err = await screen.findByTestId("pub-error");
  expect(err.textContent).toContain("Publish failed");
  expect(err.textContent).toContain("nats: timeout");
});

it("shows a binary request response as a hex preview", async () => {
  vi.mocked(Request).mockResolvedValue({
    ok: true,
    payload: toBase64Bytes(new Uint8Array([0x00, 0xff, 0x80])),
    headers: null,
    elapsed_ms: 5,
    no_responder: false,
  });
  render(<PubPanel />);
  fireEvent.click(screen.getByTestId("mode-request"));
  setSubject("bin");
  fireEvent.click(screen.getByTestId("send-button"));

  const bin = await screen.findByTestId("req-payload-binary");
  expect(bin.textContent).toContain("Binary payload");
  expect(bin.textContent).toContain("00ff80");
  expect(screen.queryByTestId("req-payload")).toBeNull();
});

it("keeps the history capped at 20 entries, newest first", async () => {
  render(<PubPanel />);
  for (let i = 0; i < 22; i++) {
    setSubject(`s${i}`);
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(Publish).toHaveBeenCalledTimes(i + 1));
  }

  const items = screen.getAllByTestId("history-item");
  expect(items).toHaveLength(20);
  expect(items[0].textContent).toContain("s21");
});

it("clears the history on demand", async () => {
  render(<PubPanel />);
  setSubject("telemetry");
  fireEvent.click(screen.getByTestId("send-button"));
  await screen.findByTestId("pub-result");

  fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
  expect(screen.getByTestId("pub-history").textContent).toContain("Nothing sent yet.");
  expect(screen.queryByTestId("history-item")).toBeNull();
});

it("renders the three message tabs with placeholders for sessions and trace", async () => {
  render(<MessagesPage />);
  expect(screen.getByRole("tab", { name: "Publish" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Sessions" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Trace" })).toBeTruthy();
  expect(screen.getByTestId("pub-panel")).toBeTruthy();

  // Radix tabs activate on mousedown (automatic activation), so the click
  // goes through userEvent's full pointer sequence.
  await userEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  expect(await screen.findByTestId("sessions-placeholder")).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "Trace" }));
  expect(await screen.findByTestId("trace-placeholder")).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "Publish" }));
  expect(await screen.findByTestId("pub-panel")).toBeTruthy();
});
