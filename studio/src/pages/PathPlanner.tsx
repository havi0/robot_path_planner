import clsx from "clsx";
import { Brain, Check, Map as MapIcon, Play, Route } from "lucide-react";
import { useState } from "react";
import { SimCanvas, type PathOverlay } from "../components/sim/SimCanvas";
import { Button } from "../components/ui/button";
import { Field, NumberInput, Segmented } from "../components/ui/controls";
import { Badge, EmptyState, Tag } from "../components/ui/feedback";
import { useAction } from "../components/ui/overlay";
import { Panel } from "../components/ui/panel";
import { api } from "../lib/api";
import { fmt, int, pct } from "../lib/format";
import { useLive } from "../lib/live";
import type { CompareResponse } from "../lib/types";

// Learned = violet / orange family; classical planners = aqua. Dash pattern is the second cue.
const STYLE: Record<string, { color: string; dash?: number[]; css?: string; label: string; learned: boolean }> = {
  dqn_recovery: { color: "#9085e9", label: "DQN + recovery", learned: true },
  dqn: { color: "#9085e9", dash: [7, 5], css: "6 4", label: "DQN", learned: true },
  qlearning: { color: "#d95926", label: "Q-learning", learned: true },
  astar: { color: "#199e70", label: "A*", learned: false },
  dijkstra: { color: "#199e70", dash: [2, 5], css: "2 4", label: "Dijkstra", learned: false },
};

export function PathPlanner() {
  const run = useAction();
  const online = useLive((s) => s.connection === "online");
  const sim = useLive((s) => s.sim);
  const models = useLive((s) => s.models);
  const [algos, setAlgos] = useState<string[]>(["dqn_recovery", "astar", "dijkstra"]);
  const [source, setSource] = useState<"current" | "random">("current");
  const [seed, setSeed] = useState<number | null>(1000123);
  const [density, setDensity] = useState<number | null>(0.15);
  const [trials, setTrials] = useState<number | null>(20);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);

  const available = (k: string) => (k.startsWith("dqn") ? !!models?.dqn : k === "qlearning" ? !!models?.qlearning : true);
  const valid = algos.length > 0 && trials !== null && trials >= 0 && trials <= 200 && (source === "current" || (seed !== null && density !== null && density >= 0 && density <= 0.35));

  const go = async () => {
    setBusy(true);
    const r = await run(() => api.planner.compare(algos, source, trials ?? 0, seed ?? undefined, density ?? undefined));
    setBusy(false);
    if (r) { setResult(r); setHidden([]); }
  };

  const overlays: PathOverlay[] = (result?.results ?? [])
    .filter((r) => !hidden.includes(r.key))
    .map((r) => ({ points: r.trajectory, color: STYLE[r.key].color, dash: STYLE[r.key].dash, width: 2.2, label: r.name }));
  const best = result?.results.filter((r) => r.success).sort((a, b) => a.path_length - b.path_length)[0];

  return (
    <div className="grid h-full min-h-[680px] gap-4 p-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <div className="space-y-4">
        <Panel title="Comparison setup" eyebrow="Same map, same start & goal" dense>
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 text-[11.5px] font-medium text-ink-2">Algorithms</div>
              <div className="space-y-1.5">
                {Object.entries(STYLE).map(([k, s]) => {
                  const on = algos.includes(k), ok = available(k);
                  return (
                    <button key={k} disabled={!ok} onClick={() => setAlgos((a) => (on ? a.filter((x) => x !== k) : [...a, k]))}
                      className={clsx("flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-[12.5px] transition-colors disabled:opacity-35",
                        on ? "border-line-strong bg-surface-3 text-ink" : "border-line text-ink-3 hover:text-ink-2")}>
                      <span className={clsx("flex h-4 w-4 items-center justify-center rounded border", on ? "border-violet bg-violet text-white" : "border-line-strong")}>{on && <Check className="h-3 w-3" />}</span>
                      <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke={s.color} strokeWidth="2.2" strokeDasharray={s.css} /></svg>
                      <span className="flex-1">{s.label}</span>
                      {s.learned ? <Tag>sensors</Tag> : <Tag>full map</Tag>}
                    </button>
                  );
                })}
              </div>
            </div>
            <Field label="Map">
              <Segmented value={source} onChange={setSource} options={[{ value: "current", label: "Current simulation" }, { value: "random", label: "Unseen map" }]} />
            </Field>
            {source === "random" ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Map seed"><NumberInput value={seed} min={0} integer onChange={(v) => setSeed(v)} /></Field>
                <Field label="Density" error={density === null || density < 0 || density > 0.35 ? "0 – 0.35" : null}><NumberInput value={density} min={0} max={0.35} onChange={(v) => setDensity(v)} /></Field>
              </div>
            ) : (
              <div className="mono text-[11px] text-ink-3">{sim ? `seed ${sim.config.seed} · ${sim.world.rects.length} obstacles · includes your edits` : "—"}</div>
            )}
            <Field label="Repeated trials" hint="Also run every algorithm on N unseen test maps for success rates (0 = single map only)" error={trials === null || trials < 0 || trials > 200 ? "0 – 200" : null}>
              <NumberInput value={trials} min={0} max={200} integer onChange={(v) => setTrials(v)} />
            </Field>
            <Button variant="primary" className="w-full" disabled={!online || !valid} loading={busy} onClick={go} icon={<Play className="h-3.5 w-3.5" />}>
              {busy ? "Running on backend…" : "Run comparison"}
            </Button>
          </div>
        </Panel>
        <Panel title="Reading the results" dense>
          <div className="space-y-2.5 text-[12px] leading-relaxed text-ink-3">
            <p><Brain className="mr-1 inline h-3.5 w-3.5 text-[#9085e9]" /><b className="text-ink-2">Learned policies</b> only see 24 range readings and the goal direction. They have never seen this map.</p>
            <p><MapIcon className="mr-1 inline h-3.5 w-3.5 text-[#199e70]" /><b className="text-ink-2">A* and Dijkstra</b> are given the complete obstacle map and the true pose before moving. They are an upper reference, not a like-for-like competitor.</p>
            <p>All paths are executed by the same simulated robot with the same four actions.</p>
          </div>
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <section className="panel relative min-h-[420px] flex-1 overflow-hidden">
          {result ? (
            <>
              <SimCanvas world={result.map} overlays={overlays} options={{ grid: true }} showControls
                annotation={`${result.source === "current" ? "CURRENT MAP" : "UNSEEN MAP"} · SEED ${result.map_seed}`} />
              <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-[#0b0c0f]/85 p-1.5 backdrop-blur">
                {result.results.map((r) => (
                  <button key={r.key} onClick={() => setHidden((h) => (h.includes(r.key) ? h.filter((x) => x !== r.key) : [...h, r.key]))}
                    className={clsx("inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px]", hidden.includes(r.key) ? "text-ink-3 line-through opacity-50" : "text-ink-2 hover:bg-surface-3")}>
                    <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke={STYLE[r.key].color} strokeWidth="2.2" strokeDasharray={STYLE[r.key].css} /></svg>
                    {r.name} <span className={r.success ? "text-good" : r.outcome === "collision" ? "text-bad" : "text-warn"}>· {r.outcome}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <EmptyState icon={<Route className="h-4 w-4" />} title="No comparison yet">Choose algorithms and run them on the same map. Paths, timings and success rates come from real executions on the backend.</EmptyState>
          )}
        </section>

        {result && (
          <Panel title="Results" eyebrow={best ? `Shortest successful path on this map: ${best.name} (${fmt(best.path_length)} m)` : "No algorithm reached the goal on this map"} bodyClassName="!p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="eyebrow border-b border-line text-left">
                    <th className="px-4 py-2 font-normal">Algorithm</th>
                    <th className="px-2 py-2 font-normal">Knowledge</th>
                    <th className="px-2 py-2 font-normal">This map</th>
                    <th className="px-2 py-2 text-right font-normal">Path (m)</th>
                    <th className="px-2 py-2 text-right font-normal">÷ shortest</th>
                    <th className="px-2 py-2 text-right font-normal">Actions</th>
                    <th className="px-2 py-2 text-right font-normal">Collisions</th>
                    <th className="px-2 py-2 text-right font-normal">Planning</th>
                    <th className="px-2 py-2 text-right font-normal">Inference / step</th>
                    {result.trials && <th className="px-4 py-2 text-right font-normal">Success over {result.trials._info?.trials} maps</th>}
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((r) => {
                    const t = result.trials?.[r.key];
                    return (
                      <tr key={r.key} className="border-b border-line/60">
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-2 text-ink">
                            <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke={STYLE[r.key].color} strokeWidth="2.2" strokeDasharray={STYLE[r.key].css} /></svg>
                            {r.name}
                          </span>
                        </td>
                        <td className="px-2 py-2.5"><Tag>{r.uses_known_map ? "full map" : "sensors only"}</Tag></td>
                        <td className="px-2 py-2.5"><Badge tone={r.success ? "good" : r.outcome === "collision" ? "bad" : "warn"}>{r.outcome}</Badge></td>
                        <td className="mono px-2 py-2.5 text-right">{fmt(r.path_length)}</td>
                        <td className="mono px-2 py-2.5 text-right">{r.path_ratio !== null ? `${fmt(r.path_ratio)}×` : "—"}</td>
                        <td className="mono px-2 py-2.5 text-right">{int(r.actions)}</td>
                        <td className="mono px-2 py-2.5 text-right">{r.collisions}</td>
                        <td className="mono px-2 py-2.5 text-right">{r.uses_known_map ? `${fmt(r.planning_ms, 1)} ms` : "—"}</td>
                        <td className="mono px-2 py-2.5 text-right">{r.uses_known_map ? "—" : `${fmt(r.inference_ms_per_step, 3)} ms`}</td>
                        {result.trials && (
                          <td className="mono px-4 py-2.5 text-right">{t ? <>{pct(t.success_rate)} <span className="text-ink-3">[{pct(t.success_ci_low)}–{pct(t.success_ci_high)}]</span></> : "—"}</td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2.5 text-[11px] text-ink-3">
              Shortest = A* path to the goal circle on the known map. Planning time is a one-off cost before moving; inference time is per decision.
              {result.trials?._info && ` Trials: unseen test maps ${result.trials._info.seeds[0]}–${result.trials._info.seeds[1]}, density ${result.trials._info.density}. Brackets: 95% Wilson interval.`}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
