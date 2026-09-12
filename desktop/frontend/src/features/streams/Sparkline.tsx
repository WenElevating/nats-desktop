import { Activity } from "lucide-react";
import { useTranslation } from "../../app/i18n";

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Accessible description; also rendered as the SVG <title>. */
  ariaLabel: string;
}

const PAD = 2;

/**
 * Dependency-free rate sparkline (spec §6.6 detail panel): a single SVG
 * <polyline> normalized to the viewBox. Empty input renders a dashed
 * placeholder line plus an icon/text hint instead of an empty chart.
 */
export function Sparkline({ values, width = 160, height = 40, ariaLabel }: SparklineProps) {
  const { t } = useTranslation();
  const empty = values.length === 0;

  let points = "";
  if (!empty) {
    const max = Math.max(...values, 0);
    const span = values.length > 1 ? values.length - 1 : 1;
    points = values
      .map((v, i) => {
        const x = PAD + (i / span) * (width - 2 * PAD);
        const y =
          max > 0 ? height - PAD - (v / max) * (height - 2 * PAD) : height / 2;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }

  return (
    <div className="flex items-center gap-2" data-testid="sparkline">
      <svg
        role="img"
        aria-label={ariaLabel}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="shrink-0"
      >
        <title>{ariaLabel}</title>
        {empty ? (
          <line
            x1={PAD}
            y1={height / 2}
            x2={width - PAD}
            y2={height / 2}
            stroke="var(--border)"
            strokeWidth="1.5"
            strokeDasharray="4 3"
          />
        ) : (
          <polyline
            points={points}
            fill="none"
            stroke="var(--accent-strong)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
      </svg>
      {empty && (
        <span
          data-testid="sparkline-empty"
          className="flex items-center gap-1 text-xs text-[var(--fg-faint)]"
        >
          <Activity size={12} strokeWidth={1.75} aria-hidden="true" />
          {t("streams.detail.noRateData")}
        </span>
      )}
    </div>
  );
}
