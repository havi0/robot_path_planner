import clsx from "clsx";
import { Flame, MousePointerSquareDashed, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CiRows, OUTCOME_COLOR, OutcomeBadge, toWorldState } from "../components/research/shared";
import { SimCanvas, type Heatmap, type PathOverlay, type Tool } from "../components/sim/SimCanvas";
import { Button } from "../components/ui/button";
import { Segmented, Select } from "../components/ui/controls";
import { EmptyState, Skeleton, Tag } from "../components/ui/feedback";
import { ConfirmDialog, useAction } from "../components/ui/overlay";
import { Panel } from "../components/ui/panel";
import { dateTime, humanize, pct } from "../lib/format";
import { useLive } from "../lib/live";
import { research } from "../lib/research-api";
import type { BenchmarkRun, RegionResult, RiskMap, RiskSummary } from "../lib/research-types";

const LAYERS = {
  failure_ratio: { label: "Failure ratio", rgb: [240, 82, 79] as [number, number, number] },
  visits: { label: "Visits", rgb: [144, 133, 233] as [number, number, number] },
  collisions: { label: "Collisions", rgb: [240, 82, 79] as [number, number, number] },
  stuck: { label: "Stuck (stagnation)", rgb: [227, 179, 65] as [number, number, number] },
};

export function RiskExplorer() {
  const run = useAction();
  const jobs = useLive((s) => s.jobs.length);
  const [runs, setRuns] = useState<BenchmarkRun[] | null>(null);
  const [runId, setRunId] = useState("");
  const [summary, setSummary] = useState<RiskSummary | null>(null);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [map, setMap] = useState<RiskMap | null>(null);
  const [layer, setLayer] = useState<keyof typeof LAYERS>("failure_ratio");
  const [tool, setTool] = useState<Tool>("pan");
  const [selection, setSelection] = useState<number[] | null>(null);
  const [region, setRegion] = useState<RegionResult | null>(null);
  const [del, setDel] = useState(false);
  const [showTraj, setShowTraj] = useState(true);

  useEffect(() => {
    research.runs.list().then((l) => { setRuns(l); if (!runId && l.length) setRunId(l[0].id); }).catch(() => setRuns([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);
  useEffect(() => {
    if (!runId) return;
    setSummary(null); setScenarioId(null); setMap(null);
    research.risk.summary({ run_id: runId }).then(setSummary).catch(() => setSummary({ episodes: 0 }));
  }, [runId]);
  useEffect(() => {
    if (!scenarioId) return;
    setRegion(null); setSelection(null);
    research.risk.map({ scenario_id: scenarioId, run_id: runId }).then(setMap).catch(() => setMap(null));
  }, [scenarioId, runId]);

  const heatmap: Heatmap | null = useMemo(() => {
    if (!map) return null;
    const values = map.layers[layer];
    const flat = values.flat().filter((v): v is number => v !== null);
    return { cell: map.cell, values, max: layer === "failure_ratio" ? 1 : Math.max(1, ...flat), rgb: LAYERS[layer].rgb };
  }, [map, layer]);
  const overlays: PathOverlay[] = showTraj && map ? map.trajectories.map((t) => ({ points: t.points, color: OUTCOME_COLOR[t.outcome], width: 1.4,
    dash: t.outcome === "success" ? undefined : t.outcome === "collision" ? [5, 3] : [2, 3] })) : [];
  const selectedRun = runs?.find((r) => r.id === runId);

  return (
    <div className="space-y-4 p-4">
      <section className="panel flex flex-wrap items-center gap-3 px-4 py-3">
        <Flame className="h-4 w-4 text-warn" />
        <div className="w-[360px] max-w-full">
          <Select value={runId} onChange={setRunId} options={(runs ?? []).map((r) => ({ value: r.id, label: `${r.label} · ${dateTime(r.created)} (${r.status})` }))} />
        </div>
        {selectedRun && <span className="text-[12px] text-ink-3">set <b className="text-ink-2">{selectedRun.set_name}</b> · {selectedRun.repeats} repeats · noise {String(selectedRun.conditions.sensor_noise)}/{String(selectedRun.conditions.motion_noise)} · shield {selectedRun.conditions.shield ? "on" : "off"}</span>}
        {selectedRun && <Button size="sm" variant="ghost" className="ml-auto text-bad" onClick={() => setDel(true)} icon={<Trash2 className="h-3.5 w-3.5" />}>Delete run</Button>}
      </section>

      {runs !== null && runs.length === 0 && (
        <div className="panel"><EmptyState icon={<Flame className="h-4 w-4" />} title="No benchmark runs recorded"
          action={<Link to="/models"><Button variant="primary">Open Model Registry</Button></Link>}>
          The Risk Explorer is built only from recorded simulation runs. Benchmark a model on the shared benchmark or an evaluation set first.
        </EmptyState></div>
      )}

      {summary && summary.episodes > 0 && (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <Panel title="Success by scenario type" eyebrow={`${summary.episodes} recorded episodes · 95% Wilson intervals`} dense>
              <CiRows rows={Object.entries(summary.by_type ?? {}).map(([t, v]) => ({ name: humanize(t), ci: v.success }))} color="#9085e9" label="success" />
              <div className="mt-4"><CiRows rows={Object.entries(summary.by_type ?? {}).map(([t, v]) => ({ name: humanize(t), ci: v.collision }))} color="#d95926" label="collision" /></div>
              <div className="mt-1 text-[10.5px] text-ink-3">Top: success rate (violet). Bottom: collision rate (orange).</div>
            </Panel>
            <div className="space-y-4">
              <Panel title="Minimum obstacle clearance" eyebrow={`per episode · n=${summary.clearance_hist?.n ?? 0}`} dense>
                <div className="h-[150px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={(summary.clearance_hist?.counts ?? []).map((c, i) => ({ bin: `${summary.clearance_hist!.edges[i]}–${summary.clearance_hist!.edges[i + 1]}`, count: c }))} margin={{ left: -18, right: 6, top: 6 }}>
                      <CartesianGrid stroke="#1d2129" vertical={false} />
                      <XAxis dataKey="bin" tick={{ fill: "#6c7380", fontSize: 9.5, fontFamily: "JetBrains Mono" }} stroke="#2c313b" interval={0} angle={-25} textAnchor="end" height={40} />
                      <YAxis tick={{ fill: "#6c7380", fontSize: 10 }} stroke="#2c313b" allowDecimals={false} />
                      <Tooltip cursor={{ fill: "#ffffff08" }} contentStyle={{ background: "#14171d", border: "1px solid #2f3440", fontSize: 12 }} />
                      <Bar dataKey="count" name="episodes" fill="#9085e9" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="text-[10.5px] text-ink-3">metres between robot surface and the nearest obstacle (negative = contact)</div>
              </Panel>
              <Panel title="Behaviour frequency" dense>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(summary.behaviors ?? {}).sort((a, b) => b[1] - a[1]).map(([b, c]) => (
                    <Link key={b} to={`/episodes?behavior=${b}`}><Tag className="hover:border-line-strong hover:text-ink">{humanize(b)} · {c}</Tag></Link>
                  ))}
                  {!Object.keys(summary.behaviors ?? {}).length && <span className="text-[12px] text-ink-3">No behaviour labels detected.</span>}
                </div>
              </Panel>
            </div>
          </div>
          <div className="text-[11.5px] text-ink-3">{summary.note}</div>

          <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
            <Panel title="Scenarios by failure rate" eyebrow="Select to inspect" bodyClassName="!p-0">
              <div className="max-h-[560px] divide-y divide-line overflow-y-auto">
                {(summary.scenarios ?? []).map((s) => (
                  <button key={s.scenario_id} onClick={() => setScenarioId(s.scenario_id)} className={clsx("flex w-full items-center gap-3 px-3 py-2 text-left", scenarioId === s.scenario_id ? "bg-surface-3" : "hover:bg-surface-2")}>
                    <div className="min-w-0 flex-1"><div className="truncate text-[12.5px] text-ink">{s.name}</div><div className="mono text-[10.5px] text-ink-3">{s.type} · {s.episodes} episodes</div></div>
                    <div className="mono text-right text-[11px]"><div className="text-ink">{pct(s.failure.rate)} fail</div><div className="text-ink-3">[{pct(s.failure.ci_low)}–{pct(s.failure.ci_high)}]</div></div>
                  </button>
                ))}
              </div>
            </Panel>
            <section className="panel flex min-h-[560px] flex-col overflow-hidden">
              {!scenarioId ? <EmptyState icon={<Flame className="h-4 w-4" />} title="Select a scenario">Inspect where episodes on that map collided, stalled or took failing routes.</EmptyState> : !map ? <Skeleton className="m-4 h-[500px]" /> : (
                <>
                  <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                    <Segmented size="sm" value={layer} onChange={setLayer} options={Object.entries(LAYERS).map(([k, v]) => ({ value: k as keyof typeof LAYERS, label: v.label }))} />
                    <Button size="sm" variant={tool === "select" ? "primary" : "outline"} onClick={() => setTool(tool === "select" ? "pan" : "select")} icon={<MousePointerSquareDashed className="h-3.5 w-3.5" />}>Select region</Button>
                    <Button size="sm" variant="ghost" active={showTraj} onClick={() => setShowTraj(!showTraj)}>Trajectories</Button>
                    <span className="ml-auto text-[11px] text-ink-3">{map.episodes} episodes · cell {map.cell} m</span>
                  </div>
                  <div className="relative min-h-[420px] flex-1">
                    <SimCanvas world={toWorldState(map.scenario.world)} heatmap={heatmap} overlays={overlays} selection={selection} tool={tool} showControls options={{ grid: true }}
                      onTool={async (_k, d) => { setSelection(d); setTool("pan"); const r = await run(() => research.risk.region({ scenario_id: map.scenario.id, rect: d, run_id: runId })); if (r) setRegion(r); }}
                      annotation={`${map.scenario.name.toUpperCase()} · ${LAYERS[layer].label.toUpperCase()}`} />
                    <div className="pointer-events-none absolute bottom-3 left-3 flex gap-3 rounded-lg border border-line bg-[#0b0c0f]/85 px-3 py-1.5 text-[10.5px] text-ink-3">
                      {(["success", "collision", "timeout"] as const).map((o) => <span key={o} className="inline-flex items-center gap-1.5"><span className="h-0 w-4 border-t-2" style={{ borderColor: OUTCOME_COLOR[o], borderStyle: o === "success" ? "solid" : "dashed" }} />{o}</span>)}
                      <span>{layer === "failure_ratio" ? `shaded cells: share of passing episodes that failed (cells with ≥ ${map.min_visits} visits)` : `shaded by ${LAYERS[layer].label.toLowerCase()} count`}</span>
                    </div>
                  </div>
                  <div className="grid gap-0 border-t border-line lg:grid-cols-2">
                    <div className="border-line p-3 lg:border-r">
                      <div className="eyebrow mb-2">Route clusters (1 m cell sequence)</div>
                      <div className="space-y-1.5">
                        {map.routes.slice(0, 6).map((r, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 text-[11.5px]">
                            <span className="text-ink-2">Route {i + 1} · {r.failure.n} episodes</span>
                            <span className="mono text-ink">{pct(r.failure.rate)} fail <span className="text-ink-3">[{pct(r.failure.ci_low)}–{pct(r.failure.ci_high)}]</span></span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="p-3">
                      <div className="eyebrow mb-2">Selected region</div>
                      {!region ? <div className="text-[11.5px] text-ink-3">Use “Select region” and drag on the map to list the episodes that passed through it.</div> : (
                        <>
                          <div className="text-[12px] text-ink-2">{region.passing} episodes passed · {pct(region.failure.rate)} failed overall [{pct(region.failure.ci_low)}–{pct(region.failure.ci_high)}] · {region.failed_inside} ended inside</div>
                          <div className="mt-2 max-h-[150px] space-y-1 overflow-y-auto">
                            {region.episodes.map((e) => (
                              <Link key={e.id} to={`/episodes?id=${e.id}`} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-[11.5px] hover:bg-surface-2">
                                <span className="truncate text-ink-2">{e.policy_name} · step {e.first_step_in_region}{e.failed_in_region ? " · failed here" : ""}</span>
                                <OutcomeBadge outcome={e.outcome} />
                              </Link>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
            </section>
          </div>
        </>
      )}
      {summary && summary.episodes === 0 && runId && <div className="panel"><EmptyState title="This run has no recorded episodes yet" /></div>}
      <ConfirmDialog open={del} onClose={() => setDel(false)} title="Delete benchmark run?" danger confirmLabel="Delete run and its episodes"
        onConfirm={async () => { await run(() => research.runs.remove(runId), "Run deleted"); setRunId(""); setSummary(null); research.runs.list().then(setRuns); }}>
        This removes the run and every episode it recorded. Model registry entries keep their summary.
      </ConfirmDialog>
    </div>
  );
}
