import { useSyncExternalStore } from "react";

/** Per-browser UI preferences (localStorage). Never stores credentials. */
export type PanelId = "telemetry" | "analysis" | "environment";
export const TELEMETRY_FIELDS = ["pose", "distance", "action", "reward", "steps", "collision", "rate", "safety"] as const;
export type TelemetryField = (typeof TELEMETRY_FIELDS)[number];
export interface WorkspaceLayout { panels: PanelId[]; telemetry: TelemetryField[] }

export const BUILTIN_LAYOUTS: Record<string, WorkspaceLayout> = {
  Default: { panels: ["telemetry", "analysis", "environment"], telemetry: [...TELEMETRY_FIELDS] },
  "Demo (minimal)": { panels: ["telemetry"], telemetry: ["pose", "distance", "action", "collision"] },
  "Map editing": { panels: ["environment", "analysis"], telemetry: ["pose"] },
};

/** Interface density only: hides nothing permanently, never touches training or simulation state. */
export type UiMode = "beginner" | "advanced";

export interface Prefs {
  sim: { showGrid: boolean; showTrail: boolean; showSensors: boolean; showReference: boolean; speed: number; view: "3d" | "2d"; camera: "orbit" | "top" | "follow" };
  charts: { window: number; smoothing: number; showRaw: boolean };
  training: { episodes: number; lr: number; gamma: number; batch: number };
  reduceMotion: boolean;
  sidebarCollapsed: boolean;
  uiMode: UiMode;
  workspace: { active: string; layout: WorkspaceLayout; saved: Record<string, WorkspaceLayout> };
}

const DEFAULTS: Prefs = {
  sim: { showGrid: true, showTrail: true, showSensors: true, showReference: false, speed: 8, view: "3d", camera: "orbit" },
  charts: { window: 500, smoothing: 50, showRaw: true },
  training: { episodes: 1500, lr: 0.00025, gamma: 0.99, batch: 128 },
  reduceMotion: false,
  sidebarCollapsed: false,
  uiMode: "beginner",
  workspace: { active: "Default", layout: BUILTIN_LAYOUTS.Default, saved: {} },
};

const KEY = "nexus.prefs.v1";
let prefs: Prefs = load();
const listeners = new Set<() => void>();

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw);
    return {
      ...DEFAULTS, ...p,
      sim: { ...DEFAULTS.sim, ...p.sim },
      charts: { ...DEFAULTS.charts, ...p.charts },
      training: { ...DEFAULTS.training, ...p.training },
      workspace: { ...DEFAULTS.workspace, ...p.workspace },
    };
  } catch {
    return DEFAULTS;
  }
}

export function updatePrefs(fn: (p: Prefs) => Prefs) {
  prefs = fn(prefs);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function resetPrefs() {
  updatePrefs(() => DEFAULTS);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}
