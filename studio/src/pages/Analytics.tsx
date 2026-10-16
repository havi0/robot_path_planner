import clsx from "clsx";
import { BarChart3, Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LineChartCard, type Series } from "../components/charts/LineChartCard";
import { Select } from "../components/ui/controls";
import { EmptyState, Skeleton, Tag } from "../components/ui/feedback";
import { Panel } from "../components/ui/panel";
import { api } from "../lib/api";
import { fmt, int, pct, smooth } from "../lib/format";
import type { EpisodeMetric, Experiment } from "../lib/types";

// Three validated colours (all-pairs safe on the dark surface) + dash patterns as second cue.
const COLORS = ["#9085e9", "#d95926", "#199e70"];
const DASH = [undefined, "6 3", "2 3"];

export function Analytics() {
  const [params, setParams] = useSearchParams();
  const [all, setAll] = useState<Experiment[] | null>(null);
  const [metrics, setMetrics] = useState<Record<string, EpisodeMetric[]>>({});
  const [smoothing, setSmoothing] = useState(50);
  const ids = (params.get("ids") ?? "").split(",").filter(Boolean).slice(0, 3);

  useEffect(() => {
    api.experiments.list().then((l) => {
      setAll(l);
      if (!params.get("ids") && l.length) setParams({ ids: l.slice(0, Math.min(2, l.length)).map((e) => e.id).join(",") }, { replace: true });
    }).catch(() => setAll([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    ids.filter((id) => !metrics[id]).forEach((id) => api.experiments.metrics(id).then((m) => setMetrics((x) => ({ ...x, [id]: m }))).catch(() => {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(",")]);

  const sel = ids.map((id) => all?.find((e) => e.id === id)).filter(Boolean) as Experiment[];
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id].slice(-3);
    setParams({ ids: next.join(",") });
  };

  const { reward, success, length, validation } = useMemo(() => {
    const byEp = (key: (m: EpisodeMetric[]) => number[]) => {
      const rows = new Map<number, Record<string, number | null>>();
      sel.forEach((e, i) => {
        const ms = metrics[e.id] ?? [];
        const vals = key(ms);
        ms.forEach((m, j) => {
          const r = rows.get(m.episode) ?? { x: m.episode };
          r[`e${i}`] = vals[j];
          rows.set(m.episode, r);
        });
      });
      return [...rows.values()].sort((a, b) => (a.x as number) - (b.x as number));
    };
    const val = new Map<number, Record<string, number | null>>();
    sel.forEach((e, i) => e.evaluations.filter((v) => v.kind === "validation").forEach((v) => {
      const r = val.get(v.total_steps ?? 0) ?? { x: v.total_steps ?? 0 };
      r[`e${i}`] = v.success_rate ?? null;
      val.set(v.total_steps ?? 0, r);
    }));
    return {
      reward: byEp((ms) => smooth(ms.map((m) => m.reward), smoothing)),
      success: byEp((ms) => smooth(ms.map((m) => (m.outcome === "success" ? 1 : 0)), smoothing)),
      length: byEp((ms) => smooth(ms.map((m) => m.length), smoothing)),
      validation: [...val.values()].sort((a, b) => (a.x as number) - (b.x as number)),
    };
  }, [sel.map((e) => e.id).join(","), metrics, smoothing]); // eslint-disable-line react-hooks/exhaustive-deps

  const series: Series[] = sel.map((e, i) => ({ key: `e${i}`, label: e.name, color: COLORS[i], dash: DASH[i] }));

  return (
    <div className="space-y-4 p-4">
      <Panel title="Compare experiments" eyebrow="Select up to three" dense
        actions={<Select value={String(smoothing)} onChange={(v) => setSmoothing(Number(v))} options={[{ value: "1", label: "Raw" }, { value: "20", label: "Avg 20" }, { value: "50", label: "Avg 50" }, { value: "200", label: "Avg 200" }]} />}>
        {all === null ? <Skeleton className="h-16" /> : all.length === 0 ? (
          <EmptyState icon={<BarChart3 className="h-4 w-4" />} title="Nothing to analyse yet">Train an experiment to analyse its learning curves.</EmptyState>
        ) : (
          <div className="flex flex-wrap gap-2">
            {all.map((e) => {
              const i = ids.indexOf(e.id);
              return (
                <button key={e.id} onClick={() => toggle(e.id)}
                  className={clsx("inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors", i >= 0 ? "border-line-strong bg-surface-3 text-ink" : "border-line text-ink-3 hover:text-ink-2")}>
                  {i >= 0 ? <svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" stroke={COLORS[i]} strokeWidth="2.2" strokeDasharray={DASH[i]} /></svg> : <span className="h-1.5 w-4 rounded bg-line-strong" />}
                  {e.name}
                  <Tag>{e.algorithm === "dqn" ? "DQN" : "Q-L"}</Tag>
                  {i >= 0 && <Check className="h-3 w-3 text-violet" />}
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      {sel.length > 0 && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <LineChartCard title="Episode reward" eyebrow={smoothing > 1 ? `Moving average ${smoothing}` : "Raw"} data={reward} series={series} xLabel="episode" yFormat={(v) => v.toFixed(0)} height={230}
              description="Total reward per training episode (unitless): +10 at the goal, −40 for a collision, small costs per step. Noisy; compare runs by their trend, not single points." />
            <LineChartCard title="Training success rate" eyebrow={`Rolling ${smoothing} episodes (with exploration)`} data={success} series={series} xLabel="episode" yDomain={[0, 1]} yFormat={(v) => `${Math.round(v * 100)}%`} height={230}
              description="Share of training episodes that reached the goal. Includes random exploration, so it is lower than the policy's real performance." />
            <LineChartCard title="Episode length" eyebrow="Actions per episode" data={length} series={series} xLabel="episode" yFormat={(v) => v.toFixed(0)} height={230}
              description="Decisions per episode (0.25 s each). Falling usually means faster success, but crashes also end episodes early." />
            <LineChartCard title="Validation success (greedy, unseen maps)" eyebrow="By environment steps" data={validation} series={series} xLabel="steps" yDomain={[0, 1]} yFormat={(v) => `${Math.round(v * 100)}%`} height={230}
              description="Success on 30 held-out maps with exploration off — the fairest measure of how well each run generalises."
              empty="No validation checks recorded for the selected experiments." />
          </div>

          <Panel title="Summary" eyebrow="From recorded data only" bodyClassName="!p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="eyebrow border-b border-line text-left">
                    <th className="px-4 py-2 font-normal">Experiment</th>
                    <th className="px-2 py-2 text-right font-normal">Episodes</th>
                    <th className="px-2 py-2 text-right font-normal">Steps</th>
                    <th className="px-2 py-2 text-right font-normal">Final train success (last 100)</th>
                    <th className="px-2 py-2 text-right font-normal">Best validation</th>
                    <th className="px-4 py-2 text-right font-normal">Last test evaluation</th>
                  </tr>
                </thead>
                <tbody>
                  {sel.map((e, i) => {
                    const ms = metrics[e.id] ?? [];
                    const last = ms.slice(-100);
                    const vals = e.evaluations.filter((v) => v.kind === "validation").map((v) => v.success_rate ?? 0);
                    const test = e.evaluations.filter((v) => v.kind === "test").slice(-1)[0];
                    const tr = test?.results ? Object.entries(test.results)[0] : null;
                    return (
                      <tr key={e.id} className="border-b border-line/60">
                        <td className="px-4 py-2.5"><span className="inline-flex items-center gap-2"><svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" stroke={COLORS[i]} strokeWidth="2.2" strokeDasharray={DASH[i]} /></svg>{e.name}</span></td>
                        <td className="mono px-2 py-2.5 text-right">{int(e.episodes)}</td>
                        <td className="mono px-2 py-2.5 text-right">{int(e.total_steps)}</td>
                        <td className="mono px-2 py-2.5 text-right">{last.length ? pct(last.filter((m) => m.outcome === "success").length / last.length) : "—"}</td>
                        <td className="mono px-2 py-2.5 text-right">{vals.length ? pct(Math.max(...vals)) : "—"}</td>
                        <td className="mono px-4 py-2.5 text-right">{tr ? `${tr[0]}: ${pct(tr[1].success_rate)} (${test!.episodes} maps, path ${fmt(tr[1].mean_path_ratio_success)}×)` : "not evaluated"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2.5 text-[11px] text-ink-3">Training success includes ε-exploration; validation and test numbers are greedy policies on maps never used for training.</div>
          </Panel>
        </>
      )}
    </div>
  );
}
