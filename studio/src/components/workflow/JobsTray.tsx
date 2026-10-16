import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Layers, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { clock, duration } from "../../lib/format";
import { useLive } from "../../lib/live";
import { research } from "../../lib/research-api";
import type { Job } from "../../lib/research-types";
import { setUi, useUi } from "../../lib/ui-store";
import { Badge, EmptyState } from "../ui/feedback";
import { useAction } from "../ui/overlay";

const tone = (s: Job["status"]) => (s === "running" ? "violet" : s === "queued" ? "info" : s === "completed" ? "good" : s === "failed" ? "bad" : "warn") as "good";

/** Background-job status: live active jobs from the socket + recent history on open. */
export function JobsTray() {
  const active = useLive((s) => s.jobs);
  const training = useLive((s) => s.training);
  const open = useUi((s) => s.jobsOpen);
  const [history, setHistory] = useState<Job[]>([]);
  const run = useAction();
  const ref = useRef<HTMLDivElement>(null);
  const trainingActive = training?.status === "running" || training?.status === "paused";
  const count = active.length + (trainingActive ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    research.jobs.list().then(setHistory).catch(() => {});
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setUi({ jobsOpen: false });
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, active.length]);

  const done = history.filter((h) => !active.some((a) => a.id === h.id)).slice(0, 8);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setUi({ jobsOpen: !open })} aria-label="Background jobs" title="Background jobs"
        className={clsx("relative inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px]", count ? "border-[#8b7cf655] text-[#c4bcff]" : "border-line-strong text-ink-3 hover:text-ink-2")}>
        {count ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
        Jobs{count ? ` · ${count}` : ""}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.12 }}
            className="panel absolute right-0 top-10 z-[120] w-[400px] overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="text-[13px] font-semibold">Background jobs</span>
              <button onClick={() => setUi({ jobsOpen: false })} className="rounded p-1 text-ink-3 hover:bg-surface-3" aria-label="Close"><X className="h-3.5 w-3.5" /></button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {trainingActive && training && (
                <div className="border-b border-line px-4 py-3">
                  <div className="flex items-center justify-between text-[12.5px]"><span className="text-ink">Training run</span><Badge tone={training.status === "running" ? "violet" : "warn"} pulse={training.status === "running"}>{training.status}</Badge></div>
                  <Progress done={training.episode} total={training.target_episodes} />
                  <div className="mono mt-1 text-[10.5px] text-ink-3">{training.experiment_id}</div>
                </div>
              )}
              {active.map((j) => (
                <div key={j.id} className="border-b border-line px-4 py-3">
                  <div className="flex items-center justify-between gap-2 text-[12.5px]">
                    <span className="truncate text-ink">{j.title}</span>
                    <span className="flex items-center gap-1.5"><Badge tone={tone(j.status)} pulse={j.status === "running"}>{j.status}</Badge>
                      <button onClick={() => run(() => research.jobs.cancel(j.id), "Cancellation requested")} className="rounded px-1.5 py-0.5 text-[11px] text-ink-3 hover:bg-surface-3 hover:text-bad">Cancel</button></span>
                  </div>
                  <Progress done={j.done} total={j.total} />
                  <div className="mt-1 truncate text-[11px] text-ink-3">{j.message || "waiting for worker"}</div>
                </div>
              ))}
              {!active.length && !trainingActive && <EmptyState icon={<Layers className="h-4 w-4" />} title="No running jobs">Benchmarks, experiment designs and scenario sets run here in the background.</EmptyState>}
              {done.length > 0 && <div className="eyebrow px-4 pb-1 pt-3">Recent</div>}
              {done.map((j) => (
                <div key={j.id} className="flex items-center justify-between gap-2 px-4 py-2 text-[12px]">
                  <span className="truncate text-ink-2">{j.title}</span>
                  <span className="flex shrink-0 items-center gap-2"><span className="mono text-[10.5px] text-ink-3">{j.finished ? clock(j.finished) : ""}{j.started && j.finished ? ` · ${duration(j.finished - j.started)}` : ""}</span><Badge tone={tone(j.status)}>{j.status}</Badge></span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number | null }) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
        {total ? <div className="h-full rounded-full bg-violet transition-[width] duration-500" style={{ width: `${Math.min(100, (100 * done) / total)}%` }} />
          : <div className="h-full w-1/3 animate-pulse rounded-full bg-violet/50" />}
      </div>
      <span className="mono text-[10.5px] text-ink-3">{total ? `${done}/${total}` : `${done}`}</span>
    </div>
  );
}
