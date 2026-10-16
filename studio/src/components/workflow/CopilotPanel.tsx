import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, BookOpen, Bot, FlaskConical, Lightbulb, Loader2, Sigma, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { research } from "../../lib/research-api";
import type { BenchmarkRun, CopilotAnswer } from "../../lib/research-types";
import type { Experiment } from "../../lib/types";
import { setUi, useUi } from "../../lib/ui-store";
import { Button } from "../ui/button";
import { Select, TextInput } from "../ui/controls";
import { Badge, Tag } from "../ui/feedback";
import { useToast } from "../ui/overlay";

/** Research Copilot: deterministic facts from recorded data + optional AI narrative. */
export function CopilotPanel() {
  const open = useUi((s) => s.copilotOpen);
  const request = useUi((s) => s.copilotRequest);
  const ctx = useUi((s) => s.context);
  const nav = useNavigate();
  const toast = useToast();
  const [answer, setAnswer] = useState<CopilotAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ enabled: boolean; provider: string; model?: string; reason: string; concepts: string[] } | null>(null);
  const [exps, setExps] = useState<Experiment[]>([]);
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [a, setA] = useState(""); const [b, setB] = useState("");
  const [concept, setConcept] = useState("exploration");
  const [question, setQuestion] = useState("");

  useEffect(() => {
    if (!open) return;
    research.copilot.status().then(setStatus).catch(() => {});
    api.experiments.list().then((l) => { setExps(l); if (l.length > 1 && !a) { setA(l[0].id); setB(l[1].id); } }).catch(() => {});
    research.runs.list().then(setRuns).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ask = async (intent: string, params: Record<string, unknown> = {}, q?: string) => {
    setBusy(true);
    try { setAnswer(await research.copilot.ask(intent, params, q)); }
    catch (e) { toast("error", "Copilot", e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (request) ask(request.intent, request.params); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [request?.nonce]);

  const doAction = (act: Record<string, unknown> | null) => {
    if (!act) return;
    const page = act.page as string;
    if (page === "episodes") nav(`/episodes?id=${act.episode_id}&step=${act.step}&cf=${encodeURIComponent(JSON.stringify(act.modification ?? {}))}`);
    else if (page === "designer") nav(`/designer?prefill=${encodeURIComponent(JSON.stringify(act.prefill ?? {}))}`);
    else if (page === "training") nav(`/training?curriculum=${(act.curriculum as string[] | undefined)?.join(",") ?? ""}`);
    else if (page === "models") nav("/models");
    else nav("/");
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside initial={{ x: 440 }} animate={{ x: 0 }} exit={{ x: 440 }} transition={{ duration: 0.18, ease: "easeOut" }}
          className="fixed bottom-0 right-0 top-0 z-[110] flex w-[440px] max-w-[100vw] flex-col border-l border-line bg-[#0d0e12] shadow-2xl" aria-label="Research Copilot">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#8b7cf650] bg-[#151225]"><Bot className="h-4 w-4 text-violet" /></div>
              <div>
                <div className="text-[13.5px] font-semibold">Research Copilot</div>
                <div className="text-[10.5px] text-ink-3">Grounded in recorded data · {status?.enabled ? `AI narrative: ${status.model}` : "AI narrative off"}</div>
              </div>
            </div>
            <button onClick={() => setUi({ copilotOpen: false })} className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Close copilot"><X className="h-4 w-4" /></button>
          </div>

          <div className="space-y-2 border-b border-line p-3">
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => ask("summary")} icon={<Sigma className="h-3.5 w-3.5" />}>Summarize results</Button>
              <Button size="sm" variant="secondary" onClick={() => ask("suggest")} icon={<Lightbulb className="h-3.5 w-3.5" />}>Suggest experiments</Button>
              <Button size="sm" variant="secondary" onClick={() => ask("correlations")} icon={<Sparkles className="h-3.5 w-3.5" />}>Parameter correlations</Button>
              <Button size="sm" variant="secondary" disabled={!ctx.episodeId} onClick={() => ask("episode", { episode_id: ctx.episodeId })}
                title={ctx.episodeId ? "" : "Open an episode on the Episodes page first"} icon={<FlaskConical className="h-3.5 w-3.5" />}>Explain episode</Button>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1"><Select value={a} onChange={setA} options={exps.map((e) => ({ value: e.id, label: e.name }))} /></div>
              <span className="text-[11px] text-ink-3">vs</span>
              <div className="min-w-0 flex-1"><Select value={b} onChange={setB} options={exps.map((e) => ({ value: e.id, label: e.name }))} /></div>
              <Button size="sm" variant="outline" disabled={!a || !b || a === b} onClick={() => ask("compare", { a, b })}>Compare</Button>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="flex-1"><Select value={concept} onChange={setConcept} options={(status?.concepts ?? ["exploration"]).map((c) => ({ value: c, label: c }))} /></div>
              <Button size="sm" variant="outline" onClick={() => ask("concept", { term: concept })} icon={<BookOpen className="h-3.5 w-3.5" />}>Explain concept</Button>
            </div>
            <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (question.trim()) ask("question", ctx.episodeId ? { episode_id: ctx.episodeId } : {}, question.trim()); }}>
              <TextInput value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about your results…" aria-label="Question" />
              <Button size="md" variant="primary" type="submit" disabled={!question.trim()}>Ask</Button>
            </form>
            {runs.length > 0 && <div className="text-[10.5px] text-ink-3">Suggestions use the latest benchmark run ({runs[0].label}).</div>}
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {busy && <div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Analysing recorded data…</div>}
            {!busy && !answer && (
              <div className="text-[12.5px] leading-relaxed text-ink-3">
                Pick an analysis above. Every statement under <b className="text-ink-2">Measured facts</b> is computed from recorded experiments, episodes and benchmark runs and lists its source.
                Hypotheses and recommendations are labelled separately and are never presented as measured results.
              </div>
            )}
            {!busy && answer && (
              <>
                <div className="text-[14px] font-semibold">{answer.title}</div>
                {answer.background && (
                  <Section title="Background (concept explanation, not data)" icon={<BookOpen className="h-3.5 w-3.5 text-cyan" />}>
                    <p className="text-[12.5px] leading-relaxed text-ink-2">{answer.background}</p>
                  </Section>
                )}
                {answer.facts.length > 0 && (
                  <Section title="Measured facts" icon={<Sigma className="h-3.5 w-3.5 text-good" />}>
                    <ul className="space-y-2">
                      {answer.facts.map((f, i) => (
                        <li key={i} className="text-[12.5px] leading-relaxed text-ink-2">{f.text} <Tag className="ml-1">{f.source}</Tag></li>
                      ))}
                    </ul>
                  </Section>
                )}
                {answer.hypotheses.length > 0 && (
                  <Section title="Hypotheses (not verified)" icon={<Lightbulb className="h-3.5 w-3.5 text-warn" />}>
                    <ul className="space-y-2">
                      {answer.hypotheses.map((h, i) => <li key={i} className="text-[12.5px] leading-relaxed text-ink-2">{h.text} <span className="text-[11px] text-ink-3">(basis: {h.basis})</span></li>)}
                    </ul>
                  </Section>
                )}
                {answer.recommendations.length > 0 && (
                  <Section title="Recommendations" icon={<ArrowRight className="h-3.5 w-3.5 text-violet" />}>
                    <ul className="space-y-2">
                      {answer.recommendations.map((r, i) => (
                        <li key={i} className="rounded-lg border border-line bg-surface-2 p-2.5 text-[12.5px] text-ink-2">
                          {r.text}
                          {r.action && <button onClick={() => doAction(r.action)} className="mt-1.5 flex items-center gap-1 text-[11.5px] text-[#b3a9ff] hover:text-[#cfc8ff]">Open <ArrowRight className="h-3 w-3" /></button>}
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
                <Section title="AI narrative" icon={<Bot className="h-3.5 w-3.5 text-violet" />}>
                  {answer.narrative?.text ? (
                    <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">{answer.narrative.text}
                      <div className="mt-2"><Badge tone="violet">generated by {answer.narrative.model} from the facts above</Badge></div></div>
                  ) : answer.narrative?.error ? (
                    <div className="text-[12px] text-bad">{answer.narrative.error}</div>
                  ) : (
                    <div className="text-[12px] leading-relaxed text-ink-3">{answer.provider.reason} To enable, start the server with <span className="mono">NEXUS_COPILOT_PROVIDER=anthropic</span> and Anthropic credentials (<span className="mono">ANTHROPIC_API_KEY</span> or <span className="mono">ant auth login</span>). The analysis above does not depend on it.</div>
                  )}
                </Section>
              </>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className={clsx("mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-3")}>{icon}{title}</div>
      {children}
    </section>
  );
}
