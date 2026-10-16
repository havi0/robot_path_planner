// Types mirror the JSON produced by server/*.py. Undefined metrics arrive as null.
import type { CurriculumState, Job } from "./research-types";

export type Vec2 = [number, number];
export type Rect = [number, number, number, number];

export interface WorldState {
  width: number;
  height: number;
  rects: Rect[];
  timed?: number[][];
  movers: Vec2[];
  mover_radius: number;
  start: [number, number, number];
  goal: Vec2;
  goal_radius: number;
  robot_radius: number;
}

export interface RobotPose {
  x: number;
  y: number;
  theta: number;
  collided?: boolean;
}

export interface SensorState {
  ranges: (number | null)[];
  angles: number[];
  max_range: number;
}

export type SimStatus = "idle" | "running" | "paused" | "finished";
export type Outcome = "success" | "collision" | "timeout" | null;

export interface SimConfig {
  width: number;
  height: number;
  density: number;
  num_obstacles: number | null;
  dynamic_obstacles: number;
  seed: number;
  max_linear: number;
  max_angular: number;
}

export interface RobotVisual {
  model: "scout" | "hauler" | "glide" | "courier" | "custom";
  color: string;
  length: number;
  width: number;
  height: number;
  body?: "round" | "box";
}

export interface CustomRobot {
  drive: "differential" | "skid_steer";
  radius: number;
  max_linear: number;
  max_angular: number;
  name: string;
  visual: { color: string; body: "round" | "box"; height: number };
}

/** Mirrors navigation/robots.py public(). */
export interface RobotProfile {
  id: string;
  name: string;
  kind: string;
  tagline: string;
  description: string;
  drive: "differential" | "skid_steer" | "mecanum";
  kinematics: "diff_drive" | "skid_steer" | "holonomic";
  action_set: "unicycle4" | "holonomic8";
  radius: number;
  max_linear: number;
  max_angular: number;
  visual: RobotVisual;
  capabilities: string[];
  limitations: string[];
  training: boolean;
  training_note?: string;
  sensor: { num_beams: number; fov_deg: number; max_range: number };
  kinematics_params?: { yaw_efficiency?: number };
  actions: string[];
  reference: boolean;
  custom?: CustomRobot;
}

export type CompatStatus = "trained" | "unvalidated" | "incompatible" | "planner" | "unavailable";
export interface PolicyCompat { status: CompatStatus; ok: boolean; detail: string }

export interface RobotState {
  robots: RobotProfile[];
  selected: RobotProfile;
  compatibility: Record<string, PolicyCompat>;
  preview: Record<string, Record<string, PolicyCompat>>;
  policy_names: Record<string, string>;
  speed_limits: { max_linear: number; max_angular: number };
  notes?: string[];
}

export interface SimSnapshot {
  status: SimStatus;
  robot_profile?: RobotProfile;
  policy_compat?: Record<string, PolicyCompat>;
  episode: number;
  outcome: Outcome;
  policy: string;
  policies: Record<string, string>;
  shield: boolean;
  speed: number;
  config: SimConfig;
  world_version: number;
  world: WorldState;
  robot: RobotPose;
  sensor: SensorState;
  trail: Vec2[];
  planned_path: Vec2[];
  reference_path: Vec2[];
  collisions: Vec2[];
  collision_cause: { kind: string; cause: string; bearing_deg: number; sensed_before: boolean; last_action: string } | null;
  interventions: number;
  reward_terms: Record<string, number>;
  telemetry: {
    x: number;
    y: number;
    heading_deg: number;
    distance_to_goal: number;
    action: string | null;
    reward: number;
    steps: number;
    max_steps: number;
    collision: boolean;
    sim_hz: number;
    safety: string[];
  };
  analysis: {
    traveled: number;
    turns: number;
    min_clearance: number | null;
    reference_length: number | null;
    path_ratio: number | null;
    plan: { length: number | null; time_ms: number; nodes_expanded: number; found: boolean } | null;
  };
}

export type TrainingStatus = "idle" | "running" | "paused" | "stopping" | "completed" | "stopped" | "failed";

export interface TrainingPreview {
  world: WorldState;
  robot: RobotPose;
  trail: Vec2[];
  episode: number;
  reward: number;
}

export interface TrainingSummary {
  status: TrainingStatus;
  experiment_id: string | null;
  algorithm: "dqn" | "qlearning" | null;
  episode: number;
  target_episodes: number;
  total_steps: number;
  epsilon: number | null;
  loss: number | null;
  throughput: number;
  elapsed: number;
  mean_reward: number | null;
  success_rate: number | null;
  collision_rate: number | null;
  mean_length: number | null;
  window: number;
  evaluating: string | null;
  preview: TrainingPreview | null;
  curriculum: CurriculumState | null;
}

export interface EpisodeMetric {
  episode: number;
  total_steps: number;
  reward: number;
  length: number;
  outcome: "success" | "collision" | "timeout";
  epsilon: number | null;
  loss: number | null;
  throughput: number | null;
  time: number | null;
}

export type EventLevel = "info" | "success" | "warning" | "error";

export interface NexusEvent {
  seq: number;
  time: number;
  level: EventLevel;
  category: string;
  message: string;
  data: Record<string, unknown>;
}

export interface HardwareSnapshot {
  status: "disconnected" | "connected" | "error";
  kind: "ros2" | "loopback" | null;
  simulated: boolean;
  ros2_available: boolean;
  last_error: string | null;
  armed: boolean;
  estop: boolean;
  mode: "idle" | "manual" | "autonomous";
  goal: Vec2 | null;
  deploy_outcome: string | null;
  arm_phrase: string;
  telemetry: {
    pose: { x: number; y: number; theta: number; age: number } | null;
    sensor: { valid_fraction: number; age: number; min_range: number | null; ranges: (number | null)[]; angles: number[]; max_range: number } | null;
    requested: { v: number; w: number } | null;
    executed: { v: number; w: number } | null;
    safety: string[];
  } | null;
  world: WorldState | null;
  trail: Vec2[];
  limits: {
    max_linear: number;
    max_angular: number;
    profile_max_linear: number;
    profile_max_angular: number;
    stop_distance: number;
    sensor_timeout: number;
    manual_timeout: number;
  };
}

export interface ModelInfo {
  experiment_id: string | null;
  label: string;
  path: string;
  algorithm: string;
}

export interface Models {
  dqn: ModelInfo | null;
  qlearning: ModelInfo | null;
}

export interface Checkpoint {
  name: string;
  path: string;
  size: number;
  modified: number;
}

export interface EvalResultStats {
  episodes: number;
  success_rate: number;
  success_ci_low: number;
  success_ci_high: number;
  collision_rate: number;
  timeout_rate: number;
  mean_path_ratio_success: number | null;
  mean_path_length_success: number | null;
  mean_steps_success: number | null;
  mean_planning_ms?: number | null;
  mean_inference_ms: number | null;
}

export interface Evaluation {
  kind: "validation" | "test";
  total_steps?: number;
  episodes: number;
  success_rate?: number;
  collision_rate?: number;
  timeout_rate?: number;
  checkpoint?: string;
  time?: number;
  results?: Record<string, EvalResultStats>;
}

export interface Experiment {
  id: string;
  name: string;
  algorithm: "dqn" | "qlearning";
  hyperparameters: Record<string, unknown>;
  environment: Record<string, unknown>;
  seed: number;
  status: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  duration_s: number | null;
  episodes: number;
  total_steps: number;
  target_episodes?: number;
  evaluations: Evaluation[];
  imported: boolean;
  notes?: string;
  checkpoints: Checkpoint[];
}

export interface CompareResult {
  key: string;
  name: string;
  uses_known_map: boolean;
  outcome: string;
  success: boolean;
  path_length: number;
  actions: number;
  collisions: number;
  planning_ms: number;
  nodes_expanded: number;
  inference_ms_per_step: number;
  wall_ms: number;
  reference_length: number | null;
  path_ratio: number | null;
  trajectory: Vec2[];
  planned_path: Vec2[];
}

export interface CompareResponse {
  map: WorldState;
  map_seed: number;
  source: string;
  results: CompareResult[];
  trials: (Record<string, EvalResultStats> & { _info?: { trials: number; density: number; seeds: [number, number] } }) | null;
}

export interface LiveState {
  connection: "connecting" | "online" | "offline";
  operatingMode: "simulation" | "hardware";
  sim: SimSnapshot | null;
  training: TrainingSummary | null;
  hardware: HardwareSnapshot | null;
  events: NexusEvent[];
  episodes: EpisodeMetric[];
  models: Models | null;
  jobs: Job[];
  lastTick: number;
}
