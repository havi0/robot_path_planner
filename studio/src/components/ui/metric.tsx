import clsx from "clsx";
import type { ReactNode } from "react";
import { Skeleton } from "./feedback";

/** Compact metric panel. `value` null => explicit empty state, never a fake number. */
export function Metric({ label, value, unit, sub, icon, loading, trend, accent, empty }: {
  label: string;
  value: ReactNode | null;
  unit?: string;
  sub?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  trend?: { delta: number; goodWhenUp: boolean; label: string } | null;
  accent?: boolean;
  /** Shown instead of "—" when value is null: what to do to get this number. */
  empty?: ReactNode;
}) {
  const trendGood = trend ? (trend.delta >= 0) === trend.goodWhenUp : false;
  return (
    <div className={clsx("panel relative overflow-hidden px-4 py-3.5", accent && "border-[#8b7cf640]")}>
      {accent && <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet/70 to-transparent" />}
      <div className="flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        {icon && <span className="text-ink-3">{icon}</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        {loading ? (
          <Skeleton className="h-7 w-20" />
        ) : (value === null || value === undefined) && empty ? (
          <span className="text-[13px] font-medium leading-[32px] text-ink-3">No data yet</span>
        ) : value === null || value === undefined ? (
          <span className="mono text-[22px] font-medium text-ink-3">—</span>
        ) : (
          <>
            <span className="mono text-[24px] font-medium tracking-tight text-ink">{value}</span>
            {unit && <span className="mono text-[12px] text-ink-3">{unit}</span>}
          </>
        )}
      </div>
      <div className="mt-1 flex min-h-[16px] items-center gap-2 text-[11.5px] text-ink-3">
        {trend && (
          <span className={clsx("mono", trendGood ? "text-good" : "text-bad")}>
            {trend.delta >= 0 ? "▲" : "▼"} {trend.label}
          </span>
        )}
        {(value === null || value === undefined) && empty && !loading ? empty : sub}
      </div>
    </div>
  );
}
