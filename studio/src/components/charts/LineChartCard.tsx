import { useId, type ReactNode } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState } from "../ui/feedback";
import { Panel } from "../ui/panel";

export interface Series {
  key: string;
  label: string;
  color: string;
  width?: number;
  opacity?: number;
  dash?: string;
}

type Row = Record<string, number | null>;

const AXIS = { stroke: "#2c313b", tick: { fill: "#7f8694", fontSize: 10.5, fontFamily: "JetBrains Mono" } };

/** Evenly downsample long series for rendering (always keeps the last point). */
export function downsample<T>(rows: T[], max = 1200): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(rows[Math.floor(i * step)]);
  out.push(rows[rows.length - 1]);
  return out;
}

export function LineChartCard({ title, data, series, xKey = "x", xLabel, yFormat = (v) => String(v), yDomain, height = 200, empty, actions, eyebrow, cursor, description }: {
  title: ReactNode;
  data: Row[];
  series: Series[];
  xKey?: string;
  xLabel?: string;
  yFormat?: (v: number) => string;
  yDomain?: [number | "auto", number | "auto"];
  height?: number;
  empty?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  cursor?: number | null;
  /** One plain-language sentence: what the metric is, its unit, how to read it. */
  description?: ReactNode;
}) {
  const rows = downsample(data);
  const legend = series.length >= 2;
  // a faint gradient under the line only when exactly one primary series is drawn (never under overlapping series)
  const primary = series.filter((s) => !s.dash && (s.opacity ?? 1) === 1);
  const fill = primary.length === 1 ? primary[0] : null;
  const gid = `fill-${useId().replace(/:/g, "")}`;
  return (
    <Panel title={title} eyebrow={eyebrow} actions={actions} dense bodyClassName="!pt-2">
      {description && <p className="mb-2 text-[11.5px] leading-relaxed text-ink-3">{description}</p>}
      {legend && (
        <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-2">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <svg width="16" height="6" aria-hidden>
                <line x1="0" y1="3" x2="16" y2="3" stroke={s.color} strokeOpacity={s.opacity ?? 1} strokeWidth={2} strokeDasharray={s.dash} />
              </svg>
              {s.label}
            </span>
          ))}
        </div>
      )}
      {rows.length < 2 ? (
        <div style={{ height }}>
          <EmptyState title="No data yet">{empty ?? "Metrics appear here as soon as real episodes complete."}</EmptyState>
        </div>
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 6, right: 8, bottom: xLabel ? 14 : 0, left: -8 }}>
              {fill && (
                <defs>
                  <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={fill.color} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={fill.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
              )}
              <CartesianGrid stroke="#1b1f27" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey={xKey}
                {...AXIS}
                tickLine={false}
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(Math.round(v)))}
                label={xLabel ? { value: xLabel, position: "insideBottom", offset: -8, fill: "#6c7380", fontSize: 10.5 } : undefined}
              />
              <YAxis {...AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={yFormat} domain={yDomain ?? ["auto", "auto"]} />
              <Tooltip
                cursor={{ stroke: "#3a404c", strokeWidth: 1 }}
                isAnimationActive={false}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <div className="rounded-lg border border-white/[0.08] bg-[#14161d]/90 px-3 py-2 shadow-[0_12px_30px_-12px_#000] backdrop-blur-md">
                      <div className="mono mb-1 text-[10.5px] text-ink-3">
                        {xLabel ?? xKey} {typeof label === "number" ? Math.round(label).toLocaleString() : label}
                      </div>
                      {payload.filter((p, i, all) => all.findIndex((q) => q.dataKey === p.dataKey) === i).map((p) => {   /* the fill Area repeats its line's key */
                        const s = series.find((x) => x.key === p.dataKey);
                        return (
                          <div key={String(p.dataKey)} className="flex items-center justify-between gap-4 text-[11.5px]">
                            <span className="inline-flex items-center gap-1.5 text-ink-2">
                              <span className="h-[2px] w-3" style={{ background: s?.color, opacity: s?.opacity ?? 1 }} />
                              {s?.label}
                            </span>
                            <span className="mono text-ink">{typeof p.value === "number" ? yFormat(p.value) : "—"}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null
                }
              />
              {fill && <Area dataKey={fill.key} stroke="none" fill={`url(#${gid})`} baseValue="dataMin" isAnimationActive={false} activeDot={false} tooltipType="none" connectNulls />}
              {cursor !== undefined && cursor !== null && <ReferenceLine x={cursor} stroke="#5ec8d8" strokeDasharray="3 3" />}
              {series.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeOpacity={s.opacity ?? 1}
                  strokeWidth={s.width ?? 2}
                  strokeDasharray={s.dash}
                  dot={false}
                  activeDot={s.opacity && s.opacity < 1 ? false : { r: 4, stroke: "#111317", strokeWidth: 2 }}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}
