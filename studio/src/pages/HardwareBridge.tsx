import clsx from "clsx";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Cable, Lock, OctagonX, Plug, PlugZap, Power, ShieldAlert, ShieldCheck, Square, Unplug, Navigation } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SimCanvas } from "../components/sim/SimCanvas";
import { Button } from "../components/ui/button";
import { Field, NumberInput, Segmented, Slider, TextInput } from "../components/ui/controls";
import { Badge, EmptyState, Tag } from "../components/ui/feedback";
import { ConfirmDialog, Dialog, useAction } from "../components/ui/overlay";
import { KeyValue, Panel } from "../components/ui/panel";
import { api } from "../lib/api";
import { fmt, humanize, isTypingTarget, pct } from "../lib/format";
import { useLive } from "../lib/live";
import type { HardwareSnapshot } from "../lib/types";

export function HardwareBridge() {
  const hw = useLive((s) => s.hardware);
  const mode = useLive((s) => s.operatingMode);
  const online = useLive((s) => s.connection === "online");
  const run = useAction();
  const [kind, setKind] = useState<"ros2" | "loopback">("ros2");
  const [armOpen, setArmOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [profile, setProfile] = useState<Record<string, any> | null>(null);
  useEffect(() => { api.hardware.profile().then(setProfile).catch(() => setProfile(null)); }, []);

  const connected = hw?.status === "connected";
  const hwMode = mode === "hardware";
  const canMove = hwMode && connected && !!hw?.armed && !hw?.estop;

  return (
    <div className="space-y-4 p-4">
      {!hwMode && (
        <div className="flex items-center gap-3 rounded-[10px] border border-[#e3b34133] bg-[#e3b3410d] px-4 py-2.5 text-[12.5px] text-[#f0d58a]">
          <Lock className="h-4 w-4 shrink-0" />
          <span className="flex-1">Simulation mode: hardware motion controls are locked. You can still inspect the bridge and connect a backend.</span>
          <Button size="sm" variant="secondary" onClick={() => setModeOpen(true)}>Switch to Hardware mode</Button>
        </div>
      )}

      {/* -------- connection -------- */}
      <section className="panel flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className={clsx("flex h-11 w-11 items-center justify-center rounded-xl border", connected ? (hw?.simulated ? "border-[#5ec8d855] bg-cyan-soft text-cyan" : "border-[#3fb95055] bg-[#3fb95014] text-good") : "border-line-strong bg-surface-2 text-ink-3")}>
            {connected ? <PlugZap className="h-5 w-5" /> : <Unplug className="h-5 w-5" />}
          </div>
          <div>
            <div className="text-[15px] font-semibold">
              {connected ? (hw?.simulated ? "Simulation loopback" : "Physical robot (ROS 2)") : hw?.status === "error" ? "Connection error" : "No robot connected"}
            </div>
            <div className="text-[12px] text-ink-3">
              {connected ? (hw?.simulated ? "SIMULATED backend behind the hardware bridge - no physical robot is moving" : "Live link to the robot driver")
                : hw?.last_error ?? "Hardware mode stays disconnected until a real backend is configured and connected."}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={connected ? (hw?.simulated ? "info" : "good") : hw?.status === "error" ? "bad" : "muted"}>{connected ? (hw?.simulated ? "loopback · simulated" : "connected") : hw?.status ?? "—"}</Badge>
          <Badge tone={hw?.armed ? "warn" : "muted"} pulse={hw?.armed}>{hw?.armed ? "ARMED" : "disarmed"}</Badge>
          <Badge tone={hw?.estop ? "bad" : "good"}>{hw?.estop ? "E-STOP engaged" : "E-stop released"}</Badge>
          <Badge tone={hw?.ros2_available ? "good" : "muted"}>ROS 2 {hw?.ros2_available ? "available" : "not installed"}</Badge>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {!connected ? (
            <>
              <Segmented value={kind} onChange={setKind} options={[
                { value: "ros2", label: <><Cable className="h-3.5 w-3.5" /> ROS 2 robot</>, title: hw?.ros2_available ? "" : "ROS 2 not installed" },
                { value: "loopback", label: <>Simulation loopback</> },
              ]} />
              <Button variant="primary" disabled={!online} onClick={() => run(() => api.hardware.connect(kind), kind === "loopback" ? "Loopback connected (simulated)" : "Connected")} icon={<Plug className="h-3.5 w-3.5" />}>Connect</Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => run(() => api.hardware.disconnect(), "Disconnected")} icon={<Unplug className="h-3.5 w-3.5" />}>Disconnect</Button>
          )}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)_340px]">
        {/* -------- safety -------- */}
        <div className="space-y-4">
          <Panel title="Safety controls" eyebrow="Operator" dense>
            <button
              onClick={() => run(() => api.hardware.estop(!hw?.estop))}
              disabled={!online}
              className={clsx("flex w-full flex-col items-center justify-center gap-1 rounded-xl border-2 py-5 font-semibold tracking-wide transition-colors disabled:opacity-40",
                hw?.estop ? "border-line-strong bg-surface-3 text-ink-2 hover:bg-surface-2" : "border-[#ff6b68] bg-[#c62f2c] text-white shadow-[0_8px_30px_-10px_#f0524f] hover:bg-[#d93633] active:bg-[#b02826]")}
            >
              <OctagonX className="h-7 w-7" />
              {hw?.estop ? "RELEASE E-STOP" : "EMERGENCY STOP"}
              <span className="text-[10.5px] font-normal opacity-80">{hw?.estop ? "robot stays disarmed after release" : "stops motion and disarms immediately"}</span>
            </button>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button variant={hw?.armed ? "secondary" : "primary"} disabled={!hwMode || !connected || hw?.armed || hw?.estop} onClick={() => setArmOpen(true)} icon={<ShieldAlert className="h-3.5 w-3.5" />}>Arm robot</Button>
              <Button variant="outline" disabled={!hw?.armed} onClick={() => run(() => api.hardware.disarm(), "Disarmed")} icon={<ShieldCheck className="h-3.5 w-3.5" />}>Disarm</Button>
            </div>
            <div className="mt-3 rounded-lg border border-[#e3b34133] bg-[#e3b3410a] p-2.5 text-[11.5px] leading-relaxed text-[#e9cf86]">
              The software e-stop depends on this computer, the network and the robot driver. It does <b>not</b> replace a physical emergency stop that cuts motor power.
            </div>
          </Panel>
          <Panel title="Command limits" eyebrow="Enforced server-side" dense>
            {hw && <>
              <KeyValue label="Max linear (safety layer)" value={`${hw.limits.max_linear} m/s`} />
              <KeyValue label="Max angular (safety layer)" value={`${hw.limits.max_angular} rad/s`} />
              <KeyValue label="Robot profile linear cap" value={`${hw.limits.profile_max_linear} m/s`} />
              <KeyValue label="Robot profile angular cap" value={`${hw.limits.profile_max_angular} rad/s`} />
              <KeyValue label="Proximity stop distance" value={`${hw.limits.stop_distance} m`} />
              <KeyValue label="Sensor timeout" value={`${hw.limits.sensor_timeout} s`} />
              <KeyValue label="Manual dead-man timeout" value={`${hw.limits.manual_timeout} s`} />
            </>}
            <div className="mt-2 text-[11px] leading-relaxed text-ink-3">Link loss → stop + disarm. Stale or invalid scans → stop. The policy only chooses actions; it never commands motors directly.</div>
          </Panel>
        </div>

        {/* -------- telemetry / view -------- */}
        <div className="flex min-w-0 flex-col gap-4">
          <section className="panel relative h-[380px] overflow-hidden">
            {connected && hw?.world ? (
              <>
                <SimCanvas world={hw.world} robot={hw.telemetry?.pose ?? null} trail={hw.trail}
                  sensor={hw.telemetry?.sensor ? { ranges: hw.telemetry.sensor.ranges, angles: hw.telemetry.sensor.angles, max_range: hw.telemetry.sensor.max_range } : null}
                  options={{ grid: true, trail: true, sensors: true }} active={hw.mode !== "idle"} showControls annotation="LOOPBACK · SIMULATED BACKEND" />
                <div className="pointer-events-none absolute left-3 top-8"><Badge tone="info">Simulated - not a physical robot</Badge></div>
              </>
            ) : connected ? (
              <ScanView hw={hw!} />
            ) : (
              <EmptyState icon={<Unplug className="h-4 w-4" />} title="No telemetry">
                Connect a backend to stream pose, range scan and command telemetry. Nothing is displayed until real data arrives.
              </EmptyState>
            )}
          </section>
          <Panel title="Telemetry" eyebrow="Live" dense>
            {!connected || !hw?.telemetry ? <div className="text-[12px] text-ink-3">Disconnected.</div> : (
              <div className="grid gap-x-8 md:grid-cols-2">
                <div>
                  <KeyValue label="Pose x / y" value={hw.telemetry.pose ? `${fmt(hw.telemetry.pose.x)} / ${fmt(hw.telemetry.pose.y)} m` : "NO DATA"} tone={hw.telemetry.pose ? undefined : "bad"} />
                  <KeyValue label="Heading" value={hw.telemetry.pose ? `${fmt((hw.telemetry.pose.theta * 180) / Math.PI, 1)}°` : "—"} />
                  <KeyValue label="Odometry age" value={hw.telemetry.pose ? `${fmt(hw.telemetry.pose.age, 2)} s` : "—"} tone={hw.telemetry.pose && hw.telemetry.pose.age > hw.limits.sensor_timeout ? "bad" : undefined} />
                  <KeyValue label="Mode" value={hw.mode} tone={hw.mode === "idle" ? "muted" : "warn"} />
                </div>
                <div>
                  <KeyValue label="Scan valid beams" value={hw.telemetry.sensor ? pct(hw.telemetry.sensor.valid_fraction) : "NO DATA"} tone={hw.telemetry.sensor ? (hw.telemetry.sensor.valid_fraction < 0.5 ? "bad" : undefined) : "bad"} />
                  <KeyValue label="Scan age" value={hw.telemetry.sensor ? `${fmt(hw.telemetry.sensor.age, 2)} s` : "—"} tone={hw.telemetry.sensor && hw.telemetry.sensor.age > hw.limits.sensor_timeout ? "bad" : undefined} />
                  <KeyValue label="Requested v / ω" value={hw.telemetry.requested ? `${fmt(hw.telemetry.requested.v)} / ${fmt(hw.telemetry.requested.w)}` : "—"} />
                  <KeyValue label="Executed v / ω" value={hw.telemetry.executed ? `${fmt(hw.telemetry.executed.v)} / ${fmt(hw.telemetry.executed.w)}` : "—"} />
                </div>
                <div className="md:col-span-2">
                  <KeyValue label="Safety layer" value={hw.telemetry.safety.length ? humanize(hw.telemetry.safety.join(", ")) : "nominal"} tone={hw.telemetry.safety.length ? "warn" : "good"} />
                </div>
              </div>
            )}
          </Panel>
        </div>

        {/* -------- control -------- */}
        <div className="space-y-4">
          <ManualControl hw={hw} enabled={canMove} />
          <Deployment hw={hw} enabled={canMove} />
          <Panel title="Robot profile" eyebrow="config/robot_profile.yaml" dense>
            {profile ? (
              <>
                <KeyValue label="Model" value={profile.name} />
                <KeyValue label="Radius / wheel base" value={`${profile.geometry?.radius} / ${profile.geometry?.wheel_base} m`} />
                <KeyValue label="Calibration (lin / ang)" value={`${profile.calibration?.linear_scale} / ${profile.calibration?.angular_scale}`} />
                <KeyValue label="cmd_vel topic" value={profile.ros2?.cmd_vel_topic} />
                <KeyValue label="scan / odom topics" value={`${profile.ros2?.scan_topic} · ${profile.ros2?.odom_topic}`} />
                <div className="mt-2 text-[11px] text-ink-3">Edit the YAML on the robot computer and restart the server. See docs/HARDWARE.md for the bench-test procedure.</div>
              </>
            ) : <div className="text-[12px] text-ink-3">Profile unavailable.</div>}
          </Panel>
        </div>
      </div>

      <ArmDialog open={armOpen} onClose={() => setArmOpen(false)} hw={hw} />
      <ConfirmDialog open={modeOpen} onClose={() => setModeOpen(false)} title="Switch to Hardware mode?" confirmLabel="Switch mode"
        onConfirm={() => run(() => api.setMode("hardware"))}>
        This only unlocks the bridge controls. Motion still requires a connected backend and an explicit arm confirmation.
      </ConfirmDialog>
    </div>
  );
}

function ScanView({ hw }: { hw: HardwareSnapshot }) {
  const s = hw.telemetry?.sensor;
  if (!s) return <EmptyState title="Waiting for scan data" />;
  const R = 150, cx = 0, cy = 0;
  return (
    <div className="flex h-full items-center justify-center">
      <svg viewBox="-170 -170 340 340" className="h-full max-h-[360px]">
        {[1, 2, 3].map((k) => <circle key={k} cx={cx} cy={cy} r={(R * k) / 3} fill="none" stroke="#22262e" />)}
        {s.angles.map((a, i) => {
          const r = s.ranges[i];
          const rr = ((r ?? s.max_range) / s.max_range) * R;
          return <line key={i} x1={0} y1={0} x2={-Math.sin(a) * rr} y2={-Math.cos(a) * rr} stroke={r === null ? "#f0524f" : r < 0.5 ? "#ec835a" : "#8b7cf6"} strokeOpacity={0.7} />;
        })}
        <circle r={8} fill="#17142b" stroke="#8b7cf6" />
        <text y={R + 14} textAnchor="middle" fill="#6c7380" fontSize="10" fontFamily="JetBrains Mono">range scan · forward = up · rings 1 m</text>
      </svg>
    </div>
  );
}

function ManualControl({ hw, enabled }: { hw: HardwareSnapshot | null; enabled: boolean }) {
  const run = useAction();
  const [speed, setSpeed] = useState(0.5);
  const timer = useRef<number | undefined>(undefined);
  const lim = hw?.limits;
  const drive = (dv: number, dw: number) => {
    window.clearInterval(timer.current);
    if (!enabled || !lim) return;
    const send = () => api.hardware.manual(dv * lim.max_linear * speed, dw * lim.max_angular * speed).catch(() => window.clearInterval(timer.current));
    send();
    timer.current = window.setInterval(send, 150);
  };
  const release = () => {
    window.clearInterval(timer.current);
    timer.current = undefined;
  };
  useEffect(() => {
    const keys: Record<string, [number, number]> = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, 1], ArrowRight: [0, -1] };
    const down = (e: KeyboardEvent) => { if (keys[e.key] && enabled && !e.repeat && !isTypingTarget(e)) { e.preventDefault(); drive(...keys[e.key]); } };
    const up = (e: KeyboardEvent) => keys[e.key] && release();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); release(); };
  });
  const Pad = ({ dv, dw, icon, label }: { dv: number; dw: number; icon: React.ReactNode; label: string }) => (
    <button aria-label={label} disabled={!enabled} onPointerDown={() => drive(dv, dw)} onPointerUp={release} onPointerLeave={release}
      className="flex h-12 items-center justify-center rounded-lg border border-line-strong bg-surface-2 text-ink-2 transition-colors hover:bg-surface-3 active:border-violet active:bg-violet-soft active:text-[#c4bcff] disabled:opacity-30">
      {icon}
    </button>
  );
  return (
    <Panel title="Manual control" eyebrow="Override · hold to drive" dense actions={<Tag>arrow keys</Tag>}>
      <div className="mx-auto grid w-48 grid-cols-3 gap-1.5">
        <span /><Pad dv={1} dw={0} label="Forward" icon={<ArrowUp className="h-4 w-4" />} /><span />
        <Pad dv={0} dw={1} label="Turn left" icon={<ArrowLeft className="h-4 w-4" />} />
        <button aria-label="Stop" disabled={!enabled} onClick={() => run(() => api.hardware.stop())} className="flex h-12 items-center justify-center rounded-lg border border-line-strong bg-surface-3 text-ink-2 hover:text-ink disabled:opacity-30"><Square className="h-4 w-4" /></button>
        <Pad dv={0} dw={-1} label="Turn right" icon={<ArrowRight className="h-4 w-4" />} />
        <span /><Pad dv={-1} dw={0} label="Reverse" icon={<ArrowDown className="h-4 w-4" />} /><span />
      </div>
      <div className="mt-3"><Field label="Speed (fraction of limit)"><Slider value={speed} min={0.1} max={1} step={0.05} onChange={setSpeed} format={(v) => `${Math.round(v * 100)}%`} /></Field></div>
      <div className="mt-1 text-[11px] text-ink-3">{enabled ? "Commands expire 0.5 s after release (dead-man). Reverse is blocked by the safety layer unless enabled in config." : "Requires Hardware mode, a connected backend and an armed robot."}</div>
    </Panel>
  );
}

function Deployment({ hw, enabled }: { hw: HardwareSnapshot | null; enabled: boolean }) {
  const run = useAction();
  const models = useLive((s) => s.models);
  const [gx, setGx] = useState<number | null>(null);
  const [gy, setGy] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (hw?.world && gx === null) { setGx(+hw.world.goal[0].toFixed(2)); setGy(+hw.world.goal[1].toFixed(2)); }
  }, [hw?.world, gx]);
  const auto = hw?.mode === "autonomous";
  return (
    <Panel title="Autonomous deployment" eyebrow="DQN + recovery + safety layer" dense>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Goal x (m)"><NumberInput value={gx} onChange={(v) => setGx(v)} disabled={!enabled || auto} /></Field>
        <Field label="Goal y (m)"><NumberInput value={gy} onChange={(v) => setGy(v)} disabled={!enabled || auto} /></Field>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" className="flex-1" disabled={!enabled || auto || gx === null || gy === null || !models?.dqn} onClick={() => setConfirm(true)} icon={<Navigation className="h-3.5 w-3.5" />}>Deploy policy</Button>
        <Button variant="outline" disabled={!auto} onClick={() => run(() => api.hardware.stop(), "Stopped")} icon={<Power className="h-3.5 w-3.5" />}>Stop</Button>
      </div>
      <div className="mt-2 flex items-center justify-between text-[11.5px]">
        <span className="text-ink-3">Policy: {models?.dqn?.label ?? "none loaded"}</span>
        {hw?.deploy_outcome && <Badge tone={hw.deploy_outcome === "success" ? "good" : "bad"}>{hw.deploy_outcome}</Badge>}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Start autonomous navigation?" confirmLabel="Start" danger={!hw?.simulated}
        onConfirm={() => run(() => api.hardware.deploy([gx!, gy!]), "Autonomous navigation started")}>
        {hw?.simulated ? "The policy will drive the SIMULATED loopback robot." : <>The learned policy will move the <b className="text-ink">physical robot</b> toward ({gx}, {gy}). Keep a hand on the physical e-stop. Any manual command overrides it.</>}
      </ConfirmDialog>
    </Panel>
  );
}

function ArmDialog({ open, onClose, hw }: { open: boolean; onClose: () => void; hw: HardwareSnapshot | null }) {
  const run = useAction();
  const [text, setText] = useState("");
  const [checks, setChecks] = useState([false, false, false]);
  useEffect(() => { if (open) { setText(""); setChecks([false, false, false]); } }, [open]);
  const items = ["The test area is clear of people and fragile objects", "An operator can reach the physical emergency stop", "Wheels / motors were bench-tested (docs/HARDWARE.md)"];
  const ok = checks.every(Boolean) && text === hw?.arm_phrase;
  return (
    <Dialog open={open} onClose={onClose} title={hw?.simulated ? "Arm loopback robot (simulated)" : "Arm physical robot"}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={!ok} onClick={async () => { const r = await run(() => api.hardware.arm(text), "Robot armed"); if (r) onClose(); }}>Arm robot</Button></>}>
      <div className="space-y-2">
        {items.map((it, i) => (
          <label key={i} className="flex cursor-pointer items-start gap-2.5 text-[12.5px] text-ink-2">
            <input type="checkbox" checked={checks[i]} onChange={(e) => { const v = e.target.checked; setChecks((prev) => prev.map((c, j) => (j === i ? v : c))); }} className="mt-0.5 accent-[#8b7cf6]" />
            {it}
          </label>
        ))}
      </div>
      <div className="mt-4">
        <Field label={`Type ${hw?.arm_phrase ?? "ARM"} to confirm`}><TextInput value={text} onChange={(e) => setText(e.target.value)} placeholder={hw?.arm_phrase} /></Field>
      </div>
    </Dialog>
  );
}
