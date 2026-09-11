import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "../../app/i18n";
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
  type ContextForm,
  type ContextSummary,
  type TestResult,
} from "../../lib/bindings";
import { contextFormSchema, type ContextFormValues } from "./schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const AUTH_TYPES = ["none", "userpass", "token", "creds", "nkey"] as const;
type AuthType = (typeof AUTH_TYPES)[number];

const AUTH_KEYS: Record<AuthType, string> = {
  none: "connections.authNone",
  userpass: "connections.authUser",
  token: "connections.authToken",
  creds: "connections.authCreds",
  nkey: "connections.authNkey",
};

// Credential fields owned by each authType. On submit the fields outside
// the active type are blanked so values hidden behind the radio switch
// never leak into a save (blanked fields keep stored values on edit — the
// natscontext merge semantics documented in internal/connections).
const AUTH_FIELDS: Record<AuthType, string[]> = {
  none: [],
  userpass: ["user", "password"],
  token: ["token"],
  creds: ["creds"],
  nkey: ["nkey"],
};

/**
 * The form draft: the schema's fields plus the two JetStream prefix fields
 * (§6.2 includes them; the brief's verbatim schema deliberately omits
 * them, so they ride along and are validated only by being strings).
 */
type Draft = ContextFormValues & { jsApiPrefix?: string; jsEventPrefix?: string };

const emptyDraft = (): Draft => ({
  name: "",
  url: "",
  description: "",
  authType: "none",
  tlsFirst: false,
});

const asAuthType = (v: string): AuthType =>
  (AUTH_TYPES as readonly string[]).includes(v) ? (v as AuthType) : "none";

/** Wire (snake_case Go model) → form draft, for the edit prefill. */
const fromWire = (f: ContextForm, authType: string): Draft => ({
  name: f.name,
  description: f.description ?? "",
  url: f.url,
  authType: asAuthType(authType),
  user: f.user ?? "",
  password: f.password ?? "",
  token: f.token ?? "",
  creds: f.creds ?? "",
  nkey: f.nkey ?? "",
  cert: f.cert ?? "",
  key: f.key ?? "",
  ca: f.ca ?? "",
  jsDomain: f.js_domain ?? "",
  jsApiPrefix: f.js_api_prefix ?? "",
  jsEventPrefix: f.js_event_prefix ?? "",
  inboxPrefix: f.inbox_prefix ?? "",
  socksProxy: f.socks_proxy ?? "",
  colorScheme: f.color_scheme ?? "",
  tlsFirst: Boolean(f.tls_first),
});

/** Form draft → wire model. Credential fields of other auth types are
 * blanked (see AUTH_FIELDS). */
const toWire = (d: Draft): ContextForm => {
  const keep = new Set(AUTH_FIELDS[d.authType]);
  const auth = (field: string, v: string | undefined): string =>
    keep.has(field) ? v ?? "" : "";
  return {
    name: d.name,
    description: d.description ?? "",
    url: d.url,
    user: auth("user", d.user),
    password: auth("password", d.password),
    token: auth("token", d.token),
    creds: auth("creds", d.creds),
    nkey: auth("nkey", d.nkey),
    cert: d.cert ?? "",
    key: d.key ?? "",
    ca: d.ca ?? "",
    js_domain: d.jsDomain ?? "",
    js_api_prefix: d.jsApiPrefix ?? "",
    js_event_prefix: d.jsEventPrefix ?? "",
    inbox_prefix: d.inboxPrefix ?? "",
    socks_proxy: d.socksProxy ?? "",
    color_scheme: d.colorScheme ?? "",
    tls_first: d.tlsFirst ?? false,
  };
};

/** First zod issue message per top-level field (messages are i18n keys). */
const collectErrors = (
  issues: { path: PropertyKey[]; message: string }[],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
};

export interface ConnectionsPageProps {
  /** Name of the currently active context ("" = none). Drives the active
   * marker, the delete-active confirm text, and the disconnect-first flow. */
  activeContext?: string;
  /** Invoked after save/delete/copy so the host can refresh the switcher
   * and command-palette context lists. */
  onChanged?: () => void;
}

/**
 * Connection management page (Settings > Connections): context list with
 * per-card actions (Connect / Edit / Copy / Delete), a create/edit dialog
 * with inline zod validation and a test-connection probe, a copy dialog,
 * and an env-override warning banner (spec §6.2 / §6.4).
 */
export function ConnectionsPage({ activeContext = "", onChanged }: ConnectionsPageProps) {
  const { t } = useTranslation();
  const [list, setList] = useState<ContextSummary[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Create/edit dialog state.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // Copy dialog state.
  const [copySrc, setCopySrc] = useState<string | null>(null);
  const [copyName, setCopyName] = useState("");
  const [copyError, setCopyError] = useState("");

  // Delete confirm state.
  const [deleting, setDeleting] = useState<ContextSummary | null>(null);

  const refresh = useCallback(async () => {
    try {
      setList((await ListContexts()) ?? []);
    } catch (err) {
      console.error("list contexts failed:", err);
    }
  }, []);

  useEffect(() => {
    void refresh();
    EnvWarnings()
      .then((vars) => setWarnings(vars ?? []))
      .catch(() => setWarnings([]));
  }, [refresh]);

  const afterMutation = () => {
    void refresh();
    onChanged?.();
  };

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const openNew = () => {
    setEditing(false);
    setDraft(emptyDraft());
    setErrors({});
    setTestResult(null);
    setShowPassword(false);
    setFormOpen(true);
  };

  const openEdit = (c: ContextSummary) => {
    setEditing(true);
    // Prefill from the summary at once, then refine with the full stored
    // form (Task 6 caution: the edit form must show stored values so
    // "unchanged" is the norm — empty fields would keep old values).
    setDraft({
      ...emptyDraft(),
      name: c.name,
      description: c.description,
      url: c.url,
      colorScheme: c.color_scheme,
    });
    setErrors({});
    setTestResult(null);
    setShowPassword(false);
    setFormOpen(true);
    GetContextForm(c.name)
      .then((form) => {
        if (form) setDraft(fromWire(form, c.auth_type));
      })
      .catch((err) => console.error("load context form failed:", err));
  };

  const validate = (): boolean => {
    const parsed = contextFormSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(collectErrors(parsed.error.issues));
      return false;
    }
    setErrors({});
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
    try {
      await SaveContext(toWire(draft));
      setFormOpen(false);
      afterMutation();
    } catch (err) {
      console.error("save context failed:", err);
    }
  };

  const handleTest = async () => {
    if (!validate()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await CheckConnection(toWire(draft));
      setTestResult(result ?? { ok: false, rtt_ms: 0, jetstream: false, error: "no result" });
    } catch (err) {
      setTestResult({ ok: false, rtt_ms: 0, jetstream: false, error: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleConnect = (name: string) => {
    // State feedback arrives via conn:state events (Task 8/9 wiring).
    Connect(name).catch((err) => console.error("connect failed:", err));
  };

  const confirmDelete = async () => {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    try {
      if (target.name === activeContext) {
        await Disconnect(); // active context: close the live connection first
      }
      await DeleteContext(target.name);
      afterMutation();
    } catch (err) {
      console.error("delete context failed:", err);
    }
  };

  const confirmCopy = async () => {
    if (!copySrc) return;
    const name = copyName.trim();
    if (name === "" || /[/\\]/.test(name)) {
      setCopyError("connections.nameInvalid");
      return;
    }
    setCopyError("");
    try {
      await CopyContext(copySrc, name);
      setCopySrc(null);
      setCopyName("");
      afterMutation();
    } catch (err) {
      console.error("copy context failed:", err);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-6" data-testid="connections-page">
      {warnings.length > 0 && (
        <div
          role="alert"
          data-testid="env-warning"
          className="rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-sm text-[var(--warn-fg)]"
        >
          {t("connections.envWarning", { vars: warnings.join(", ") })}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-medium">{t("connections.title")}</h1>
        <Button size="sm" onClick={openNew}>
          {t("connections.new")}
        </Button>
      </div>

      <ul className="flex flex-col gap-3">
        {list.map((c) => {
          const active = c.name === activeContext;
          return (
            <li
              key={c.name}
              data-testid={`ctx-card-${c.name}`}
              className="flex items-start justify-between gap-4 rounded-lg border border-border bg-panel p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`size-2 shrink-0 rounded-full ${active ? "bg-[var(--ok)]" : "bg-[var(--fg-faint)]"}`}
                    aria-hidden="true"
                  />
                  <span className="font-medium">{c.name}</span>
                  {active && <Badge variant="secondary">{t("connections.active")}</Badge>}
                  {c.color_scheme && <Badge variant="outline">{c.color_scheme}</Badge>}
                </div>
                {c.description && (
                  <p className="mt-1 text-sm text-[var(--fg-muted)]">{c.description}</p>
                )}
                <p className="mt-0.5 truncate text-xs text-[var(--fg-faint)]">
                  {c.url} · {t(AUTH_KEYS[asAuthType(c.auth_type)])}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {!active && (
                  <Button size="sm" variant="outline" onClick={() => handleConnect(c.name)}>
                    {t("connections.connect")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                  {t("connections.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCopySrc(c.name);
                    setCopyName("");
                    setCopyError("");
                  }}
                >
                  {t("connections.copy")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-[var(--danger-fg)]"
                  onClick={() => setDeleting(c)}
                >
                  {t("connections.delete")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {list.length === 0 && (
        <p className="text-sm text-[var(--fg-muted)]">{t("connections.empty")}</p>
      )}

      {/* Create / edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t(editing ? "connections.edit" : "connections.new")}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ctx-name" label={t("connections.name")} error={errors.name ? t(errors.name) : undefined}>
                {/* Editing renames = "save as new", so the key is frozen. */}
                <Input
                  id="ctx-name"
                  value={draft.name}
                  disabled={editing}
                  aria-invalid={errors.name ? true : undefined}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field id="ctx-desc" label={t("connections.description")}>
                <Input
                  id="ctx-desc"
                  value={draft.description ?? ""}
                  onChange={(e) => patch({ description: e.target.value })}
                />
              </Field>
            </div>

            <Field id="ctx-url" label={t("connections.url")} error={errors.url ? t(errors.url) : undefined}>
              <Input
                id="ctx-url"
                value={draft.url}
                placeholder="nats://127.0.0.1:4222"
                aria-invalid={errors.url ? true : undefined}
                onChange={(e) => patch({ url: e.target.value })}
              />
            </Field>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{t("connections.auth")}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {AUTH_TYPES.map((a) => (
                  <label key={a} className="flex cursor-pointer items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name="ctx-auth"
                      checked={draft.authType === a}
                      onChange={() => patch({ authType: a })}
                    />
                    {t(AUTH_KEYS[a])}
                  </label>
                ))}
              </div>
            </fieldset>

            {draft.authType === "userpass" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="ctx-user" label={t("connections.user")}>
                  <Input
                    id="ctx-user"
                    value={draft.user ?? ""}
                    autoComplete="off"
                    onChange={(e) => patch({ user: e.target.value })}
                  />
                </Field>
                <Field id="ctx-password" label={t("connections.password")}>
                  <div className="relative">
                    <Input
                      id="ctx-password"
                      className="pr-9"
                      type={showPassword ? "text" : "password"}
                      value={draft.password ?? ""}
                      autoComplete="off"
                      onChange={(e) => patch({ password: e.target.value })}
                    />
                    <button
                      type="button"
                      aria-label={t(showPassword ? "connections.hidePassword" : "connections.showPassword")}
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--fg-muted)] hover:text-foreground"
                    >
                      {showPassword ? (
                        <EyeOff size={14} strokeWidth={1.75} />
                      ) : (
                        <Eye size={14} strokeWidth={1.75} />
                      )}
                    </button>
                  </div>
                </Field>
              </div>
            )}
            {draft.authType === "token" && (
              <Field id="ctx-token" label={t("connections.token")}>
                <Input
                  id="ctx-token"
                  value={draft.token ?? ""}
                  autoComplete="off"
                  onChange={(e) => patch({ token: e.target.value })}
                />
              </Field>
            )}
            {draft.authType === "creds" && (
              <Field id="ctx-creds" label={t("connections.credsPath")}>
                <Input
                  id="ctx-creds"
                  value={draft.creds ?? ""}
                  onChange={(e) => patch({ creds: e.target.value })}
                />
              </Field>
            )}
            {draft.authType === "nkey" && (
              <Field id="ctx-nkey" label={t("connections.nkeyPath")}>
                <Input
                  id="ctx-nkey"
                  value={draft.nkey ?? ""}
                  onChange={(e) => patch({ nkey: e.target.value })}
                />
              </Field>
            )}

            <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">{t("connections.tls")}</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field id="ctx-cert" label={t("connections.cert")}>
                  <Input id="ctx-cert" value={draft.cert ?? ""} onChange={(e) => patch({ cert: e.target.value })} />
                </Field>
                <Field id="ctx-key" label={t("connections.key")}>
                  <Input id="ctx-key" value={draft.key ?? ""} onChange={(e) => patch({ key: e.target.value })} />
                </Field>
                <Field id="ctx-ca" label={t("connections.ca")}>
                  <Input id="ctx-ca" value={draft.ca ?? ""} onChange={(e) => patch({ ca: e.target.value })} />
                </Field>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.tlsFirst ?? false}
                  onChange={(e) => patch({ tlsFirst: e.target.checked })}
                />
                {t("connections.tlsFirst")}
              </label>
            </fieldset>

            <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">{t("connections.js")}</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field id="ctx-jsdomain" label={t("connections.jsDomain")}>
                  <Input
                    id="ctx-jsdomain"
                    value={draft.jsDomain ?? ""}
                    onChange={(e) => patch({ jsDomain: e.target.value })}
                  />
                </Field>
                <Field id="ctx-jsapi" label={t("connections.jsApiPrefix")}>
                  <Input
                    id="ctx-jsapi"
                    value={draft.jsApiPrefix ?? ""}
                    onChange={(e) => patch({ jsApiPrefix: e.target.value })}
                  />
                </Field>
                <Field id="ctx-jsevent" label={t("connections.jsEventPrefix")}>
                  <Input
                    id="ctx-jsevent"
                    value={draft.jsEventPrefix ?? ""}
                    onChange={(e) => patch({ jsEventPrefix: e.target.value })}
                  />
                </Field>
              </div>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="ctx-inbox" label={t("connections.inboxPrefix")}>
                <Input
                  id="ctx-inbox"
                  value={draft.inboxPrefix ?? ""}
                  onChange={(e) => patch({ inboxPrefix: e.target.value })}
                />
              </Field>
              <Field id="ctx-socks" label={t("connections.socksProxy")}>
                <Input
                  id="ctx-socks"
                  value={draft.socksProxy ?? ""}
                  onChange={(e) => patch({ socksProxy: e.target.value })}
                />
              </Field>
              <Field id="ctx-color" label={t("connections.colorScheme")}>
                <Input
                  id="ctx-color"
                  value={draft.colorScheme ?? ""}
                  onChange={(e) => patch({ colorScheme: e.target.value })}
                />
              </Field>
            </div>

            {testResult && (
              <p
                data-testid="test-result"
                role="status"
                className={testResult.ok ? "text-sm text-[var(--ok-fg)]" : "text-sm text-[var(--danger-fg)]"}
              >
                {testResult.ok
                  ? t("connections.testOk", {
                      rtt: testResult.rtt_ms,
                      js: t(testResult.jetstream ? "connections.jsYes" : "connections.jsNo"),
                    })
                  : t("connections.testFail", { error: testResult.error ?? "" })}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleTest} disabled={testing}>
              {testing ? t("connections.testing") : t("connections.test")}
            </Button>
            <Button onClick={handleSave}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Copy dialog */}
      <Dialog
        open={copySrc !== null}
        onOpenChange={(o) => {
          if (!o) {
            setCopySrc(null);
            setCopyError("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("connections.copyTitle")}</DialogTitle>
            <DialogDescription>{copySrc}</DialogDescription>
          </DialogHeader>
          <Field id="ctx-copy-name" label={t("connections.copyName")} error={copyError ? t(copyError) : undefined}>
            <Input
              id="ctx-copy-name"
              value={copyName}
              onChange={(e) => setCopyName(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCopySrc(null);
                setCopyError("");
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={confirmCopy}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm (danger; active contexts disconnect first) */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("connections.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && deleting.name === activeContext
                ? t("connections.deleteActive")
                : t("connections.deleteConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void confirmDelete(); }}>
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Label + control + inline validation error, the form's atomic row. */
function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger-fg)]">
          {error}
        </p>
      )}
    </div>
  );
}
