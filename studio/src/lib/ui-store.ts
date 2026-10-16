import { useSyncExternalStore } from "react";

/** Global UI state shared across pages (overlays + copilot context). */
export interface UiState {
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  copilotOpen: boolean;
  jobsOpen: boolean;
  copilotRequest: { intent: string; params: Record<string, unknown>; nonce: number } | null;
  context: { episodeId?: string; experimentIds?: string[]; runId?: string };
}

let ui: UiState = { paletteOpen: false, shortcutsOpen: false, copilotOpen: false, jobsOpen: false, copilotRequest: null, context: {} };
const listeners = new Set<() => void>();

export function setUi(patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) {
  ui = { ...ui, ...(typeof patch === "function" ? patch(ui) : patch) };
  listeners.forEach((l) => l());
}

export function useUi<T>(sel: (s: UiState) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => sel(ui));
}

/** Open the copilot and run an intent (e.g. from an "Explain" button). */
export function askCopilot(intent: string, params: Record<string, unknown> = {}) {
  setUi({ copilotOpen: true, copilotRequest: { intent, params, nonce: Date.now() } });
}
