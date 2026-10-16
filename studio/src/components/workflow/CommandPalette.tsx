import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Bot, CornerDownLeft, FlaskConical, Map as MapIcon, Play, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { getLive } from "../../lib/live";
import { updatePrefs } from "../../lib/prefs";
import { research } from "../../lib/research-api";
import type { SearchHit } from "../../lib/research-types";
import { askCopilot, setUi, useUi } from "../../lib/ui-store";
import { NAV } from "../layout/Sidebar";
import { Kbd } from "../ui/feedback";
import { useAction } from "../ui/overlay";

interface Command { id: string; group: string; label: string; hint?: string; icon?: React.ReactNode; run: () => void }

const KIND_PATH: Record<string, (id: string) => string> = {
  experiment: () => "/experiments", model: (id) => `/models?id=${id}`, scenario: (id) => `/scenarios?id=${id}`,
  episode: (id) => `/episodes?id=${id}`, design: (id) => `/designer?id=${id}`,
};

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const nav = useNavigate();
  const run = useAction();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => setUi({ paletteOpen: false });

  useEffect(() => {
    if (open) { setQ(""); setSel(0); setHits([]); setTimeout(() => inputRef.current?.focus(), 20); }
  }, [open]);
  useEffect(() => {
    if (!open || q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => research.search(q).then(setHits).catch(() => setHits([])), 160);
    return () => clearTimeout(t);
  }, [q, open]);

  const commands: Command[] = useMemo(() => {
    const go = (to: string) => () => { nav(to); close(); };
    const sim = getLive().sim;
    const list: Command[] = NAV.map((n, i) => ({ id: `nav-${n.to}`, group: "Navigate", label: n.label, hint: i < 9 ? `Alt ${i + 1}` : undefined,
      icon: <n.icon className="h-4 w-4" />, run: go(n.to) }));
    list.push(
      { id: "sim-toggle", group: "Simulation", label: sim?.status === "running" ? "Pause simulation" : "Start / resume simulation", icon: <Play className="h-4 w-4" />,
        run: () => { run(() => api.sim.control(sim?.status === "running" ? "pause" : sim?.status === "paused" ? "resume" : "start")); close(); } },
      { id: "sim-reset", group: "Simulation", label: "Reset episode", run: () => { run(() => api.sim.control("reset")); close(); } },
      { id: "sim-regen", group: "Simulation", label: "Regenerate environment", run: () => { run(() => api.sim.control("regenerate")); close(); } },
      { id: "sim-shield", group: "Simulation", label: `Turn safety shield ${sim?.shield ? "off" : "on"}`, run: () => { run(() => api.sim.shield(!sim?.shield)); close(); } },
      { id: "sim-analyze", group: "Analysis", label: "Analyze current map", icon: <MapIcon className="h-4 w-4" />, run: go("/scenarios?analyze=1") },
      { id: "copilot", group: "Copilot", label: "Open Research Copilot", hint: "Ctrl J", icon: <Bot className="h-4 w-4" />, run: () => { setUi({ copilotOpen: true }); close(); } },
      { id: "copilot-summary", group: "Copilot", label: "Summarize recorded results", icon: <Sparkles className="h-4 w-4" />, run: () => { askCopilot("summary"); close(); } },
      { id: "copilot-suggest", group: "Copilot", label: "Suggest experiments from failures", icon: <Sparkles className="h-4 w-4" />, run: () => { askCopilot("suggest"); close(); } },
      { id: "bench", group: "Research", label: "Build shared benchmark", icon: <FlaskConical className="h-4 w-4" />, run: () => { run(() => research.sets.benchmark(), "Benchmark build queued"); close(); } },
      { id: "jobs", group: "Workflow", label: "Show background jobs", run: () => { setUi({ jobsOpen: true }); close(); } },
      { id: "sidebar", group: "Workflow", label: "Toggle sidebar", run: () => { updatePrefs((p) => ({ ...p, sidebarCollapsed: !p.sidebarCollapsed })); close(); } },
      { id: "shortcuts", group: "Workflow", label: "Keyboard shortcuts", hint: "?", run: () => { setUi({ shortcutsOpen: true, paletteOpen: false }); } },
    );
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ql = q.trim().toLowerCase();
  const filtered = commands.filter((c) => !ql || c.label.toLowerCase().includes(ql) || c.group.toLowerCase().includes(ql));
  const hitCmds: Command[] = hits.map((h) => ({ id: `hit-${h.kind}-${h.id}`, group: `Search · ${h.kind}s`, label: h.title, hint: h.subtitle,
    icon: <Search className="h-4 w-4" />, run: () => { nav(KIND_PATH[h.kind]?.(h.id) ?? "/"); close(); } }));
  const items = [...filtered, ...hitCmds];

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[sel]?.run(); }
    else if (e.key === "Escape") close();
  };

  let lastGroup = "";
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[150] flex items-start justify-center px-4 pt-[12vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }}>
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={close} />
          <motion.div role="dialog" aria-label="Command palette" className="panel relative w-full max-w-[620px] overflow-hidden shadow-2xl"
            initial={{ y: -8, scale: 0.98 }} animate={{ y: 0, scale: 1 }} transition={{ duration: 0.12 }}>
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search className="h-4 w-4 text-ink-3" />
              <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
                placeholder="Type a command, page, experiment, model, scenario or episode…" aria-label="Search commands"
                className="h-12 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3" />
              <Kbd>Esc</Kbd>
            </div>
            <div className="max-h-[52vh] overflow-y-auto py-1.5" role="listbox">
              {items.length === 0 && <div className="px-4 py-8 text-center text-[12.5px] text-ink-3">No matches</div>}
              {items.map((c, i) => {
                const header = c.group !== lastGroup ? <div key={`g-${c.group}`} className="eyebrow px-4 pb-1 pt-2.5">{c.group}</div> : null;
                lastGroup = c.group;
                return (
                  <div key={c.id}>
                    {header}
                    <button role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={c.run}
                      className={clsx("flex w-full items-center gap-3 px-4 py-2 text-left text-[13px]", i === sel ? "bg-surface-3 text-ink" : "text-ink-2")}>
                      <span className="text-ink-3">{c.icon ?? <ArrowRight className="h-4 w-4" />}</span>
                      <span className="flex-1 truncate">{c.label}</span>
                      {c.hint && <span className="mono truncate text-[10.5px] text-ink-3">{c.hint}</span>}
                      {i === sel && <CornerDownLeft className="h-3.5 w-3.5 text-ink-3" />}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-4 border-t border-line px-4 py-2 text-[10.5px] text-ink-3">
              <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate</span><span><Kbd>Enter</Kbd> run</span><span><Kbd>Ctrl</Kbd> <Kbd>K</Kbd> toggle</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export const SHORTCUTS: [string, string][] = [
  ["Ctrl K", "Command palette (pages, actions, search)"], ["Ctrl J", "Research Copilot"], ["?", "This help"],
  ["Alt 1-9", "Jump to page"], ["Space", "Live Simulation: start / pause"], ["S", "Live Simulation: step one action"],
  ["R", "Live Simulation: reset episode"], ["N", "Live Simulation: regenerate map"], ["G", "Live Simulation: goal tool"],
  ["Esc", "Close dialogs / pan tool"], ["← →", "Episodes replay: previous / next step"], ["Space", "Episodes replay: play / pause"],
];
