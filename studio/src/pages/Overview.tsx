import clsx from "clsx";
import { motion, useScroll, useTransform } from "framer-motion";
import { Activity, AlertTriangle, ArrowRight, ArrowUpRight, Bot, Boxes, CheckCircle2, CircleDot, Cpu, FlaskConical, Info, ListVideo, Map as MapIcon, Play, Rocket, Route, ShieldCheck, Shuffle, XCircle, Zap } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SimCanvas } from "../components/sim/SimCanvas";
import { Scene3DView } from "../components/three/Scene3DView";
import { useTilt } from "../components/ui/tilt";
import { Button } from "../components/ui/button";
import { Collapsible } from "../components/ui/collapsible";
import { Badge, EmptyState, StatusDot } from "../components/ui/feedback";
import { Metric } from "../components/ui/metric";
import { useAction } from "../components/ui/overlay";
import { KeyValue, Panel } from "../components/ui/panel";
import { api, type TrainRequest } from "../lib/api";
import { clock, fmt, int, pct } from "../lib/format";
import { useLive } from "../lib/live";
import { usePrefs } from "../lib/prefs";
import type { EventLevel, Experiment } from "../lib/types";

const PRESETS: { label: string; desc: string; req: TrainRequest }[] = [
  { label: "Quick DQN", desc: "300 episodes · ~2 min", req: { name: "Quick DQN", algorithm: "dqn", episodes: 300, eval_every: 10000 } },
  { label: "Standard DQN", desc: "1,500 episodes · report settings", req: { name: "Standard DQN", algorithm: "dqn", episodes: 1500 } },
  { label: "Q-learning baseline", desc: "3,000 episodes · tabular", req: { name: "Q-learning baseline", algorithm: "qlearning", episodes: 3000, eps_decay: 2000 } },
];

const levelIcon: Record<EventLevel, { icon: typeof Info; cls: string }> = {
  info: { icon: Info, cls: "text-cyan" },
  success: { icon: CheckCircle2, cls: "text-good" },
  warning: { icon: AlertTriangle, cls: "text-warn" },
  error: { icon: XCircle, cls: "text-bad" },
};

export function Overview() {
  const nav = useNavigate();
  const run = useAction();
  const connection = useLive((s) => s.connection);
  const sim = useLive((s) => s.sim);
  const training = useLive((s) => s.training);
  const episodes = useLive((s) => s.episodes);
  const events = useLive((s) => s.events);
  const models = useLive((s) => s.models);
  const hardware = useLive((s) => s.hardware);
  const { uiMode, reduceMotion } = usePrefs();
  const beginner = uiMode === "beginner";
  const [experiments, setExperiments] = useState<Experiment[] | null>(null);
  const lastEvalSeq = events.filter((e) => e.category === "evaluation" || e.category === "training").slice(-1)[0]?.seq ?? 0;

  useEffect(() => {
    api.experiments.list().then(setExperiments).catch(() => setExperiments([]));
  }, [lastEvalSeq]);

  const online = connection === "online";
  const navOnline = online && !!sim && !!models?.dqn;
  const running = training?.status === "running" || training?.status === "paused";

  const trend = useMemo(() => {
    if (episodes.length < 100) return null;
    const a = episodes.slice(-50), b = episodes.slice(-100, -50);
    const rate = (xs: typeof a) => xs.filter((e) => e.outcome === "success").length / xs.length;
    const d = rate(a) - rate(b);
    return { delta: d, goodWhenUp: true, label: `${(d * 100).toFixed(0)} pts vs prev. 50` };
  }, [episodes]);

  const systemRows = (
    <>
            <KeyValue label="Backend API" value={connection} tone={online ? "good" : "bad"} />
            <KeyValue label="Simulation engine" value={sim ? sim.status : "—"} tone={sim ? undefined : "muted"} />
            <KeyValue label="Navigation policy (DQN)" value={models?.dqn ? models.dqn.label : "not loaded"} tone={models?.dqn ? undefined : "warn"} />
            <KeyValue label="Training" value={training?.status ?? "—"} />
            <KeyValue label="Hardware bridge" value={hardware ? (hardware.status === "connected" ? (hardware.simulated ? "loopback (simulated)" : "robot connected") : "disconnected") : "—"}
              tone={hardware?.status === "connected" && !hardware.simulated ? "good" : "muted"} />
            <KeyValue label="ROS 2" value={hardware?.ros2_available ? "available" : "not installed"} tone={hardware?.ros2_available ? "good" : "muted"} />
            <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => nav("/hardware")} icon={<Cpu className="h-3.5 w-3.5" />}>Hardware Bridge</Button>
    </>
  );

  const lastTest = useMemo(() => {
    for (const e of experiments ?? []) {
      const t = e.evaluations.filter((v) => v.kind === "test" && v.results).slice(-1)[0];
      if (t?.results) return { exp: e, res: Object.values(t.results)[0] };
    }
    return null;
  }, [experiments]);

  return (
    <div className="space-y-5 p-4">
      <Hero reduceMotion={reduceMotion} scene={sim ? (
          <Scene3DView variant="hero" world={sim.world} robot={sim.robot} trail={sim.trail} sensor={sim.sensor} plannedPath={sim.planned_path}
            referencePath={sim.reference_path} routeFromReference collisions={sim.collisions} outcome={sim.outcome} active={sim.status === "running"}
            fallback={<div className="absolute inset-y-0 right-0 w-full lg:w-[55%]"><SimCanvas world={sim.world} robot={sim.robot} trail={sim.trail} sensor={sim.sensor} collisions={sim.collisions} outcome={sim.outcome}
              compact active={sim.status === "running"} options={{ grid: true, trail: true, sensors: true }} /></div>} />
        ) : (
          <div className="absolute inset-y-0 right-0 flex w-full items-center lg:w-[55%]">
            <EmptyState icon={<Bot className="h-4 w-4" />} title="Simulation not connected">The live robot appears here once the backend is online.</EmptyState>
          </div>
        )}>
        {sim && (
          <div className="pointer-events-none absolute bottom-5 right-5 z-10 flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-[#0d0e13]/70 px-3 py-2 backdrop-blur-md">
            <Badge tone={sim.status === "running" ? "violet" : "muted"} pulse={sim.status === "running"}>Live · {sim.status}</Badge>
            <span className="text-[11.5px] text-ink-2">{sim.policies[sim.policy]} · episode <span className="mono">{sim.episode}</span></span>
            {sim.reference_path.length > 1 && !sim.planned_path.length && <span className="hidden text-[11px] text-ink-3 md:inline">· blue route = A* reference</span>}
          </div>
        )}
        <div className="relative z-10 flex h-full max-w-[560px] flex-col justify-center px-8 py-12 md:px-12">
          <div className="mb-6 flex items-center gap-2 text-[12px]">
            {navOnline ? (
              <><StatusDot tone="good" pulse /><span className="text-good">Navigation system online · policy loaded</span></>
            ) : (
              <><StatusDot tone={online ? "warn" : "bad"} /><span className="text-ink-2">{online ? "Backend online · no navigation policy loaded" : "Backend offline · start it with python main.py studio"}</span></>
            )}
          </div>
          <div className="mono mb-3 text-[11px] tracking-[0.22em] text-[#b3a9ff]">WELCOME TO NEXUS</div>
          <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
            className="text-[44px] font-semibold leading-[1.02] tracking-[-0.035em] text-ink md:text-[60px]">
            Teach robots<br /><span className="bg-gradient-to-r from-[#e9e5ff] via-[#b9afff] to-[#7fb2ff] bg-clip-text text-transparent">to navigate.</span>
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.08, ease: [0.2, 0.8, 0.2, 1] }}
            className="mt-5 max-w-[440px] text-[15px] leading-relaxed text-ink-2">
            Train a simulated robot to reach goals without hitting obstacles using reinforcement learning, then measure how reliably it navigates.
          </motion.p>
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
            className="mt-8 flex flex-wrap gap-3">
            <Button variant="primary" size="lg" className="h-11 px-5" onClick={() => nav("/simulation")} icon={<Play className="h-4 w-4" />}>Launch Simulation</Button>
            <Button variant="secondary" size="lg" className="h-11 px-5" onClick={() => nav("/training")} icon={<Activity className="h-4 w-4" />}>Open Training Lab</Button>
          </motion.div>
          <div className="mono mt-10 flex flex-wrap gap-x-5 gap-y-1 text-[10.5px] tracking-[0.12em] text-ink-3">
            <span>DEEP Q-NETWORK</span><span>24-BEAM LIDAR</span><span>DIFF-DRIVE</span><span>SAFETY LAYER</span>
          </div>
        </div>
      </Hero>

      {/* -------- performance summary -------- */}
      <Reveal className="grid gap-4 xl:grid-cols-[230px_minmax(0,1fr)]">
        <div className="flex flex-col justify-center px-1 py-2">
          <div className="eyebrow mb-1.5">Performance</div>
          <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">Latest training run</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">Measured from real episodes only. Hover a label to learn what it means.</p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Metric label="Current episode" value={training?.episode ? int(training.episode) : null} accent={running}
            sub={training?.experiment_id ? `${training.algorithm?.toUpperCase()} · ${training.status}` : "no run this session"} icon={<CircleDot className="h-3.5 w-3.5" />}
            empty="Start a training run to see progress" />
          <Metric label="Mean reward" value={training?.mean_reward != null ? fmt(training.mean_reward, 1) : null}
            sub={training?.window ? `last ${training.window} episodes` : "train to populate"} icon={<Zap className="h-3.5 w-3.5" />}
            empty="Appears after training episodes finish" />
          <Metric label="Goal success" value={training?.success_rate != null ? pct(training.success_rate) : null} trend={trend}
            sub={!trend && training?.window ? `last ${training.window} episodes` : !training?.window ? "train to populate" : undefined} icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            empty="Share of episodes reaching the goal" />
          <Metric label="Collision rate" value={training?.collision_rate != null ? pct(training.collision_rate) : null}
            sub={training?.window ? `last ${training.window} episodes` : "train to populate"} icon={<XCircle className="h-3.5 w-3.5" />}
            empty="Share of episodes ending in a crash" />
          <Metric label="Avg path length" value={lastTest?.res.mean_path_length_success != null ? fmt(lastTest.res.mean_path_length_success) : null} unit="m"
            sub={lastTest ? `last evaluation · ${lastTest.exp.name}` : "evaluate a policy"} icon={<Route className="h-3.5 w-3.5" />}
            empty="Press Evaluate in the Training Lab" />
          <Metric label="Training speed" value={training?.status === "running" && training.throughput ? int(training.throughput) : null} unit="steps/s"
            sub={training?.status === "running" ? "measured, 10 s window" : "no active run"} icon={<Rocket className="h-3.5 w-3.5" />}
            empty="Measured while training runs" />
        </div>
      </Reveal>

      {beginner && <Reveal><GettingStarted /></Reveal>}

      <Reveal className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {/* -------- activity -------- */}
        <Panel className="self-start" title="Recent activity" eyebrow="Event stream" actions={<span className="mono text-[10.5px] text-ink-3">{events.length} events</span>} bodyClassName="!p-0">
          {events.length === 0 ? (
            <EmptyState icon={<Activity className="h-4 w-4" />} title="No events yet">Training, simulation and hardware events appear here in real time.</EmptyState>
          ) : (
            <ol className="max-h-[380px] divide-y divide-line overflow-y-auto">
              {[...events].reverse().slice(0, 40).map((e) => {
                const L = levelIcon[e.level];
                return (
                  <motion.li key={e.seq} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} className="flex items-start gap-3 px-4 py-2.5">
                    <span className={clsx("mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/[0.04]", L.cls)}><L.icon className="h-3.5 w-3.5" /></span>
                    <div className="min-w-0 flex-1 text-[12.5px] leading-5 text-ink-2">{e.message}</div>
                    <span className="mono shrink-0 rounded-md bg-white/[0.04] px-1.5 py-px text-[10px] uppercase text-ink-3">{e.category}</span>
                    <span className="mono w-16 shrink-0 text-right text-[10.5px] leading-5 text-ink-3">{clock(e.time)}</span>
                  </motion.li>
                );
              })}
            </ol>
          )}
        </Panel>

        <div className="space-y-4">
          {/* -------- quick launch -------- */}
          <Panel title="Quick launch" eyebrow="Predefined experiments" dense>
            <div className="space-y-2.5">
              {PRESETS.map((p) => (
                <LaunchTile key={p.label} label={p.label} desc={p.desc} disabled={!online || running}
                  onClick={async () => { const r = await run(() => api.training.start(p.req), `${p.label} started`); if (r) nav("/training"); }} />
              ))}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <Button variant="outline" size="md" onClick={() => nav("/experiments")} icon={<FlaskConical className="h-3.5 w-3.5" />}>Open checkpoint</Button>
                <Button variant="outline" size="md" disabled={!online}
                  onClick={async () => { await run(() => api.sim.control("regenerate")); nav("/simulation"); }} icon={<Shuffle className="h-3.5 w-3.5" />}>New simulation</Button>
              </div>
              {running && <div className="text-[11.5px] text-ink-3">A training run is active - stop it to launch another.</div>}
            </div>
          </Panel>

          {/* -------- system -------- */}
          {beginner ? (
            <Collapsible title="System status" description="Backend, policy, training, hardware and ROS 2 details" className="panel">
              {systemRows}
            </Collapsible>
          ) : (
            <Panel title="System status" eyebrow="Subsystems" dense>{systemRows}</Panel>
          )}
        </div>
      </Reveal>

      {/* -------- deeper tools -------- */}
      <Reveal>
        <div className="mb-3 flex items-end justify-between gap-3 px-1">
          <div>
            <div className="eyebrow mb-1">Go deeper</div>
            <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Research & analysis tools</h2>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {DEEPER.map((d) => <ToolTile key={d.to} {...d} />)}
        </div>
      </Reveal>
    </div>
  );
}

/** Beginner mode: the three-step path through the studio. Navigation links only — starts nothing by itself. */
function GettingStarted() {
  const nav = useNavigate();
  const steps = [
    { n: 1, icon: Play, title: "Watch the robot drive", text: "Open Live Simulation and press Start. The trained policy steers using its LiDAR; the safety layer blocks unsafe moves.", to: "/simulation", cta: "Launch Simulation" },
    { n: 2, icon: Activity, title: "Train a policy", text: "In the Training Lab choose Deep Q-Network and press Start training. Watch the success rate as it learns.", to: "/training", cta: "Open Training Lab" },
    { n: 3, icon: ShieldCheck, title: "Check reliability", text: "See how often the policy reaches the goal or collides on maps it has never seen, with 95% confidence intervals.", to: "/reliability", cta: "Open Reliability" },
  ];
  return (
    <section className="panel p-4" aria-label="Getting started">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[14px] font-semibold text-ink">Getting started</h2>
        <span className="text-[11.5px] text-ink-3">Hover a label for an explanation · switch to Advanced in the top bar to see every setting</span>
      </div>
      <ol className="grid gap-3 md:grid-cols-3">
        {steps.map((s) => (
          <li key={s.n} className="flex flex-col rounded-lg bg-surface-2 p-3.5">
            <div className="flex items-center gap-2">
              <span className="mono flex h-6 w-6 items-center justify-center rounded-full bg-violet-soft text-[11.5px] text-[#c4bcff]">{s.n}</span>
              <span className="text-[13px] font-medium text-ink">{s.title}</span>
            </div>
            <p className="mt-2 flex-1 text-[12.5px] leading-relaxed text-ink-2">{s.text}</p>
            <button onClick={() => nav(s.to)} className="mt-3 inline-flex items-center gap-1.5 self-start rounded-md text-[12.5px] font-medium text-[#c4bcff] hover:text-ink">
              <s.icon className="h-3.5 w-3.5" /> {s.cta} <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

const DEEPER: { to: string; title: string; text: string; icon: typeof Info }[] = [
  { to: "/reliability", title: "Reliability", text: "Validation verdict, outcome rates with 95% intervals and collision causes.", icon: ShieldCheck },
  { to: "/episodes", title: "Episodes & Behaviour", text: "Replay any episode step by step and branch a what-if counterfactual.", icon: ListVideo },
  { to: "/scenarios", title: "Scenario Lab", text: "Generate traps, corridors and clutter; build benchmark scenario sets.", icon: MapIcon },
  { to: "/models", title: "Model Registry", text: "Every saved policy with its origin, compatibility and validation.", icon: Boxes },
];

/** Full-bleed hero: live 3D scene behind, headline in front, scroll parallax (off with reduced motion). */
function Hero({ scene, children, reduceMotion }: { scene: ReactNode; children: ReactNode; reduceMotion: boolean }) {
  const main = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { main.current = document.querySelector("main"); }, []);
  const { scrollY } = useScroll({ container: main });
  const sceneY = useTransform(scrollY, [0, 600], [0, reduceMotion ? 0 : 90]);
  const fade = useTransform(scrollY, [0, 520], [1, reduceMotion ? 1 : 0.35]);
  return (
    <section className="hero-shell relative h-[560px] overflow-hidden rounded-[20px] md:h-[600px]" aria-label="NEXUS overview">
      <motion.div className="absolute inset-0" style={{ y: sceneY, opacity: fade }}>
        {scene}
      </motion.div>
      {/* legibility veil: obsidian on the text side, open on the scene side */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,#0a0b0fF2_0%,#0a0b0fCC_30%,#0a0b0f33_58%,transparent_75%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#0a0b0f] to-transparent" />
      {children}
    </section>
  );
}

function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.section className={className} initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.12 }}
      transition={{ duration: 0.55, ease: [0.2, 0.8, 0.2, 1] }}>
      {children}
    </motion.section>
  );
}

function LaunchTile({ label, desc, disabled, onClick }: { label: string; desc: string; disabled: boolean; onClick: () => void }) {
  const tilt = useTilt(3);
  return (
    <button disabled={disabled} onClick={onClick} {...(disabled ? {} : tilt)}
      className="tile group flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left disabled:opacity-40">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[linear-gradient(145deg,#8b7cf633,#5aa2ff1a)] text-[#c4bcff] shadow-[inset_0_1px_0_#ffffff14]">
        <FlaskConical className="h-4 w-4" />
      </span>
      <div className="flex-1">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        <div className="mono text-[10.5px] text-ink-3">{desc}</div>
      </div>
      <ArrowRight className="h-4 w-4 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-[#c4bcff]" />
    </button>
  );
}

function ToolTile({ to, title, text, icon: Icon }: { to: string; title: string; text: string; icon: typeof Info }) {
  const tilt = useTilt(4);
  return (
    <Link to={to} {...tilt} className="tile group flex flex-col rounded-2xl p-4">
      <div className="flex items-center justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[linear-gradient(145deg,#8b7cf633,#5aa2ff1a)] text-[#c4bcff] shadow-[inset_0_1px_0_#ffffff14]"><Icon className="h-4 w-4" /></span>
        <ArrowUpRight className="h-4 w-4 text-ink-3 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-ink" />
      </div>
      <div className="mt-4 text-[14px] font-semibold text-ink">{title}</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{text}</p>
    </Link>
  );
}
