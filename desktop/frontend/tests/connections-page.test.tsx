import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import { ConnectionsPage } from "../src/features/connections/ConnectionsPage";
import {
  CheckConnection,
  Connect,
  CopyContext,
  DeleteContext,
  Disconnect,
  EnvWarnings,
  GetContextForm,
  ListContexts,
  SaveContext,
} from "../src/lib/bindings";

// The brief's scenario assertions match user-visible (interpolated) text —
// e.g. /RTT 12ms/ — so this file does NOT stub t:(k)=>k like the older
// suites; it uses the real i18n module (en resources, synchronous init).
// Only the Wails bindings are mocked.

vi.mock("../src/lib/bindings", () => ({
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

const summary = (over: Partial<ReturnType<typeof ListContexts>[number]> = {}) => ({
  name: "dev",
  description: "local server",
  url: "nats://localhost:4222",
  auth_type: "none",
  color_scheme: "",
  ...over,
});

const fullForm = {
  name: "dev",
  description: "local server",
  url: "nats://localhost:4222",
  user: "",
  password: "",
  token: "",
  creds: "",
  nkey: "",
  cert: "",
  key: "",
  ca: "",
  js_domain: "",
  js_api_prefix: "",
  js_event_prefix: "",
  inbox_prefix: "",
  socks_proxy: "",
  color_scheme: "",
  tls_first: false,
};

beforeEach(() => {
  vi.mocked(ListContexts).mockResolvedValue([summary()]);
  vi.mocked(EnvWarnings).mockResolvedValue([]);
  vi.mocked(GetContextForm).mockResolvedValue(fullForm as never);
  vi.mocked(SaveContext).mockResolvedValue(undefined);
  vi.mocked(DeleteContext).mockResolvedValue(undefined);
  vi.mocked(CopyContext).mockResolvedValue(undefined);
  vi.mocked(Disconnect).mockResolvedValue(undefined);
  vi.mocked(Connect).mockResolvedValue(undefined);
  vi.mocked(CheckConnection).mockResolvedValue({ ok: true, rtt_ms: 0, jetstream: false });
});

it("rejects a name with path separator inline without saving", async () => {
  render(<ConnectionsPage />);
  fireEvent.click(screen.getByRole("button", { name: "New context" }));
  await userEvent.type(await screen.findByLabelText("Name"), "a/b");
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "nats://localhost:4222" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText(/must not contain path separators/)).toBeTruthy();
  expect(SaveContext).not.toHaveBeenCalled();
});

it("shows the test result with rtt and jetstream", async () => {
  vi.mocked(CheckConnection).mockResolvedValue({ ok: true, rtt_ms: 12, jetstream: true });
  render(<ConnectionsPage />);
  fireEvent.click(screen.getByRole("button", { name: "New context" }));
  await userEvent.type(await screen.findByLabelText("Name"), "probe");
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "nats://localhost:4222" } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

  expect(await screen.findByText(/RTT 12ms/)).toBeTruthy();
  expect(screen.getByText(/JetStream: yes/)).toBeTruthy();
  expect(CheckConnection).toHaveBeenCalledTimes(1);
});

it("delete of the active context confirms, disconnects, then deletes", async () => {
  render(<ConnectionsPage activeContext="dev" />);
  await screen.findByText("dev");
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/will be disconnected first/)).toBeTruthy();

  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(DeleteContext).toHaveBeenCalledWith("dev"));
  expect(Disconnect).toHaveBeenCalledTimes(1);
  expect(Disconnect.mock.invocationCallOrder[0]).toBeLessThan(
    DeleteContext.mock.invocationCallOrder[0],
  );
});

it("shows the env-var warning banner when overrides are present", async () => {
  vi.mocked(EnvWarnings).mockResolvedValue(["NATS_URL"]);
  render(<ConnectionsPage />);
  expect(await screen.findByText(/environment variables detected/)).toBeTruthy();
  expect(screen.getByText(/NATS_URL/)).toBeTruthy();
});

// ---- Additional coverage beyond the brief's four scenarios ----

it("saves a valid new context and refreshes the list", async () => {
  render(<ConnectionsPage />);
  fireEvent.click(screen.getByRole("button", { name: "New context" }));
  await userEvent.type(await screen.findByLabelText("Name"), "prod");
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "nats://prod.example:4222" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(SaveContext).toHaveBeenCalledTimes(1));
  const form = vi.mocked(SaveContext).mock.calls[0][0];
  expect(form.name).toBe("prod");
  expect(form.url).toBe("nats://prod.example:4222");
  await waitFor(() => expect(ListContexts).toHaveBeenCalledTimes(2));
});

it("copy prompts for a new name and duplicates the context", async () => {
  render(<ConnectionsPage />);
  await screen.findByText("dev");
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await userEvent.type(await screen.findByLabelText("New name"), "dev2");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(CopyContext).toHaveBeenCalledWith("dev", "dev2"));
});

it("edit prefills the stored context form and disables renaming", async () => {
  vi.mocked(GetContextForm).mockResolvedValue({
    ...fullForm,
    url: "nats://stored:4222",
    user: "alice",
    password: "secret",
  } as never);
  render(<ConnectionsPage />);
  await screen.findByText("dev");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));

  const name = await screen.findByLabelText("Name");
  expect((name as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("nats://stored:4222");
});

it("masks the password until the eye toggle reveals it", async () => {
  render(<ConnectionsPage />);
  fireEvent.click(screen.getByRole("button", { name: "New context" }));
  await screen.findByLabelText("Name");
  fireEvent.click(screen.getByLabelText("Username / Password"));
  await userEvent.type(screen.getByLabelText("Password"), "hunter2");

  const pw = screen.getByLabelText("Password") as HTMLInputElement;
  expect(pw.type).toBe("password");
  expect(pw.value).toBe("hunter2");
  fireEvent.click(screen.getByRole("button", { name: "Show password" }));
  expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("text");
});

it("connect action calls the Connect binding", async () => {
  render(<ConnectionsPage />);
  await screen.findByText("dev");
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(Connect).toHaveBeenCalledWith("dev"));
});
