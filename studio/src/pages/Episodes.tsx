import clsx from "clsx";
import { Bot, GitBranch, ListVideo, Pause, Play, Search, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LineChartCard } from "../components/charts/LineChartCard";
import { OUTCOME_COLOR, OutcomeBadge, toWorldState } from "../components/research/shared";
import { SimCanvas, type Marker, type PathOverlay, type Tool } from "../components/sim/SimCanvas";
import { Button } from "../components/ui/button";
import { Field, NumberInput, Segmented, Select, TextInput } from "../components/ui/controls";
import { Badge, EmptyState, Skeleton, Tag } from "../components/ui/feedback";
import { useAction } from "../components/ui/overlay";
import { KeyValue, Panel } from "../components/ui/panel";
import { dateTime, fmt, humanize, isTypingTarget } from "../lib/format";
import { research } from "../lib/research-api";
import type { CounterfactualResult, Episode, EpisodeSummary, StepInspection } from "../lib/research-types";
import { askCopilot, setUi } from "../lib/ui-store";

const ACTION_COLOR: Record<string, string> = { forward: "#9085e9", turn_left: "#5ec8d8", turn_right: "#199e70", stop: "#6c7380" };
const BEHAVIOR_FILTERS = ["success", "collision", "timeout", "repeated_turning", "oscillation", "stagnation", "excessive_detour", "approach_retreat", "idle_stop", "near_miss"];

export function Episodes() {
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState<EpisodeSummary[] | null>(null);
  const [filters, setFilters] = useState({ source: "", behavior: params.get("behavior") ?? "", policy: "", q: "" });
  const [ep, setEp] = useState<Episode | null>(null);
  const selectedId = params.get("id");

  useEffect(() => {
    const t = setTimeout(() => research.episodes.list({ ...filters, limit: 400 }).then(setList).catch(() => setList([])), 150);
    return () => clearTimeout(t);
  }, [filters]);
  useEffect(() => {
    if (!selectedId) { setEp(null); return; }
    research.episodes.get(selectedId).then((e) => { setEp(e); setUi((s) => ({ context: { ...s.context, episodeId: e.id } })); }).catch(() => setEp(null));
  }, [selectedId]);

  const select = (id: string) => setParams({ id });
  return (
    <div className="grid h-full min-h-[680px] gap-4 p-4 xl:grid-cols-[380px_minmax(0,1fr)]">
      <Panel title="Episode history" eyebrow={list ? `${list.length} shown` : "Loading"} bodyClassName="!p-0" className="min-h-0">
        <div className="space-y-2 border-b border-line p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-3" />
            <TextInput value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="Search id, scenario, model…" className="pl-8" aria-label="Search episodes" />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Select value={filters.source} onChange={(v) => setFilters({ ...filters, source: v })}
              options={[{ value: "", label: "All sources" }, { value: "benchmark", label: "Benchmark" }, { value: "live", label: "Live sim" }, { value: "counterfactual", label: "Counterfactual" }]} />
            <Select value={filters.behavior} onChange={(v) => setFilters({ ...filters, behavior: v })}
              options={[{ value: "", label: "Any behaviour" }, ...BEHAVIOR_FILTERS.map((b) => ({ value: b, label: humanize(b) }))]} />
            <Select value={filters.policy} onChange={(v) => setFilters({ ...filters, policy: v })}
              options={[{ value: "", label: "Any policy" }, ...["dqn_recovery", "dqn", "qlearning", "astar", "dijkstra"].map((p) => ({ value: p, label: p }))]} />
          </div>
        </div>
        {list === null ? <div className="space-y-2 p-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div> : list.length === 0 ? (
          <EmptyState icon={<ListVideo className="h-4 w-4" />} title="No recorded episodes">
            Episodes are recorded automatically from the Live Simulation and from benchmark runs (Model Registry / Risk Explorer).
          </EmptyState>
        ) : (
          <div className="max-h-[calc(100vh-280px)] divide-y divide-line overflow-y-auto">
            {list.map((e) => (
              <button key={e.id} onClick={() => select(e.id)} className={clsx("block w-full px-3 py-2.5 text-left transition-colors", selectedId === e.id ? "bg-surface-3" : "hover:bg-surface-2")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12.5px] text-ink">{e.policy_name} · {e.scenario_name ?? "random map"}</span>
                  <OutcomeBadge outcome={e.outcome} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Tag>{e.source}</Tag>
                  {e.label && e.label.toLowerCase() !== e.source && <Tag className={e.exact === false ? "text-warn" : "text-[#d9a3ff]"}>{e.label.toLowerCase()}</Tag>}
                  {e.behaviors.map((b) => <Tag key={b}>{humanize(b)}</Tag>)}
                  {e.uncertain.map((b) => <Tag key={b} className="text-ink-3">{humanize(b)}?</Tag>)}
                  <span className="mono ml-auto text-[10px] text-ink-3">{e.steps} steps · {dateTime(e.created)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Panel>
      {ep ? <EpisodeDetail key={ep.id} ep={ep} /> : (
        <div className="panel"><EmptyState icon={<ListVideo className="h-4 w-4" />} title="Select an episode">Replay it, inspect its behaviour classification, or branch a counterfactual.</EmptyState></div>
      )}
    </div>
  );
}

function EpisodeDetail({ ep }: { ep: Episode }) {
  const [params] = useSearchParams();
  const n = ep.steps.action.length;
  const [t, setT] = useState(() => Math.min(n, Number(params.get("step") ?? n)));
  const [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState<"replay" | "counterfactual">(params.get("cf") ? "counterfactual" : "replay");
  const [cf, setCf] = useState<CounterfactualResult | null>(null);
  const [tool, setTool] = useState<Tool>("pan");
  const [pending, setPending] = useState<((d: number[]) => void) | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => setT((v) => (v >= n ? (setPlaying(false), v) : v + 1)), 125);
    return () => window.clearInterval(timer.current);
  }, [playing, n]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.key === "ArrowRight") setT((v) => Math.min(n, v + 1));
      else if (e.key === "ArrowLeft") setT((v) => Math.max(0, v - 1));
      else if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [n]);

  const world = useMemo(() => toWorldState(ep.world, ep.goal_radius, ep.robot_radius), [ep]);
  const trail = useMemo(() => ep.steps.x.slice(0, t + 1).map((x, i) => [x, ep.steps.y[i]] as [number, number]), [ep, t]);
  const overlays: PathOverlay[] = [];
  const markers: Marker[] = [];
  if (cf) {
    overlays.push({ points: ep.steps.x.map((x, i) => [x, ep.steps.y[i]] as [number, number]), color: "#9085e9", width: 2, label: "ORIGINAL" });
    overlays.push({ points: cf.episode.steps.x.map((x, i) => [x, cf.episode.steps.y[i]] as [number, number]), color: "#d95926", dash: [7, 4], width: 2.2, label: "COUNTERFACTUAL" });
    const k = cf.restoration.branch_step;
    markers.push({ x: ep.steps.x[k], y: ep.steps.y[k], color: "#5ec8d8", label: `BRANCH @ step ${k}` });
  }
  if (ep.parent) markers.push({ x: ep.steps.x[ep.parent.branch_step], y: ep.steps.y[ep.parent.branch_step], color: "#5ec8d8", label: `BRANCHED @ step ${ep.parent.branch_step}` });

  const series = useMemo(() => {
    let cum = 0;
    return ep.steps.dist.map((d, i) => {
      if (i > 0) cum += ep.steps.reward[i - 1];
      return { x: i, dist: d, minr: ep.steps.min_range[i] ?? null, cum };
    });
  }, [ep]);

  return (
    <div className="min-w-0 space-y-4 overflow-y-auto">
      <section className="panel flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold">{ep.policy_name} · {ep.scenario?.name ?? "random map"}</span>
            <OutcomeBadge outcome={ep.outcome} />
            {ep.label && <Badge tone={ep.restoration?.exact === false ? "warn" : "violet"}>{ep.label}</Badge>}
          </div>
          <div className="mono mt-0.5 text-[10.5px] text-ink-3">{ep.id} · seed {ep.seed} · {ep.source}{ep.model ? ` · model ${ep.model.model_id}` : ""}</div>
        </div>
        <div className="flex flex-wrap gap-x-5 text-[12px]">
          <span className="text-ink-3">steps <b className="mono text-ink">{n}</b></span>
          <span className="text-ink-3">path <b className="mono text-ink">{fmt(ep.metrics.path_length)} m</b></span>
          <span className="text-ink-3">÷ shortest <b className="mono text-ink">{ep.metrics.path_ratio ? `${fmt(ep.metrics.path_ratio)}×` : "—"}</b></span>
          <span className="text-ink-3">reward <b className="mono text-ink">{fmt(ep.metrics.reward, 1)}</b></span>
          <span className="text-ink-3">min clearance <b className="mono text-ink">{ep.metrics.min_clearance !== null ? `${fmt(ep.metrics.min_clearance, 3)} m` : "—"}</b></span>
        </div>
        <div className="ml-auto flex gap-2">
          {ep.parent && <Link to={`/episodes?id=${ep.parent.episode_id}`}><Button size="sm" variant="outline" icon={<GitBranch className="h-3.5 w-3.5" />}>Original episode</Button></Link>}
          <Button size="sm" variant="secondary" onClick={() => askCopilot("episode", { episode_id: ep.id })} icon={<Bot className="h-3.5 w-3.5" />}>Explain</Button>
        </div>
      </section>

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="panel flex min-h-[440px] flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Segmented size="sm" value={tab} onChange={(v) => { setTab(v); setTool("pan"); }} options={[{ value: "replay", label: "Replay & behaviour" }, { value: "counterfactual", label: "Counterfactual studio" }]} />
            <div className="ml-auto flex items-center gap-1">
              <Button size="icon" variant="ghost" onClick={() => setT(0)} aria-label="To start"><SkipBack className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</Button>
              <Button size="icon" variant="ghost" onClick={() => setT(n)} aria-label="To end"><SkipForward className="h-4 w-4" /></Button>
            </div>
          </div>
          <div className="relative min-h-[360px] flex-1">
            <SimCanvas world={world} robot={{ x: ep.steps.x[t], y: ep.steps.y[t], theta: ep.steps.theta[t], collided: t === n && ep.outcome === "collision" }}
              trail={cf ? [] : trail} plannedPath={ep.planned_path} overlays={overlays} markers={markers} options={{ grid: true, trail: true }}
              collisions={!cf && t === n && ep.outcome === "collision" ? [[ep.steps.x[n], ep.steps.y[n]]] : []} showControls
              tool={tool} onTool={(_k, d) => { pending?.(d); setPending(null); setTool("pan"); }} />
            {cf && (
              <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1">
                <Badge tone="violet">ORIGINAL — {ep.outcome}</Badge>
                <Badge tone={cf.restoration.exact ? "warn" : "bad"}>{cf.restoration.exact ? "COUNTERFACTUAL" : "APPROXIMATE RERUN"} — {cf.episode.outcome}</Badge>
              </div>
            )}
          </div>
          <div className="border-t border-line px-3 py-2">
            <input type="range" min={0} max={n} value={t} onChange={(e) => setT(Number(e.target.value))} className="w-full accent-[#8b7cf6]" aria-label="Replay step" />
            <div className="mono flex justify-between text-[10.5px] text-ink-3">
              <span>step {t} / {n}</span>
              <span>{t < n ? `action: ${humanize(ep.steps.action[t])}` : `end: ${ep.outcome}`}{t > 0 && ep.steps.safety[t - 1]?.length ? ` · safety: ${ep.steps.safety[t - 1].join(", ")}` : ""}</span>
              <span>x {fmt(ep.steps.x[t])} · y {fmt(ep.steps.y[t])} · d {fmt(ep.steps.dist[t])} m</span>
            </div>
          </div>
        </section>

        <div className="space-y-4">
          {tab === "replay" ? <BehaviorPanel ep={ep} t={t} onSeek={setT} /> :
            <CounterfactualPanel ep={ep} step={Math.min(t, n - 1)} result={cf} onResult={setCf} requestPick={(tl, fn) => { setTool(tl); setPending(() => fn); }} />}
        </div>
      </div>

      <Timeline ep={ep} t={t} onSeek={setT} />
      <div className="grid gap-4 lg:grid-cols-2">
        <LineChartCard title="Distance & clearance" eyebrow="metres per step" data={series} cursor={t} xLabel="step" height={170}
          series={[{ key: "dist", label: "Distance to goal", color: "#9085e9" }, { key: "minr", label: "Nearest obstacle (range)", color: "#d95926", dash: "5 3" }]} yFormat={(v) => v.toFixed(1)} />
        <LineChartCard title="Cumulative reward" data={series} cursor={t} xLabel="step" height={170} series={[{ key: "cum", label: "Reward", color: "#199e70" }]} yFormat={(v) => v.toFixed(0)} />
      </div>
    </div>
  );
}

function Timeline({ ep, t, onSeek }: { ep: Episode; t: number; onSeek: (v: number) => void }) {
  const n = Math.max(1, ep.steps.action.length);
  const lanes = ep.behavior.labels;
  const ref = useRef<HTMLDivElement>(null);
  const seek = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onSeek(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * n));
  };
  return (
    <Panel title="Behaviour timeline" eyebrow="Click to seek · rule-based classification" dense>
      <div className="flex gap-3">
        <div className="w-44 shrink-0 space-y-1.5 pt-0.5 text-[11.5px]">
          <div className="h-4 text-ink-3">Actions</div>
          {lanes.map((l) => <div key={l.label} className="flex h-4 items-center gap-1.5 truncate text-ink-2">{l.name}{l.status === "uncertain" && <Tag className="text-warn">uncertain</Tag>}</div>)}
          <div className="h-4 text-ink-3">Outcome</div>
        </div>
        <div ref={ref} className="relative min-w-0 flex-1 cursor-pointer space-y-1.5" onClick={seek}>
          <div className="flex h-4 overflow-hidden rounded">
            {ep.steps.action.map((a, i) => <div key={i} className="h-full flex-1" style={{ background: ACTION_COLOR[a] ?? "#444", opacity: 0.8 }} title={`${i}: ${a}`} />)}
          </div>
          {lanes.map((l) => (
            <div key={l.label} className="relative h-4 rounded bg-surface-3">
              {l.segments.map(([a, b], i) => (
                <div key={i} className="absolute top-0 h-full rounded" style={{ left: `${(a / n) * 100}%`, width: `${Math.max(0.6, ((b - a) / n) * 100)}%`,
                  background: l.status === "detected" ? "#e3b341" : "repeating-linear-gradient(45deg,#e3b34166 0 3px,transparent 3px 6px)" }} />
              ))}
            </div>
          ))}
          <div className="relative h-4 rounded bg-surface-3"><div className="absolute right-0 top-0 h-full w-2 rounded" style={{ background: OUTCOME_COLOR[ep.outcome] }} /></div>
          <div className="pointer-events-none absolute -bottom-1 -top-1 w-px bg-cyan" style={{ left: `${(t / n) * 100}%` }} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-[10.5px] text-ink-3">
        {Object.entries(ACTION_COLOR).map(([a, c]) => <span key={a} className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-sm" style={{ background: c }} />{humanize(a)}</span>)}
        <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-warn" />detected segment</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-sm" style={{ background: "repeating-linear-gradient(45deg,#e3b34166 0 2px,transparent 2px 4px)" }} />uncertain</span>
      </div>
    </Panel>
  );
}

function BehaviorPanel({ ep, t, onSeek }: { ep: Episode; t: number; onSeek: (v: number) => void }) {
  return (
    <Panel title="Behaviour classification" eyebrow="Explicit, testable rules" dense>
      <div className="mb-2 flex items-center gap-2 text-[12.5px]"><span className="text-ink-3">Outcome</span><OutcomeBadge outcome={ep.outcome} /></div>
      {ep.behavior.labels.length === 0 && <div className="text-[12px] text-ink-3">No behaviour rule reached its detection or uncertain band.</div>}
      <div className="space-y-2">
        {ep.behavior.labels.map((l) => (
          <div key={l.label} className="rounded-lg border border-line bg-surface-2 p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-ink">{l.name}</span>
              <Badge tone={l.status === "detected" ? "warn" : "muted"}>{l.status}</Badge>
            </div>
            <div className="mt-1 text-[11px] text-ink-3">{l.rule}</div>
            <div className="mono mt-1 text-[11px] text-ink-2">measured {String(l.value)} · threshold {l.threshold} · uncertain from {l.uncertain_from}</div>
            {l.segments.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {l.segments.slice(0, 6).map(([a, b], i) => (
                  <button key={i} onClick={() => onSeek(a)} className={clsx("mono rounded border px-1.5 text-[10px]", t >= a && t <= b ? "border-cyan text-cyan" : "border-line text-ink-3 hover:text-ink")}>steps {a}–{b}</button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 text-[11px] leading-relaxed text-ink-3">Conditions: sensor noise {String(ep.conditions.sensor_noise ?? 0)}, motion noise {String(ep.conditions.motion_noise ?? 0)}, shield {ep.conditions.shield ? "on" : "off"}. Rules are listed in evaluation/behavior.py.</div>
    </Panel>
  );
}

function CounterfactualPanel({ ep, step, result, onResult, requestPick }: {
  ep: Episode; step: number; result: CounterfactualResult | null; onResult: (r: CounterfactualResult | null) => void;
  requestPick: (tool: Tool, fn: (d: number[]) => void) => void;
}) {
  const [params] = useSearchParams();
  const run = useAction();
  const [insp, setInsp] = useState<StepInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const pre = useMemo(() => { try { return JSON.parse(params.get("cf") ?? "{}"); } catch { return {}; } }, [params]);
  const [type, setType] = useState<string>(pre.type ?? "action");
  const [action, setAction] = useState("turn_left");
  const [shield, setShield] = useState<string>(pre.enabled === false ? "off" : "on");
  const [noise, setNoise] = useState<number | null>(0.05);
  const [rect, setRect] = useState<number[] | null>(null);
  const [point, setPoint] = useState<number[] | null>(null);
  useEffect(() => { setInsp(null); }, [step]);

  const modification = (): Record<string, unknown> | null => {
    if (type === "action") return { type, action };
    if (type === "shield") return { type, enabled: shield === "on" };
    if (type === "sensor_noise") return noise === null ? null : { type, std: noise };
    if (type === "add_obstacle") return rect ? { type, rect } : null;
    if (type === "remove_obstacle" || type === "goal") return point ? { type, x: point[0], y: point[1] } : null;
    return null;
  };
  const mod = modification();

  return (
    <>
      <Panel title={`Decision at step ${step}`} eyebrow="Recorded observation & action" dense
        actions={<Button size="sm" variant="secondary" loading={busy} onClick={async () => { setBusy(true); const r = await run(() => research.episodes.step(ep.id, step)); setBusy(false); if (r) setInsp(r); }}>Inspect</Button>}>
        {!insp ? <div className="text-[12px] text-ink-3">Move the replay scrubber to a decision point and press Inspect. The state is restored by deterministic re-simulation.</div> : (
          <div className="space-y-2">
            <Badge tone={insp.restoration.exact ? "good" : "warn"}>{insp.restoration.exact ? "state restored exactly" : "approximate restoration"}</Badge>
            <KeyValue label="Recorded action" value={humanize(insp.recorded_action)} />
            <KeyValue label="Goal distance / bearing" value={`${fmt(insp.observation.goal_dist_norm, 3)} (norm) · ${fmt(insp.observation.goal_bearing_deg, 0)}°`} />
            {insp.q_values && (
              <div>
                <div className="eyebrow mb-1">Q-values (DQN)</div>
                {Object.entries(insp.q_values).map(([a, q]) => {
                  const vals = Object.values(insp.q_values!);
                  const lo = Math.min(...vals), hi = Math.max(...vals);
                  return (
                    <div key={a} className="flex items-center gap-2 text-[11.5px]">
                      <span className="w-20 text-ink-2">{humanize(a)}</span>
                      <div className="h-1.5 flex-1 rounded-full bg-surface-3"><div className="h-full rounded-full" style={{ width: `${hi > lo ? ((q - lo) / (hi - lo)) * 100 : 100}%`, background: a === insp.recorded_action ? "#9085e9" : "#3a404c" }} /></div>
                      <span className="mono w-16 text-right text-ink">{q.toFixed(3)}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <Polar ranges={insp.observation.ranges_norm} angles={insp.observation.beam_angles_deg} />
          </div>
        )}
      </Panel>
      <Panel title="Branch from this step" eyebrow="Change one thing, re-run the rest" dense>
        {(
          <div className="space-y-3">
            <Field label="Modification">
              <Select value={type} onChange={(v) => { setType(v); setRect(null); setPoint(null); }} options={[
                { value: "action", label: "Take a different action" }, { value: "shield", label: "Toggle safety shield" },
                { value: "sensor_noise", label: "Change sensor noise" }, { value: "add_obstacle", label: "Add an obstacle" },
                { value: "remove_obstacle", label: "Remove an obstacle" }, { value: "goal", label: "Move the goal" }]} />
            </Field>
            {type === "action" && <Field label="Action at the branch step"><Select value={action} onChange={setAction} options={["forward", "turn_left", "turn_right", "stop"].map((a) => ({ value: a, label: humanize(a) }))} /></Field>}
            {type === "shield" && <Field label="Shield from this step"><Segmented value={shield} onChange={setShield} options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]} /></Field>}
            {type === "sensor_noise" && <Field label="Range noise std (m)"><NumberInput value={noise} min={0} max={0.5} onChange={(v) => setNoise(v)} /></Field>}
            {type === "add_obstacle" && <Button size="sm" variant="outline" onClick={() => requestPick("add", setRect)}>{rect ? `Rect ${rect.map((v) => v.toFixed(2)).join(", ")}` : "Draw rectangle on the map"}</Button>}
            {(type === "remove_obstacle" || type === "goal") && <Button size="sm" variant="outline" onClick={() => requestPick("goal", setPoint)}>{point ? `Point ${point.map((v) => v.toFixed(2)).join(", ")}` : "Click on the map"}</Button>}
            <Button variant="primary" className="w-full" disabled={!mod || busy} loading={busy} icon={<GitBranch className="h-3.5 w-3.5" />}
              onClick={async () => { setBusy(true); const r = await run(() => research.episodes.counterfactual(ep.id, step, mod!)); setBusy(false); if (r) onResult(r); }}>
              Run counterfactual from step {step}
            </Button>
          </div>
        )}
      </Panel>
      {result && (
        <Panel title="Original vs counterfactual" eyebrow={result.restoration.method} dense
          actions={<Badge tone={result.restoration.exact ? "good" : "warn"}>{result.restoration.exact ? "exact branch" : "approximate rerun"}</Badge>}>
          {!result.restoration.exact && <div className="mb-2 text-[11.5px] text-warn">{result.restoration.note}</div>}
          <table className="w-full text-[12px]">
            <thead><tr className="eyebrow text-left"><th className="font-normal" /><th className="text-right font-normal text-[#b3a9ff]">Original</th><th className="text-right font-normal text-[#ec835a]">Counterfactual</th><th className="text-right font-normal">Δ</th></tr></thead>
            <tbody>
              {Object.entries(result.comparison).map(([k, v]) => (
                <tr key={k} className="border-t border-line/60">
                  <td className="py-1.5 text-ink-3">{humanize(k)}</td>
                  <td className="mono py-1.5 text-right">{typeof v.original === "number" ? fmt(v.original as number) : String(v.original ?? "—")}</td>
                  <td className="mono py-1.5 text-right">{typeof v.counterfactual === "number" ? fmt(v.counterfactual as number) : String(v.counterfactual ?? "—")}</td>
                  <td className="mono py-1.5 text-right text-ink-3">{v.delta !== null ? (v.delta > 0 ? "+" : "") + fmt(v.delta) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 text-[11px] text-ink-3">Branch at step {result.restoration.branch_step}; prefix deviation {result.restoration.max_prefix_deviation_m} m; modification {JSON.stringify(result.episode.parent?.modification)}.</div>
          <Link to={`/episodes?id=${result.episode.id}`} className="mt-2 inline-block text-[12px] text-[#b3a9ff] hover:text-[#cfc8ff]">Open counterfactual episode →</Link>
        </Panel>
      )}
    </>
  );
}

function Polar({ ranges, angles }: { ranges: number[]; angles: number[] }) {
  const R = 60;
  return (
    <svg viewBox="-70 -70 140 140" className="mx-auto h-[150px]" role="img" aria-label="Normalised range scan at this step (forward = up)">
      {[0.33, 0.66, 1].map((k) => <circle key={k} r={R * k} fill="none" stroke="#22262e" />)}
      {ranges.map((r, i) => {
        const a = (angles[i] * Math.PI) / 180;
        return <line key={i} x1={0} y1={0} x2={-Math.sin(a) * r * R} y2={-Math.cos(a) * r * R} stroke={r < 0.15 ? "#f0524f" : "#8b7cf6"} strokeOpacity={0.75} />;
      })}
      <circle r={4} fill="#8b7cf6" />
      <text y={68} textAnchor="middle" fontSize="7" fill="#6c7380" fontFamily="JetBrains Mono">scan · forward = up</text>
    </svg>
  );
}
