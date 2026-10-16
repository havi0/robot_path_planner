import clsx from "clsx";
import { BarChart3, Check, Download, FileArchive, FileJson, FlaskConical, Pencil, RefreshCw, Search, Target, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LineChartCard } from "../components/charts/LineChartCard";
import { Button } from "../components/ui/button";
import { NumberInput, TextInput } from "../components/ui/controls";
import { Badge, EmptyState, Skeleton, Tag, type Tone } from "../components/ui/feedback";
import { ConfirmDialog, Dialog, useAction } from "../components/ui/overlay";
import { KeyValue, Panel } from "../components/ui/panel";
import { api } from "../lib/api";
import { research } from "../lib/research-api";
import { bytes, dateTime, duration, fmt, int, pct, smooth } from "../lib/format";
import { useLive } from "../lib/live";
import type { EpisodeMetric, Experiment } from "../lib/types";

const statusTone = (s: string): Tone => (s === "completed" ? "good" : s === "running" ? "violet" : s === "paused" ? "warn" : s === "failed" ? "bad" : "muted");

export function Experiments() {
  const [list, setList] = useState<Experiment[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const nav = useNavigate();
  const lastSeq = useLive((s) => s.events.filter((e) => ["training", "evaluation", "checkpoint", "experiment"].includes(e.category)).slice(-1)[0]?.seq ?? 0);
  const reload = () => api.experiments.list().then((l) => { setList(l); if (!selected && l.length) setSelected(l[0].id); }).catch(() => setList([]));
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lastSeq]);

  const exp = list?.find((e) => e.id === selected) ?? null;
  const ql = q.trim().toLowerCase();
  const shown = (list ?? []).filter((e) => !ql || e.name.toLowerCase().includes(ql) || e.id.includes(ql) || e.algorithm.includes(ql) || e.status.includes(ql));
  const bestVal = (e: Experiment) => {
    const v = e.evaluations.filter((x) => x.kind === "validation").map((x) => x.success_rate ?? 0);
    return v.length ? Math.max(...v) : null;
  };

  return (
    <div className="grid h-full min-h-[640px] gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <Panel title="Experiments" eyebrow={list ? `${list.length} recorded` : "Loading"} bodyClassName="!p-0"
        actions={<>
          <Button size="sm" variant="ghost" onClick={reload} icon={<RefreshCw className="h-3.5 w-3.5" />}>Refresh</Button>
          <Button size="sm" variant="secondary" disabled={compare.length < 1} onClick={() => nav(`/analytics?ids=${compare.join(",")}`)} icon={<BarChart3 className="h-3.5 w-3.5" />}>
            Compare{compare.length ? ` (${compare.length})` : ""}
          </Button>
        </>}>
        {list === null ? (
          <div className="space-y-2 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : list.length === 0 ? (
          <EmptyState icon={<FlaskConical className="h-4 w-4" />} title="No experiments yet"
            action={<Button variant="primary" onClick={() => nav("/training")}>Open Training Lab</Button>}>
            Every training run is recorded here with its configuration, seed, metrics and checkpoints.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <div className="relative border-b border-line p-3">
              <Search className="pointer-events-none absolute left-5 top-5 h-4 w-4 text-ink-3" />
              <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search experiment history (name, id, algorithm, status)" className="pl-8" aria-label="Search experiments" />
            </div>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="eyebrow border-b border-line text-left">
                  <th className="w-8 px-3 py-2" aria-label="Compare" />
                  <th className="px-2 py-2 font-normal">Name</th>
                  <th className="px-2 py-2 font-normal">Algo</th>
                  <th className="px-2 py-2 font-normal">Status</th>
                  <th className="px-2 py-2 text-right font-normal">Episodes</th>
                  <th className="px-2 py-2 text-right font-normal">Best val.</th>
                  <th className="px-3 py-2 text-right font-normal">Created</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id} onClick={() => setSelected(e.id)}
                    className={clsx("cursor-pointer border-b border-line/60 transition-colors", selected === e.id ? "bg-surface-3" : "hover:bg-surface-2")}>
                    <td className="px-3 py-2.5" onClick={(ev) => ev.stopPropagation()}>
                      <button aria-label="Select for comparison" disabled={!compare.includes(e.id) && compare.length >= 3}
                        onClick={() => setCompare((c) => (c.includes(e.id) ? c.filter((x) => x !== e.id) : [...c, e.id]))}
                        className={clsx("flex h-4 w-4 items-center justify-center rounded border disabled:opacity-30", compare.includes(e.id) ? "border-violet bg-violet text-white" : "border-line-strong")}>
                        {compare.includes(e.id) && <Check className="h-3 w-3" />}
                      </button>
                    </td>
                    <td className="max-w-[220px] px-2 py-2.5">
                      <div className="truncate font-medium text-ink">{e.name}</div>
                      <div className="mono truncate text-[10.5px] text-ink-3">{e.id}</div>
                    </td>
                    <td className="px-2 py-2.5"><Tag>{e.algorithm === "dqn" ? "DQN" : "Q-L"}</Tag></td>
                    <td className="px-2 py-2.5"><span className="inline-flex items-center gap-1.5 whitespace-nowrap"><Badge tone={statusTone(e.status)}>{e.status}</Badge>{e.imported && <Tag>ref</Tag>}</span></td>
                    <td className="mono px-2 py-2.5 text-right text-ink-2">{int(e.episodes)}</td>
                    <td className="mono px-2 py-2.5 text-right text-ink-2">{pct(bestVal(e))}</td>
                    <td className="mono whitespace-nowrap px-3 py-2.5 text-right text-[11px] text-ink-3">{dateTime(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 py-2 text-[11px] text-ink-3">Select up to 3 experiments to compare their curves in Analytics.</div>
          </div>
        )}
      </Panel>

      {exp ? <ExperimentDetail key={exp.id} exp={exp} onChanged={reload} onDeleted={() => { setSelected(null); reload(); }} /> : (
        <div className="panel"><EmptyState icon={<FlaskConical className="h-4 w-4" />} title="Select an experiment">Details, checkpoints and evaluations appear here.</EmptyState></div>
      )}
    </div>
  );
}

function ExperimentDetail({ exp, onChanged, onDeleted }: { exp: Experiment; onChanged: () => void; onDeleted: () => void }) {
  const run = useAction();
  const training = useLive((s) => s.training);
  const liveEpisodes = useLive((s) => s.episodes);
  const [metrics, setMetrics] = useState<EpisodeMetric[] | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [del, setDel] = useState(false);
  const [evalOpen, setEvalOpen] = useState(false);
  const [evalN, setEvalN] = useState<number | null>(50);
  const isLive = training?.experiment_id === exp.id && (training.status === "running" || training.status === "paused");

  useEffect(() => {
    if (!isLive) api.experiments.metrics(exp.id).then(setMetrics).catch(() => setMetrics([]));
  }, [exp.id, isLive, exp.episodes]);
  const data = isLive ? liveEpisodes : metrics;
  const rows = useMemo(() => {
    if (!data) return [];
    const avg = smooth(data.map((m) => m.reward), 50);
    const succ = smooth(data.map((m) => (m.outcome === "success" ? 1 : 0)), 50);
    return data.map((m, i) => ({ x: m.episode, avg: avg[i], succ: succ[i] }));
  }, [data]);

  const tests = exp.evaluations.filter((e) => e.kind === "test");
  const vals = exp.evaluations.filter((e) => e.kind === "validation");
  const hp = Object.entries(exp.hyperparameters ?? {});

  return (
    <div className="min-w-0 space-y-4 overflow-y-auto">
      <section className="panel p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[17px] font-semibold tracking-tight">{exp.name}</h2>
              {!exp.imported && <button onClick={() => setRename(exp.name)} className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Rename"><Pencil className="h-3.5 w-3.5" /></button>}
            </div>
            <div className="mono mt-0.5 text-[11px] text-ink-3">{exp.id}</div>
          </div>
          <Badge tone={statusTone(exp.status)} pulse={exp.status === "running"}>{exp.status}</Badge>
        </div>
        {exp.notes && <p className="mt-2 text-[12px] text-ink-3">{exp.notes}</p>}
        <div className="mt-4 grid grid-cols-2 gap-x-6 md:grid-cols-4">
          <KeyValue label="Algorithm" value={exp.algorithm.toUpperCase()} />
          <KeyValue label="Seed" value={exp.seed} />
          <KeyValue label="Episodes" value={int(exp.episodes)} />
          <KeyValue label="Steps" value={int(exp.total_steps)} />
          <KeyValue label="Duration" value={duration(exp.duration_s)} />
          <KeyValue label="Created" value={dateTime(exp.created_at)} />
          <KeyValue label="Finished" value={dateTime(exp.finished_at)} />
          <KeyValue label="Checkpoints" value={exp.checkpoints.length} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!exp.checkpoints.length || !!training?.evaluating} loading={training?.evaluating === exp.id}
            onClick={() => setEvalOpen(true)} icon={<Target className="h-3.5 w-3.5" />}>Evaluate</Button>
          <a href={api.experiments.exportUrl(exp.id, "csv")} download><Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />}>Metrics CSV</Button></a>
          <a href={api.experiments.exportUrl(exp.id, "json")} download><Button size="sm" variant="outline" icon={<FileJson className="h-3.5 w-3.5" />}>Export JSON</Button></a>
          <a href={research.bundleUrl(exp.id)} download><Button size="sm" variant="outline" icon={<FileArchive className="h-3.5 w-3.5" />}>Bundle (.zip)</Button></a>
          <Button size="sm" variant="ghost" className="ml-auto text-bad hover:text-bad" disabled={exp.imported || isLive} onClick={() => setDel(true)} icon={<Trash2 className="h-3.5 w-3.5" />}
            title={exp.imported ? "Reference experiments are read-only" : isLive ? "Stop the run first" : undefined}>Delete</Button>
        </div>
      </section>

      <LineChartCard title="Learning curve" eyebrow={`${data ? int(data.length) : "…"} episodes · moving average 50`} data={rows} height={190} xLabel="episode"
        series={[{ key: "avg", label: "Reward (avg 50)", color: "#9085e9" }]} yFormat={(v) => v.toFixed(0)} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Checkpoints" dense>
          {exp.checkpoints.length === 0 ? <div className="text-[12px] text-ink-3">No checkpoints saved yet.</div> : (
            <div className="space-y-1.5">
              {exp.checkpoints.map((c) => (
                <div key={c.name} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5">
                  <span className="mono flex-1 truncate text-[12px] text-ink">{c.name}</span>
                  <span className="mono text-[10.5px] text-ink-3">{bytes(c.size)}</span>
                  <Button size="sm" variant="ghost" onClick={() => run(() => api.training.load(exp.id, c.name), `Loaded ${c.name} into the simulator`)} icon={<Upload className="h-3 w-3" />}>Load</Button>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Hyperparameters" dense>
          {hp.length === 0 ? <div className="text-[12px] text-ink-3">—</div> : hp.map(([k, v]) => <KeyValue key={k} label={k} value={Array.isArray(v) ? v.join(" × ") : String(v)} />)}
        </Panel>
      </div>

      <Panel title="Evaluations" eyebrow="Test = unseen test maps · validation = periodic during training" dense>
        {tests.length === 0 && vals.length === 0 ? <div className="text-[12px] text-ink-3">No evaluations yet. Press Evaluate to test the policy on unseen maps.</div> : (
          <div className="space-y-3">
            {tests.slice().reverse().map((t, i) => (
              <div key={i} className="rounded-lg border border-line p-3">
                <div className="mb-2 flex items-center justify-between text-[11.5px]">
                  <span className="text-ink-2">Test · {t.checkpoint} · {t.episodes} unseen maps</span>
                  <span className="mono text-ink-3">{dateTime(t.time)}</span>
                </div>
                <table className="w-full text-[12px]">
                  <thead><tr className="eyebrow text-left"><th className="font-normal">Method</th><th className="text-right font-normal">Success [95% CI]</th><th className="text-right font-normal">Collision</th><th className="text-right font-normal">Timeout</th><th className="text-right font-normal">Path ratio</th></tr></thead>
                  <tbody>
                    {Object.entries(t.results ?? {}).map(([name, r]) => (
                      <tr key={name} className="border-t border-line/60">
                        <td className="py-1.5 text-ink">{name}</td>
                        <td className="mono py-1.5 text-right">{pct(r.success_rate)} <span className="text-ink-3">[{pct(r.success_ci_low)}, {pct(r.success_ci_high)}]</span></td>
                        <td className="mono py-1.5 text-right">{pct(r.collision_rate)}</td>
                        <td className="mono py-1.5 text-right">{pct(r.timeout_rate)}</td>
                        <td className="mono py-1.5 text-right">{fmt(r.mean_path_ratio_success)}×</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {vals.length > 0 && (
              <div className="mono text-[11px] text-ink-3">
                {vals.length} validation checks · best success {pct(Math.max(...vals.map((v) => v.success_rate ?? 0)))} · last {pct(vals[vals.length - 1].success_rate)}
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Environment configuration" dense>
        <pre className="mono max-h-56 overflow-auto text-[11px] leading-relaxed text-ink-2">{JSON.stringify(exp.environment, null, 2)}</pre>
      </Panel>

      <Dialog open={rename !== null} onClose={() => setRename(null)} title="Rename experiment"
        footer={<><Button variant="ghost" onClick={() => setRename(null)}>Cancel</Button>
          <Button variant="primary" disabled={!rename?.trim()} onClick={async () => { const r = await run(() => api.experiments.rename(exp.id, rename!.trim()), "Renamed"); if (r) { setRename(null); onChanged(); } }}>Save</Button></>}>
        <TextInput value={rename ?? ""} maxLength={80} onChange={(e) => setRename(e.target.value)} />
      </Dialog>
      <Dialog open={evalOpen} onClose={() => setEvalOpen(false)} title="Evaluate policy"
        footer={<><Button variant="ghost" onClick={() => setEvalOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={!evalN || evalN < 5 || evalN > 500} onClick={async () => { const r = await run(() => api.training.evaluate(exp.id, undefined, evalN!), "Evaluation started"); if (r) setEvalOpen(false); }}>Run evaluation</Button></>}>
        <p className="mb-3">Runs the greedy policy (best checkpoint) on unseen test maps in the background. DQN is also evaluated with the recovery behaviour.</p>
        <label className="block text-[11.5px] text-ink-2">Number of maps (5 – 500)</label>
        <div className="mt-1.5 w-32"><NumberInput value={evalN} min={5} max={500} integer onChange={(v) => setEvalN(v)} /></div>
      </Dialog>
      <ConfirmDialog open={del} onClose={() => setDel(false)} title="Delete experiment?" danger confirmLabel="Delete permanently"
        onConfirm={async () => { const r = await run(() => api.experiments.remove(exp.id), "Experiment deleted"); if (r) onDeleted(); }}>
        This permanently removes <b className="text-ink">{exp.name}</b>, its metrics and its {exp.checkpoints.length} checkpoint(s) from disk.
      </ConfirmDialog>
    </div>
  );
}
