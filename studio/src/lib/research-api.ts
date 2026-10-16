import { getApiBase } from "./base";
import { get, post, request } from "./api";
import type {
  BenchmarkRun, CopilotAnswer, CounterfactualResult, Design, DesignPlan, Episode, EpisodeSummary, Job, MapAnalysis,
  ModelComparison, RegionResult, ReliabilityReport, RegisteredModel, RiskMap, RiskSummary, Scenario, ScenarioSet, SearchHit, StepInspection,
} from "./research-types";

const qs = (o: Record<string, unknown>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

export const research = {
  scenarios: {
    types: () => get<Record<string, string>>("/api/scenarios/types"),
    generate: (type: string, seed?: number | null, size = 6, save = false, name?: string) =>
      post<Scenario>("/api/scenarios/generate", { type, seed: seed ?? undefined, size, save, name }),
    list: () => get<Scenario[]>("/api/scenarios"),
    get: (id: string) => get<Scenario>(`/api/scenarios/${id}`),
    remove: (id: string) => request("DELETE", `/api/scenarios/${id}`),
    load: (id: string) => post(`/api/scenarios/${id}/load`),
    saveCurrent: (name: string) => post<Scenario>("/api/scenarios/save-current", { name }),
    analyzeSim: () => get<MapAnalysis>("/api/sim/analyze"),
  },
  sets: {
    list: () => get<ScenarioSet[]>("/api/scenario-sets"),
    get: (id: string) => get<ScenarioSet>(`/api/scenario-sets/${id}`),
    create: (b: { name: string; types: string[]; per_type: number; role: string; size: number }) => post<Job>("/api/scenario-sets", b),
    benchmark: () => post<Job>("/api/scenario-sets/benchmark"),
    remove: (id: string) => request("DELETE", `/api/scenario-sets/${id}`),
  },
  episodes: {
    list: (f: Record<string, unknown>) => get<EpisodeSummary[]>(`/api/episodes?${qs(f)}`),
    get: (id: string) => get<Episode>(`/api/episodes/${id}`),
    step: (id: string, k: number) => get<StepInspection>(`/api/episodes/${id}/step/${k}`),
    counterfactual: (id: string, step: number, modification: Record<string, unknown>) =>
      post<CounterfactualResult>(`/api/episodes/${id}/counterfactual`, { step, modification }),
    rules: () => get<Record<string, { desc: string; detect: number; uncertain: number }>>("/api/behavior/rules"),
  },
  risk: {
    summary: (f: Record<string, unknown>) => get<RiskSummary>(`/api/risk/summary?${qs(f)}`),
    map: (f: Record<string, unknown>) => get<RiskMap>(`/api/risk/map?${qs(f)}`),
    region: (b: { scenario_id: string; rect: number[]; run_id?: string; model_id?: string }) => post<RegionResult>("/api/risk/region", b),
  },
  runs: {
    list: () => get<BenchmarkRun[]>("/api/runs"),
    get: (id: string) => get<BenchmarkRun>(`/api/runs/${id}`),
    create: (b: { set_id: string; entries: { policy: string; model_id?: string }[]; repeats: number; label?: string;
      sensor_noise?: number; motion_noise?: number; shield?: boolean }) => post<Job>("/api/runs", b),
    remove: (id: string) => request("DELETE", `/api/runs/${id}`),
  },
  models: {
    list: () => get<RegisteredModel[]>("/api/models"),
    get: (id: string) => get<RegisteredModel>(`/api/models/${id}`),
    load: (id: string) => post(`/api/models/${id}/load`),
    benchmark: (id: string, policy: string, repeats: number) => post<Job>(`/api/models/${id}/benchmark`, { policy, repeats }),
    compare: (a: string, b: string) => get<ModelComparison>(`/api/models/${a}/compare/${b}`),
  },
  designs: {
    plan: (spec: Record<string, unknown>) => post<DesignPlan>("/api/designs/plan", { spec }),
    create: (spec: Record<string, unknown>, name?: string) => post<Design>("/api/designs", { spec, name }),
    list: () => get<Design[]>("/api/designs"),
    get: (id: string) => get<Design>(`/api/designs/${id}`),
    remove: (id: string) => request("DELETE", `/api/designs/${id}`),
  },
  jobs: {
    list: () => get<Job[]>("/api/jobs"),
    cancel: (id: string) => post<Job>(`/api/jobs/${id}/cancel`),
  },
  copilot: {
    status: () => get<{ provider: string; enabled: boolean; model?: string; reason: string; concepts: string[] }>("/api/copilot/status"),
    ask: (intent: string, params: Record<string, unknown> = {}, question?: string) =>
      post<CopilotAnswer>("/api/copilot/ask", { intent, params, question }),
  },
  reliability: (modelId?: string) => get<ReliabilityReport>(`/api/reliability${modelId ? `?model_id=${modelId}` : ""}`),
  search: (q: string) => get<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
  bundleUrl: (expId: string) => `${getApiBase()}/api/experiments/${expId}/bundle`,
};
