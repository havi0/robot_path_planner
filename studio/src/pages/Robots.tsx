/**
 * Explore Robots: choose the simulated robot. Selection is applied by the backend
 * (kinematics, footprint, action set, speed limits) - not cosmetic. Policy compatibility
 * comes from the backend's explicit checks against the loaded checkpoints.
 */
import clsx from "clsx";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Loader2, Pause, RotateCcw, RotateCw, Sparkles, XCircle } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Field, NumberInput, Segmented, TextInput } from "../components/ui/controls";
import { Badge } from "../components/ui/feedback";
import { useToast } from "../components/ui/overlay";
import { webglAvailable } from "../components/three/Scene3DView";
import { COMPAT_LABEL, WorkflowSteps } from "../components/workflow/WorkflowSteps";
import { api, ApiError } from "../lib/api";
import { useLive } from "../lib/live";
import { usePrefs } from "../lib/prefs";
import type { CustomRobot, RobotProfile, RobotState } from "../lib/types";

const RobotStage = lazy(() => import("../components/three/RobotStage"));

const DEFAULT_CUSTOM: CustomRobot = { drive: "differential", radius: 0.15, max_linear: 0.3, max_angular: 1.2, name: "Custom robot", visual: { color: "#c9c3ff", body: "round", height: 0.16 } };
const LIM = { radius: [0.1, 0.3], max_linear: [0.05, 0.3], max_angular: [0.3, 1.5], height: [0.08, 0.5] } as const;

/** Client-side mirror of the custom profile's visual sizing (backend is authoritative once selected). */
function customPreview(base: RobotProfile, c: CustomRobot): RobotProfile {
  const side = c.radius * (c.visual.body === "round" ? 2 : 1.38);
  return {
    ...base, name: c.name || "Custom robot", radius: c.radius, max_linear: c.max_linear, max_angular: c.max_angular,
    drive: c.drive, kinematics: c.drive === "skid_steer" ? "skid_steer" : "diff_drive",
    visual: { model: "custom", color: c.visual.color, body: c.visual.body, height: c.visual.height, length: side, width: side },
  };
}

function Stage(props: { robot: RobotProfile; yaw?: number; interactive?: boolean; live?: boolean; zoom?: number }) {
  const { reduceMotion } = usePrefs();
  const fallback = (
    <div className="flex h-full items-center justify-center">
      <div className="h-24 w-24 rounded-full border border-white/10" style={{ background: `radial-gradient(circle at 35% 30%, ${props.robot.visual.color}, #1b1d26 70%)` }} />
    </div>
  );
  if (!webglAvailable()) return fallback;
  return (
    <Suspense fallback={fallback}>
      <RobotStage visual={props.robot.visual} radius={props.robot.radius} yaw={props.yaw} interactive={props.interactive}
        autoRotate live={props.live} reducedMotion={reduceMotion} zoom={props.zoom ?? (props.robot.visual.model === "courier" ? 1.25 : 1)} />
    </Suspense>
  );
}

function Spec({ k, v, learn }: { k: string; v: string; learn?: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-3 py-2">
      <div className="text-[11px] text-ink-3" data-learn={learn}>{k}</div>
      <div className="mt-0.5 text-[13px] font-medium text-ink">{v}</div>
    </div>
  );
}

export default function RobotsPage() {
  const nav = useNavigate();
  const toast = useToast();
  const sim = useLive((s) => s.sim);
  const modelsKey = useLive((s) => `${s.models?.dqn?.path ?? ""}|${s.models?.qlearning?.path ?? ""}`);
  const [state, setState] = useState<RobotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [custom, setCustom] = useState<CustomRobot>(DEFAULT_CUSTOM);
  const [yaw, setYaw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ kind: "fit" | "running" | "other"; text: string } | null>(null);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedId = sim?.robot_profile?.id;

  const load = useCallback(() => api.robots.list().then((s) => { setState(s); setError(null); return s; }).catch((e) => setError(String(e.message ?? e))), []);
  useEffect(() => {
    load().then((s) => {
      if (!s) return;
      setFocus((f) => f ?? s.selected.id);
      if (s.selected.custom) setCustom({ ...DEFAULT_CUSTOM, ...s.selected.custom, visual: { ...DEFAULT_CUSTOM.visual, ...s.selected.custom.visual } });
    });
  }, [load, modelsKey]);
  useEffect(() => { if (selectedId && state && state.selected.id !== selectedId) load(); }, [selectedId, state, load]);

  const robots = state?.robots ?? [];
  const base = robots.find((r) => r.id === focus) ?? null;
  const shown = useMemo(() => (base && base.id === "custom" ? customPreview(base, custom) : base), [base, custom]);
  const isSelected = !!shown && selectedId === shown.id;
  const compat = shown ? (shown.id === "custom" ? (isSelected ? state?.compatibility : null) : state?.preview[shown.id]) : null;
  const customErr = useMemo(() => {
    for (const k of ["radius", "max_linear", "max_angular"] as const) {
      const v = custom[k]; const [lo, hi] = LIM[k];
      if (!(v >= lo && v <= hi)) return `${k.replace("_", " ")} must be between ${lo} and ${hi}`;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(custom.visual.color)) return "Colour must be #rrggbb";
    return null;
  }, [custom]);

  const select = async (regenerate = false) => {
    if (!shown) return;
    setBusy(true); setProblem(null);
    try {
      const res = await api.robots.select(shown.id, shown.id === "custom" ? custom : null, regenerate);
      setState((s) => (s ? { ...s, ...res } : s));
      toast("success", `${res.selected.name} selected`, "The simulator now uses this robot's kinematics, footprint and speed limits.");
      res.notes?.forEach((n) => toast("warning", "Robot change", n));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const kind = e instanceof ApiError && e.status === 409 ? "fit" : /Pause the simulation/.test(msg) ? "running" : "other";
      setProblem({ kind, text: msg });
    } finally {
      setBusy(false);
    }
  };

  const onCardKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = robots.length;
    const j = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n
      : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    cards.current[j]?.focus();
    setFocus(robots[j].id);
    setProblem(null);
  };

  if (error && !state) {
    return <div className="p-6"><div className="panel p-6 text-[13px] text-bad">Could not load robots: {error}</div></div>;
  }

  return (
    <div className="space-y-5 p-4">
      <motion.header initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
        className="flex flex-wrap items-end justify-between gap-4 px-1 pt-2">
        <div>
          <div className="mono mb-2 text-[11px] tracking-[0.22em] text-[#b3a9ff]">EXPLORE ROBOTS</div>
          <h1 className="text-[34px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink md:text-[42px]">
            Choose who <span className="bg-gradient-to-r from-[#e9e5ff] via-[#b9afff] to-[#7fb2ff] bg-clip-text text-transparent">navigates.</span>
          </h1>
          <p className="mt-2 max-w-[560px] text-[13.5px] leading-relaxed text-ink-2">
            Each robot changes the simulation for real - its kinematics, footprint and speed limits. Learned policies are checked
            against the robot they were trained on, never assumed to transfer.
          </p>
        </div>
        <WorkflowSteps current="robot" />
      </motion.header>

      {!state || !shown ? (
        <div className="panel flex h-[480px] items-center justify-center text-ink-3"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading robots</div>
      ) : (
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          {/* ------------------------------------------------ stage */}
          <div className="hero-shell relative h-[420px] overflow-hidden rounded-[20px] xl:h-[560px]">
            <Stage robot={shown} yaw={yaw} interactive live />
            <div className="pointer-events-none absolute left-6 top-6">
              <div className="text-[13px] text-ink-3">{shown.kind}</div>
              <motion.div key={shown.id + shown.name} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
                className="text-[40px] font-semibold leading-none tracking-[-0.03em] text-ink">{shown.name}</motion.div>
              {isSelected && <div className="mt-3"><Badge tone="good">Selected for simulation</Badge></div>}
            </div>
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/[0.07] bg-[#0d0e13]/75 p-1 backdrop-blur-md">
              <button className="rounded-lg p-2 text-ink-2 hover:bg-white/[0.06] hover:text-ink" aria-label="Rotate robot left" onClick={() => setYaw((y) => y + Math.PI / 4)}><RotateCcw className="h-4 w-4" /></button>
              <span className="hidden px-2 text-[11px] text-ink-3 sm:inline">Drag to orbit · pinch or scroll to zoom</span>
              <button className="rounded-lg p-2 text-ink-2 hover:bg-white/[0.06] hover:text-ink" aria-label="Rotate robot right" onClick={() => setYaw((y) => y - Math.PI / 4)}><RotateCw className="h-4 w-4" /></button>
            </div>
            <div className="pointer-events-none absolute right-5 top-6 hidden text-right text-[11px] text-ink-3 md:block">
              Lavender ring = collision footprint ({shown.radius.toFixed(2)} m)
            </div>
          </div>

          {/* ------------------------------------------------ details */}
          <div className="panel flex flex-col p-5">
            <p className="text-[15px] leading-relaxed text-ink">{shown.tagline}</p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">{shown.description}</p>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Spec k="Drive" v={shown.drive === "skid_steer" ? "Skid-steer (4WD)" : shown.drive === "mecanum" ? "Mecanum (4 omni wheels)" : "Differential (2WD + caster)"} />
              <Spec k="Kinematics" v={shown.kinematics === "holonomic" ? "Holonomic" : shown.kinematics === "skid_steer" ? `Unicycle, ${Math.round((shown.kinematics_params?.yaw_efficiency ?? 0.8) * 100)}% yaw` : "Unicycle (exact arcs)"} />
              <Spec k="Footprint" v={`${shown.radius.toFixed(2)} m radius`} />
              <Spec k="Top speed" v={`${shown.max_linear.toFixed(2)} m/s`} />
              <Spec k="Turn rate" v={`${shown.max_angular.toFixed(2)} rad/s`} />
              <Spec k="Sensor" v={`${shown.sensor.num_beams}-beam LiDAR, ${shown.sensor.max_range} m`} learn="lidar" />
            </div>
            <div className="mt-2 rounded-lg bg-white/[0.03] px-3 py-2 text-[12px] text-ink-2">
              <span className="text-ink-3">Actions ({shown.actions.length}): </span>{shown.actions.map((a) => a.replace("_", " ")).join(" · ")}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <div className="eyebrow mb-1.5">Can do</div>
                <ul className="space-y-1">{shown.capabilities.map((c) => <li key={c} className="flex gap-2 text-[12px] text-ink-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" />{c}</li>)}</ul>
              </div>
              <div>
                <div className="eyebrow mb-1.5">Limits</div>
                <ul className="space-y-1">{shown.limitations.map((c) => <li key={c} className="flex gap-2 text-[12px] text-ink-2"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />{c}</li>)}</ul>
              </div>
            </div>

            {shown.id === "custom" && <CustomEditor value={custom} onChange={(c) => { setCustom(c); setProblem(null); }} error={customErr} />}

            <div className="mt-4">
              <div className="eyebrow mb-1.5" data-learn="policy-compat">Controller compatibility</div>
              {compat ? (
                <ul className="space-y-1.5">
                  {Object.entries(compat).map(([k, c]) => {
                    const L = COMPAT_LABEL[c.status];
                    const Icon = c.status === "incompatible" ? XCircle : c.status === "unvalidated" ? AlertTriangle : c.status === "unavailable" ? XCircle : CheckCircle2;
                    return (
                      <li key={k} className="flex items-start gap-2 text-[12px]" title={c.detail}>
                        <Icon className={clsx("mt-0.5 h-3.5 w-3.5 shrink-0", { good: "text-good", warn: "text-warn", bad: "text-bad", info: "text-cyan", muted: "text-ink-3" }[L.tone])} />
                        <span className="min-w-[120px] text-ink">{state.policy_names[k] ?? k}</span>
                        <span className="text-ink-3">{L.text}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[12px] text-ink-3">Checked against the loaded models when you select this robot.</p>
              )}
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
                {shown.training ? "Training: supported - start a run in the Training Lab with this robot selected to get a policy trained for it."
                  : `Training: not available - ${shown.training_note}`}
              </p>
            </div>

            {problem && (
              <div className={clsx("mt-4 rounded-lg border px-3 py-2.5 text-[12px]", problem.kind === "other" ? "border-[#f0524f55] bg-[#f0524f0f] text-[#ffb3b1]" : "border-[#e3b34155] bg-[#e3b3410d] text-warn")} role="alert">
                {problem.text}
                {problem.kind === "fit" && (
                  <div className="mt-2"><Button size="sm" variant="secondary" loading={busy} onClick={() => select(true)}>Generate a fitting map & select</Button></div>
                )}
                {problem.kind === "running" && (
                  <div className="mt-2"><Button size="sm" variant="secondary" icon={<Pause className="h-3.5 w-3.5" />}
                    onClick={async () => { await api.sim.control("pause").catch(() => {}); select(); }}>Pause simulation & select</Button></div>
                )}
              </div>
            )}

            <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
              {isSelected && !(shown.id === "custom" && JSON.stringify(state.selected.custom) !== JSON.stringify(custom)) ? (
                <>
                  <Button variant="primary" size="lg" onClick={() => nav("/simulation")} icon={<ArrowRight className="h-4 w-4" />}>Run simulation</Button>
                  <Button variant="secondary" size="lg" onClick={() => nav("/training")} disabled={!shown.training}>Train for this robot</Button>
                  <span className="inline-flex items-center gap-1.5 text-[12px] text-good"><CheckCircle2 className="h-4 w-4" /> Active in the simulator</span>
                </>
              ) : (
                <Button variant="primary" size="lg" loading={busy} disabled={!!(shown.id === "custom" && customErr)} onClick={() => select()} icon={<Sparkles className="h-4 w-4" />}>
                  {isSelected ? "Apply changes" : `Select ${shown.name}`}
                </Button>
              )}
            </div>
            <p className="mt-3 text-[11px] text-ink-3">Applies to the simulator, training and replays. The Hardware Bridge keeps using config/robot_profile.yaml.</p>
          </div>
        </section>
      )}

      {/* ------------------------------------------------ gallery */}
      {state && (
        <section aria-label="Robot gallery">
          <div className="mb-3 flex items-end justify-between px-1">
            <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">All robots</h2>
            <span className="text-[11.5px] text-ink-3">Arrow keys move between robots · Enter shows details</span>
          </div>
          <div role="listbox" aria-label="Robots" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            {robots.map((r, i) => (
              <RobotCard key={r.id} robot={r.id === "custom" ? customPreview(r, custom) : r} focused={focus === r.id} selected={selectedId === r.id}
                refCb={(el) => { cards.current[i] = el; }} onKeyDown={(e) => onCardKey(e, i)}
                onClick={() => { setFocus(r.id); setProblem(null); window.scrollTo?.({ top: 0 }); document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" }); }} />
            ))}
          </div>
          <p className="mt-4 px-1 text-[11.5px] text-ink-3">
            Models are procedural (built from geometric primitives in this app) and drawn inside each robot's collision footprint.{" "}
            <Link to="/simulation" className="text-[#c4bcff] hover:text-ink">Open Live Simulation</Link>
          </p>
        </section>
      )}
    </div>
  );
}

function RobotCard({ robot, focused, selected, onClick, onKeyDown, refCb }: {
  robot: RobotProfile; focused: boolean; selected: boolean; onClick: () => void; onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void; refCb: (el: HTMLButtonElement | null) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button ref={refCb} role="option" aria-selected={focused} tabIndex={focused ? 0 : -1} onClick={onClick} onKeyDown={onKeyDown}
      onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}
      className={clsx("tile group relative flex flex-col overflow-hidden rounded-2xl text-left", focused && "!shadow-[inset_0_0_0_1px_#8b7cf6,0_18px_40px_-24px_#8b7cf680]")}>
      <div className="relative h-[170px] bg-[radial-gradient(260px_160px_at_50%_70%,#8b7cf61f,transparent_70%)]">
        <Stage robot={robot} live={hover} zoom={robot.visual.model === "courier" ? 1.25 : 0.95} />
        {selected && <span className="absolute right-3 top-3"><Badge tone="good">Selected</Badge></span>}
      </div>
      <div className="px-4 pb-4 pt-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[15px] font-semibold text-ink">{robot.name}</span>
          <span className="text-[11px] text-ink-3">{robot.radius.toFixed(2)} m</span>
        </div>
        <div className="text-[12px] text-ink-3">{robot.kind}</div>
        <p className={clsx("mt-2 text-[12px] leading-relaxed text-ink-2 transition-all duration-300", hover || focused ? "max-h-24 opacity-100" : "max-h-0 opacity-0 md:max-h-0")}>
          {robot.tagline}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[10.5px] text-ink-2">{robot.action_set === "holonomic8" ? "Holonomic" : "Forward + turn"}</span>
          <span className={clsx("rounded-md px-1.5 py-0.5 text-[10.5px]", robot.training ? "bg-[#3fb9501a] text-good" : "bg-white/[0.05] text-ink-3")}>{robot.training ? "Trainable" : "Planner only"}</span>
        </div>
      </div>
    </button>
  );
}

function CustomEditor({ value: c, onChange, error }: { value: CustomRobot; onChange: (c: CustomRobot) => void; error: string | null }) {
  const set = <K extends keyof CustomRobot>(k: K, v: CustomRobot[K]) => onChange({ ...c, [k]: v });
  const setV = <K extends keyof CustomRobot["visual"]>(k: K, v: CustomRobot["visual"][K]) => onChange({ ...c, visual: { ...c.visual, [k]: v } });
  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-[#8b7cf633] bg-[#8b7cf60a] p-3">
        <div className="mb-2 text-[12px] font-medium text-[#c4bcff]">Affects navigation</div>
        <div className="space-y-2.5">
          <Field label="Drive">
            <Segmented value={c.drive} onChange={(v) => set("drive", v)} options={[{ value: "differential", label: "Differential" }, { value: "skid_steer", label: "Skid-steer" }]} />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Footprint (m)"><NumberInput value={c.radius} min={0.1} max={0.3} step={0.01} onChange={(v) => v !== null && set("radius", v)} /></Field>
            <Field label="Speed (m/s)"><NumberInput value={c.max_linear} min={0.05} max={0.3} step={0.01} onChange={(v) => v !== null && set("max_linear", v)} /></Field>
            <Field label="Turn (rad/s)"><NumberInput value={c.max_angular} min={0.3} max={1.5} step={0.1} onChange={(v) => v !== null && set("max_angular", v)} /></Field>
          </div>
          <p className="text-[11px] text-ink-3">Sensor stays the standard 24-beam LiDAR so learned policies keep a valid input.</p>
        </div>
      </div>
      <div className="rounded-xl border border-line p-3">
        <div className="mb-2 text-[12px] font-medium text-ink-2">Visual only</div>
        <div className="space-y-2.5">
          <Field label="Name"><TextInput value={c.name} maxLength={40} onChange={(e) => set("name", e.target.value)} /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Colour">
              <input type="color" value={c.visual.color} onChange={(e) => setV("color", e.target.value)} aria-label="Body colour"
                className="h-8 w-full cursor-pointer rounded-lg border border-line-strong bg-surface-2" />
            </Field>
            <Field label="Body">
              <Segmented size="sm" value={c.visual.body} onChange={(v) => setV("body", v)} options={[{ value: "round", label: "Round" }, { value: "box", label: "Box" }]} />
            </Field>
            <Field label="Height (m)"><NumberInput value={c.visual.height} min={0.08} max={0.5} step={0.01} onChange={(v) => v !== null && setV("height", v)} /></Field>
          </div>
        </div>
      </div>
      {error && <div className="text-[12px] text-bad md:col-span-2">{error}</div>}
    </div>
  );
}
