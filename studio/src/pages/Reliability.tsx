import { AlertTriangle, CheckCircle2, Play, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CiRows, OutcomeBadge } from "../components/research/shared";
import { Button } from "../components/ui/button";
import { Badge, EmptyState, Skeleton, Tag, type Tone } from "../components/ui/feedback";
import { Panel } from "../components/ui/panel";
import { dateTime, pct } from "../lib/format";
import { useLive } from "../lib/live";
import { research } from "../lib/research-api";
import type { ReliabilityReport, ValidationStatus } from "../lib/research-types";

export const VALIDATION_TONE: Record<ValidationStatus["status"], Tone> = { validated: "good", failed: "bad", not_validated: "warn" };

export function ValidationBadge({ v }: { v: ValidationStatus | undefined }) {
  if (!v) return <Badge tone="muted">no model</Badge>;
  return <Badge tone={VALIDATION_TONE[v.status]}>{v.label}</Badge>;
}

/** Navigation Reliability: built only from recorded evaluation episodes and benchmark runs. */
export function Reliability() {
  const [r, setR] = useState<ReliabilityReport | null>(null);
  const events = useLive((s) => s.events.length);
  const models = useLive((s) => s.models?.dqn?.path);
  useEffect(() => { research.reliability().then(setR).catch(() => setR(null)); }, [events, models]);

  if (!r) return <div className="p-4"><Skeleton className="h-64" /></div>;
  const v = r.validation;
  return (
    <div className="space-y-4 p-4">
      <section className="panel px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-violet" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">Navigation reliability</div>
            <div className="text-[12px] text-ink-3">Active policy: {r.active_model?.label ?? "none"} {r.model_id && <span className="mono">({r.model_id})</span>}</div>
          </div>
          {v && Object.entries(v).map(([pol, s]) => (
            <span key={pol} className="flex items-center gap-1.5 text-[12px] text-ink-2"><Tag>{pol}</Tag><ValidationBadge v={s} /></span>
          ))}
          <Link to={r.model_id ? `/models?id=${r.model_id}` : "/models"}><Button size="sm" variant="secondary">Run validation benchmark</Button></Link>
        </div>
        {v && (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {Object.entries(v).map(([pol, s]) => (
              <div key={pol} className="rounded-lg border border-line bg-surface-2 p-2.5 text-[12px]">
                <div className="mb-1 flex items-center gap-2 font-medium text-ink">{s.status === "validated" ? <CheckCircle2 className="h-3.5 w-3.5 text-good" /> : s.status === "failed" ? <XCircle className="h-3.5 w-3.5 text-bad" /> : <AlertTriangle className="h-3.5 w-3.5 text-warn" />}{pol}: {s.label}</div>
                {s.reasons.map((x, i) => <div key={i} className="text-ink-2">• {x}</div>)}
                {s.evidence && <div className="mono mt-1 text-[10.5px] text-ink-3">{s.evidence.episodes} benchmark episodes · success {pct(s.evidence.success.rate)} · collision {pct(s.evidence.collision.rate)}</div>}
                <div className="mt-1 text-[10.5px] text-ink-3">Criteria: {s.criteria}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {r.episodes === 0 ? (
        <div className="panel"><EmptyState icon={<ShieldAlert className="h-4 w-4" />} title="No evaluation episodes recorded for this policy">
          Run it in Live Simulation or benchmark it in the Model Registry. Training episodes are not counted as evaluations.
        </EmptyState></div>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Recent evaluation outcomes" eyebrow={`last ${r.episodes} evaluation episodes (benchmark + live) · 95% Wilson intervals`} dense>
              <CiRows rows={[{ name: "Goal reached", ci: r.outcomes.success }, { name: "Simulator collision", ci: r.outcomes.collision }, { name: "Timeout (failed)", ci: r.outcomes.timeout }]} />
              <div className="mt-4 eyebrow">Collision rate with vs. without the safety layer</div>
              <div className="mt-2">
                <CiRows color="#d95926" label="collision" rows={[
                  { name: `Shield on (n=${r.by_shield.shield_on.episodes})`, ci: r.by_shield.shield_on.collision },
                  { name: `Shield off (n=${r.by_shield.shield_off.episodes})`, ci: r.by_shield.shield_off.collision }]} />
              </div>
            </Panel>
            <div className="space-y-4">
              <Panel title="Safety-layer interventions" eyebrow="Motions rejected or modified BEFORE execution - not collisions" dense>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="Interventions" value={String(r.safety.total_interventions)} />
                  <Stat label="Episodes affected" value={String(r.safety.episodes_with_interventions)} />
                  <Stat label="Per episode" value={r.safety.per_episode !== null ? r.safety.per_episode.toFixed(1) : "—"} />
                </div>
              </Panel>
              <Panel title="Most common collision causes" eyebrow="Classified from the contact point and the scan before contact" dense>
                {r.collision_causes.length === 0 ? <div className="text-[12px] text-ink-3">No collisions recorded in this window.</div> : (
                  <div className="space-y-1.5">
                    {r.collision_causes.map(([c, n]) => (
                      <div key={c} className="flex items-center gap-2 text-[12px]">
                        <span className="min-w-0 flex-1 truncate text-ink-2">{c}</span>
                        <div className="h-1.5 w-28 rounded-full bg-surface-3"><div className="h-full rounded-full bg-[#d95926]" style={{ width: `${(n / r.collision_causes[0][1]) * 100}%` }} /></div>
                        <span className="mono w-8 text-right text-ink">{n}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
              <Panel title="Environment check (A* baseline, known map)" dense>
                {r.baseline ? (
                  <div className="space-y-1 text-[12px] text-ink-2">
                    <div>A* success {pct(r.baseline.success.rate)} [{pct(r.baseline.success.ci_low)}–{pct(r.baseline.success.ci_high)}] over {r.baseline.episodes} benchmark episodes.</div>
                    <div>Collisions on maps without moving obstacles: {r.baseline.static_map_collisions.k} / {r.baseline.static_map_collisions.n}.</div>
                    <div className="text-[11px] text-ink-3">{r.baseline.note}</div>
                  </div>
                ) : <div className="text-[12px] text-ink-3">Benchmark A* to verify that maps are navigable and the collision system behaves.</div>}
              </Panel>
            </div>
          </div>

          <Panel title="Recent failures" eyebrow="Evaluation episodes that ended in a collision or timeout" bodyClassName="!p-0">
            {r.failures.length === 0 ? <EmptyState title="No failures in this window" /> : (
              <div className="divide-y divide-line">
                {r.failures.map((f) => (
                  <div key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[12px]">
                    <span className="mono w-28 shrink-0 text-[11px] text-ink-3">{dateTime(f.time)}</span>
                    <OutcomeBadge outcome={f.outcome} />
                    <span className="min-w-0 flex-1 truncate text-ink-2">{f.policy} · {f.scenario}{f.cause ? ` — ${f.cause}` : f.outcome === "timeout" ? " — did not reach the goal in time" : ""}</span>
                    <Tag>{f.source}</Tag>
                    <Tag>{f.shield ? "shield on" : "shield off"}</Tag>
                    <Link to={`/episodes?id=${f.id}`}><Button size="sm" variant="ghost" icon={<Play className="h-3 w-3" />}>Replay</Button></Link>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Training episodes (not evaluations)" eyebrow={r.training.note} dense>
          <div className="text-[12px] text-ink-2">{r.training.episodes ? `${r.training.not_reaching_goal} of the last ${r.training.episodes} training episodes did not reach the goal (${r.training.collisions} ended in a collision).` : "No training run in this server session."}</div>
        </Panel>
        <Panel title="Definitions" dense>
          {Object.entries(r.definitions).map(([k, d]) => <div key={k} className="text-[11.5px] text-ink-3"><b className="text-ink-2">{k.replace(/_/g, " ")}:</b> {d}</div>)}
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-line bg-surface-2 px-3 py-2"><div className="eyebrow">{label}</div><div className="mono mt-0.5 text-[16px] text-ink">{value}</div></div>;
}
