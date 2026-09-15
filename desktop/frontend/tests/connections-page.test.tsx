import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import { toast } from "sonner";
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

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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

// GetContextForm resolves a { form, mod_time_ms } wrapper (Task 12): the
// mtime snapshot the edit dialog must hand back to SaveContext.
const formResult = (form: typeof fullForm = fullForm, modTimeMs = 17180) => ({
  form,
  mod_time_ms: modTimeMs,
});

// The Go sentinel, wrapped the way Wails surfaces it (name included).
const conflictError = () => new Error('save context "dev": context modified externally');

beforeEach(() => {
  vi.mocked(ListContexts).mockResolvedValue([summary()]);
  vi.mocked(EnvWarnings).mockResolvedValue([]);
  vi.mocked(GetContextForm).mockResolvedValue(formResult() as never);
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
  vi.mocked(GetContextForm).mockResolvedValue(
    formResult({ ...fullForm, url: "nats://stored:4222", user: "alice", password: "secret" }) as never,
  );
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

// AC-030 (matrix F-1): the context token is a credential like the password
// and must default to masked display. Falsifies if the token input ever
// renders as plaintext type="text".
it("masks the token until the eye toggle reveals it (AC-030)", async () => {
  render(<ConnectionsPage />);
  fireEvent.click(screen.getByRole("button", { name: "New context" }));
  await screen.findByLabelText("Name");
  fireEvent.click(screen.getByRole("radio", { name: "Token" }));

  // Both the token auth radio and the token field are labelled "Token";
  // pick the field by its stable ctx-token id.
  const tokenInput = () =>
    screen.getAllByLabelText("Token").find((el) => el.id === "ctx-token") as HTMLInputElement;
  await userEvent.type(tokenInput(), "s3cr3t-token");

  expect(tokenInput().type).toBe("password");
  expect(tokenInput().value).toBe("s3cr3t-token");
  fireEvent.click(screen.getByRole("button", { name: "Show token" }));
  expect(tokenInput().type).toBe("text");
});

it("connect action calls the Connect binding", async () => {
  render(<ConnectionsPage />);
  await screen.findByText("dev");
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(Connect).toHaveBeenCalledWith("dev"));
});

// ---- Fix round 1: backend failures toast (spec §18.5) ----

it("save failure toasts the server error and keeps the dialog open", async () => {
  vi.mocked(SaveContext).mockRejectedValue(new Error("boom"));
  render(<ConnectionsPage />);
  fireEvent.click(screen.getByRole("button", { name: "New context" }));
  await userEvent.type(await screen.findByLabelText("Name"), "prod");
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "nats://prod:4222" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("boom");
  // Dialog stays open so the user can retry or adjust (no silent close).
  expect(screen.getByLabelText("Name")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
});

// ---- Task 12: external-modification conflict detection (spec §6.2) ----

it("edit saves carry the observed mtime; creates carry 0", async () => {
  vi.mocked(GetContextForm).mockResolvedValue(formResult(fullForm, 987654) as never);
  render(<ConnectionsPage />);
  await screen.findByText("dev");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() =>
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("nats://localhost:4222"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(SaveContext).toHaveBeenCalledWith(expect.objectContaining({ name: "dev" }), 987654),
  );

  // Create flow: no snapshot exists, the check stays disabled.
  fireEvent.click(screen.getByRole("button", { name: "New context" }));
  await userEvent.type(await screen.findByLabelText("Name"), "prod");
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "nats://prod:4222" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(SaveContext).toHaveBeenLastCalledWith(expect.objectContaining({ name: "prod" }), 0),
  );
});

it("an external modification opens the conflict dialog instead of toasting", async () => {
  vi.mocked(SaveContext).mockRejectedValue(conflictError());
  render(<ConnectionsPage />);
  await screen.findByText("dev");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await screen.findByLabelText("Name");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Context changed on disk")).toBeTruthy();
  expect(within(dialog).getByText(/dev/)).toBeTruthy();
  // A conflict is not a generic failure: no toast, and the edit form is
  // still open underneath awaiting the user's choice.
  expect(toast.error).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Server URL")).toBeTruthy();
  expect(SaveContext).toHaveBeenCalledTimes(1);
});

it("keep mine re-saves with the mtime check disabled and closes", async () => {
  vi.mocked(SaveContext).mockRejectedValueOnce(conflictError()).mockResolvedValueOnce(undefined);
  render(<ConnectionsPage />);
  await screen.findByText("dev");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await screen.findByLabelText("Name");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Keep mine" }));

  await waitFor(() => expect(SaveContext).toHaveBeenCalledTimes(2));
  expect(SaveContext).toHaveBeenLastCalledWith(expect.objectContaining({ name: "dev" }), 0);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  // Success closes the edit dialog and refreshes (mount + afterMutation).
  await waitFor(() => expect(screen.queryByLabelText("Server URL")).toBeNull());
  await waitFor(() => expect(ListContexts).toHaveBeenCalledTimes(2));
});

it("reload re-fetches the stored form, replaces the draft, and saves on the fresh mtime", async () => {
  vi.mocked(SaveContext).mockRejectedValueOnce(conflictError());
  vi.mocked(GetContextForm)
    .mockResolvedValueOnce(formResult({ ...fullForm, url: "nats://stale:4222" }, 111) as never)
    .mockResolvedValueOnce(formResult({ ...fullForm, url: "nats://stored:4222" }, 222) as never);
  render(<ConnectionsPage />);
  await screen.findByText("dev");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() =>
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("nats://stale:4222"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Reload" }));

  await waitFor(() => expect(GetContextForm).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("nats://stored:4222"),
  );
  // Reload only re-prefills — nothing is written, no toast is shown.
  expect(SaveContext).toHaveBeenCalledTimes(1);
  expect(toast.error).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();

  // The next save carries the reloaded snapshot.
  vi.mocked(SaveContext).mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(SaveContext).toHaveBeenLastCalledWith(expect.objectContaining({ name: "dev" }), 222),
  );
  await waitFor(() => expect(screen.queryByLabelText("Server URL")).toBeNull());
});
