import { useSyncExternalStore } from "react";
import { getApiBase } from "./base";
import type { EpisodeMetric, LiveState, NexusEvent } from "./types";

/** Live backend state, fed only by the /ws stream. Nothing here is synthesised:
 *  if the socket is down the UI shows 'offline' and the last known state. */

let state: LiveState = {
  connection: "connecting",
  operatingMode: "simulation",
  sim: null,
  training: null,
  hardware: null,
  events: [],
  episodes: [],
  models: null,
  jobs: [],
  lastTick: 0,
};
const listeners = new Set<() => void>();
let episodesExp: string | null = null;

function set(patch: Partial<LiveState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useLive<T>(selector: (s: LiveState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
  );
}

export const getLive = () => state;

function mergeEvents(prev: NexusEvent[], incoming: NexusEvent[]) {
  if (!incoming.length) return prev;
  const last = prev.length ? prev[prev.length - 1].seq : 0;
  const fresh = incoming.filter((e) => e.seq > last);
  return fresh.length ? [...prev, ...fresh].slice(-300) : prev;
}

function mergeEpisodes(prev: EpisodeMetric[], incoming: EpisodeMetric[]) {
  if (!incoming.length) return prev;
  const last = prev.length ? prev[prev.length - 1].episode : 0;
  const fresh = incoming.filter((e) => e.episode > last);
  return fresh.length ? [...prev, ...fresh].slice(-20000) : prev;
}

let socket: WebSocket | null = null;
let retry = 500;
let pingTimer: number | undefined;
let reconnectTimer: number | undefined;

export function connectLive() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const base = getApiBase();
  const url = base
    ? base.replace(/^http/, "ws").replace(/\/$/, "") + "/ws"
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  set({ connection: state.connection === "online" ? "connecting" : state.connection });
  const ws = new WebSocket(url);
  socket = ws;

  ws.onopen = () => {
    retry = 500;
    set({ connection: "online" });
    window.clearInterval(pingTimer);
    pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 15000);
  };

  ws.onmessage = (msg) => {
    let data: any;
    try {
      data = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (data.type === "hello") {
      episodesExp = null;
      set({
        operatingMode: data.operating_mode,
        events: (data.events as NexusEvent[]).slice(-300),
        models: data.models,
        episodes: data.training_episodes ?? [],
      });
    } else if (data.type === "tick") {
      const expId: string | null = data.training?.experiment_id ?? null;
      let episodes = state.episodes;
      if (expId !== episodesExp && episodesExp !== null) episodes = [];
      episodesExp = expId;
      set({
        operatingMode: data.operating_mode,
        sim: data.sim,
        training: data.training,
        hardware: data.hardware,
        models: data.models,
        jobs: data.jobs ?? [],
        events: mergeEvents(state.events, data.events ?? []),
        episodes: mergeEpisodes(episodes, data.episodes ?? []),
        lastTick: performance.now(),
      });
    }
  };

  ws.onclose = () => {
    window.clearInterval(pingTimer);
    if (socket === ws) socket = null;
    set({ connection: "offline" });
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connectLive, retry);
    retry = Math.min(retry * 2, 5000);
  };
  ws.onerror = () => ws.close();
}

export function reconnectLive() {
  socket?.close();
  socket = null;
  retry = 500;
  connectLive();
}
