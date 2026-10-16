import clsx from "clsx";
import { Download, FlaskConical, Gauge, Pause, Play, Save, Square, Target, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { research } from "../lib/research-api";
import { LineChartCard, type Series } from "../components/charts/LineChartCard";
import { Collapsible } from "../components/ui/collapsible";
import { SimCanvas } from "../components/sim/SimCanvas";
import { Button } from "../components/ui/button";
import { Field, NumberInput, Segmented, Select, Switch, TextInput } from "../components/ui/controls";
import { Badge, EmptyState, Tag } from "../components/ui/feedback";
import { ConfirmDialog, Dialog, useAction } from "../components/ui/overlay";
import { Panel } from "../components/ui/panel";
import { api, type TrainRequest } from "../lib/api";
import { duration, fmt, int, pct, smooth } from "../lib/format";
import { useLive } from "../lib/live";
import { updatePrefs, usePrefs } from "../lib/prefs";
import type { EpisodeMetric, Experiment, TrainingPreview, TrainingSummary } from "../lib/types";

const S1 = "#9085e9", S2 = "#d95926", S3 = "#199e70";

type Form = Required<Omit<TrainRequest, "alpha" | "curriculum">> & { alpha: number };
interface Cur { enabled: boolean; types: string[]; threshold: number; window: number; min_episodes: number }

function defaults(prefs: ReturnType<typeof usePrefs>): Form {
  return {
    name: `DQN run ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}`,
    algorithm: "dqn", episodes: prefs.training.episodes, lr: prefs.training.lr, gamma: prefs.training.gamma,
    eps_start: 1.0, eps_end: 0.05, eps_decay: 100000, buffer_size: 200000, batch_size: prefs.training.batch,
    target_update: 2000, seed: 0, density_min: 0.05, density_max: 0.25, randomization: true, eval_every: 10000, alpha: 0.1,
  };
}

const LIMITS: Partial<Record<keyof Form, [number, number, boolean?]>> = {
  episodes: [1, 200000, true], lr: [1e-6, 0.1], gamma: [0.5, 0.9999], eps_start: [0, 1], eps_end: [0, 1],
  eps_decay: [1, 10000000, true], buffer_size: [1000, 2000000, true], batch_size: [8, 1024, true],
  target_update: [10, 1000000, true], seed: [0, 2147483647, true], density_min: [0, 0.35], density_max: [0, 0.35],
  eval_every: [1000, 1000000, true], alpha: [0.0001, 1],
};

export function TrainingLab() {
  const prefs = usePrefs();
  const beginner = prefs.uiMode === "beginner";
  const training = useLive((s) => s.training);
  const episodes = useLive((s) => s.episodes);
  const online = useLive((s) => s.connection === "online");
  const run = useAction();
  const [form, setForm] = useState<Form>(() => defaults(prefs));
  const [params] = useSearchParams();
  const preCur = params.get("curriculum");
  const [cur, setCur] = useState<Cur>({ enabled: !!preCur, types: preCur ? preCur.split(",").filter(Boolean) : ["open", "dense_field", "narrow_passage", "u_trap", "dead_end"], threshold: 0.6, window: 50, min_episodes: 100 });
  const [scTypes, setScTypes] = useState<string[]>([]);
  useEffect(() => { research.scenarios.types().then((t) => setScTypes(Object.keys(t))).catch(() => {}); }, []);
  const [bad, setBad] = useState<Record<string, boolean>>({});
  const [confirmStop, setConfirmStop] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [exp, setExp] = useState<Experiment | null>(null);
  const status = training?.status ?? "idle";
  const active = status === "running" || status === "paused" || status === "stopping";
  const expId = training?.experiment_id ?? null;

  // refresh experiment metadata (checkpoints, evaluations) when it changes or an evaluation finishes
  const evaluating = training?.evaluating ?? null;
  const prevEval = useRef<string | null>(null);
  useEffect(() => {
    if (!expId) return;
    if (prevEval.current && !evaluating) api.experiments.get(expId).then(setExp).catch(() => {});
    prevEval.current = evaluating;
  }, [evaluating, expId]);
  useEffect(() => {
    if (expId) api.experiments.get(expId).then(setExp).catch(() => setExp(null));
  }, [expId, status]);

  const num = (k: keyof Form, integer = false) => ({
    value: form[k] as number,
    min: LIMITS[k]?.[0], max: LIMITS[k]?.[1], integer: integer || LIMITS[k]?.[2],
    disabled: active,
    onChange: (v: number | null, ok: boolean) => { setForm({ ...form, [k]: v ?? 0 }); setBad({ ...bad, [k]: !ok }); },
  });
  const err = (k: keyof Form) => (bad[k] ? `${LIMITS[k]?.[0]} – ${LIMITS[k]?.[1]}${LIMITS[k]?.[2] ? ", integer" : ""}` : null);
  const curErr = cur.enabled && form.algorithm !== "dqn" ? "Curriculum mode needs DQN" : cur.enabled && !cur.types.length ? "Pick at least one scenario type"
    : cur.enabled && (cur.threshold <= 0 || cur.threshold > 1 || cur.window < 5 || cur.min_episodes < cur.window) ? "Curriculum: 0 < threshold ≤ 1, window ≥ 5, min episodes ≥ window" : null;
  const crossErr = form.eps_end > form.eps_start ? "ε end must not exceed ε start" : form.density_min > form.density_max ? "density min must not exceed max" : !form.name.trim() ? "Name the experiment" : curErr;
  const canStart = online && !active && !Object.values(bad).some(Boolean) && !crossErr;

  const start = async () => {
    const req: TrainRequest = { ...form, name: form.name.trim(), curriculum: cur.enabled ? cur : undefined };
    if (form.algorithm === "qlearning") {
      delete req.lr; delete req.buffer_size; delete req.batch_size; delete req.target_update; delete req.eval_every;
    } else delete req.alpha;
    updatePrefs((p) => ({ ...p, training: { episodes: form.episodes, lr: form.lr, gamma: form.gamma, batch: form.batch_size } }));
    await run(() => api.training.start(req), "Training started");
  };

  return (
    <div className="space-y-4 p-4">
      <StatusStrip training={training} exp={exp} onStop={() => setConfirmStop(true)} onLoad={() => setLoadOpen(true)} />
      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        {/* -------- configuration -------- */}
        <Panel title="Experiment configuration" eyebrow="Hyperparameters" dense className="self-start">
          <div className="space-y-3">
            <Field label="Experiment name"><TextInput value={form.name} disabled={active} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Algorithm">
              <Segmented value={form.algorithm} onChange={(v) => setForm({ ...form, algorithm: v, name: form.name.replace(/^(DQN|Q-learning)/, v === "dqn" ? "DQN" : "Q-learning"), eps_decay: v === "dqn" ? 100000 : 4000 })}
                options={[{ value: "dqn", label: "Deep Q-Network", disabled: active }, { value: "qlearning", label: "Tabular Q-learning", disabled: active }]} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Episodes" hint="Training stops after this many episodes" error={err("episodes")}><NumberInput {...num("episodes", true)} /></Field>
              <Field label="Random seed" hint="Same seed + config = reproducible run" error={err("seed")}><NumberInput {...num("seed", true)} /></Field>
            </div>
            <AdvancedSection beginner={beginner} forceOpen={Object.values(bad).some(Boolean) || !!crossErr}>
            <div className="grid grid-cols-2 gap-3">
              {form.algorithm === "dqn" ? (
                <Field label="Learning rate" hint="Adam step size" error={err("lr")}><NumberInput {...num("lr")} /></Field>
              ) : (
                <Field label="Learning rate α" hint="Tabular update step" error={err("alpha")}><NumberInput {...num("alpha")} /></Field>
              )}
              <Field label="Discount γ" hint="How much future reward counts" error={err("gamma")}><NumberInput {...num("gamma")} /></Field>
              <Field label="ε start" hint="Initial exploration probability" error={err("eps_start")}><NumberInput {...num("eps_start")} /></Field>
              <Field label="ε end" hint="Final exploration probability" error={err("eps_end")}><NumberInput {...num("eps_end")} /></Field>
              <Field label={form.algorithm === "dqn" ? "ε decay (steps)" : "ε decay (episodes)"} hint="Linear decay length" error={err("eps_decay")}><NumberInput {...num("eps_decay", true)} /></Field>
              {form.algorithm === "dqn" && <>
                <Field label="Replay buffer" hint="Transitions kept for experience replay" error={err("buffer_size")}><NumberInput {...num("buffer_size", true)} /></Field>
                <Field label="Batch size" error={err("batch_size")}><NumberInput {...num("batch_size", true)} /></Field>
                <Field label="Target update" hint="Gradient updates between target-network syncs" error={err("target_update")}><NumberInput {...num("target_update", true)} /></Field>
                <Field label="Validate every" hint="Environment steps between validation runs (30 unseen maps)" error={err("eval_every")}><NumberInput {...num("eval_every", true)} /></Field>
              </>}
            </div>
            <div className="rounded-lg border border-line bg-surface-2 p-3">
              <div className="eyebrow mb-2">Training maps</div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Density min" error={err("density_min")}><NumberInput {...num("density_min")} /></Field>
                <Field label="Density max" error={err("density_max")}><NumberInput {...num("density_max")} /></Field>
              </div>
              <div className="mt-3">
                <Switch checked={form.randomization} disabled={active} onChange={(v) => setForm({ ...form, randomization: v })} label="Domain randomisation"
                  description="New random map, wheel error, sensor & motion noise each episode" />
              </div>
            </div>
            <div className="rounded-lg border border-line bg-surface-2 p-3">
              <Switch checked={cur.enabled} disabled={active} onChange={(v) => setCur({ ...cur, enabled: v })} label="Curriculum mode (DQN)"
                description="Scenario difficulty rises only when the measured criterion is met" />
              {cur.enabled && (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {scTypes.map((t) => (
                      <button key={t} disabled={active} onClick={() => setCur({ ...cur, types: cur.types.includes(t) ? cur.types.filter((x) => x !== t) : [...cur.types, t] })}
                        className={`rounded-md border px-2 py-0.5 text-[11px] ${cur.types.includes(t) ? "border-[#8b7cf655] bg-violet-soft text-[#c4bcff]" : "border-line text-ink-3"}`}>{t.replace(/_/g, " ")}</button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Field label="Promote at" hint="Success rate over the window"><NumberInput value={cur.threshold} min={0.05} max={1} disabled={active} onChange={(v) => v !== null && setCur({ ...cur, threshold: v })} /></Field>
                    <Field label="Window"><NumberInput value={cur.window} min={5} max={1000} integer disabled={active} onChange={(v) => v !== null && setCur({ ...cur, window: v })} /></Field>
                    <Field label="Min episodes" hint="Per level, before promotion"><NumberInput value={cur.min_episodes} min={5} max={100000} integer disabled={active} onChange={(v) => v !== null && setCur({ ...cur, min_episodes: v })} /></Field>
                  </div>
                  <div className="text-[11px] text-ink-3">Levels are bands of geometric difficulty (0-20, 20-32, 32-45, 45+). Training scenarios use seeds &lt; 1,000,000 only.</div>
                </div>
              )}
            </div>
            </AdvancedSection>
            {crossErr && <div className="text-[11.5px] text-bad">{crossErr}</div>}
            <div className="flex gap-2">
              <Button variant="ghost" size="md" disabled={active} onClick={() => { setForm(defaults(prefs)); setBad({}); }}>Defaults</Button>
              <Button variant="primary" size="md" className="flex-1" disabled={!canStart} onClick={start} icon={<Play className="h-3.5 w-3.5" />}>
                {active ? "Training in progress" : "Start training"}
              </Button>
            </div>
          </div>
        </Panel>

        {/* -------- live charts -------- */}
        <div className="min-w-0 space-y-4">
          {training?.curriculum && <CurriculumStatus c={training.curriculum} />}
          <ChartsArea episodes={episodes} algorithm={training?.algorithm ?? form.algorithm} preview={training?.preview ?? null} active={status === "running"} exp={exp} />
        </div>
      </div>

      <ConfirmDialog open={confirmStop} onClose={() => setConfirmStop(false)} title="Stop training?" confirmLabel="Stop training" danger
        onConfirm={() => run(() => api.training.action("stop"), "Stopping - final checkpoint will be saved")}>
        The run ends after the current step. A final checkpoint (<span className="mono">last.pt</span>) is saved and all existing
        checkpoints and metrics are kept.
      </ConfirmDialog>
      <LoadDialog open={loadOpen} onClose={() => setLoadOpen(false)} />
    </div>
  );
}

function StatusStrip({ training: t, exp, onStop, onLoad }: { training: TrainingSummary | null; exp: Experiment | null; onStop: () => void; onLoad: () => void }) {
  const run = useAction();
  const online = useLive((s) => s.connection === "online");
  const status = t?.status ?? "idle";
  const tone = status === "running" ? "violet" : status === "paused" ? "warn" : status === "failed" ? "bad" : status === "completed" ? "good" : "muted";
  const progress = t && t.target_episodes ? t.episode / t.target_episodes : 0;
  const lastTest = exp?.evaluations.filter((e) => e.kind === "test").slice(-1)[0];
  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Badge tone={tone} pulse={status === "running"}>{status}</Badge>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold">{exp?.name ?? (t?.experiment_id ? t.experiment_id : "No training run yet")}</div>
            <div className="mono truncate text-[11px] text-ink-3">{t?.experiment_id ?? "configure an experiment and press Start"}{t?.algorithm && ` · ${t.algorithm.toUpperCase()}`}</div>
          </div>
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-x-5 gap-y-1">
          {[
            ["Episode", t ? `${int(t.episode)} / ${int(t.target_episodes)}` : "—"],
            ["Steps", int(t?.total_steps)],
            ["Elapsed", duration(t?.elapsed)],
            ["Exploration", fmt(t?.epsilon, 3)],
            ["Throughput", t?.throughput ? `${int(t.throughput)}/s` : "—"],
            ["Loss", fmt(t?.loss, 4)],
          ].map(([k, v]) => (
            <div key={k}>
              <div className="eyebrow">{k}</div>
              <div className="mono text-[13px] text-ink">{v}</div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {status === "running" && <Button size="sm" onClick={() => run(() => api.training.action("pause"))} icon={<Pause className="h-3.5 w-3.5" />}>Pause</Button>}
          {status === "paused" && <Button size="sm" variant="primary" onClick={() => run(() => api.training.action("resume"))} icon={<Play className="h-3.5 w-3.5" />}>Resume</Button>}
          <Button size="sm" disabled={!online || !(status === "running" || status === "paused")} onClick={() => run(() => api.training.action("checkpoint"), "Checkpoint requested")} icon={<Save className="h-3.5 w-3.5" />}>Checkpoint</Button>
          <Button size="sm" variant="outline" disabled={!(status === "running" || status === "paused")} onClick={onStop} icon={<Square className="h-3.5 w-3.5" />}>Stop</Button>
          <Button size="sm" variant="outline" disabled={!online || !t?.experiment_id || !!t?.evaluating || !exp?.checkpoints.length} loading={!!t?.evaluating}
            onClick={() => t?.experiment_id && run(() => api.training.evaluate(t.experiment_id!), "Evaluation started")} icon={<Target className="h-3.5 w-3.5" />}>Evaluate</Button>
          <Button size="sm" variant="outline" disabled={!online} onClick={onLoad} icon={<Upload className="h-3.5 w-3.5" />}>Load checkpoint</Button>
        </div>
      </div>
      <div className="h-[3px] bg-surface-3">
        <div className={clsx("h-full transition-[width] duration-500", status === "paused" ? "bg-warn" : "bg-violet")} style={{ width: `${Math.min(100, progress * 100)}%` }} />
      </div>
      {lastTest?.results && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-line px-4 py-2 text-[12px]">
          <span className="eyebrow self-center">Last evaluation · {lastTest.episodes} unseen maps · {lastTest.checkpoint}</span>
          {Object.entries(lastTest.results).map(([name, r]) => (
            <span key={name} className="text-ink-2">{name}: <span className="mono text-ink">{pct(r.success_rate)}</span> success · <span className="mono text-ink">{pct(r.collision_rate)}</span> collision</span>
          ))}
        </div>
      )}
    </section>
  );
}

function ChartsArea({ episodes, algorithm, preview, active, exp }: { episodes: EpisodeMetric[]; algorithm: string; preview: TrainingPreview | null; active: boolean; exp: Experiment | null }) {
  const prefs = usePrefs();
  const { window: win, smoothing, showRaw } = prefs.charts;
  const rows = useMemo(() => {
    const src = win > 0 ? episodes.slice(-win) : episodes;
    const rewards = src.map((e) => e.reward);
    const avg = smooth(rewards, smoothing);
    const succ = smooth(src.map((e) => (e.outcome === "success" ? 1 : 0)), smoothing);
    const coll = smooth(src.map((e) => (e.outcome === "collision" ? 1 : 0)), smoothing);
    const len = smooth(src.map((e) => e.length), smoothing);
    let lastLoss = 0;
    const lossFilled = src.map((e) => (e.loss === null ? lastLoss : (lastLoss = e.loss)));
    const lossAvg = smooth(lossFilled, smoothing);
    return src.map((e, i) => ({
      x: e.episode, reward: e.reward, avg: avg[i], succ: succ[i], coll: coll[i], len: len[i], lenRaw: e.length,
      eps: e.epsilon, loss: e.loss === null ? null : lossAvg[i], tp: e.throughput,
    }));
  }, [episodes, win, smoothing]);
  const valid = (exp?.evaluations ?? []).filter((e) => e.kind === "validation").map((e) => ({ x: e.total_steps ?? 0, succ: e.success_rate ?? null, coll: e.collision_rate ?? null }));
  const raw = (s: Series): Series[] => (showRaw ? [{ ...s, key: s.key === "avg" ? "reward" : "lenRaw", label: "Raw", opacity: 0.28, width: 1 }] : []);

  const controls = (
    <div className="flex items-center gap-2">
      <Select value={String(win)} onChange={(v) => updatePrefs((p) => ({ ...p, charts: { ...p.charts, window: Number(v) } }))}
        options={[{ value: "200", label: "Last 200" }, { value: "500", label: "Last 500" }, { value: "2000", label: "Last 2,000" }, { value: "0", label: "All episodes" }]} />
      <Select value={String(smoothing)} onChange={(v) => updatePrefs((p) => ({ ...p, charts: { ...p.charts, smoothing: Number(v) } }))}
        options={[{ value: "1", label: "No smoothing" }, { value: "20", label: "Avg 20" }, { value: "50", label: "Avg 50" }, { value: "100", label: "Avg 100" }]} />
      <Switch checked={showRaw} onChange={(v) => updatePrefs((p) => ({ ...p, charts: { ...p.charts, showRaw: v } }))} label={<span className="text-[11.5px] text-ink-2">Raw</span>} />
    </div>
  );

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <LineChartCard title="Episode reward" eyebrow={`Raw vs. moving average (${smoothing})`} data={rows} actions={controls} height={210}
          series={[...raw({ key: "avg", label: "", color: S1 }), { key: "avg", label: `Moving avg (${smoothing})`, color: S1 }]} xLabel="episode" yFormat={(v) => v.toFixed(0)}
          empty="Start a training run - every point is a real episode from the environment."
          description="Total reward collected in each episode (unitless). Reaching the goal adds +10, a collision costs −40, and every step costs a little. It is noisy and need not rise steadily — judge learning by success rate too." />
        <Panel title="Live training episode" eyebrow={preview ? `Episode ${preview.episode} · reward ${fmt(preview.reward, 1)}` : "Preview"} dense bodyClassName="!p-0">
          <div className="h-[244px]">
            {preview ? (
              <SimCanvas world={preview.world} robot={preview.robot} trail={preview.trail} compact active={active} options={{ grid: true, trail: true, sensors: false }} />
            ) : (
              <EmptyState icon={<Gauge className="h-4 w-4" />} title="No active episode">The robot currently being trained appears here.</EmptyState>
            )}
          </div>
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <LineChartCard title="Success & collision rate" eyebrow={`Training episodes, rolling ${smoothing}`} data={rows} yDomain={[0, 1]} yFormat={(v) => `${Math.round(v * 100)}%`}
          series={[{ key: "succ", label: "Success", color: S1 }, { key: "coll", label: "Collision", color: S2, dash: "5 3" }]} xLabel="episode"
          description="Share of recent training episodes that reached the goal or crashed. Includes random exploration, so it understates the final policy." />
        <LineChartCard title="Episode length" eyebrow="Actions per episode" data={rows}
          series={[...raw({ key: "len", label: "", color: S3 }), { key: "len", label: `Moving avg (${smoothing})`, color: S3 }]} xLabel="episode" yFormat={(v) => v.toFixed(0)}
          description="Decisions per episode (each lasts 0.25 s). Short can mean quick success or an early crash; the maximum means a timeout." />
        <LineChartCard title="Exploration rate ε" data={rows} series={[{ key: "eps", label: "ε", color: S1 }]} xLabel="episode" yDomain={[0, 1]} yFormat={(v) => v.toFixed(2)}
          description="Probability of a random action instead of the learned one. Follows a fixed schedule from ε start down to ε end." />
        <LineChartCard title="TD loss" eyebrow={`Huber loss, moving average ${smoothing}`} data={algorithm === "dqn" ? rows.filter((r) => r.loss !== null) : []} series={[{ key: "loss", label: "Loss", color: S2 }]} xLabel="episode"
          yFormat={(v) => v.toFixed(3)} empty={algorithm === "dqn" ? "Loss appears once learning starts (after 5,000 warm-up steps)." : "Tabular Q-learning has no network loss."}
          description="How far the network's value predictions are from their learning targets. It does not have to fall to zero; spikes or steady growth suggest instability." />
        <LineChartCard title="Training throughput" eyebrow="Environment steps per second" data={rows.filter((r) => r.tp !== null)} series={[{ key: "tp", label: "Steps/s", color: S3 }]} xLabel="episode" yFormat={(v) => v.toFixed(0)}
          empty="Throughput is measured during live runs (not stored for imported runs)."
          description="Simulation steps processed per second of real time — a property of this computer, not of policy quality." />
        <LineChartCard title="Validation on unseen maps" eyebrow="Greedy policy, 30 validation maps" data={valid} xLabel="steps" yDomain={[0, 1]} yFormat={(v) => `${Math.round(v * 100)}%`}
          series={[{ key: "succ", label: "Success", color: S1 }, { key: "coll", label: "Collision", color: S2, dash: "5 3" }]}
          empty="Validation runs periodically during DQN training."
          description="Greedy policy (no exploration) on 30 maps never used for training. The best-scoring checkpoint here is the one that is kept." />
      </div>
    </>
  );
}

function CurriculumStatus({ c }: { c: import("../lib/research-types").CurriculumState }) {
  return (
    <Panel title="Curriculum" eyebrow={c.criterion} dense>
      <div className="flex items-center gap-1.5">
        {Array.from({ length: c.n_levels }).map((_, i) => (
          <div key={i} className={`h-2 flex-1 rounded-full ${i < c.level ? "bg-good" : i === c.level ? "bg-violet" : "bg-surface-3"}`} title={`level ${i + 1}: difficulty ${c.edges[i]}-${c.edges[i + 1]}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 text-[12px] text-ink-2">
        <span>Level <b className="mono text-ink">{c.level + 1}/{c.n_levels}</b> (difficulty {c.band[0]}-{c.band[1]})</span>
        <span>Episodes at level <b className="mono text-ink">{c.episodes_at_level}</b></span>
        <span>Rolling success <b className="mono text-ink">{pct(c.rolling_success)}</b> / target {pct(c.threshold)}</span>
      </div>
      {c.history.length > 0 && <div className="mt-2 space-y-0.5 text-[11.5px] text-ink-3">{c.history.map((h, i) => <div key={i}>Episode {h.episode}: level {h.from + 1} → {h.to + 1} at {pct(h.success)} success</div>)}</div>}
    </Panel>
  );
}

function LoadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const run = useAction();
  const [list, setList] = useState<Experiment[] | null>(null);
  useEffect(() => {
    if (open) api.experiments.list().then(setList).catch(() => setList([]));
  }, [open]);
  const models = useLive((s) => s.models);
  return (
    <Dialog open={open} onClose={onClose} title="Load a checkpoint into the simulator" width={560}>
      <p className="mb-3 text-[12.5px]">The loaded policy drives the robot on the Live Simulation page and in Path Planner comparisons.</p>
      <div className="mb-3 grid grid-cols-2 gap-2 text-[11.5px]">
        <div className="rounded-lg border border-line bg-surface-2 p-2"><div className="eyebrow">Active DQN</div><div className="truncate text-ink-2">{models?.dqn?.label ?? "none"}</div></div>
        <div className="rounded-lg border border-line bg-surface-2 p-2"><div className="eyebrow">Active Q-learning</div><div className="truncate text-ink-2">{models?.qlearning?.label ?? "none"}</div></div>
      </div>
      <div className="max-h-[360px] space-y-2 overflow-y-auto">
        {list === null ? <div className="text-ink-3">Loading…</div> : list.filter((e) => e.checkpoints.length).length === 0 ? (
          <EmptyState icon={<FlaskConical className="h-4 w-4" />} title="No checkpoints yet">Train an experiment first.</EmptyState>
        ) : list.filter((e) => e.checkpoints.length).map((e) => (
          <div key={e.id} className="rounded-lg border border-line p-3">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-ink">{e.name}</div>
                <div className="mono text-[10.5px] text-ink-3">{e.algorithm.toUpperCase()} · {int(e.episodes)} episodes · {e.status}</div>
              </div>
              <Link to="/experiments" onClick={onClose} className="text-[11.5px] text-ink-3 hover:text-ink">details</Link>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {e.checkpoints.map((c) => (
                <Button key={c.name} size="sm" variant="secondary" icon={<Download className="h-3 w-3" />}
                  onClick={async () => { const r = await run(() => api.training.load(e.id, c.name), `Loaded ${c.name}`); if (r) onClose(); }}>
                  {c.name}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3"><Tag>Checkpoints are never deleted by stopping a run</Tag></div>
    </Dialog>
  );
}

/** Beginner mode: tuning parameters collapsed (still mounted, values kept). Advanced: shown inline as before. */
function AdvancedSection({ beginner, forceOpen, children }: { beginner: boolean; forceOpen: boolean; children: React.ReactNode }) {
  if (!beginner) return <>{children}</>;
  return (
    <Collapsible title="Advanced settings" description="Learning rate, exploration, replay, training maps, curriculum — defaults work well" forceOpen={forceOpen}>
      <div className="space-y-3">{children}</div>
    </Collapsible>
  );
}
