// Types for NEXUS 2.0 research features (mirror server/research.py, stores.py, catalog.py, copilot.py).
import type { Rect, Vec2 } from "./types";

export interface Ci { rate: number | null; k: number; n: number; ci_low: number; ci_high: number }
export interface MeanCi { mean: number | null; n: number; ci_low: number | null; ci_high: number | null; std: number | null }

export interface Difficulty {
  score: number | null;
  band: string;
  components: Record<string, number>;
  weights: Record<string, number>;
  note?: string;
}

export interface MapAnalysis {
  assumptions: Record<string, number>;
  width: number; height: number;
  obstacle_density: number; static_obstacles: number; moving_obstacles: number; temporary_blockages: number;
  free_space_ratio: number; reachable_free_ratio: number; free_regions: number; route_exists: boolean;
  start_goal_distance: number; start_clearance: number; goal_clearance: number; narrow_regions: number;
  local_minimum_trap: boolean; greedy_stuck_distance: number;
  shortest_path: number | null; path: Vec2[]; tortuosity: number | null; route_min_clearance: number | null;
  narrow_on_route: number | null; route_alternatives: number; start_heading_error_deg: number | null;
  difficulty: Difficulty;
}

export interface WorldDict {
  width: number; height: number; rects: Rect[]; timed: number[][]; movers: number[][]; mover_radius: number;
  start: [number, number, number]; goal: Vec2;
}

export interface Scenario {
  id: string | null; name: string; type: string; seed: number; size: number; split: string; created: number;
  world?: WorldDict; analysis?: MapAnalysis; difficulty: Difficulty;
}

export interface ScenarioSet {
  id: string; name: string; role: "training" | "evaluation"; scenario_ids: string[]; created: number;
  recipe: Record<string, unknown>;
  composition: { bands: Record<string, number>; by_type: Record<string, Record<string, number>>; count: number };
  difficulty_scores: number[];
  scenarios?: { id: string; name: string; type: string; difficulty: Difficulty; seed: number }[];
}

export interface BehaviorLabel {
  label: string; name: string; status: "detected" | "uncertain"; value: number | null; threshold: number;
  uncertain_from: number; rule: string; segments: [number, number][]; evidence: Record<string, unknown>;
}

export interface EpisodeSummary {
  id: string; created: number; source: string; label: string | null; policy: string; policy_name: string;
  run_id: string | null; seed: number; outcome: "success" | "collision" | "timeout"; world_hash: string;
  steps: number; reward: number; path_length: number; path_ratio: number | null; min_clearance: number | null;
  model_id: string | null; model_label: string | null; scenario_id: string | null; scenario_type: string | null;
  scenario_name: string | null; behaviors: string[]; uncertain: string[]; parent_id: string | null; exact: boolean | null;
}

export interface Restoration {
  method: string; exact: boolean; branch_step: number; prefix_action_mismatches: number;
  max_prefix_deviation_m: number; note: string;
}

export interface Episode {
  id: string; created: number; source: string; label: string | null; policy: string; policy_name: string;
  model: { model_id: string; label: string; algorithm: string; env_version: string } | null;
  scenario: { id: string; type: string; name: string; difficulty?: number; modified?: boolean } | null;
  run_id: string | null; seed: number; conditions: Record<string, unknown>; world: WorldDict;
  control_dt: number; robot_radius: number; goal_radius: number; max_steps: number; planned_path: Vec2[];
  steps: {
    x: number[]; y: number[]; theta: number[]; dist: number[]; min_range: (number | null)[]; action: string[];
    reward: number[]; v: number[]; w: number[]; safety: string[][];
  };
  metrics: {
    outcome: string; steps_taken: number; reward: number; path_length: number; reference_length: number | null;
    path_ratio: number | null; collisions: number; min_clearance: number | null;
  };
  outcome: string;
  behavior: { outcome: string; labels: BehaviorLabel[]; detected: string[]; uncertain: string[]; metrics: Record<string, unknown> };
  parent: { episode_id: string; branch_step: number; modification: Record<string, unknown> } | null;
  restoration: Restoration | null;
}

export interface StepInspection {
  step: number; recorded_action: string; pose: { x: number; y: number; theta: number };
  observation: {
    ranges_norm: number[]; goal_dist_norm: number; goal_bearing_deg: number; last_v_norm: number;
    last_w_norm: number; beam_angles_deg: number[];
  };
  q_values: Record<string, number> | null; restoration: Restoration; actions: string[];
}

export interface CounterfactualResult {
  episode: Episode; summary: EpisodeSummary; restoration: Restoration;
  comparison: Record<string, { original: unknown; counterfactual: unknown; delta: number | null }>;
}

export interface RunEntryResult {
  policy: string; model_id: string | null; name: string;
  overall: { episodes: number; success: Ci; collision: Ci; timeout: Ci; path_ratio: MeanCi };
  by_type: Record<string, { success: Ci; collision: Ci }>; behaviors: Record<string, number>;
}

export interface BenchmarkRun {
  id: string; label: string; set_id: string; set_name: string; entries: { policy: string; model_id?: string }[];
  repeats: number; conditions: Record<string, unknown>; status: string; created: number; finished?: number;
  results: Record<string, RunEntryResult>;
}

export interface RiskSummary {
  episodes: number;
  by_type?: Record<string, { success: Ci; collision: Ci; timeout: Ci }>;
  clearance_hist?: { edges: number[]; counts: number[]; n: number };
  behaviors?: Record<string, number>;
  scenarios?: { scenario_id: string; name: string; type: string; episodes: number; failure: Ci; collision: Ci }[];
  note?: string;
}

export interface RiskMap {
  scenario: { id: string; name: string; type: string; world: WorldDict; difficulty: Difficulty };
  episodes: number; cell: number; nx: number; ny: number; min_visits: number;
  layers: { visits: number[][]; collisions: number[][]; stuck: number[][]; failure_ratio: (number | null)[][] };
  trajectories: { id: string; outcome: string; policy: string; model_id: string | null; points: Vec2[]; behaviors: string[]; route: string }[];
  routes: { route: string; episodes: string[]; failure: Ci }[];
  note: string;
}

export interface RegionResult {
  episodes: (EpisodeSummary & { steps_in_region: number; first_step_in_region: number; ended_in_region: boolean; failed_in_region: boolean })[];
  passing: number; failure: Ci; failed_inside: number;
}

export interface Benchmark {
  run_id: string; set_id: string; set_name: string; policy: string; time: number; repeats: number;
  conditions: Record<string, unknown>;
  summary: { episodes: number; success: Ci; collision: Ci; timeout: Ci; path_ratio: MeanCi };
}

export interface RegisteredModel {
  model_id: string; label: string; algorithm: "dqn" | "qlearning"; architecture: Record<string, unknown>;
  interface: Record<string, unknown>; env_version: string; training_config: Record<string, unknown>; seed: number;
  experiment_id: string | null; checkpoint: string; checkpoint_name: string; created: number;
  training: { episodes: number | null; total_steps: number | null; duration_s: number | null; best_validation_success: number | null };
  benchmarks: Benchmark[];
  compatibility_issues: string[]; checkpoint_exists?: boolean; active?: boolean; episodes?: number;
}

export interface ModelComparison {
  a: RegisteredModel; b: RegisteredModel; differences: { key: string; a: unknown; b: unknown }[];
  benchmark: null | { metric: string; a: Ci; b: Ci; p_value: number | null; verdict: string; comparable: boolean };
  compatible_with_each_other: boolean;
}

export interface DesignCell { cell_id: string; params: Record<string, unknown>; purpose: string; baseline?: boolean }

export interface DesignPlan {
  question: string; design_type: "train" | "evaluate"; cells: DesignCell[]; seeds: number; eval_set: string; metric: string;
  eval_repeats: number; episodes_per_run: number; runs: number; estimated_env_steps: number; estimated_minutes: number;
  budget_minutes: number; within_budget: boolean; separation: string; mode: string;
}

export interface DesignSummaryCell extends MeanCi { cell_id: string; purpose: string; params: Record<string, unknown>; values: number[] }

export interface Design {
  id: string; name: string; spec: Record<string, unknown>; plan: DesignPlan; status: string; created: number; job_id?: string;
  results: { cell_id: string; seed: number; model_id: string; metrics: Record<string, number | null>; episodes: number }[];
  summary: null | {
    metric: string; higher_is_better: boolean; winner: string | null; conclusion: string; cells: DesignSummaryCell[];
    comparisons: { cell_id: string; vs: string; p_value: number | null; verdict: string }[];
  };
}

export interface Job {
  id: string; kind: string; title: string; status: "queued" | "running" | "completed" | "failed" | "cancelled";
  done: number; total: number | null; message: string; result: unknown; error: string | null;
  created: number; started: number | null; finished: number | null;
}

export interface CopilotAnswer {
  intent: string; title: string;
  facts: { text: string; source: string }[];
  hypotheses: { text: string; basis: string }[];
  recommendations: { text: string; basis?: string; action: Record<string, unknown> | null }[];
  background?: string; data: Record<string, unknown>;
  provider: { provider: string; enabled: boolean; model?: string; reason: string };
  narrative: null | { text?: string; model?: string; error?: string };
}

export interface CurriculumState {
  level: number; n_levels: number; band: [number, number]; edges: number[]; episodes_at_level: number;
  rolling_success: number | null; threshold: number; window: number; min_episodes: number; types: string[];
  history: { episode: number; from: number; to: number; success: number; episodes_at_level: number }[];
  pool_sizes: Record<string, number>; criterion: string;
}

export interface SearchHit { kind: string; id: string; title: string; subtitle: string }

export interface ValidationStatus {
  status: "validated" | "failed" | "not_validated"; label: string; reasons: string[]; criteria: string;
  evidence: null | { run_id: string; episodes: number; success: Ci; collision: Ci; timeout: Ci };
}

export interface ReliabilityReport {
  model_id: string | null; active_model: { label: string; path: string } | null;
  validation: Record<string, ValidationStatus> | null; window: number; episodes: number;
  outcomes: { success: Ci; collision: Ci; timeout: Ci };
  by_shield: Record<"shield_on" | "shield_off", { episodes: number; collision: Ci; success: Ci }>;
  safety: { total_interventions: number; episodes_with_interventions: number; per_episode: number | null };
  collision_causes: [string, number][];
  failures: { id: string; time: number; outcome: string; cause: string | null; policy: string; scenario: string; source: string; shield: boolean; behaviors: string[] }[];
  training: { status: string; episodes: number; not_reaching_goal: number; collisions: number; note: string };
  baseline: null | { episodes: number; success: Ci; static_map_collisions: Ci; note: string };
  definitions: Record<string, string>;
}
