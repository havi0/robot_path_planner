import { FolderPlus, Map as MapIcon, Play, Save, Shuffle, Trash2, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { DifficultyBadge, StatPill, toWorldState } from "../components/research/shared";
import { SimCanvas } from "../components/sim/SimCanvas";
import { Button } from "../components/ui/button";
import { Field, NumberInput, Segmented, Select, TextInput } from "../components/ui/controls";
import { Badge, EmptyState, Skeleton, Tag } from "../components/ui/feedback";
import { ConfirmDialog, useAction } from "../components/ui/overlay";
import { KeyValue, Panel } from "../components/ui/panel";
import { dateTime, fmt, int, pct } from "../lib/format";
import { useLive } from "../lib/live";
import { research } from "../lib/research-api";
import type { MapAnalysis, Scenario, ScenarioSet } from "../lib/research-types";

export function ScenarioLab() {
  const [params] = useSearchParams();
  const run = useAction();
  const nav = useNavigate();
  const [types, setTypes] = useState<Record<string, string>>({});
  const [kind, setKind] = useState("u_trap");
  const [seed, setSeed] = useState<number | null>(null);
  const [size, setSize] = useState<number | null>(6);
  const [current, setCurrent] = useState<Scenario | null>(null);
  const [simAnalysis, setSimAnalysis] = useState<MapAnalysis | null>(null);
  const [saved, setSaved] = useState<Scenario[] | null>(null);
  const [sets, setSets] = useState<ScenarioSet[]>([]);
  const [tab, setTab] = useState<"generator" | "sets">("generator");
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<Scenario | null>(null);
  const jobs = useLive((s) => s.jobs.length);

  const reload = () => {
    research.scenarios.list().then(setSaved).catch(() => setSaved([]));
    research.sets.list().then(setSets).catch(() => {});
  };
  useEffect(() => { research.scenarios.types().then(setTypes).catch(() => {}); reload(); }, []);
  useEffect(() => { reload(); }, [jobs]);
  useEffect(() => {
    const id = params.get("id");
    if (id) research.scenarios.get(id).then(setCurrent).catch(() => {});
    if (params.get("analyze")) analyzeSim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const generate = async () => {
    setBusy(true);
    const r = await run(() => research.scenarios.generate(kind, seed, size ?? 6));
    setBusy(false);
    if (r) { setCurrent(r); setSimAnalysis(null); }
  };
  const analyzeSim = async () => {
    const r = await run(() => research.scenarios.analyzeSim());
    if (r) { setSimAnalysis(r); setCurrent(null); }
  };
  const analysis = current?.analysis ?? simAnalysis;
  const sim = useLive((s) => s.sim);
  const shownWorld = current?.world ? toWorldState(current.world) : simAnalysis && sim ? sim.world : null;

  return (
    <div className="grid h-full min-h-[680px] gap-4 p-4 xl:grid-cols-[330px_minmax(0,1fr)_360px]">
      {/* ------------------------------------------------ left: generator / sets */}
      <div className="min-w-0 space-y-4 overflow-y-auto">
        <Segmented value={tab} onChange={setTab} options={[{ value: "generator", label: "Generator" }, { value: "sets", label: "Scenario sets" }]} />
        {tab === "generator" ? (
          <>
            <Panel title="Procedural generator" eyebrow="Challenging scenarios" dense>
              <div className="space-y-3">
                <Field label="Scenario type">
                  <Select value={kind} onChange={setKind} options={Object.keys(types).map((t) => ({ value: t, label: t.replace(/_/g, " ") }))} />
                </Field>
                <p className="text-[11.5px] text-ink-3">{types[kind]}</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Seed" hint="Empty = random evaluation seed (>= 3,000,000)"><NumberInput value={seed} allowEmpty integer min={0} placeholder="random" onChange={(v) => setSeed(v)} /></Field>
                  <Field label="Size (m)"><NumberInput value={size} min={4} max={12} onChange={(v) => setSize(v)} /></Field>
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" className="flex-1" loading={busy} onClick={generate} icon={<Wand2 className="h-3.5 w-3.5" />}>Generate & analyze</Button>
                  <Button variant="secondary" onClick={() => { setSeed(null); generate(); }} title="New random seed" icon={<Shuffle className="h-3.5 w-3.5" />} />
                </div>
                <Button variant="outline" className="w-full" onClick={analyzeSim} icon={<MapIcon className="h-3.5 w-3.5" />}>Analyze current simulation map</Button>
              </div>
            </Panel>
            <Panel title="Saved scenarios" eyebrow={saved ? `${saved.length} saved` : "Loading"} dense bodyClassName="!p-0">
              {saved === null ? <div className="p-3"><Skeleton className="h-24" /></div> : saved.length === 0 ? (
                <EmptyState title="No saved scenarios">Generate one and press Save.</EmptyState>
              ) : (
                <div className="max-h-[360px] divide-y divide-line overflow-y-auto">
                  {saved.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 px-3 py-2 hover:bg-surface-2">
                      <button className="min-w-0 flex-1 text-left" onClick={() => s.id && research.scenarios.get(s.id).then((d) => { setCurrent(d); setSimAnalysis(null); })}>
                        <div className="truncate text-[12.5px] text-ink">{s.name}</div>
                        <div className="mono text-[10.5px] text-ink-3">{s.type} · seed {s.seed}</div>
                      </button>
                      <DifficultyBadge d={s.difficulty} />
                      <button onClick={() => setDel(s)} className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-bad" aria-label="Delete scenario"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </>
        ) : (
          <SetBuilder types={Object.keys(types)} sets={sets} onChanged={reload} />
        )}
      </div>

      {/* ------------------------------------------------ center: preview */}
      <section className="panel relative min-h-[520px] overflow-hidden">
        {shownWorld ? (
          <>
            <SimCanvas world={shownWorld} referencePath={analysis?.path ?? []} options={{ grid: true, reference: true }} showControls
              annotation={current ? `${current.type.toUpperCase()} · SEED ${current.seed} · ${current.split.toUpperCase()}` : "CURRENT SIMULATION MAP"} />
            <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg border border-line bg-[#0b0c0f]/85 p-1.5 backdrop-blur">
              {current && <>
                <Button size="sm" variant="secondary" disabled={!!current.id} onClick={async () => { const r = await run(() => research.scenarios.generate(current.type, current.seed, current.size, true), "Scenario saved"); if (r) { setCurrent(r); reload(); } }}
                  icon={<Save className="h-3.5 w-3.5" />}>{current.id ? "Saved" : "Save"}</Button>
                <Button size="sm" variant="primary" disabled={!current.id} title={current.id ? "" : "Save first"} onClick={async () => { const r = await run(() => research.scenarios.load(current.id!), "Loaded into Live Simulation"); if (r) nav("/simulation"); }}
                  icon={<Play className="h-3.5 w-3.5" />}>Replay in simulator</Button>
              </>}
              <span className="flex items-center gap-1.5 px-1 text-[10.5px] text-ink-3"><span className="h-0 w-4 border-t border-dotted border-cyan" /> shortest route (A*, known map)</span>
            </div>
          </>
        ) : (
          <EmptyState icon={<MapIcon className="h-4 w-4" />} title="No scenario selected">Generate a scenario or analyze the current simulation map.</EmptyState>
        )}
      </section>

      {/* ------------------------------------------------ right: analysis */}
      <div className="min-w-0 space-y-4 overflow-y-auto">
        {analysis ? <AnalysisPanel a={analysis} /> : <Panel title="Map analysis" dense><div className="text-[12px] text-ink-3">Measurable properties of the selected map appear here.</div></Panel>}
      </div>

      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title="Delete scenario?" danger confirmLabel="Delete"
        onConfirm={async () => { if (del?.id) { await run(() => research.scenarios.remove(del.id!), "Scenario deleted"); reload(); } }}>
        Recorded episodes that used this scenario keep their own copy of the map.
      </ConfirmDialog>
    </div>
  );
}

function AnalysisPanel({ a }: { a: MapAnalysis }) {
  const d = a.difficulty;
  const comps = Object.entries(d.weights ?? {}).map(([k, w]) => ({ k, w, v: d.components?.[k] ?? 0 }));
  return (
    <>
      <Panel title="Geometric difficulty" eyebrow="Weighted, inspectable score" dense actions={<DifficultyBadge d={d} />}>
        {d.score === null ? <div className="text-[12.5px] text-bad">No collision-free route exists under the stated assumptions.</div> : (
          <div className="space-y-1.5">
            {comps.map(({ k, w, v }) => (
              <div key={k} className="flex items-center gap-2 text-[11.5px]">
                <span className="w-32 shrink-0 text-ink-2">{k.replace(/_/g, " ")}</span>
                <div className="h-1.5 flex-1 rounded-full bg-surface-3"><div className="h-full rounded-full bg-violet" style={{ width: `${v * 100}%` }} /></div>
                <span className="mono w-20 text-right text-[10.5px] text-ink-3">{v.toFixed(2)} × {w}</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-warn">{d.note ?? "Geometric difficulty only - not validated as RL difficulty."} Use benchmark runs to measure how hard a map is for a policy.</p>
      </Panel>
      <Panel title="Measured properties" eyebrow={`robot r=${a.assumptions.robot_radius} m · grid ${a.assumptions.resolution} m`} dense>
        <div className="mb-2 grid grid-cols-2 gap-2">
          <StatPill label="Route exists" value={a.route_exists ? "yes" : "NO"} />
          <StatPill label="Shortest path" value={a.shortest_path !== null ? `${fmt(a.shortest_path)} m` : "—"} />
        </div>
        <KeyValue label="Obstacle density" value={pct(a.obstacle_density, 1)} />
        <KeyValue label="Free-space ratio (robot centre)" value={pct(a.free_space_ratio, 1)} />
        <KeyValue label="Reachable free space" value={pct(a.reachable_free_ratio, 1)} />
        <KeyValue label="Connected free regions" value={a.free_regions} tone={a.free_regions > 1 ? "warn" : undefined} />
        <KeyValue label="Narrow passages (total / on route)" value={`${a.narrow_regions} / ${a.narrow_on_route ?? "—"}`} />
        <KeyValue label="Start–goal distance" value={`${fmt(a.start_goal_distance)} m`} />
        <KeyValue label="Tortuosity (path ÷ straight line)" value={a.tortuosity !== null ? fmt(a.tortuosity) : "—"} />
        <KeyValue label="Route alternatives (≤1.5× shortest)" value={`${a.route_alternatives} (estimate)`} />
        <KeyValue label="Min clearance on shortest route" value={a.route_min_clearance !== null ? `${fmt(a.route_min_clearance, 3)} m` : "—"} />
        <KeyValue label="Local-minimum trap" value={a.local_minimum_trap ? `yes (stuck ${fmt(a.greedy_stuck_distance)} m from goal)` : "no"} tone={a.local_minimum_trap ? "warn" : undefined} />
        <KeyValue label="Start heading error" value={a.start_heading_error_deg !== null ? `${fmt(a.start_heading_error_deg, 0)}°` : "—"} />
        <KeyValue label="Start / goal clearance" value={`${fmt(a.start_clearance)} / ${fmt(a.goal_clearance)} m`} />
        <KeyValue label="Moving obstacles / temporary blockages" value={`${a.moving_obstacles} / ${a.temporary_blockages}`} />
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">Route existence and shortest path use a classical planner on the known static map (temporary blockages active at t = 0).</p>
      </Panel>
    </>
  );
}

function SetBuilder({ types, sets, onChanged }: { types: string[]; sets: ScenarioSet[]; onChanged: () => void }) {
  const run = useAction();
  const [name, setName] = useState("Balanced evaluation set");
  const [role, setRole] = useState<"evaluation" | "training">("evaluation");
  const [chosen, setChosen] = useState<string[]>([]);
  const [per, setPer] = useState<number | null>(4);
  const [del, setDel] = useState<ScenarioSet | null>(null);
  useEffect(() => { if (!chosen.length && types.length) setChosen(types); }, [types, chosen.length]);
  const bands = ["easy", "moderate", "hard", "extreme"];
  const total = useMemo(() => chosen.length * (per ?? 0), [chosen, per]);
  return (
    <>
      <Panel title="Build a scenario set" eyebrow="Balanced by type" dense>
        <div className="space-y-3">
          <Field label="Name"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Role" hint="Evaluation sets use seeds >= 3,000,000 and are never used for training">
            <Segmented value={role} onChange={setRole} options={[{ value: "evaluation", label: "Evaluation" }, { value: "training", label: "Training" }]} />
          </Field>
          <div>
            <div className="mb-1.5 text-[11.5px] font-medium text-ink-2">Scenario types</div>
            <div className="flex flex-wrap gap-1.5">
              {types.map((t) => (
                <button key={t} onClick={() => setChosen((c) => (c.includes(t) ? c.filter((x) => x !== t) : [...c, t]))}
                  className={`rounded-md border px-2 py-1 text-[11px] ${chosen.includes(t) ? "border-[#8b7cf655] bg-violet-soft text-[#c4bcff]" : "border-line text-ink-3"}`}>{t.replace(/_/g, " ")}</button>
              ))}
            </div>
          </div>
          <Field label="Scenarios per type" error={per === null || per < 1 || per > 50 ? "1 – 50" : null}><NumberInput value={per} min={1} max={50} integer onChange={(v) => setPer(v)} /></Field>
          <Button variant="primary" className="w-full" disabled={!chosen.length || !per || per > 50 || !name.trim()}
            onClick={async () => { const r = await run(() => research.sets.create({ name, types: chosen, per_type: per!, role, size: 6 }), `Building ${total} scenarios in the background`); if (r) onChanged(); }}
            icon={<FolderPlus className="h-3.5 w-3.5" />}>Build {total} scenarios</Button>
          <Button variant="outline" className="w-full" onClick={async () => { await run(() => research.sets.benchmark(), "Benchmark build queued"); onChanged(); }}>Build shared benchmark (9 types × 5)</Button>
        </div>
      </Panel>
      <Panel title="Scenario sets" eyebrow={`${sets.length} sets`} dense bodyClassName="!p-0">
        {sets.length === 0 ? <EmptyState title="No sets yet">Build an evaluation set to benchmark models on held-out scenarios.</EmptyState> : (
          <div className="divide-y divide-line">
            {sets.map((s) => (
              <div key={s.id} className="px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0"><div className="truncate text-[12.5px] text-ink">{s.name}</div>
                    <div className="mono text-[10.5px] text-ink-3">{s.composition.count} scenarios · {dateTime(s.created)}</div></div>
                  <span className="flex items-center gap-1.5"><Badge tone={s.role === "evaluation" ? "info" : "violet"}>{s.role}</Badge>
                    {s.id !== "benchmark-v1" && <button onClick={() => setDel(s)} className="rounded p-1 text-ink-3 hover:text-bad" aria-label="Delete set"><Trash2 className="h-3.5 w-3.5" /></button>}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {bands.map((b) => <Tag key={b}>{b} {int(s.composition.bands[b] ?? 0)}</Tag>)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title="Delete scenario set?" danger confirmLabel="Delete"
        onConfirm={async () => { if (del) { await run(() => research.sets.remove(del.id), "Set deleted"); onChanged(); } }}>
        The scenarios themselves are kept; only the set definition is removed.
      </ConfirmDialog>
    </>
  );
}
