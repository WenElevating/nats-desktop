import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "@/app/i18n";
import { GetSettings } from "@/lib/bindings";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type L1Options = { titleKey: string; bodyKey?: string; confirmKey?: string; data?: Record<string, string> };

type ConfirmApi = {
  confirmL1: (opts: L1Options) => Promise<boolean>;
  confirmNameMatch: (name: string) => Promise<boolean>;
};

const Ctx = createContext<ConfirmApi | null>(null);

/**
 * Global confirmation primitives (Global Constraint 4):
 * - confirmL1 (level-1): a plain AlertDialog. Skipped entirely — resolves true
 *   without rendering anything — when settings.behavior.confirm_level is
 *   "relaxed"; shown at "standard", which is also the fail-closed fallback
 *   when the settings read fails.
 * - confirmNameMatch (level-2): always shown regardless of level; the confirm
 *   button stays disabled until the input equals the target name, so a wrong
 *   name can never resolve the promise (AC-010).
 * The useTranslation hook is imported from the app's single i18n surface
 * (@/app/i18n), matching the rest of the codebase.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [l1, setL1] = useState<(L1Options & { resolve: (v: boolean) => void }) | null>(null);
  const [nm, setNm] = useState<{ name: string; input: string; resolve: (v: boolean) => void } | null>(null);

  const confirmL1 = useCallback(async (opts: L1Options) => {
    let level: "standard" | "relaxed" = "standard";
    try {
      const st = await GetSettings();
      level = st.behavior?.confirm_level === "relaxed" ? "relaxed" : "standard";
    } catch { /* 读取失败按 standard 兜底（fail-closed） */ }
    if (level === "relaxed") return true;
    return new Promise<boolean>((resolve) => setL1({ ...opts, resolve }));
  }, []);

  const confirmNameMatch = useCallback((name: string) => new Promise<boolean>((resolve) => setNm({ name, input: "", resolve })), []);

  const api = useMemo(() => ({ confirmL1, confirmNameMatch }), [confirmL1, confirmNameMatch]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <AlertDialog open={!!l1} onOpenChange={(o) => { if (!o) { l1?.resolve(false); setL1(null); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(l1?.titleKey ?? "", l1?.data)}</AlertDialogTitle>
            {l1?.bodyKey ? <AlertDialogDescription>{t(l1.bodyKey, l1.data)}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { l1?.resolve(false); setL1(null); }}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { l1?.resolve(true); setL1(null); }}>{t(l1?.confirmKey ?? "common.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={!!nm} onOpenChange={(o) => { if (!o) { nm?.resolve(false); setNm(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("common.nameMatchTitle", { name: nm?.name ?? "" })}</DialogTitle></DialogHeader>
          <Input value={nm?.input ?? ""} onChange={(e) => setNm((p) => (p ? { ...p, input: e.target.value } : p))} placeholder={nm?.name} aria-label="name-match-input" />
          <DialogFooter>
            <Button variant="outline" onClick={() => { nm?.resolve(false); setNm(null); }}>{t("common.cancel")}</Button>
            <Button variant="destructive" disabled={(nm?.input ?? "") !== (nm?.name ?? "\u0000")}
              onClick={() => { if (nm && nm.input === nm.name) { nm.resolve(true); setNm(null); } }}>
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useConfirm requires ConfirmProvider");
  return v;
}
