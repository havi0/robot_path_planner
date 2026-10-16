import clsx from "clsx";
import { AlertTriangle, Boxes, GitCompare, Target, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CiRows } from "../components/research/shared";
import { Button } from "../components/ui/button";
import { Field, Select } from "../components/ui/controls";
import { Badge, EmptyState, Skeleton, Tag } from "../components/ui/feedback";
import { Dialog, useAction } from "../components/ui/overlay";
import { KeyValue, Panel } from "../components/ui/panel";
import { dateTime, duration, fmt, int, pct } from "../lib/format";
import { useLive } from "../lib/live";
import { research } from "../lib/research-api";
import type { ModelComparison, RegisteredModel } from "../lib/research-types";

export function ModelRegistry() {
  const [params, setParams] = useSearchParams();
  const run = useAction();
  const jobs = useLive((s) => s.jobs.length);
  const [models, setModels] = useState<RegisteredModel[] | null>(null);
  const [cmp, setCmp] = useState<ModelComparison | null>(null);
  const [cmpWith, setCmpWith] = useState("");
  const [benchOpen, setBenchOpen] = useState(false);
  const [benchPolicy, setBenchPolicy] = useState("dqn_recovery");
  const [benchRepeats, setBenchRepeats] = useState("2");
  const sel = params.get("id");

  useEffect(() => { research.models.list().then((l) => { setModels(l); if (!sel && l.length) setParams({ id: l[0].model_id }, { replace: true }); }).catch(() => setModels([])); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);
  const m = models?.find((x) => x.model_id === sel) ?? null;
  const bench = (x: RegisteredModel) => x.benchmarks.filter((b) => b.set_id === "benchmark-v1").slice(-1)[0];

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Panel title="Model registry" eyebrow={models ? `${models.length} versions · content-addressed ids` : "Loading"} bodyClassName="!p-0">
        {models === null ? <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div> : models.length === 0 ? (
          <EmptyState icon={<Boxes className="h-4 w-4" />} title="No models registered">Every checkpoint saved by training is registered automatically.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="eyebrow border-b border-line text-left">
                <th className="px-4 py-2 font-normal">Model</th><th className="px-2 py-2 font-normal">Algo</th><th className="px-2 py-2 font-normal">Env</th>
                <th className="px-2 py-2 text-right font-normal">Seed</th><th className="px-2 py-2 text-right font-normal">Benchmark success</th><th className="px-4 py-2 text-right font-normal">Created</th></tr></thead>
              <tbody>
                {models.map((x) => {
                  const b = bench(x);
                  return (
                    <tr key={x.model_id} onClick={() => { setParams({ id: x.model_id }); setCmp(null); }} className={clsx("cursor-pointer border-b border-line/60", sel === x.model_id ? "bg-surface-3" : "hover:bg-surface-2")}>
                      <td className="max-w-[260px] px-4 py-2.5"><div className="flex items-center gap-1.5 truncate text-ink">{x.label}{x.active && <Badge tone="violet">active</Badge>}</div>
                        <div className="mono text-[10.5px] text-ink-3">{x.model_id}{x.compatibility_issues.length > 0 && <span className="ml-1 text-bad">· incompatible</span>}</div></td>
                      <td className="px-2"><Tag>{x.algorithm === "dqn" ? "DQN" : "Q-L"}</Tag></td>
                      <td className="mono px-2 text-[10.5px] text-ink-3">{x.env_version}</td>
                      <td className="mono px-2 text-right text-ink-2">{x.seed}</td>
                      <td className="mono px-2 text-right">{b ? <>{pct(b.summary.success.rate)} <span className="text-[10.5px] text-ink-3">[{pct(b.summary.success.ci_low)}–{pct(b.summary.success.ci_high)}]</span></> : <span className="text-ink-3">not run</span>}</td>
                      <td className="mono whitespace-nowrap px-4 text-right text-[11px] text-ink-3">{dateTime(x.created)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {m && (
        <div className="min-w-0 space-y-4">
          <section className="panel p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><div className="truncate text-[16px] font-semibold">{m.label}</div><div className="mono text-[11px] text-ink-3">{m.model_id} · {m.checkpoint_name}</div></div>
              {m.active && <Badge tone="violet">loaded in simulator</Badge>}
            </div>
            {m.compatibility_issues.length > 0 && (
              <div className="mt-3 rounded-lg border border-[#f0524f44] bg-[#f0524f10] p-2.5 text-[12px] text-[#ffb3b1]"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Incompatible with this simulator - loading is refused: {m.compatibility_issues.join("; ")}</div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-x-6 md:grid-cols-3">
              <KeyValue label="Algorithm" value={m.algorithm.toUpperCase()} />
              <KeyValue label="Seed" value={m.seed} />
              <KeyValue label="Env version" value={m.env_version} />
              <KeyValue label="Training episodes" value={int(m.training.episodes)} />
              <KeyValue label="Training steps" value={int(m.training.total_steps)} />
              <KeyValue label="Training duration" value={duration(m.training.duration_s)} />
              <KeyValue label="Best validation" value={pct(m.training.best_validation_success)} />
              <KeyValue label="Created" value={dateTime(m.created)} />
              <KeyValue label="Experiment" value={m.experiment_id ? <Link className="text-[#b3a9ff]" to="/experiments">{m.experiment_id.slice(0, 18)}…</Link> : "—"} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={m.compatibility_issues.length > 0 || m.checkpoint_exists === false} onClick={() => run(() => research.models.load(m.model_id), "Model loaded into the simulator")} icon={<Upload className="h-3.5 w-3.5" />}>Restore into simulator</Button>
              <Button size="sm" variant="secondary" onClick={() => { setBenchPolicy(m.algorithm === "dqn" ? "dqn_recovery" : "qlearning"); setBenchOpen(true); }} icon={<Target className="h-3.5 w-3.5" />}>Evaluate on shared benchmark</Button>
              <div className="ml-auto flex items-center gap-1.5">
                <div className="w-52"><Select value={cmpWith} onChange={setCmpWith} options={[{ value: "", label: "Compare with…" }, ...(models ?? []).filter((x) => x.model_id !== m.model_id).map((x) => ({ value: x.model_id, label: x.label }))]} /></div>
                <Button size="sm" variant="outline" disabled={!cmpWith} onClick={async () => { const r = await run(() => research.models.compare(m.model_id, cmpWith)); if (r) setCmp(r); }} icon={<GitCompare className="h-3.5 w-3.5" />}>Compare</Button>
              </div>
            </div>
          </section>

          {cmp && (
            <Panel title="Version comparison" eyebrow={`${cmp.a.model_id} vs ${cmp.b.model_id}`} dense actions={<Badge tone={cmp.compatible_with_each_other ? "good" : "warn"}>{cmp.compatible_with_each_other ? "same interface" : "different interface"}</Badge>}>
              {cmp.benchmark ? (
                <div className="mb-3">
                  <CiRows rows={[{ name: cmp.a.label, ci: cmp.benchmark.a }, { name: cmp.b.label, ci: cmp.benchmark.b }]} label="benchmark success" />
                  <div className="mt-2 text-[12px] text-ink-2">Two-proportion test: <b>{cmp.benchmark.verdict}</b>{!cmp.benchmark.comparable && <span className="text-warn"> · benchmark conditions differ</span>}</div>
                </div>
              ) : <div className="mb-3 text-[12px] text-ink-3">Benchmark both models on the shared benchmark to compare their performance.</div>}
              <div className="eyebrow mb-1">{cmp.differences.length} configuration differences</div>
              <div className="max-h-56 overflow-y-auto">
                {cmp.differences.map((d) => (
                  <div key={d.key} className="flex justify-between gap-3 border-t border-line/60 py-1 text-[11.5px]">
                    <span className="mono truncate text-ink-3">{d.key}</span><span className="mono shrink-0 text-ink-2">{JSON.stringify(d.a)} → {JSON.stringify(d.b)}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel title="Evaluation history" eyebrow="Benchmarks on evaluation scenario sets" dense>
            {m.benchmarks.length === 0 ? <div className="text-[12px] text-ink-3">Not evaluated yet.</div> : (
              <CiRows rows={m.benchmarks.slice().reverse().map((b) => ({ name: <span title={b.run_id}>{b.set_name} · {b.policy}</span>, ci: b.summary.success }))} label="success" />
            )}
          </Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Architecture" dense><pre className="mono overflow-auto text-[11px] text-ink-2">{JSON.stringify(m.architecture, null, 2)}</pre></Panel>
            <Panel title="Observation / action interface" dense><pre className="mono max-h-56 overflow-auto text-[11px] text-ink-2">{JSON.stringify(m.interface, null, 2)}</pre></Panel>
          </div>
          <Panel title="Training configuration" dense><pre className="mono max-h-64 overflow-auto text-[11px] text-ink-2">{JSON.stringify(m.training_config, null, 2)}</pre></Panel>
          <div className="mono text-[10.5px] text-ink-3">checkpoint: {m.checkpoint} {m.checkpoint_exists === false && <span className="text-bad">(missing)</span>}</div>
        </div>
      )}

      <Dialog open={benchOpen} onClose={() => setBenchOpen(false)} title="Evaluate on the shared benchmark" footer={<>
        <Button variant="ghost" onClick={() => setBenchOpen(false)}>Cancel</Button>
        <Button variant="primary" onClick={async () => { if (!m) return; const r = await run(() => research.models.benchmark(m.model_id, benchPolicy, Number(benchRepeats)), "Benchmark queued"); if (r) setBenchOpen(false); }}>Run in background</Button></>}>
        <p className="mb-3">Runs the greedy policy on the 45 fixed evaluation scenarios (9 types × 5, seeds never used in training) with sensor noise 0.02 and motion noise 0.05. Every episode is recorded with this model id.</p>
        <div className="grid grid-cols-2 gap-3">
          {m?.algorithm === "dqn" && <Field label="Policy"><Select value={benchPolicy} onChange={setBenchPolicy} options={[{ value: "dqn_recovery", label: "DQN + recovery" }, { value: "dqn", label: "DQN" }]} /></Field>}
          <Field label="Repeats per scenario"><Select value={benchRepeats} onChange={setBenchRepeats} options={["1", "2", "3", "5"].map((v) => ({ value: v, label: `${v} (${45 * Number(v)} episodes)` }))} /></Field>
        </div>
        <div className="mt-2 text-[11.5px] text-ink-3">Estimated {fmt((45 * Number(benchRepeats) * 0.15) / 60, 1)}–{fmt((45 * Number(benchRepeats) * 0.4) / 60, 1)} min.</div>
      </Dialog>
    </div>
  );
}
