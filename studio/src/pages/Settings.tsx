import { Download, RotateCcw, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Field, NumberInput, Segmented, Select, Switch, TextInput } from "../components/ui/controls";
import { Badge } from "../components/ui/feedback";
import { ConfirmDialog, useAction, useToast } from "../components/ui/overlay";
import { KeyValue, Panel } from "../components/ui/panel";
import { api } from "../lib/api";
import { research } from "../lib/research-api";
import { getApiBase, setApiBase } from "../lib/base";
import { reconnectLive, useLive } from "../lib/live";
import { resetPrefs, updatePrefs, usePrefs } from "../lib/prefs";

export function SettingsPage() {
  const prefs = usePrefs();
  const run = useAction();
  const toast = useToast();
  const connection = useLive((s) => s.connection);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  const [url, setUrl] = useState(getApiBase());
  const [urlErr, setUrlErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [profile, setProfile] = useState<Record<string, any> | null>(null);
  const [copilot, setCopilot] = useState<{ provider: string; enabled: boolean; model?: string; reason: string } | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api.hardware.profile().then(setProfile).catch(() => setProfile(null));
    research.copilot.status().then(setCopilot).catch(() => setCopilot(null));
  }, [connection]);

  const sim = (k: keyof typeof prefs.sim, v: boolean | number) => updatePrefs((p) => ({ ...p, sim: { ...p.sim, [k]: v } }));

  const testBackend = async (save: boolean) => {
    const u = url.trim();
    if (u && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(u)) { setUrlErr("Use a URL like http://192.168.1.20:8000 (or leave empty for this server)"); return; }
    setUrlErr(null);
    setTesting(true);
    try {
      const r = await fetch(`${u.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      if (j.status !== "ok") throw new Error("unexpected response");
      if (save) { setApiBase(u); reconnectLive(); toast("success", "Backend saved", `NEXUS ${j.version} reachable`); }
      else toast("success", "Backend reachable", `NEXUS ${j.version} · torch ${j.torch}`);
    } catch (e) {
      toast("error", "Backend not reachable", e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const exportAll = async () => {
    const list = await run(() => api.experiments.list());
    if (!list) return;
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), experiments: list }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nexus-experiments-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Appearance" dense>
          <div className="space-y-4">
            <Field label="Interface mode" hint="Beginner shows essentials first with guidance; Advanced shows every parameter expanded. Display only — training, simulation and saved data are not affected.">
              <Segmented value={prefs.uiMode} onChange={(v) => updatePrefs((p) => ({ ...p, uiMode: v }))} options={[{ value: "beginner", label: "Beginner" }, { value: "advanced", label: "Advanced" }]} />
            </Field>
            <Field label="Theme"><Segmented value="dark" onChange={() => {}} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light", disabled: true, title: "Dark is the only theme" }]} /></Field>
            <Switch checked={prefs.reduceMotion} onChange={(v) => updatePrefs((p) => ({ ...p, reduceMotion: v }))} label="Reduce motion" description="Disables interface animations (simulation rendering is unaffected)" />
            <Switch checked={prefs.sidebarCollapsed} onChange={(v) => updatePrefs((p) => ({ ...p, sidebarCollapsed: v }))} label="Collapsed sidebar" />
          </div>
        </Panel>

        <Panel title="Simulation defaults" dense>
          <div className="space-y-3">
            <Switch checked={prefs.sim.showGrid} onChange={(v) => sim("showGrid", v)} label="Coordinate grid" />
            <Switch checked={prefs.sim.showTrail} onChange={(v) => sim("showTrail", v)} label="Trajectory" />
            <Switch checked={prefs.sim.showSensors} onChange={(v) => sim("showSensors", v)} label="Sensor rays" />
            <Switch checked={prefs.sim.showReference} onChange={(v) => sim("showReference", v)} label="A* reference path" />
            <Field label="Default speed">
              <Select value={String(prefs.sim.speed)} onChange={(v) => sim("speed", Number(v))}
                options={[{ value: "4", label: "1× real time" }, { value: "8", label: "2×" }, { value: "20", label: "5×" }, { value: "80", label: "20×" }, { value: "400", label: "100×" }]} />
            </Field>
          </div>
        </Panel>

        <Panel title="Training defaults" dense>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Episodes"><NumberInput value={prefs.training.episodes} min={1} max={200000} integer onChange={(v, ok) => ok && v && updatePrefs((p) => ({ ...p, training: { ...p.training, episodes: v } }))} /></Field>
            <Field label="Learning rate"><NumberInput value={prefs.training.lr} min={1e-6} max={0.1} onChange={(v, ok) => ok && v && updatePrefs((p) => ({ ...p, training: { ...p.training, lr: v } }))} /></Field>
            <Field label="Discount γ"><NumberInput value={prefs.training.gamma} min={0.5} max={0.9999} onChange={(v, ok) => ok && v && updatePrefs((p) => ({ ...p, training: { ...p.training, gamma: v } }))} /></Field>
            <Field label="Batch size"><NumberInput value={prefs.training.batch} min={8} max={1024} integer onChange={(v, ok) => ok && v && updatePrefs((p) => ({ ...p, training: { ...p.training, batch: v } }))} /></Field>
          </div>
          <div className="mt-2 text-[11px] text-ink-3">Pre-fills the Training Lab form. Other hyperparameters use the report configuration.</div>
        </Panel>

        <Panel title="Charts" dense>
          <div className="space-y-3">
            <Field label="Time window">
              <Select value={String(prefs.charts.window)} onChange={(v) => updatePrefs((p) => ({ ...p, charts: { ...p.charts, window: Number(v) } }))}
                options={[{ value: "200", label: "Last 200 episodes" }, { value: "500", label: "Last 500 episodes" }, { value: "2000", label: "Last 2,000 episodes" }, { value: "0", label: "All episodes" }]} />
            </Field>
            <Field label="Smoothing">
              <Select value={String(prefs.charts.smoothing)} onChange={(v) => updatePrefs((p) => ({ ...p, charts: { ...p.charts, smoothing: Number(v) } }))}
                options={[{ value: "1", label: "None" }, { value: "20", label: "Moving average 20" }, { value: "50", label: "Moving average 50" }, { value: "100", label: "Moving average 100" }]} />
            </Field>
            <Switch checked={prefs.charts.showRaw} onChange={(v) => updatePrefs((p) => ({ ...p, charts: { ...p.charts, showRaw: v } }))} label="Show raw values behind averages" />
          </div>
        </Panel>

        <Panel title="Backend" eyebrow="API + WebSocket endpoint" dense className="md:col-span-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[280px] flex-1">
              <Field label="Backend URL" hint="Leave empty when the studio is served by the backend itself (default)." error={urlErr}>
                <TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="same origin (default)" className="mono" />
              </Field>
            </div>
            <Button variant="secondary" loading={testing} onClick={() => testBackend(false)} icon={<Server className="h-3.5 w-3.5" />}>Test</Button>
            <Button variant="primary" disabled={testing} onClick={() => testBackend(true)}>Validate & save</Button>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
            Current status <Badge tone={connection === "online" ? "good" : connection === "connecting" ? "warn" : "bad"}>{connection}</Badge>
            <span className="text-ink-3">· No credentials are stored in the browser.</span>
          </div>
        </Panel>

        <Panel title="Hardware configuration" eyebrow="config/robot_profile.yaml (read-only here)" dense>
          {profile ? (
            <>
              <KeyValue label="Robot" value={profile.name} />
              <KeyValue label="Max linear / angular" value={`${profile.limits?.max_linear_speed} m/s · ${profile.limits?.max_angular_speed} rad/s`} />
              <KeyValue label="Watchdog (command / odom)" value={`${profile.watchdog?.command_timeout} s / ${profile.watchdog?.odom_timeout} s`} />
              <KeyValue label="ROS node" value={profile.ros2?.node_name} />
            </>
          ) : <div className="text-[12px] text-ink-3">Unavailable while the backend is offline.</div>}
          <div className="mt-2 text-[11px] leading-relaxed text-ink-3">Hardware limits are edited on the robot computer, not from the browser, so a UI session can never raise them.</div>
        </Panel>

        <Panel title="Research Copilot" eyebrow="Optional AI provider (server-side)" dense>
          <KeyValue label="Provider" value={copilot?.provider ?? "—"} />
          <KeyValue label="AI narrative" value={copilot ? (copilot.enabled ? `enabled · ${copilot.model}` : "disabled") : "—"} tone={copilot?.enabled ? "good" : "muted"} />
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">{copilot?.reason}</p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
            The copilot's measured facts, hypotheses and recommendations work without any AI provider. To add AI-written narratives, start the server with
            <span className="mono"> NEXUS_COPILOT_PROVIDER=anthropic</span> (optional <span className="mono">NEXUS_COPILOT_MODEL</span>) and Anthropic credentials in the
            server environment. Keys are never entered or stored in the browser.
          </p>
        </Panel>

        <Panel title="Data & application" dense>
          <Button variant="secondary" onClick={exportAll} icon={<Download className="h-3.5 w-3.5" />}>Export all experiment metadata (JSON)</Button>
          <div className="mt-1 text-[11px] text-ink-3">Per-experiment metrics (CSV/JSON) are exported from the Experiments page.</div>
          <div className="mt-4">
            <KeyValue label="Studio version" value="2.0.0" />
            <KeyValue label="Backend version" value={health?.version ?? "—"} />
            <KeyValue label="Python / PyTorch" value={health ? `${health.python} / ${health.torch}` : "—"} />
            <KeyValue label="ROS 2" value={health ? (health.ros2_available ? "available" : "not installed") : "—"} />
          </div>
          <Button variant="ghost" className="mt-3" onClick={() => setConfirmReset(true)} icon={<RotateCcw className="h-3.5 w-3.5" />}>Reset preferences</Button>
        </Panel>
      </div>
      <ConfirmDialog open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset all preferences?" confirmLabel="Reset" onConfirm={() => { resetPrefs(); toast("success", "Preferences reset"); }}>
        Restores default display, chart and training-form preferences in this browser. Experiments and models on the server are not affected.
      </ConfirmDialog>
    </div>
  );
}
