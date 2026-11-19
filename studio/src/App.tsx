import { MotionConfig, motion } from "framer-motion";
import { lazy, Suspense, useEffect, useRef } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LearnLayer } from "./components/learn/LearnLayer";
import { Sidebar, NAV } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { Kbd } from "./components/ui/feedback";
import { Dialog, ToastProvider, useToast } from "./components/ui/overlay";
import { CommandPalette, SHORTCUTS } from "./components/workflow/CommandPalette";
import { CopilotPanel } from "./components/workflow/CopilotPanel";
import { isTypingTarget } from "./lib/format";
import { useLive } from "./lib/live";
import { isOnboarded } from "./lib/onboarding";
import { updatePrefs, usePrefs } from "./lib/prefs";
import { setUi, useUi } from "./lib/ui-store";
import { Analytics } from "./pages/Analytics";
import { Designer } from "./pages/Designer";
import { Episodes } from "./pages/Episodes";
import { Experiments } from "./pages/Experiments";
import { HardwareBridge } from "./pages/HardwareBridge";
import { LiveSimulation } from "./pages/LiveSimulation";
import { ModelRegistry } from "./pages/ModelRegistry";
import { Overview } from "./pages/Overview";
import { PathPlanner } from "./pages/PathPlanner";
import { Reliability } from "./pages/Reliability";
import { RiskExplorer } from "./pages/RiskExplorer";
import { ScenarioLab } from "./pages/ScenarioLab";
import { SettingsPage } from "./pages/Settings";
import { TrainingLab } from "./pages/TrainingLab";

const RobotsPage = lazy(() => import("./pages/Robots"));
const WelcomePage = lazy(() => import("./pages/Welcome"));   // first-run onboarding (three.js on demand)   // 3D gallery: loads three.js on demand

function GlobalKeys() {
  const nav = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTypingTarget(e);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setUi((s) => ({ paletteOpen: !s.paletteOpen })); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setUi((s) => ({ copilotOpen: !s.copilotOpen })); }
      else if (e.altKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); const n = NAV[Number(e.key) - 1]; if (n) nav(n.to); }
      else if (!typing && e.key === "?") setUi({ shortcutsOpen: true });
      else if (e.key === "Escape") setUi({ copilotOpen: false, jobsOpen: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);
  return null;
}

/** Non-blocking notifications for background jobs and curriculum promotions. */
function EventToasts() {
  const events = useLive((s) => s.events);
  const toast = useToast();
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!events.length) return;
    const last = events[events.length - 1].seq;
    if (seen.current === null) { seen.current = last; return; }
    for (const e of events.filter((x) => x.seq > (seen.current ?? 0))) {
      if (e.category === "job" && e.level !== "info") toast(e.level === "success" ? "success" : e.level === "error" ? "error" : "warning", "Background job", e.message);
      if (e.category === "curriculum" && e.level === "success") toast("success", "Curriculum", e.message);
    }
    seen.current = last;
  }, [events, toast]);
  return null;
}

function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  return (
    <Dialog open={open} onClose={() => setUi({ shortcutsOpen: false })} title="Keyboard shortcuts" width={520}>
      <div className="grid gap-y-2">
        {SHORTCUTS.map(([k, d], i) => (
          <div key={i} className="flex items-center justify-between gap-4 text-[12.5px]">
            <span className="text-ink-2">{d}</span>
            <span className="flex gap-1">{k.split(" ").map((p) => <Kbd key={p}>{p}</Kbd>)}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function Shell() {
  const loc = useLocation();
  const navigate = useNavigate();
  useEffect(() => {                       // first launch: show the welcome screen once
    if (!isOnboarded()) navigate("/welcome", { replace: true });
  }, [navigate]);
  const connection = useLive((s) => s.connection);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1180px)");
    const apply = () => mq.matches && updatePrefs((p) => ({ ...p, sidebarCollapsed: true }));
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return (
    <div className="flex h-full overflow-hidden">
      <GlobalKeys />
      <EventToasts />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {connection === "offline" && (
          <div className="border-b border-[#f0524f33] bg-[#f0524f10] px-5 py-1.5 text-[12px] text-[#ffb3b1]">
            Backend offline — reconnecting automatically. Start it with <span className="mono">python main.py studio</span>. Values shown are the last received state.
          </div>
        )}
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ErrorBoundary resetKey={loc.pathname}>
            <motion.div key={loc.pathname} className="h-full" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}>
              <Outlet />
            </motion.div>
          </ErrorBoundary>
        </main>
      </div>
      <CommandPalette />
      <CopilotPanel />
      <ShortcutsDialog />
      <LearnLayer />
    </div>
  );
}

export function App() {
  const { reduceMotion } = usePrefs();
  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);
  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="welcome" element={<Suspense fallback={<div className="h-full bg-bg" />}><WelcomePage /></Suspense>} />
            <Route element={<Shell />}>
              <Route index element={<Overview />} />
              <Route path="simulation" element={<LiveSimulation />} />
              <Route path="training" element={<TrainingLab />} />
              <Route path="experiments" element={<Experiments />} />
              <Route path="designer" element={<Designer />} />
              <Route path="models" element={<ModelRegistry />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="episodes" element={<Episodes />} />
              <Route path="reliability" element={<Reliability />} />
              <Route path="risk" element={<RiskExplorer />} />
              <Route path="scenarios" element={<ScenarioLab />} />
              <Route path="planner" element={<PathPlanner />} />
              <Route path="robots" element={<Suspense fallback={<div className="p-6 text-[13px] text-ink-3">Loading robots...</div>}><RobotsPage /></Suspense>} />
              <Route path="hardware" element={<HardwareBridge />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </MotionConfig>
  );
}
