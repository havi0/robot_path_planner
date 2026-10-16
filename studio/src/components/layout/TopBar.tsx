import clsx from "clsx";
import { Bot, ChevronRight, Command, Cpu, FlaskConical, Monitor, Settings } from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useLive } from "../../lib/live";
import { Badge } from "../ui/feedback";
import { ConfirmDialog, useAction } from "../ui/overlay";
import { setUi } from "../../lib/ui-store";
import { JobsTray } from "../workflow/JobsTray";
import { LearnButton } from "../learn/LearnLayer";
import { ModeSwitch } from "./ModeSwitch";
import { RobotChip } from "../workflow/WorkflowSteps";
import { NAV } from "./Sidebar";

export function TopBar() {
  const loc = useLocation();
  const nav = useNavigate();
  const run = useAction();
  const page = NAV.find((n) => (n.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(n.to)));
  const connection = useLive((s) => s.connection);
  const mode = useLive((s) => s.operatingMode);
  const training = useLive((s) => s.training);
  const hw = useLive((s) => s.hardware);
  const [confirmHw, setConfirmHw] = useState(false);

  const tStatus = training?.status ?? "idle";
  const tTone = tStatus === "running" ? "violet" : tStatus === "paused" ? "warn" : tStatus === "failed" ? "bad" : tStatus === "completed" ? "good" : "muted";
  const hwConnected = hw?.status === "connected" && hw.kind === "ros2";

  return (
    <header className="relative z-10 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-white/[0.06] bg-[#0b0c10]/70 px-5 shadow-[0_10px_30px_-24px_#000] backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className="text-ink-3">NEXUS</span>
        <ChevronRight className="h-3.5 w-3.5 text-ink-3" />
        <span className="truncate font-medium text-ink">{page?.label ?? "Studio"}</span>
        <button onClick={() => setUi({ paletteOpen: true })} className="ml-3 hidden items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-3 hover:text-ink-2 md:inline-flex" aria-label="Open command palette">
          <Command className="h-3.5 w-3.5" /> <span className="hidden min-[1760px]:inline">Search & commands</span> <span className="mono rounded border border-line-strong px-1 text-[10px]">Ctrl K</span>
        </button>
      </div>

      <div className="flex items-center gap-2.5">
        {training?.experiment_id && (
          <Link to="/training" className="hidden items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-2 hover:border-line-strong lg:inline-flex" title="Active experiment">
            <FlaskConical className="h-3.5 w-3.5 text-ink-3" />
            <span className="mono max-w-[220px] truncate">{training.experiment_id}</span>
          </Link>
        )}
        <RobotChip />
        <JobsTray />
        <button onClick={() => setUi({ copilotOpen: true })} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#8b7cf640] bg-violet-soft px-2.5 text-[12px] text-[#c4bcff] hover:border-[#8b7cf680]" aria-label="Open research copilot" title="Research Copilot (Ctrl J)">
          <Bot className="h-3.5 w-3.5" /> Copilot
        </button>
        <Badge tone={tTone} pulse={tStatus === "running"} className="hidden whitespace-nowrap min-[1760px]:inline-flex">Training · {tStatus}</Badge>
        <Badge tone={connection === "online" ? "good" : connection === "connecting" ? "warn" : "bad"} pulse={connection === "online"} className="hidden whitespace-nowrap xl:inline-flex">
          Backend {connection}
        </Badge>

        <ModeSwitch className="hidden lg:inline-flex" />
        <div role="radiogroup" aria-label="Operating mode" className="ml-1 inline-flex rounded-lg border border-line-strong bg-surface-2 p-0.5">
          {(["simulation", "hardware"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              disabled={connection !== "online"}
              onClick={() => (m === "hardware" && mode !== "hardware" ? setConfirmHw(true) : m !== mode && run(() => api.setMode(m)))}
              className={clsx(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors disabled:opacity-40",
                mode === m ? (m === "hardware" ? "bg-[#2a1d12] text-warn shadow-[0_0_0_1px_#e3b34140]" : "bg-surface-3 text-ink shadow-[0_0_0_1px_#2f3440]") : "text-ink-3 hover:text-ink-2",
              )}
            >
              {m === "simulation" ? <Monitor className="h-3.5 w-3.5" /> : <Cpu className="h-3.5 w-3.5" />}
              {m === "simulation" ? "Simulation" : "Hardware"}
              {m === "hardware" && <span className={clsx("h-1.5 w-1.5 rounded-full", hwConnected ? "bg-good" : "bg-ink-3")} title={hwConnected ? "robot connected" : "no robot connected"} />}
            </button>
          ))}
        </div>

        <LearnButton />
        <button onClick={() => nav("/settings")} className="rounded-lg p-2 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Settings" title="Settings">
          <Settings className="h-4 w-4" />
        </button>
      </div>

      <ConfirmDialog
        open={confirmHw}
        onClose={() => setConfirmHw(false)}
        title="Switch to Hardware mode?"
        confirmLabel="Switch mode"
        onConfirm={async () => {
          await run(() => api.setMode("hardware"));
          nav("/hardware");
        }}
      >
        Hardware mode enables the Hardware Bridge controls. It does <b className="text-ink">not</b> connect to or move a robot:
        a backend must be connected and the robot explicitly armed first.
        {!hw?.ros2_available && <div className="mt-2 text-warn">ROS 2 is not installed on this machine, so no physical robot can be connected.</div>}
      </ConfirmDialog>
    </header>
  );
}
