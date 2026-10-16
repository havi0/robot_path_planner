import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown, ArrowUp, Box, Crosshair, Eraser, Flag, Grid3x3, Hand, LayoutPanelLeft, MapPin, Orbit, Pause, Play, Radar, RotateCcw, Route, Save, ScanLine, Shield, Shuffle, SkipForward, Spline, Square, Trash2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { SimCanvas, type Tool } from "../components/sim/SimCanvas";
import { Scene3DView } from "../components/three/Scene3DView";
import { COMPAT_LABEL } from "../components/workflow/WorkflowSteps";
import { Button } from "../components/ui/button";
import { Field, NumberInput, Select, Switch, TextInput } from "../components/ui/controls";
import { Badge, Kbd, Skeleton, Tooltip } from "../components/ui/feedback";
import { ConfirmDialog, Dialog, useAction } from "../components/ui/overlay";
import { BUILTIN_LAYOUTS, TELEMETRY_FIELDS, type PanelId, type TelemetryField, type WorkspaceLayout } from "../lib/prefs";
import { KeyValue, Panel } from "../components/ui/panel";
import { api } from "../lib/api";
import { research } from "../lib/research-api";
import type { ReliabilityReport } from "../lib/research-types";
import { ValidationBadge } from "./Reliability";
import { Link } from "react-router-dom";
import { fmt, humanize, int, isTypingTarget, pct } from "../lib/format";
import { useLive } from "../lib/live";
import { updatePrefs, usePrefs } from "../lib/prefs";
import type { SimConfig, SimSnapshot } from "../lib/types";

const SPEEDS = [
  { sps: 4, label: "1×" },
  { sps: 8, label: "2×" },
  { sps: 20, label: "5×" },
  { sps: 80, label: "20×" },
  { sps: 400, label: "100×" },
];

function ToolBtn({ active, onClick, icon, label, kbd, disabled }: { active?: boolean; onClick: () => void; icon: ReactNode; label: string; kbd?: string; disabled?: boolean }) {
  return (
    <Tooltip content={<span>{label} {kbd && <Kbd>{kbd}</Kbd>}</span>} side="bottom">
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        className={clsx(
          "flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:opacity-35",
          active ? "border-[#8b7cf655] bg-violet-soft text-[#c4bcff]" : "border-transparent text-ink-3 hover:bg-surface-3 hover:text-ink",
        )}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

const Divider = () => <div className="mx-1 h-5 w-px bg-line" />;

export function LiveSimulation() {
  const sim = useLive((s) => s.sim);
  const connection = useLive((s) => s.connection);
  const prefs = usePrefs();
  const run = useAction();
  const [tool, setToolState] = useState<Tool>("pan");
  const view = prefs.sim.view ?? "3d";
  const setView = (v: "3d" | "2d") => updatePrefs((p) => ({ ...p, sim: { ...p.sim, view: v } }));
  const setTool = (t: Tool) => { setToolState(t); if (t !== "pan" && view === "3d") setView("2d"); };
  const [rel, setRel] = useState<ReliabilityReport | null>(null);
  const activeModel = useLive((s) => s.models?.dqn?.path);
  useEffect(() => { research.reliability().then(setRel).catch(() => setRel(null)); }, [activeModel]);
  const [confirmClear, setConfirmClear] = useState(false);
  const online = connection === "online";

  const status = sim?.status ?? "idle";
  const running = status === "running";

  const primary = () => {
    if (!sim) return;
    if (status === "running") run(() => api.sim.control("pause"));
    else if (status === "paused") run(() => api.sim.control("resume"));
    else run(() => api.sim.control("start"));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.key === " ") { e.preventDefault(); primary(); }
      else if (e.key === "s" && status !== "running" && status !== "finished") run(() => api.sim.control("step"));
      else if (e.key === "r") run(() => api.sim.control("reset"));
      else if (e.key === "n") run(() => api.sim.control("regenerate"));
      else if (e.key === "g") setTool("goal");
      else if (e.key === "Escape") setTool("pan");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onTool = (kind: Exclude<Tool, "pan">, d: number[]) => {
    if (running) {
      run(async () => { throw new Error("Pause the simulation before editing the map"); });
      return;
    }
    if (kind === "goal") run(() => api.sim.goal(d[0], d[1]), "Goal moved");
    if (kind === "start") run(() => api.sim.start(d[0], d[1]), "Start moved");
    if (kind === "add") run(() => api.sim.addObstacle(d), "Obstacle added");
    if (kind === "remove") run(() => api.sim.removeObstacle(d[0], d[1]), "Obstacle removed");
  };

  const toggle = (k: keyof typeof prefs.sim) => updatePrefs((p) => ({ ...p, sim: { ...p.sim, [k]: !p.sim[k] } }));

  return (
    <div className="flex h-full min-h-[640px] gap-4 p-4">
      {/* -------- viewport -------- */}
      <section className="panel flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
          <Button variant="primary" size="md" disabled={!sim || !online} onClick={primary}
            icon={running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}>
            {running ? "Pause" : status === "paused" ? "Resume" : status === "finished" ? "Restart" : "Start"}
          </Button>
          <ToolBtn label="Step one action" kbd="S" icon={<SkipForward className="h-4 w-4" />} disabled={!sim || running || status === "finished" || !online} onClick={() => run(() => api.sim.control("step"))} />
          <ToolBtn label="Reset episode" kbd="R" icon={<RotateCcw className="h-4 w-4" />} disabled={!sim || !online} onClick={() => run(() => api.sim.control("reset"))} />
          <ToolBtn label="Regenerate environment" kbd="N" icon={<Shuffle className="h-4 w-4" />} disabled={!sim || !online} onClick={() => run(() => api.sim.control("regenerate"), "New environment generated")} />
          <Divider />
          <div className="inline-flex rounded-lg border border-line-strong bg-surface-2 p-0.5" role="radiogroup" aria-label="Simulation speed">
            {SPEEDS.map((s) => (
              <button key={s.sps} role="radio" aria-checked={sim?.speed === s.sps} disabled={!online}
                onClick={() => { updatePrefs((p) => ({ ...p, sim: { ...p.sim, speed: s.sps } })); run(() => api.sim.speed(s.sps)); }}
                className={clsx("mono h-7 rounded-md px-2 text-[11px]", sim?.speed === s.sps ? "bg-surface-3 text-ink shadow-[0_0_0_1px_#2f3440]" : "text-ink-3 hover:text-ink-2")}>
                {s.label}
              </button>
            ))}
          </div>
          <Divider />
          <div className="inline-flex rounded-lg border border-line-strong bg-surface-2 p-0.5" role="radiogroup" aria-label="Viewport">
            {(["3d", "2d"] as const).map((v) => (
              <button key={v} role="radio" aria-checked={view === v} onClick={() => setView(v)} title={v === "3d" ? "3D view (orbit with mouse)" : "2D editor (map editing tools)"}
                className={clsx("inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium", view === v ? "bg-surface-3 text-ink shadow-[0_0_0_1px_#2f3440]" : "text-ink-3 hover:text-ink-2")}>
                {v === "3d" ? <Box className="h-3.5 w-3.5" /> : <Grid3x3 className="h-3.5 w-3.5" />}{v.toUpperCase()}
              </button>
            ))}
          </div>
          <Divider />
          <ToolBtn label="Trajectory" active={prefs.sim.showTrail} icon={<Spline className="h-4 w-4" />} onClick={() => toggle("showTrail")} />
          <ToolBtn label="Sensor rays" active={prefs.sim.showSensors} icon={<Radar className="h-4 w-4" />} onClick={() => toggle("showSensors")} />
          <ToolBtn label="Coordinate grid" active={prefs.sim.showGrid} icon={<Grid3x3 className="h-4 w-4" />} onClick={() => toggle("showGrid")} />
          <ToolBtn label="A* reference path" active={prefs.sim.showReference} icon={<Route className="h-4 w-4" />} onClick={() => toggle("showReference")} />
          <Divider />
          <ToolBtn label="Pan / zoom" kbd="Esc" active={tool === "pan"} icon={<Hand className="h-4 w-4" />} onClick={() => setTool("pan")} />
          <ToolBtn label="Set goal (click)" kbd="G" active={tool === "goal"} icon={<Flag className="h-4 w-4" />} onClick={() => setTool("goal")} />
          <ToolBtn label="Set start (click)" active={tool === "start"} icon={<MapPin className="h-4 w-4" />} onClick={() => setTool("start")} />
          <ToolBtn label="Add obstacle (drag)" active={tool === "add"} icon={<Square className="h-4 w-4" />} onClick={() => setTool("add")} />
          <ToolBtn label="Remove obstacle (click)" active={tool === "remove"} icon={<Eraser className="h-4 w-4" />} onClick={() => setTool("remove")} />
          <ToolBtn label="Clear all obstacles" icon={<Trash2 className="h-4 w-4" />} disabled={!sim || running || !sim.world.rects.length} onClick={() => setConfirmClear(true)} />
        </div>
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-2/40 px-3 py-1.5">
          <span className="eyebrow">Controller</span>
          <div className="w-[190px]">
            <Select
              value={sim?.policy ?? "dqn_recovery"}
              disabled={!sim || running || !online}
              onChange={(v) => run(() => api.sim.policy(v), `Policy: ${sim?.policies[v]}`)}
              options={Object.entries(sim?.policies ?? { dqn_recovery: "DQN + recovery" }).map(([value, label]) => {
                const c = sim?.policy_compat?.[value];
                return { value, label: c?.status === "incompatible" ? `${label} - incompatible with this robot` : c?.status === "unavailable" ? `${label} - no model loaded` : label,
                  disabled: c?.status === "incompatible" };
              })}
            />
          </div>
          {sim?.robot_profile && (
            <Link to="/robots" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[12px] text-ink-2 hover:text-ink" title={`${sim.robot_profile.kind} - change robot`}>
              <span className="h-2 w-2 rounded-full" style={{ background: sim.robot_profile.visual.color }} />{sim.robot_profile.name}
            </Link>
          )}
          {sim?.policy_compat?.[sim.policy] && sim.policy_compat[sim.policy].status !== "planner" && (
            <Tooltip content={sim.policy_compat[sim.policy].detail} side="bottom">
              <span className={clsx("inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[12px]",
                sim.policy_compat[sim.policy].status === "trained" ? "border-[#3fb95055] text-good" : "border-[#e3b34155] text-warn")} data-learn="policy-compat">
                {COMPAT_LABEL[sim.policy_compat[sim.policy].status].text}
              </span>
            </Tooltip>
          )}
          <Tooltip content="Safety layer: blocks motion into obstacles and enforces velocity limits" side="bottom">
            <button
              onClick={() => sim && run(() => api.sim.shield(!sim.shield))}
              disabled={!sim || !online}
              className={clsx("inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[12px]", sim?.shield ? "border-[#3fb95055] bg-[#3fb95014] text-good" : "border-line-strong text-ink-3 hover:text-ink-2")}
            >
              <Shield className="h-3.5 w-3.5" /> Safety shield {sim?.shield ? "on" : "off"}
            </button>
          </Tooltip>
          {sim && ["dqn", "dqn_recovery"].includes(sim.policy) && rel?.validation && (
            <Link to="/reliability" className="inline-flex items-center gap-1.5" title={rel.validation[sim.policy]?.reasons.join("; ")}>
              <ValidationBadge v={rel.validation[sim.policy]} />
            </Link>
          )}
          {running && <span className="text-[11px] text-ink-3">Pause to change policy or edit the map</span>}
          {sim && <span className="ml-auto text-[11.5px] text-ink-3">{sim.world.width.toFixed(1)} × {sim.world.height.toFixed(1)} m map · seed <span className="mono">{sim.config.seed}</span> · episode <span className="mono">{sim.episode}</span> · {sim.world.rects.length} obstacles</span>}
        </div>

        <div className="relative min-h-0 flex-1">
          {sim ? (
            <>
              {view === "3d" ? (
                <>
                  <Scene3DView variant="studio" world={sim.world} robot={sim.robot} robotVisual={sim.robot_profile?.visual} trail={sim.trail} sensor={sim.sensor} plannedPath={sim.planned_path}
                    referencePath={sim.reference_path} collisions={sim.collisions} outcome={sim.outcome} active={running}
                    showSensors={prefs.sim.showSensors} showTrail={prefs.sim.showTrail} showReference={prefs.sim.showReference} cameraMode={prefs.sim.camera ?? "orbit"}
                    fallback={<SimCanvas world={sim.world} robot={sim.robot} robotStep={sim.episode * 100000 + sim.telemetry.steps} trail={sim.trail} sensor={sim.sensor}
                      plannedPath={sim.planned_path} referencePath={sim.reference_path} collisions={sim.collisions} outcome={sim.outcome}
                      options={{ grid: prefs.sim.showGrid, trail: prefs.sim.showTrail, sensors: prefs.sim.showSensors, reference: prefs.sim.showReference }} active={running} showControls />} />
                  <CameraBar />
                </>
              ) : (
              <SimCanvas
                world={sim.world}
                robot={sim.robot}
                robotStep={sim.episode * 100000 + sim.telemetry.steps}
                trail={sim.trail}
                sensor={sim.sensor}
                plannedPath={sim.planned_path}
                referencePath={sim.reference_path}
                collisions={sim.collisions}
                outcome={sim.outcome}
                options={{ grid: prefs.sim.showGrid, trail: prefs.sim.showTrail, sensors: prefs.sim.showSensors, reference: prefs.sim.showReference }}
                tool={tool}
                onTool={onTool}
                active={running}
                showControls
              />
              )}
              <StatusOverlay sim={sim} beginner={prefs.uiMode === "beginner"} />
              <Legend sim={sim} showRef={prefs.sim.showReference} />
            </>
          ) : (
            <div className="flex h-full items-center justify-center"><Skeleton className="h-3/4 w-3/4" /></div>
          )}
        </div>
      </section>

      {/* -------- side panels -------- */}
      <aside className="flex w-[330px] shrink-0 flex-col gap-4 overflow-y-auto">
        <LayoutBar />
        {prefs.workspace.layout.panels.map((pid) =>
          pid === "telemetry" ? <Telemetry key={pid} sim={sim} fields={prefs.workspace.layout.telemetry} />
            : pid === "analysis" ? <PathAnalysis key={pid} sim={sim} />
              : <EnvironmentConfig key={pid} sim={sim} disabled={!online || running} />)}
      </aside>

      <ConfirmDialog open={confirmClear} onClose={() => setConfirmClear(false)} title="Remove all obstacles?" danger confirmLabel="Clear obstacles"
        onConfirm={() => run(() => api.sim.clearObstacles(), "Obstacles cleared")}>
        This removes every static obstacle from the current map. Regenerate the environment to get a random map again.
      </ConfirmDialog>
    </div>
  );
}

/** 3D camera presets (view only). */
function CameraBar() {
  const prefs = usePrefs();
  const cam = prefs.sim.camera ?? "orbit";
  const set = (c: "orbit" | "top" | "follow") => updatePrefs((p) => ({ ...p, sim: { ...p.sim, camera: c } }));
  const items = [
    { v: "orbit" as const, label: "Perspective", icon: <Orbit className="h-3.5 w-3.5" /> },
    { v: "top" as const, label: "Top-down", icon: <ScanLine className="h-3.5 w-3.5" /> },
    { v: "follow" as const, label: "Follow robot", icon: <Crosshair className="h-3.5 w-3.5" /> },
  ];
  return (
    <div className="absolute right-3 top-3 flex flex-col items-end gap-1.5">
      <div className="flex gap-0.5 rounded-xl border border-white/[0.07] bg-[#0d0e13]/75 p-1 backdrop-blur-md" role="radiogroup" aria-label="Camera">
        {items.map((i) => (
          <button key={i.v} role="radio" aria-checked={cam === i.v} onClick={() => set(i.v)} title={i.label}
            className={clsx("inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11.5px]", cam === i.v ? "bg-white/[0.08] text-ink" : "text-ink-3 hover:text-ink-2")}>
            {i.icon}<span className="hidden xl:inline">{i.label}</span>
          </button>
        ))}
      </div>
      <span className="pointer-events-none rounded-md bg-[#0d0e13]/60 px-2 py-0.5 text-[10.5px] text-ink-3">Drag to orbit · scroll to zoom · right-drag to pan</span>
    </div>
  );
}

function StatusOverlay({ sim, beginner }: { sim: SimSnapshot; beginner: boolean }) {
  const tone = sim.status === "running" ? "violet" : sim.status === "paused" ? "warn" : sim.status === "finished" ? "muted" : "muted";
  const banner = sim.outcome && {
    success: { text: "Goal reached", cls: "border-[#3fb95066] text-good", sub: `${sim.telemetry.steps} actions · ${fmt(sim.analysis.traveled)} m` },
    collision: { text: "Collision detected by the simulator", cls: "border-[#f0524f66] text-bad",
      sub: `${sim.collision_cause?.cause ?? "contact"} · after ${sim.telemetry.steps} actions${sim.shield ? "" : " · safety shield was OFF"}` },
    timeout: { text: "Episode timed out", cls: "border-[#e3b34166] text-warn", sub: `${sim.telemetry.max_steps} action limit` },
  }[sim.outcome];
  return (
    <>
      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
        <Badge tone={tone} pulse={sim.status === "running"}>{sim.status.toUpperCase()}</Badge>
        <Badge tone="info">{sim.policies[sim.policy]}</Badge>
        {sim.shield && <Badge tone="good">Shield</Badge>}
        {sim.telemetry.safety.length > 0 && <Badge tone="warn">{humanize(sim.telemetry.safety[0])}</Badge>}
      </div>
      {beginner && !sim.outcome && (sim.status === "idle" || sim.status === "paused") && (
        <div className="pointer-events-none absolute bottom-12 left-1/2 w-max max-w-[calc(100%-24px)] -translate-x-1/2 rounded-lg bg-[#111317]/90 px-3 py-1.5 text-center text-[12px] text-ink-2 backdrop-blur">
          {sim.status === "idle"
            ? "Press Start (Space) to let the policy drive to the green goal · use the toolbar to move the goal or add obstacles"
            : "Paused · press Resume to continue, or Step to advance one action at a time"}
        </div>
      )}
      <AnimatePresence>
        {banner && (
          <motion.div
            key={sim.episode + (sim.outcome ?? "")}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={clsx("pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-xl border bg-[#111317]/95 px-5 py-2.5 text-center shadow-2xl backdrop-blur", banner.cls)}
          >
            <div className="text-[14px] font-semibold">{banner.text}</div>
            <div className="mono text-[11px] text-ink-3">{banner.sub}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function Legend({ sim, showRef }: { sim: SimSnapshot; showRef: boolean }) {
  const item = (el: ReactNode, label: string) => (
    <span className="inline-flex items-center gap-1.5">{el}{label}</span>
  );
  return (
    <div className="pointer-events-none absolute bottom-2.5 left-1/2 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-4 gap-y-1 rounded-lg border border-line bg-[#0b0c0f]/85 px-3 py-1.5 text-[11px] text-ink-2 backdrop-blur">
      {item(<span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-violet bg-[#17142b]" />, "Robot")}
      {item(<span className="h-[2px] w-4 bg-violet/60" />, "Trajectory")}
      {sim.planned_path.length > 0 && item(<span className="h-0 w-4 border-t-2 border-dashed border-cyan" />, "Planned path")}
      {showRef && item(<span className="h-0 w-4 border-t border-dotted border-cyan" />, "A* reference")}
      {item(<span className="h-2 w-2 rotate-45 border-[1.5px] border-[#8a909c]" />, "Start")}
      {item(<span className="h-2.5 w-2.5 rounded-full border border-dashed border-good" />, "Goal")}
      {item(<span className="h-2.5 w-2.5 rounded-sm border border-[#383f4b] bg-[#1d2129]" />, "Obstacle")}
      {sim.world.movers.length > 0 && item(<span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-serious bg-[#262a33]" />, "Moving obstacle")}
      {(sim.world.timed?.length ?? 0) > 0 && item(<span className="h-2.5 w-2.5 rounded-sm border border-dashed border-warn" />, "Temporary blockage")}
      {sim.collisions.length > 0 && item(<span className="text-[11px] font-bold leading-none text-bad">×</span>, "Collision")}
    </div>
  );
}

const PANEL_NAMES: Record<PanelId, string> = { telemetry: "Live telemetry", analysis: "Path analysis", environment: "Environment" };
const FIELD_NAMES: Record<TelemetryField, string> = { pose: "Pose (x, y, θ)", distance: "Distance to goal", action: "Current action", reward: "Episode reward",
  steps: "Steps taken", collision: "Collision", rate: "Simulation rate", safety: "Safety layer" };

/** Saved workspace layouts: which side panels show, in which order, and which telemetry fields. */
function LayoutBar() {
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<WorkspaceLayout>(prefs.workspace.layout);
  const [name, setName] = useState("");
  const all = { ...BUILTIN_LAYOUTS, ...prefs.workspace.saved };
  const apply = (n: string) => updatePrefs((p) => ({ ...p, workspace: { ...p.workspace, active: n, layout: all[n] } }));
  const move = (i: number, d: number) => {
    const ps = [...draft.panels];
    const j = i + d;
    if (j < 0 || j >= ps.length) return;
    [ps[i], ps[j]] = [ps[j], ps[i]];
    setDraft({ ...draft, panels: ps });
  };
  return (
    <div className="flex items-center gap-1.5">
      <LayoutPanelLeft className="h-4 w-4 shrink-0 text-ink-3" />
      <div className="min-w-0 flex-1"><Select value={prefs.workspace.active in all ? prefs.workspace.active : "Default"} onChange={apply} options={Object.keys(all).map((k) => ({ value: k, label: k }))} /></div>
      <Button size="sm" variant="outline" onClick={() => { setDraft(prefs.workspace.layout); setName(""); setOpen(true); }}>Customize</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Workspace layout" width={480} footer={<>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="secondary" onClick={() => { updatePrefs((p) => ({ ...p, workspace: { ...p.workspace, layout: draft, active: "Custom (unsaved)" } })); setOpen(false); }}>Apply</Button>
        <Button variant="primary" disabled={!name.trim() || name.trim() in BUILTIN_LAYOUTS} icon={<Save className="h-3.5 w-3.5" />}
          onClick={() => { const n = name.trim(); updatePrefs((p) => ({ ...p, workspace: { active: n, layout: draft, saved: { ...p.workspace.saved, [n]: draft } } })); setOpen(false); }}>Save as layout</Button></>}>
        <div className="eyebrow mb-2">Panels (order & visibility)</div>
        <div className="space-y-1.5">
          {(["telemetry", "analysis", "environment"] as PanelId[]).sort((a, b) => (draft.panels.indexOf(a) + 9 * +(draft.panels.indexOf(a) < 0)) - (draft.panels.indexOf(b) + 9 * +(draft.panels.indexOf(b) < 0))).map((pid) => {
            const i = draft.panels.indexOf(pid);
            return (
              <div key={pid} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5">
                <div className="flex-1"><Switch checked={i >= 0} label={PANEL_NAMES[pid]} onChange={(v) => setDraft({ ...draft, panels: v ? [...draft.panels, pid] : draft.panels.filter((x) => x !== pid) })} /></div>
                <button disabled={i <= 0} onClick={() => move(i, -1)} className="rounded p-1 text-ink-3 hover:text-ink disabled:opacity-30" aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></button>
                <button disabled={i < 0 || i >= draft.panels.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-ink-3 hover:text-ink disabled:opacity-30" aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></button>
              </div>
            );
          })}
        </div>
        <div className="eyebrow mb-2 mt-4">Telemetry fields</div>
        <div className="grid grid-cols-2 gap-2">
          {TELEMETRY_FIELDS.map((f) => (
            <label key={f} className="flex items-center gap-2 text-[12.5px] text-ink-2">
              <input type="checkbox" className="accent-[#8b7cf6]" checked={draft.telemetry.includes(f)}
                onChange={(e) => setDraft({ ...draft, telemetry: e.target.checked ? [...draft.telemetry, f] : draft.telemetry.filter((x) => x !== f) })} />
              {FIELD_NAMES[f]}
            </label>
          ))}
        </div>
        <div className="mt-4"><Field label="Layout name (to save)"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lecture demo" /></Field></div>
      </Dialog>
    </div>
  );
}

function Telemetry({ sim, fields }: { sim: SimSnapshot | null; fields: TelemetryField[] }) {
  const t = sim?.telemetry;
  const has = (f: TelemetryField) => fields.includes(f);
  return (
    <Panel title="Live telemetry" eyebrow="Robot state" dense actions={sim && <span className="mono text-[10.5px] text-ink-3">{t?.sim_hz ?? 0} Hz</span>}>
      {!t ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-4" />)}</div>
      ) : (
        <>
          {has("pose") && <div className="grid grid-cols-3 gap-2 pb-2">
            {[["X", fmt(t.x), "m"], ["Y", fmt(t.y), "m"], ["θ", fmt(t.heading_deg, 1), "°"]].map(([k, v, u]) => (
              <div key={k} className="rounded-lg border border-line bg-surface-2 px-2.5 py-2">
                <div className="eyebrow">{k}</div>
                <div className="mono mt-0.5 text-[15px] text-ink">{v}<span className="ml-0.5 text-[10px] text-ink-3">{u}</span></div>
              </div>
            ))}
          </div>}
          {has("distance") && <KeyValue label="Distance to goal" value={`${fmt(t.distance_to_goal)} m`} />}
          {has("action") && <KeyValue label="Current action" value={t.action ? humanize(t.action) : "—"} />}
          {has("reward") && <KeyValue label="Episode reward" value={fmt(t.reward)} tone={t.reward >= 0 ? undefined : "muted"} />}
          {has("steps") && <KeyValue label="Steps taken" value={`${t.steps} / ${t.max_steps}`} />}
          {has("collision") && <KeyValue label="Collision" value={t.collision ? "YES" : "no"} tone={t.collision ? "bad" : "good"} />}
          {has("rate") && <KeyValue label="Simulation rate" value={`${t.sim_hz} steps/s`} />}
          {has("safety") && <KeyValue label="Safety layer" value={sim.shield ? (t.safety.length ? humanize(t.safety.join(", ")) : "nominal") : "off"} tone={sim.shield ? (t.safety.length ? "warn" : "good") : "muted"} />}
        </>
      )}
    </Panel>
  );
}

function PathAnalysis({ sim }: { sim: SimSnapshot | null }) {
  const a = sim?.analysis;
  return (
    <Panel title="Path analysis" eyebrow="This episode" dense>
      {!a || !sim ? (
        <Skeleton className="h-24" />
      ) : (
        <>
          <KeyValue label="Traveled distance" value={`${fmt(a.traveled)} m`} />
          <KeyValue label="A* reference (known map)" value={a.reference_length !== null ? `${fmt(a.reference_length)} m` : "no path"} tone="muted" />
          <KeyValue label="Path / reference" value={a.path_ratio !== null ? `${fmt(a.path_ratio)}×` : sim.outcome === "success" ? "—" : "after success"} />
          <KeyValue label="Number of turns" value={int(a.turns)} />
          <KeyValue label="Min. obstacle clearance" value={a.min_clearance !== null ? `${fmt(a.min_clearance, 3)} m` : "—"} tone={a.min_clearance !== null && a.min_clearance < 0.05 ? "warn" : undefined} />
          <KeyValue label="Goal status" value={sim.outcome ? sim.outcome : sim.status === "idle" ? "not started" : "in progress"}
            tone={sim.outcome === "success" ? "good" : sim.outcome === "collision" ? "bad" : sim.outcome === "timeout" ? "warn" : "muted"} />
          {a.plan && (
            <div className="mt-2 rounded-lg border border-line bg-surface-2 p-2.5">
              <div className="eyebrow mb-1">Planner (known map)</div>
              <KeyValue label="Plan length" value={a.plan.length !== null ? `${fmt(a.plan.length)} m` : "no path"} />
              <KeyValue label="Planning time" value={`${fmt(a.plan.time_ms, 1)} ms`} />
              <KeyValue label="Nodes expanded" value={int(a.plan.nodes_expanded)} />
            </div>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
            <Crosshair className="mr-1 inline h-3 w-3" />Solid violet = what the robot actually drove. Dashed cyan = a planner's path computed from the full map.
          </p>
        </>
      )}
    </Panel>
  );
}

function EnvironmentConfig({ sim, disabled }: { sim: SimSnapshot | null; disabled: boolean }) {
  const run = useAction();
  const [form, setForm] = useState<SimConfig | null>(null);
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (sim && !form) setForm(sim.config);
  }, [sim, form]);
  if (!sim || !form) return <Panel title="Environment" dense><Skeleton className="h-40" /></Panel>;
  const set = (k: keyof SimConfig) => (v: number | null, ok: boolean) => {
    setForm({ ...form, [k]: v } as SimConfig);
    setInvalid({ ...invalid, [k]: !ok });
  };
  const hasErr = Object.values(invalid).some(Boolean);
  const dirty = JSON.stringify(form) !== JSON.stringify(sim.config);
  return (
    <Panel title="Environment" eyebrow="Configuration" dense
      actions={<Tooltip content="Random seed" side="bottom"><button className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={() => setForm({ ...form, seed: Math.floor(Math.random() * 2_000_000) })} aria-label="Random seed"><Shuffle className="h-3.5 w-3.5" /></button></Tooltip>}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        <Field label="Width (m)" error={invalid.width ? "3 – 12" : null}><NumberInput value={form.width} min={3} max={12} onChange={set("width")} /></Field>
        <Field label="Height (m)" error={invalid.height ? "3 – 12" : null}><NumberInput value={form.height} min={3} max={12} onChange={set("height")} /></Field>
        <Field label="Obstacle density" hint="Fraction of the floor covered by obstacles (ignored if a count is set)" error={invalid.density ? "0 – 0.35" : null}>
          <NumberInput value={form.density} min={0} max={0.35} step={0.05} onChange={set("density")} />
        </Field>
        <Field label="Obstacle count" hint="Exact number of rectangles. Leave empty to use density." error={invalid.num_obstacles ? "0 – 80, integer" : null}>
          <NumberInput value={form.num_obstacles} min={0} max={80} integer allowEmpty placeholder="auto" onChange={set("num_obstacles")} />
        </Field>
        <Field label="Max linear (m/s)" hint="Forward speed. The policy was trained at 0.30 m/s." error={invalid.max_linear ? "0.05 – 0.30" : null}>
          <NumberInput value={form.max_linear} min={0.05} max={0.3} step={0.05} onChange={set("max_linear")} />
        </Field>
        <Field label="Max angular (rad/s)" hint="Turn rate. The policy was trained at 1.2 rad/s." error={invalid.max_angular ? "0.3 – 1.5" : null}>
          <NumberInput value={form.max_angular} min={0.3} max={1.5} step={0.1} onChange={set("max_angular")} />
        </Field>
        <Field label="Dynamic obstacles" hint="Moving circular obstacles (never seen in training)" error={invalid.dynamic_obstacles ? "0 – 8" : null}>
          <NumberInput value={form.dynamic_obstacles} min={0} max={8} integer onChange={set("dynamic_obstacles")} />
        </Field>
        <Field label="Random seed" error={invalid.seed ? "non-negative integer" : null}>
          <NumberInput value={form.seed} min={0} max={2 ** 31 - 1} integer onChange={set("seed")} />
        </Field>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-3">Start and goal are placed by the generator; move them with the <MapPin className="inline h-3 w-3" /> and <Flag className="inline h-3 w-3" /> tools.</p>
      <div className="mt-3 flex gap-2">
        <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => { setForm(sim.config); setInvalid({}); }}>Revert</Button>
        <Button variant="primary" size="sm" className="flex-1" disabled={disabled || hasErr || !dirty} loading={busy}
          onClick={async () => { setBusy(true); const r = await run(() => api.sim.config(form), "Environment applied"); setBusy(false); if (r) setForm(r.config); }}>
          {disabled && !hasErr ? "Pause to apply" : "Validate & apply"}
        </Button>
      </div>
      <div className="mono mt-2 text-[10px] text-ink-3">density {pct(form.density)} · {form.num_obstacles ?? "auto"} boxes</div>
    </Panel>
  );
}
