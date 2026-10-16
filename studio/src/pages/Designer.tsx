import clsx from "clsx";
import { Plus, TestTubes, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Field, NumberInput, Segmented, Select, TextInput } from "../components/ui/controls";
import { Badge, EmptyState, Tag } from "../components/ui/feedback";
import { ConfirmDialog, useAction } from "../components/ui/overlay";
import { Panel } from "../components/ui/panel";
import { dateTime, fmt } from "../lib/format";
import { useLive } from "../lib/live";
import { research } from "../lib/research-api";
import type { Design, DesignPlan, RegisteredModel, ScenarioSet } from "../lib/research-types";

const PARAMS = ["lr", "gamma", "eps_decay", "batch_size", "target_update", "progress_scale", "step_penalty", "turn_reversal_penalty", "stop_penalty", "collision_penalty", "density_max"];
const METRICS = [{ value: "success_rate", label: "Success rate" }, { value: "collision_rate", label: "Collision rate" }, { value: "path_ratio", label: "Path ratio" }, { value: "reward", label: "Episode reward" }];

export function Designer() {
  const [params] = useSearchParams();
  const run = useAction();
  const jobs = useLive((s) => s.jobs);
  const [question, setQuestion] = useState("");
  const [dtype, setDtype] = useState<"train" | "evaluate">("train");
  const [rows, setRows] = useState<{ name: string; values: string }[]>([{ name: "lr", values: "0.0005, 0.0001" }]);
  const [models, setModels] = useState<RegisteredModel[]>([]);
  const [picked, setPicked] = useState<{ policy: string; model_id?: string }[]>([]);
  const [mode, setMode] = useState("one_factor");
  const [seeds, setSeeds] = useState<number | null>(3);
  const [episodes, setEpisodes] = useState<number | null>(300);
  const [sets, setSets] = useState<ScenarioSet[]>([]);
  const [evalSet, setEvalSet] = useState("benchmark-v1");
  const [repeats, setRepeats] = useState<number | null>(1);
  const [metric, setMetric] = useState("success_rate");
  const [budget, setBudget] = useState<number | null>(30);
  const [plan, setPlan] = useState<DesignPlan | null>(null);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [selected, setSelected] = useState<string | null>(params.get("id"));
  const [del, setDel] = useState<Design | null>(null);

  const reload = () => research.designs.list().then(setDesigns).catch(() => {});
  useEffect(() => {
    reload();
    research.models.list().then(setModels).catch(() => {});
    research.sets.list().then((l) => setSets(l.filter((s) => s.role === "evaluation"))).catch(() => {});
    const pre = params.get("prefill");
    if (pre) {
      try {
        const p = JSON.parse(pre);
        if (p.design_type === "evaluate") setDtype("evaluate");
        if (p.parameter) setRows([{ name: p.parameter, values: (p.values ?? []).join(", ") }]);
        if (p.parameter) setQuestion(`How does ${p.parameter} affect navigation outcomes?`);
      } catch { /* ignore malformed prefill */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { reload(); }, [jobs.length]);
  useEffect(() => { setPlan(null); }, [question, dtype, rows, picked, mode, seeds, episodes, evalSet, repeats, metric, budget]);

  const spec = () => ({
    question, design_type: dtype, mode, seeds, episodes_per_run: episodes, eval_set: evalSet, eval_repeats: repeats, metric, budget_minutes: budget,
    parameters: rows.map((r) => ({ name: r.name, values: r.values.split(",").map((v) => Number(v.trim())).filter((v) => !Number.isNaN(v)) })),
    models: picked,
  });

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-[420px_minmax(0,1fr)]">
      <div className="space-y-4">
        <Panel title="Design an experiment" eyebrow="Systematic, reproducible evaluation" dense>
          <div className="space-y-3">
            <Field label="Research question"><TextInput value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Does a higher learning rate improve success on unseen maps?" /></Field>
            <Field label="Design type"><Segmented value={dtype} onChange={setDtype} options={[{ value: "train", label: "Train & compare configs" }, { value: "evaluate", label: "Compare existing models" }]} /></Field>
            {dtype === "train" ? (
              <>
                <div>
                  <div className="mb-1.5 text-[11.5px] font-medium text-ink-2">Parameters to investigate</div>
                  <div className="space-y-1.5">
                    {rows.map((r, i) => (
                      <div key={i} className="flex gap-1.5">
                        <div className="w-40"><Select value={r.name} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, name: v } : x)))} options={PARAMS.map((p) => ({ value: p, label: p }))} /></div>
                        <TextInput value={r.values} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))} placeholder="values, comma separated" className="mono" />
                        <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="rounded p-1.5 text-ink-3 hover:text-bad" aria-label="Remove parameter"><X className="h-3.5 w-3.5" /></button>
                      </div>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => setRows([...rows, { name: "gamma", values: "0.95, 0.995" }])} icon={<Plus className="h-3.5 w-3.5" />}>Add parameter</Button>
                  </div>
                </div>
                <Field label="Design" hint="One-factor: each value vs. the baseline with everything else fixed. Factorial: every combination.">
                  <Segmented value={mode} onChange={setMode} options={[{ value: "one_factor", label: "One factor at a time" }, { value: "factorial", label: "Full factorial" }]} />
                </Field>
                <Field label="Training episodes per run"><NumberInput value={episodes} min={20} max={5000} integer onChange={(v) => setEpisodes(v)} /></Field>
              </>
            ) : (
              <div>
                <div className="mb-1.5 text-[11.5px] font-medium text-ink-2">Models / policies</div>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {[...models.flatMap((m) => (m.algorithm === "dqn" ? [{ policy: "dqn", model_id: m.model_id, label: `${m.label} (DQN)` }, { policy: "dqn_recovery", model_id: m.model_id, label: `${m.label} (DQN + recovery)` }]
                    : [{ policy: "qlearning", model_id: m.model_id, label: m.label }])), { policy: "astar", model_id: undefined, label: "A* (known map)" }].map((o) => {
                    const on = picked.some((p) => p.policy === o.policy && p.model_id === o.model_id);
                    return (
                      <button key={`${o.policy}-${o.model_id}`} onClick={() => setPicked(on ? picked.filter((p) => !(p.policy === o.policy && p.model_id === o.model_id)) : [...picked, { policy: o.policy, model_id: o.model_id }])}
                        className={clsx("block w-full truncate rounded-md border px-2 py-1.5 text-left text-[11.5px]", on ? "border-[#8b7cf655] bg-violet-soft text-[#c4bcff]" : "border-line text-ink-3 hover:text-ink-2")}>{o.label}</button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Random seeds" hint="Independent training/evaluation seeds per configuration (>= 3 recommended)"><NumberInput value={seeds} min={1} max={10} integer onChange={(v) => setSeeds(v)} /></Field>
              <Field label="Eval repeats / map"><NumberInput value={repeats} min={1} max={10} integer onChange={(v) => setRepeats(v)} /></Field>
              <Field label="Evaluation maps" hint="Only evaluation-role sets (never used in training)">
                <Select value={evalSet} onChange={setEvalSet} options={[{ value: "benchmark-v1", label: "Shared benchmark (45)" }, ...sets.filter((s) => s.id !== "benchmark-v1").map((s) => ({ value: s.id, label: `${s.name} (${s.composition.count})` }))]} />
              </Field>
              <Field label="Primary metric"><Select value={metric} onChange={setMetric} options={METRICS} /></Field>
              <Field label="Budget (minutes)"><NumberInput value={budget} min={1} max={600} onChange={(v) => setBudget(v)} /></Field>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={async () => { const r = await run(() => research.designs.plan(spec())); if (r) setPlan(r); }}>Generate matrix</Button>
              <Button variant="primary" className="flex-1" disabled={!plan || !plan.within_budget}
                onClick={async () => { const r = await run(() => research.designs.create(spec(), question), "Design queued as a background job"); if (r) { setSelected(r.id); reload(); } }}>Run design</Button>
            </div>
          </div>
        </Panel>
        {plan && <PlanPreview plan={plan} />}
      </div>

      <div className="min-w-0 space-y-4">
        <Panel title="Designs" eyebrow={`${designs.length} recorded`} bodyClassName="!p-0">
          {designs.length === 0 ? <EmptyState icon={<TestTubes className="h-4 w-4" />} title="No designs yet">Generate a matrix, check the estimate, then run it in the background.</EmptyState> : (
            <div className="divide-y divide-line">
              {designs.map((d) => (
                <button key={d.id} onClick={() => setSelected(d.id)} className={clsx("flex w-full items-center gap-3 px-4 py-2.5 text-left", selected === d.id ? "bg-surface-3" : "hover:bg-surface-2")}>
                  <div className="min-w-0 flex-1"><div className="truncate text-[12.5px] text-ink">{d.name}</div><div className="mono text-[10.5px] text-ink-3">{d.plan.design_type} · {d.plan.runs} runs · {dateTime(d.created)}</div></div>
                  <Badge tone={d.status === "completed" ? "good" : d.status === "running" ? "violet" : d.status === "failed" ? "bad" : "muted"} pulse={d.status === "running"}>{d.status}</Badge>
                  {d.status !== "running" && d.status !== "queued" && <span role="button" onClick={(e) => { e.stopPropagation(); setDel(d); }} className="rounded p-1 text-ink-3 hover:text-bad"><Trash2 className="h-3.5 w-3.5" /></span>}
                </button>
              ))}
            </div>
          )}
        </Panel>
        {selected && <DesignResults id={selected} jobsKey={jobs.map((j) => j.done).join(",")} />}
      </div>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title="Delete design record?" danger confirmLabel="Delete"
        onConfirm={async () => { if (del) { await run(() => research.designs.remove(del.id), "Design deleted"); reload(); } }}>
        Trained experiments and recorded episodes created by this design are kept.
      </ConfirmDialog>
    </div>
  );
}

function PlanPreview({ plan }: { plan: DesignPlan }) {
  return (
    <Panel title="Experiment matrix" eyebrow={`${plan.cells.length} configurations × ${plan.seeds} seeds = ${plan.runs} runs`} dense
      actions={<Badge tone={plan.within_budget ? "good" : "bad"}>~{fmt(plan.estimated_minutes, 1)} min · budget {plan.budget_minutes}</Badge>}>
      <div className="space-y-1.5">
        {plan.cells.map((c) => (
          <div key={c.cell_id} className="rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-[12px]">
            <div className="flex items-center gap-2"><Tag>{c.cell_id}</Tag>{c.baseline && <Badge tone="info">baseline</Badge>}</div>
            <div className="mt-1 text-ink-2">{c.purpose}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-3">{plan.separation} Estimated cost: {plan.estimated_env_steps.toLocaleString()} environment steps.
        {!plan.within_budget && <b className="text-bad"> Over budget - reduce seeds, values or episodes.</b>}</p>
    </Panel>
  );
}

function DesignResults({ id, jobsKey }: { id: string; jobsKey: string }) {
  const [d, setD] = useState<Design | null>(null);
  useEffect(() => { research.designs.get(id).then(setD).catch(() => setD(null)); }, [id, jobsKey]);
  if (!d) return null;
  const s = d.summary;
  const lo = s ? Math.min(0, ...s.cells.map((c) => c.ci_low ?? c.mean ?? 0)) : 0;
  const hi = s ? Math.max(...s.cells.map((c) => c.ci_high ?? c.mean ?? 0), d.plan.metric.endsWith("rate") ? 1 : 0) : 1;
  const scale = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
  return (
    <Panel title={d.name} eyebrow={`${d.plan.design_type} · metric ${d.plan.metric} · ${d.results.length}/${d.plan.runs} runs`} dense>
      <div className="mb-3 text-[12.5px] text-ink-2">{d.plan.question}</div>
      {!s ? <div className="text-[12px] text-ink-3">{d.status === "completed" ? "No summary." : `Running… ${d.results.length} of ${d.plan.runs} runs finished.`}</div> : (
        <>
          <div className={clsx("mb-3 rounded-lg border p-3 text-[12.5px]", s.winner ? "border-[#3fb95055] bg-[#3fb95010] text-ink" : "border-line bg-surface-2 text-ink-2")}>{s.conclusion}</div>
          <div className="space-y-2.5">
            {s.cells.map((c) => (
              <div key={c.cell_id} className="text-[12px]">
                <div className="flex items-center justify-between gap-2"><span className="truncate text-ink-2"><Tag className="mr-1.5">{c.cell_id}</Tag>{c.purpose}</span>
                  <span className="mono shrink-0 text-ink">{fmt(c.mean, 3)} <span className="text-ink-3">{c.ci_low !== null ? `[${fmt(c.ci_low, 3)}, ${fmt(c.ci_high, 3)}]` : "(single seed: no CI)"} n={c.n}</span></span></div>
                <div className="relative mt-1 h-4 rounded bg-surface-3" role="img" aria-label={`${c.cell_id} mean ${fmt(c.mean, 3)}`}>
                  {c.ci_low !== null && c.ci_high !== null && <div className="absolute top-[7px] h-[2px] bg-[#9085e9]/60" style={{ left: `${scale(c.ci_low)}%`, width: `${Math.max(0.5, scale(c.ci_high) - scale(c.ci_low))}%` }} />}
                  {c.values.map((v, i) => <div key={i} className="absolute top-[5px] h-[6px] w-[2px] bg-ink-3" style={{ left: `${scale(v)}%` }} title={`seed value ${v}`} />)}
                  {c.mean !== null && <div className="absolute top-[3px] h-[10px] w-[10px] -translate-x-1/2 rounded-full border-2 border-[#111317] bg-[#9085e9]" style={{ left: `${scale(c.mean)}%` }} />}
                </div>
              </div>
            ))}
          </div>
          <div className="mono mt-1 flex justify-between text-[10px] text-ink-3"><span>{fmt(lo, 2)}</span><span>dot = mean, bar = 95% t-interval, ticks = individual seeds</span><span>{fmt(hi, 2)}</span></div>
          {s.comparisons.length > 0 && (
            <div className="mt-3 space-y-1">
              <div className="eyebrow">Controlled comparisons vs baseline</div>
              {s.comparisons.map((c) => <div key={c.cell_id} className="text-[12px] text-ink-2"><Tag className="mr-1.5">{c.cell_id}</Tag>{c.verdict}</div>)}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
