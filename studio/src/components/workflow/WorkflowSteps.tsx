import clsx from "clsx";
import { Check } from "lucide-react";
import { Link } from "react-router-dom";
import { useLive } from "../../lib/live";
import type { CompatStatus } from "../../lib/types";

export const COMPAT_LABEL: Record<CompatStatus, { text: string; tone: "good" | "warn" | "bad" | "info" | "muted" }> = {
  trained: { text: "Trained for this robot", tone: "good" },
  unvalidated: { text: "Not validated on this robot", tone: "warn" },
  incompatible: { text: "Incompatible", tone: "bad" },
  planner: { text: "Planner - works with this robot", tone: "info" },
  unavailable: { text: "No model loaded", tone: "muted" },
};

const TONE = { good: "text-good", warn: "text-warn", bad: "text-bad", info: "text-cyan", muted: "text-ink-3" };

export type StepId = "robot" | "environment" | "policy" | "run" | "evaluate";

/**
 * Choose Robot -> Configure Environment -> Train or Select Policy -> Run Simulation -> Evaluate Results.
 * Every status line is read from the live backend state.
 */
export function WorkflowSteps({ current, className }: { current?: StepId; className?: string }) {
  const sim = useLive((s) => s.sim);
  const robot = sim?.robot_profile;
  const compat = sim?.policy_compat?.[sim.policy];
  const steps: { id: StepId; title: string; to: string; status: string; tone?: keyof typeof TONE; done: boolean }[] = [
    { id: "robot", title: "Choose robot", to: "/robots", status: robot ? robot.name : "Loading...", done: !!robot },
    { id: "environment", title: "Configure environment", to: "/simulation",
      status: sim ? `${sim.world.width.toFixed(0)}×${sim.world.height.toFixed(0)} m · ${sim.world.rects.length} obstacles` : "-", done: !!sim },
    { id: "policy", title: "Train or select policy", to: "/training",
      status: sim ? `${sim.policies[sim.policy]}${compat ? ` · ${COMPAT_LABEL[compat.status].text}` : ""}` : "-",
      tone: compat ? COMPAT_LABEL[compat.status].tone : undefined, done: !!compat?.ok },
    { id: "run", title: "Run simulation", to: "/simulation",
      status: !sim ? "-" : sim.outcome ? `Last episode: ${sim.outcome}` : sim.status === "running" ? "Running" : "Ready",
      tone: sim?.outcome === "success" ? "good" : sim?.outcome === "collision" ? "bad" : sim?.outcome === "timeout" ? "warn" : undefined,
      done: !!sim?.outcome },
    { id: "evaluate", title: "Evaluate results", to: "/reliability", status: "Reliability & analytics", done: false },
  ];
  return (
    <nav aria-label="Workflow" className={clsx("overflow-x-auto", className)}>
      <ol className="flex min-w-max items-stretch gap-2">
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            <Link to={s.to} aria-current={current === s.id ? "step" : undefined}
              className={clsx("tile group flex min-w-[170px] items-center gap-3 rounded-xl px-3 py-2.5",
                current === s.id && "!bg-[linear-gradient(180deg,#221d3a,#17142a)] shadow-[inset_0_0_0_1px_#8b7cf666]")}>
              <span className={clsx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                current === s.id ? "bg-violet text-white" : s.done ? "bg-[#3fb95026] text-good" : "bg-white/[0.06] text-ink-3")}>
                {s.done && current !== s.id ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-ink">{s.title}</span>
                <span className={clsx("block max-w-[220px] truncate text-[11px]", s.tone ? TONE[s.tone] : "text-ink-3")}>{s.status}</span>
              </span>
            </Link>
            {i < steps.length - 1 && <span aria-hidden className="h-px w-4 bg-gradient-to-r from-[#8b7cf666] to-transparent" />}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Compact "selected robot" chip shown in the top bar on every page. */
export function RobotChip() {
  const robot = useLive((s) => s.sim?.robot_profile);
  if (!robot) return null;
  return (
    <Link to="/robots" data-learn="robot-chip" title={`Simulated robot: ${robot.name} (${robot.kind}) - change on the Robots page`}
      className="hidden items-center gap-2 whitespace-nowrap rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[12px] text-ink-2 hover:border-[#8b7cf666] hover:text-ink lg:inline-flex">
      <span className="h-2 w-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: robot.visual.color, color: "#8b7cf6" }} />
      <span className="text-ink-3">Robot</span>
      <span className="font-medium text-ink">{robot.name}</span>
    </Link>
  );
}
