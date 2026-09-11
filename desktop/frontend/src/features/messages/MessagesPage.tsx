import { useTranslation } from "../../app/i18n";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PubPanel } from "./PubPanel";

function TabPlaceholder({ testid, text }: { testid: string; text: string }) {
  return (
    <div
      data-testid={testid}
      className="flex flex-1 items-center justify-center p-8 text-sm text-[var(--fg-muted)]"
    >
      {text}
    </div>
  );
}

/**
 * Messages page shell (spec §6.3): the publish/request workbench plus
 * placeholder tabs for the M2 subscription sessions (Task 9) and the message
 * path trace (Task 10).
 */
export function MessagesPage() {
  const { t } = useTranslation();
  return (
    <div data-testid="messages-page" className="flex min-h-0 flex-1 flex-col">
      <Tabs defaultValue="publish" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList variant="line" className="mx-4 mt-3 shrink-0">
          <TabsTrigger value="publish">{t("messages.tabPublish")}</TabsTrigger>
          <TabsTrigger value="sessions">{t("messages.tabSessions")}</TabsTrigger>
          <TabsTrigger value="trace">{t("messages.tabTrace")}</TabsTrigger>
        </TabsList>
        <TabsContent value="publish" className="min-h-0 flex-1 overflow-y-auto">
          <PubPanel />
        </TabsContent>
        <TabsContent value="sessions" className="min-h-0 flex-1 flex flex-col">
          <TabPlaceholder testid="sessions-placeholder" text={t("messages.sessionsPlaceholder")} />
        </TabsContent>
        <TabsContent value="trace" className="min-h-0 flex-1 flex flex-col">
          <TabPlaceholder testid="trace-placeholder" text={t("messages.tracePlaceholder")} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default MessagesPage;
