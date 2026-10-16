import clsx from "clsx";
import { motion } from "framer-motion";
import { Activity, BarChart3, Bot, Boxes, ChevronsLeft, ChevronsRight, Cpu, FlaskConical, Flame, LayoutDashboard, ListVideo, Map, Route, Settings, ShieldCheck, TestTubes } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useLive } from "../../lib/live";
import { updatePrefs, usePrefs } from "../../lib/prefs";
import { StatusDot } from "../ui/feedback";

export const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, group: "Workspace" },
  { to: "/simulation", label: "Live Simulation", icon: Bot, group: "Workspace" },
  { to: "/training", label: "Training Lab", icon: Activity, group: "Workspace" },
  { to: "/experiments", label: "Experiments", icon: FlaskConical, group: "Research" },
  { to: "/designer", label: "Experiment Designer", icon: TestTubes, group: "Research" },
  { to: "/models", label: "Model Registry", icon: Boxes, group: "Research" },
  { to: "/analytics", label: "Analytics", icon: BarChart3, group: "Research" },
  { to: "/reliability", label: "Reliability", icon: ShieldCheck, group: "Analysis" },
  { to: "/episodes", label: "Episodes & Behaviour", icon: ListVideo, group: "Analysis" },
  { to: "/risk", label: "Risk Explorer", icon: Flame, group: "Analysis" },
  { to: "/scenarios", label: "Scenario Lab", icon: Map, group: "Analysis" },
  { to: "/planner", label: "Path Planner", icon: Route, group: "Analysis" },
  { to: "/hardware", label: "Hardware Bridge", icon: Cpu, group: "System" },
  { to: "/settings", label: "Settings", icon: Settings, group: "System" },
];

export function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-[#8b7cf660] bg-[linear-gradient(145deg,#211a3d,#121019)] shadow-[inset_0_1px_0_#ffffff1a,0_6px_18px_-6px_#8b7cf680]">
        <svg viewBox="0 0 32 32" className="h-5 w-5" aria-hidden>
          <path d="M9 23V9l14 14V9" stroke="#8b7cf6" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="23" cy="9" r="2.2" fill="#5ec8d8" />
        </svg>
      </div>
      {!collapsed && (
        <div className="leading-none">
          <div className="text-[14px] font-semibold tracking-[0.18em] text-ink">NEXUS</div>
          <div className="mono mt-1 text-[9.5px] tracking-wider text-ink-3">ROBOTICS STUDIO</div>
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { sidebarCollapsed: collapsed } = usePrefs();
  const connection = useLive((s) => s.connection);
  const mode = useLive((s) => s.operatingMode);
  const training = useLive((s) => s.training?.status);
  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 232 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="relative z-20 flex h-full shrink-0 flex-col border-r border-white/[0.06] bg-[linear-gradient(180deg,#0e0f14f0,#0b0c10f5)] shadow-[1px_0_0_#ffffff05,12px_0_40px_-30px_#000]"
    >
      <div className={clsx("flex h-14 items-center border-b border-line", collapsed ? "justify-center" : "px-4")}>
        <Logo collapsed={collapsed} />
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Main">
        {NAV.map(({ to, label, icon: Icon, group }, i) => (
          <div key={to}>
          {i === 0 || NAV[i - 1].group !== group ? (
            collapsed ? (i > 0 && <div className="mx-3 my-2 h-px bg-line" />) : <div className="eyebrow px-2.5 pb-1.5 pt-3">{group}</div>
          ) : null}
          <NavLink
            to={to}
            end={to === "/"}
            data-learn={`nav${to === "/" ? "-overview" : to.replace("/", "-")}`}
            data-learn-side="right"
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              clsx(
                "group relative flex h-9 items-center gap-3 rounded-lg text-[13.5px] transition-colors",
                collapsed ? "justify-center" : "px-2.5",
                isActive ? "font-medium text-ink" : "text-ink-2 hover:bg-white/[0.035] hover:text-ink",
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <motion.span layoutId="nav-pill" transition={{ type: "spring", stiffness: 420, damping: 36 }}
                  className="absolute inset-0 rounded-lg bg-[linear-gradient(90deg,#8b7cf629,#8b7cf60a)] shadow-[inset_0_0_0_1px_#8b7cf633,inset_0_1px_0_#ffffff0d]" />}
                {isActive && <motion.span layoutId="nav-active" className="absolute left-0 top-2 h-5 w-[2px] rounded-full bg-violet shadow-[0_0_10px_#8b7cf6]" />}
                <Icon className={clsx("relative h-[17px] w-[17px] shrink-0", isActive ? "text-[#b3a9ff]" : "")} strokeWidth={1.75} />
                {!collapsed && <span className="relative truncate">{label}</span>}
                {!collapsed && to === "/training" && (training === "running" || training === "paused") && (
                  <span className="ml-auto"><StatusDot tone={training === "running" ? "violet" : "warn"} pulse={training === "running"} /></span>
                )}
              </>
            )}
          </NavLink>
          </div>
        ))}
      </nav>
      <div className="border-t border-line p-3">
        {!collapsed ? (
          <div className="space-y-2 text-[11.5px]">
            <div className="flex items-center justify-between">
              <span className="text-ink-3">Backend</span>
              <span className="inline-flex items-center gap-1.5 text-ink-2">
                <StatusDot tone={connection === "online" ? "good" : connection === "connecting" ? "warn" : "bad"} pulse={connection === "online"} />
                {connection}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-3">Mode</span>
              <span className="mono text-ink-2">{mode}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-3">Version</span>
              <span className="mono text-ink-3">v2.0.0</span>
            </div>
          </div>
        ) : (
          <div className="flex justify-center" title={`Backend ${connection}`}>
            <StatusDot tone={connection === "online" ? "good" : connection === "connecting" ? "warn" : "bad"} pulse={connection === "online"} />
          </div>
        )}
        <button
          onClick={() => updatePrefs((p) => ({ ...p, sidebarCollapsed: !p.sidebarCollapsed }))}
          className={clsx("mt-3 flex h-7 w-full items-center gap-2 rounded-md text-[11.5px] text-ink-3 hover:bg-surface-2 hover:text-ink-2", collapsed ? "justify-center" : "px-2")}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /> Collapse</>}
        </button>
      </div>
    </motion.aside>
  );
}
