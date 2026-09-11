import { useTranslation } from "../../app/i18n";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PubPanel } from "./PubPanel";
import { SessionsPanel } from "./SessionsPanel";
import { TracePanel } from "./TracePanel";

/**
 * Messages page shell (spec §6.3): the publish/request workbench, the M2
 * subscription sessions tab, and the message path trace tab (spec §6.5).
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
          <SessionsPanel />
        </TabsContent>
        <TabsContent value="trace" className="min-h-0 flex-1 overflow-y-auto">
          <TracePanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default MessagesPage;
