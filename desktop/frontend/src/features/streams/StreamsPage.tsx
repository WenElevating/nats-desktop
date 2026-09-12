import { useCallback, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { useConfirm } from "../../lib/confirm";
import type { StreamSummary } from "../../lib/bindings";
import { useStreams } from "./useStreams";
import { StreamList } from "./StreamList";
import { StreamDetail } from "./StreamDetail";
import { StreamForm, type StreamFormMode } from "./StreamForm";
import { StreamMsgs } from "./StreamMsgs";
import { BackupPanel, type BackupDirection } from "./BackupPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Client-side filter (spec §6.6: immediate within 500 streams): substring
 * match on the stream name or any of its subjects, case-insensitive. */
export function matchStreams(streams: StreamSummary[], query: string): StreamSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return streams;
  return streams.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.subjects.some((sub) => sub.toLowerCase().includes(q)),
  );
}

const KNOWN_REASONS = ["no_responders", "timeout", "server"] as const;

export interface StreamsPageProps {
  /** Override for the create entry (tests/host flows). Defaults to the
   * built-in create dialog (Task 10). */
  onCreate?: () => void;
  /** Override for the restore entry. Defaults to the built-in restore panel
   * (Task 13 BackupPanel in restore mode). */
  onRestore?: () => void;
}

/**
 * Streams page (spec §6.6 / §18.1): left list rail (search filter, refresh,
 * Create/Restore slots, virtualized table) and the right detail pane with an
 * empty-state guidance. When the backend reports the stream list unavailable
 * (unavailable_reason, spec §6.6 Global Constraint) a guidance panel with the
 * domain / api_prefix troubleshooting steps replaces the table — never an
 * empty grid. Disconnected shows a connect banner instead.
 *
 * Since Task 10 the page owns the create/edit/copy dialog and the tiered
 * danger ops: purge/seal go through confirmL1, delete through
 * confirmNameMatch (Global Constraint 4 / AC-010); every op button shows its
 * spinner immediately via the `busy` key.
 */
export function StreamsPage({ onCreate, onRestore }: StreamsPageProps) {
  const { t } = useTranslation();
  const conn = useConnState();
  const api = useStreams();
  const { confirmL1, confirmNameMatch } = useConfirm();
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<{ open: boolean; mode: StreamFormMode }>({
    open: false,
    mode: "create",
  });
  const [busyOp, setBusyOp] = useState<string | null>(null);
  // Task 11: the detail pane's Messages op swaps in the browser panel (the
  // panel replaces the detail view; close returns to it).
  const [msgsOpen, setMsgsOpen] = useState(false);
  // Task 13: the backup/restore dialog — backup opens from the detail pane's
  // Backup op (with the selected stream), restore from the toolbar button.
  const [backup, setBackup] = useState<{ open: boolean; mode: BackupDirection; stream: string }>({
    open: false,
    mode: "backup",
    stream: "",
  });

  const openForm = useCallback((mode: StreamFormMode) => setForm({ open: true, mode }), []);
  const closeForm = useCallback(() => setForm((f) => ({ ...f, open: false })), []);
  const closeBackup = useCallback(() => setBackup((b) => ({ ...b, open: false })), []);

  // Runs an op with the immediate busy marker; confirm dialogs resolve before
  // the binding call, cancellation just clears the spinner.
  const runOp = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    setBusyOp(key);
    try {
      await fn();
    } finally {
      setBusyOp(null);
    }
  }, []);

  const selectedName = api.detail?.summary.name ?? "";

  const handlePurge = useCallback(
    () =>
      runOp("purge", async () => {
        if (!selectedName) return;
        const ok = await confirmL1({
          titleKey: "streams.confirm.purgeTitle",
          bodyKey: "streams.confirm.purgeBody",
          data: { name: selectedName },
        });
        if (ok) await api.purge(selectedName, 0, 0, "");
      }),
    [runOp, selectedName, confirmL1, api],
  );

  const handleSeal = useCallback(
    () =>
      runOp("seal", async () => {
        if (!selectedName) return;
        const ok = await confirmL1({
          titleKey: "streams.confirm.sealTitle",
          bodyKey: "streams.confirm.sealBody",
          data: { name: selectedName },
        });
        if (ok) await api.seal(selectedName);
      }),
    [runOp, selectedName, confirmL1, api],
  );

  const handleDelete = useCallback(
    () =>
      runOp("delete", async () => {
        if (!selectedName) return;
        // Level-2: always shown, confirm only on a character-exact name.
        const ok = await confirmNameMatch(selectedName);
        if (ok) await api.remove(selectedName);
      }),
    [runOp, selectedName, confirmNameMatch, api],
  );

  const filtered = useMemo(() => matchStreams(api.list, query), [api.list, query]);
  const connected = conn.state === "connected";
  const unavailable = api.unavailableReason !== "";
  const reasonKey = (KNOWN_REASONS as readonly string[]).includes(api.unavailableReason)
    ? `streams.unavailable.${api.unavailableReason}`
    : "streams.unavailable.generic";

  return (
    <div data-testid="streams-page" className="flex min-h-0 flex-1">
      {/* Left rail: search + refresh + slots + list */}
      <aside className="flex w-[440px] min-w-[340px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 px-3 py-2">
          <Input
            data-testid="streams-search"
            aria-label={t("streams.search")}
            placeholder={t("streams.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8"
          />
          <Button
            size="sm"
            variant="outline"
            data-testid="streams-refresh"
            aria-label={t("streams.refresh")}
            onClick={api.refresh}
            disabled={!connected || api.loading}
            className="h-8 shrink-0 px-2"
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            data-testid="streams-create"
            onClick={onCreate ?? (() => openForm("create"))}
            className="h-8 shrink-0"
          >
            {t("streams.create")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="streams-restore"
            onClick={onRestore ?? (() => setBackup({ open: true, mode: "restore", stream: "" }))}
            className="h-8 shrink-0"
          >
            {t("streams.restore")}
          </Button>
        </div>

        {!connected ? (
          <div
            data-testid="streams-not-connected"
            className="mx-3 mb-3 rounded-md border border-border bg-panel p-3 text-sm text-[var(--fg-muted)]"
          >
            {t("streams.notConnected")}
          </div>
        ) : unavailable ? (
          <div
            data-testid="streams-unavailable"
            className="mx-3 mb-3 flex flex-col gap-2 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] p-3 text-sm"
          >
            <p className="font-medium">{t("streams.unavailable.title")}</p>
            <p className="text-[var(--fg-muted)]">{t(reasonKey)}</p>
            <ul className="ml-4 list-disc text-xs text-[var(--fg-muted)]">
              <li>{t("streams.unavailable.checkDomain")}</li>
              <li>{t("streams.unavailable.checkPrefix")}</li>
            </ul>
          </div>
        ) : (
          <StreamList
            streams={filtered}
            rates={api.rates}
            selected={api.selected}
            onSelect={api.select}
          />
        )}
      </aside>

      {/* Right pane: message browser, detail, or empty-state guidance */}
      <section className="flex min-w-0 flex-1 flex-col">
        {api.detail ? (
          msgsOpen ? (
            <StreamMsgs
              key={api.detail.summary.name}
              stream={api.detail.summary.name}
              summary={{
                firstSeq: api.detail.summary.first_seq,
                lastSeq: api.detail.summary.last_seq,
              }}
              onClose={() => setMsgsOpen(false)}
            />
          ) : (
            <StreamDetail
              detail={api.detail}
              loading={api.detailLoading}
              rate={api.rate}
              series={api.series}
              busy={busyOp}
              onMessages={() => setMsgsOpen(true)}
              onEdit={() => openForm("edit")}
              onCopy={() => openForm("copy")}
              onPurge={handlePurge}
              onSeal={handleSeal}
              onBackup={() =>
                setBackup({ open: true, mode: "backup", stream: selectedName })
              }
              onDelete={handleDelete}
            />
          )
        ) : (
          <div
            data-testid="streams-detail-empty"
            className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
          >
            <p className="text-sm font-medium">{t("streams.detail.emptyTitle")}</p>
            <p className="max-w-sm text-xs text-[var(--fg-muted)]">
              {t("streams.detail.emptyBody")}
            </p>
          </div>
        )}
      </section>

      {/* Create / edit / copy dialog (Task 10). Copy submits through
       * CreateStream so the operator's tweaks travel with the new stream;
       * edit submits through UpdateStream. */}
      <StreamForm
        open={form.open}
        mode={form.mode}
        initial={form.mode === "create" ? null : api.detail?.form ?? null}
        onSubmit={async (values) =>
          form.mode === "edit" ? await api.update(values) : await api.create(values)
        }
        onDone={closeForm}
      />

      {/* Backup / restore dialog (Task 13): one panel, two modes; completion
       * refreshes the page's stream list via api.refresh. */}
      <BackupPanel
        open={backup.open}
        mode={backup.mode}
        stream={backup.stream}
        refresh={api.refresh}
        onClose={closeBackup}
      />
    </div>
  );
}

export default StreamsPage;
