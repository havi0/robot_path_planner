import clsx from "clsx";
import type { ReactNode } from "react";
import { pct } from "../../lib/format";
import type { Ci, Difficulty, WorldDict } from "../../lib/research-types";
import type { WorldState } from "../../lib/types";
import { Badge, type Tone } from "../ui/feedback";

export function toWorldState(w: WorldDict, goalRadius = 0.3, robotRadius = 0.15): WorldState {
  return {
    width: w.width, height: w.height, rects: w.rects, timed: w.timed, movers: (w.movers ?? []).map((m) => [m[0], m[1]] as [number, number]),
    mover_radius: w.mover_radius, start: w.start, goal: w.goal, goal_radius: goalRadius, robot_radius: robotRadius,
  };
}

export const outcomeTone = (o: string | null | undefined): Tone => (o === "success" ? "good" : o === "collision" ? "bad" : o === "timeout" ? "warn" : "muted");
export const OUTCOME_COLOR: Record<string, string> = { success: "#3fb950", collision: "#f0524f", timeout: "#e3b341" };

export function OutcomeBadge({ outcome }: { outcome: string }) {
  return <Badge tone={outcomeTone(outcome)}>{outcome}</Badge>;
}

const BAND_TONE: Record<string, Tone> = { easy: "good", moderate: "info", hard: "warn", extreme: "bad", unsolvable: "bad" };
export function DifficultyBadge({ d }: { d: Difficulty }) {
  return <Badge tone={BAND_TONE[d.band] ?? "muted"}>{d.score === null ? "unsolvable" : `${d.score.toFixed(0)} · ${d.band}`}</Badge>;
}

/** Dot + 95% whisker per row on a 0-1 scale. Numbers are always printed (identity never by colour alone). */
export function CiRows({ rows, color = "#9085e9", label = "rate" }: { rows: { name: ReactNode; ci: Ci; sub?: ReactNode }[]; color?: string; label?: string }) {
  return (
    <div className="space-y-2">
      <div className="flex text-[10px] text-ink-3"><span className="w-36 shrink-0" /><div className="mono flex flex-1 justify-between"><span>0%</span><span>50%</span><span>100%</span></div><span className="w-36 shrink-0" /></div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3 text-[12px]">
          <div className="w-36 shrink-0 truncate text-ink-2">{r.name}</div>
          <div className="relative h-5 flex-1" role="img" aria-label={`${label} ${pct(r.ci.rate)} (95% CI ${pct(r.ci.ci_low)}-${pct(r.ci.ci_high)}, n=${r.ci.n})`}>
            <div className="absolute inset-y-2 left-0 right-0 rounded bg-surface-3" />
            <div className="absolute left-1/2 top-1 h-3 w-px bg-line-strong" />
            {r.ci.n > 0 && (
              <>
                <div className="absolute top-[9px] h-[2px] rounded" style={{ left: `${r.ci.ci_low * 100}%`, width: `${Math.max(0.5, (r.ci.ci_high - r.ci.ci_low) * 100)}%`, background: color, opacity: 0.55 }} />
                <div className="absolute top-[5px] h-[10px] w-[10px] -translate-x-1/2 rounded-full border-2 border-[#111317]" style={{ left: `${(r.ci.rate ?? 0) * 100}%`, background: color }} />
              </>
            )}
          </div>
          <div className="mono w-36 shrink-0 text-right text-[11px] text-ink-2">{pct(r.ci.rate)} <span className="text-ink-3">[{pct(r.ci.ci_low)}–{pct(r.ci.ci_high)}] n={r.ci.n}</span></div>
          {r.sub}
        </div>
      ))}
    </div>
  );
}

export function StatPill({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={clsx("rounded-lg border border-line bg-surface-2 px-3 py-2", className)}>
      <div className="eyebrow">{label}</div>
      <div className="mono mt-0.5 text-[14px] text-ink">{value}</div>
    </div>
  );
}
