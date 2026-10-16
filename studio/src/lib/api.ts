import { getApiBase } from "./base";
import type { CompareResponse, EpisodeMetric, Experiment, HardwareSnapshot, ModelInfo, SimConfig, SimSnapshot, TrainingSummary } from "./types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(getApiBase() + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Backend unreachable - is the server running?", 0);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

export const post = <T,>(p: string, b: unknown = {}) => request<T>("POST", p, b);
export const get = <T,>(p: string) => request<T>("GET", p);

export interface TrainRequest {
  name: string;
  algorithm: "dqn" | "qlearning";
  episodes: number;
  lr?: number;
  gamma?: number;
  eps_start?: number;
  eps_end?: number;
  eps_decay?: number;
  buffer_size?: number;
  batch_size?: number;
  target_update?: number;
  alpha?: number;
  seed?: number;
  density_min?: number;
  density_max?: number;
  randomization?: boolean;
  eval_every?: number;
  curriculum?: { enabled: boolean; types: string[]; threshold: number; window: number; min_episodes: number };
}

export const api = {
  health: () => get<{ status: string; version: string; python: string; torch: string; ros2_available: boolean }>("/api/health"),
  setMode: (mode: "simulation" | "hardware") => post("/api/mode", { mode }),

  sim: {
    state: () => get<SimSnapshot>("/api/sim/state"),
    control: (action: "start" | "pause" | "resume" | "reset" | "step" | "regenerate") => post<SimSnapshot>("/api/sim/control", { action }),
    speed: (steps_per_second: number) => post("/api/sim/speed", { steps_per_second }),
    policy: (policy: string) => post("/api/sim/policy", { policy }),
    shield: (enabled: boolean) => post("/api/sim/shield", { enabled }),
    config: (cfg: Partial<SimConfig>) => post<SimSnapshot>("/api/sim/config", cfg),
    goal: (x: number, y: number) => post("/api/sim/goal", { x, y }),
    start: (x: number, y: number, theta?: number) => post("/api/sim/start", { x, y, theta }),
    addObstacle: (rect: number[]) => post("/api/sim/obstacles", { action: "add", rect }),
    removeObstacle: (x: number, y: number) => post("/api/sim/obstacles", { action: "remove", x, y }),
    clearObstacles: () => post("/api/sim/obstacles", { action: "clear" }),
  },

  training: {
    state: () => get<TrainingSummary>("/api/training/state"),
    start: (req: TrainRequest) => post<Experiment>("/api/training/start", req),
    action: (a: "pause" | "resume" | "stop" | "checkpoint") => post<TrainingSummary>(`/api/training/${a}`),
    evaluate: (experiment_id: string, checkpoint?: string, episodes = 50) =>
      post<{ checkpoint: string }>("/api/evaluate", { experiment_id, checkpoint, episodes }),
    load: (experiment_id: string, checkpoint?: string) => post<ModelInfo>("/api/checkpoints/load", { experiment_id, checkpoint }),
  },

  experiments: {
    list: () => get<Experiment[]>("/api/experiments"),
    get: (id: string) => get<Experiment>(`/api/experiments/${id}`),
    metrics: (id: string) => get<EpisodeMetric[]>(`/api/experiments/${id}/metrics`),
    rename: (id: string, name: string) => request<Experiment>("PATCH", `/api/experiments/${id}`, { name }),
    remove: (id: string) => request<{ ok: boolean }>("DELETE", `/api/experiments/${id}`),
    exportUrl: (id: string, format: "csv" | "json") => `${getApiBase()}/api/experiments/${id}/export?format=${format}`,
  },

  planner: {
    compare: (algorithms: string[], source: "current" | "random", trials: number, seed?: number, density?: number) =>
      post<CompareResponse>("/api/planner/compare", { algorithms, source, trials, seed, density }),
  },

  hardware: {
    state: () => get<HardwareSnapshot>("/api/hardware/state"),
    profile: () => get<Record<string, unknown>>("/api/hardware/profile"),
    connect: (backend: "ros2" | "loopback") => post<HardwareSnapshot>("/api/hardware/connect", { backend }),
    disconnect: () => post<HardwareSnapshot>("/api/hardware/disconnect"),
    arm: (confirmation: string) => post<HardwareSnapshot>("/api/hardware/arm", { confirmation }),
    disarm: () => post<HardwareSnapshot>("/api/hardware/disarm"),
    estop: (engaged: boolean) => post<HardwareSnapshot>("/api/hardware/estop", { engaged }),
    manual: (v: number, w: number) => post("/api/hardware/manual", { v, w }),
    deploy: (goal?: [number, number]) => post<HardwareSnapshot>("/api/hardware/deploy", { goal }),
    stop: () => post<HardwareSnapshot>("/api/hardware/stop"),
  },
};
