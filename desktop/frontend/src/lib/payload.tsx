import { useMemo, useState } from "react";
import { useTranslation } from "@/app/i18n";
import { bytesToHex, fromBase64, fromBase64Bytes } from "@/lib/base64";
import { Button } from "@/components/ui/button";

export interface PayloadViewProps {
  /** Standard-base64 payload (the wire form of every []byte crossing IPC). */
  b64: string;
  /** Whether the payload decodes to valid UTF-8 text (Go-side detection). */
  isUtf8: boolean;
  /** File name for the Blob download of the raw bytes. */
  downloadName: string;
  /** Render at most this many hex characters for binary payloads (a "…"
   * suffix marks the cut); 0/undefined = full hex. */
  hexLimit?: number;
  /** Offer the hex/text switch for binary payloads (session detail); the
   * stream browser renders hex-only and just offers the download. */
  toggle?: boolean;
  /** data-testid for the payload <pre>. The download button gets
   * `${testId}-download` and an aria-label. */
  testId?: string;
}

/**
 * Shared payload renderer (spec §6.4 / §6.6, AC-029): UTF-8 payloads render
 * in a monospace <pre> (pretty-printed when the text parses as JSON); binary
 * payloads render as lowercase hex (optionally capped for preview) with a
 * Blob download of the RAW bytes — never the base64 form. Extracted from the
 * M2 SessionView detail dialog so the stream message browser shares one
 * implementation of the mono-font/hex patterns.
 */
export function PayloadView({
  b64,
  isUtf8,
  downloadName,
  hexLimit = 0,
  toggle = false,
  testId = "payload-view",
}: PayloadViewProps) {
  const { t } = useTranslation();
  const [hexView, setHexView] = useState(true);

  // UTF-8 → decoded text (JSON pretty-printed when parseable); binary →
  // full lowercase hex. The two never mix: exactly one is computed.
  const text = useMemo(() => {
    if (!isUtf8) return null;
    const raw = fromBase64(b64);
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }, [b64, isUtf8]);
  const hexFull = useMemo(() => (text === null ? bytesToHex(fromBase64Bytes(b64)) : ""), [b64, text]);

  /** Binary export: raw bytes as a Blob download (never the base64 form). */
  const download = () => {
    const bytes = fromBase64Bytes(b64);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (text !== null) {
    return (
      <pre
        data-testid={testId}
        className="max-h-64 overflow-auto rounded-md border border-border bg-panel p-2 font-mono text-xs break-all whitespace-pre-wrap"
      >
        {text}
      </pre>
    );
  }

  const hex =
    hexLimit > 0 && hexFull.length > hexLimit
      ? `${hexFull.slice(0, hexLimit)}…`
      : hexFull;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {toggle ? (
          <>
            <Button
              size="sm"
              variant={hexView ? "default" : "outline"}
              aria-pressed={hexView}
              onClick={() => setHexView(true)}
            >
              {t("messages.sessions.hexView")}
            </Button>
            <Button
              size="sm"
              variant={hexView ? "outline" : "default"}
              aria-pressed={!hexView}
              onClick={() => setHexView(false)}
            >
              {t("messages.sessions.textView")}
            </Button>
          </>
        ) : (
          <span className="text-xs text-[var(--fg-muted)]">
            {t("messages.sessions.binaryTag")}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          className={toggle ? "ml-auto" : ""}
          aria-label={t("messages.sessions.download")}
          data-testid={`${testId}-download`}
          onClick={download}
        >
          {t("messages.sessions.download")}
        </Button>
      </div>
      <pre
        data-testid={testId}
        className="max-h-64 overflow-auto rounded-md border border-border bg-panel p-2 font-mono text-xs break-all whitespace-pre-wrap"
      >
        {hexView || !toggle ? hex : fromBase64(b64)}
      </pre>
    </div>
  );
}
