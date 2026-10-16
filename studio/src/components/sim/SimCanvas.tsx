import clsx from "clsx";
import { Maximize, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Outcome, RobotPose, SensorState, Vec2, WorldState } from "../../lib/types";

export type Tool = "pan" | "goal" | "start" | "add" | "remove" | "select";

export interface Heatmap {
  cell: number;
  values: (number | null)[][];   // rows = y cells, cols = x cells
  max: number;
  rgb: [number, number, number];
}

export interface Marker { x: number; y: number; color: string; label?: string }

export interface PathOverlay {
  points: Vec2[];
  color: string;
  dash?: number[];
  width?: number;
  label?: string;
}

export interface SimCanvasProps {
  world: WorldState | null;
  robot?: RobotPose | null;
  trail?: Vec2[];
  sensor?: SensorState | null;
  plannedPath?: Vec2[];
  referencePath?: Vec2[];
  collisions?: Vec2[];
  overlays?: PathOverlay[];
  outcome?: Outcome;
  options?: { grid?: boolean; trail?: boolean; sensors?: boolean; reference?: boolean };
  tool?: Tool;
  onTool?: (kind: Exclude<Tool, "pan">, data: number[]) => void;
  active?: boolean;              // robot currently moving (enables glow)
  robotStep?: number;            // backend action counter: interpolate only across exactly one action
  annotation?: string;
  heatmap?: Heatmap | null;
  markers?: Marker[];
  selection?: number[] | null;
  showControls?: boolean;
  className?: string;
  compact?: boolean;
}

const C = {
  bg: "#0b0c0f",
  floor: "#0e1015",
  gridMinor: "rgba(255,255,255,0.028)",
  gridMajor: "rgba(255,255,255,0.065)",
  border: "#2f3440",
  label: "#5d6470",
  obstacle: "#1d2129",
  obstacleEdge: "#383f4b",
  obstacleTop: "rgba(255,255,255,0.05)",
  violet: "#8b7cf6",
  violetSoft: "rgba(139,124,246,",
  cyan: "#5ec8d8",
  good: "#3fb950",
  bad: "#f0524f",
  serious: "#ec835a",
  ink: "#eceef2",
};

interface View { zoom: number; px: number; py: number }

const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};

export function SimCanvas(props: SimCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const viewRef = useRef<View>({ zoom: 1, px: 0, py: 0 });
  const sizeRef = useRef({ w: 800, h: 600, dpr: 1 });
  const interp = useRef<{ from: RobotPose | null; to: RobotPose | null; t0: number; dur: number; lastAt: number }>({ from: null, to: null, t0: 0, dur: 1, lastAt: 0 });
  const mouse = useRef<{ x: number; y: number; inside: boolean; drag: null | { sx: number; sy: number; px: number; py: number; mode: "pan" | "rect"; wx: number; wy: number } }>({ x: 0, y: 0, inside: false, drag: null });
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const lastStep = useRef<number | undefined>(undefined);

  // -------- robot interpolation: animate toward each new backend pose, never beyond it
  useEffect(() => {
    const r = props.robot;
    if (!r) return;
    const s = interp.current;
    const now = performance.now();
    const shown = currentPose(now) ?? r;
    const jump = s.to ? Math.hypot(r.x - s.to.x, r.y - s.to.y) : 0;
    const gap = s.lastAt ? Math.min(Math.max(now - s.lastAt, 30), 160) : 60;
    // A straight-line blend is only faithful across ONE action (one straight move or one turn).
    // If several actions happened between snapshots (high sim speed), blending would draw a chord
    // that can cut through obstacle corners, so we snap to the true pose instead.
    const step = props.robotStep;
    const multiStep = step !== undefined && lastStep.current !== undefined && step - lastStep.current !== 1;
    lastStep.current = step;
    s.from = jump > 0.6 || multiStep ? r : shown;
    s.to = r;
    s.t0 = now;
    s.dur = gap;
    s.lastAt = now;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.robot?.x, props.robot?.y, props.robot?.theta]);

  function currentPose(now: number): RobotPose | null {
    const s = interp.current;
    if (!s.to) return null;
    if (!s.from) return s.to;
    const t = Math.min(1, (now - s.t0) / s.dur);
    return { x: s.from.x + (s.to.x - s.from.x) * t, y: s.from.y + (s.to.y - s.from.y) * t, theta: lerpAngle(s.from.theta, s.to.theta, t), collided: s.to.collided };
  }

  // -------- geometry helpers
  function base() {
    const { w, h } = sizeRef.current;
    const world = propsRef.current.world;
    // asymmetric margins leave room for axis ticks/labels, the legend and the scale bar
    const [pt, pr, pb, pl] = propsRef.current.compact ? [14, 14, 14, 14] : [60, 52, 70, 52];
    const ww = world?.width ?? 6, wh = world?.height ?? 6;
    const scale = Math.min((w - pl - pr) / ww, (h - pt - pb) / wh);
    return { scale, ox: pl + (w - pl - pr) / 2, oy: pt + (h - pt - pb) / 2, cx: ww / 2, cy: wh / 2 };
  }
  function toScreen(x: number, y: number): Vec2 {
    const b = base(), v = viewRef.current;
    const s = b.scale * v.zoom;
    return [b.ox + (x - b.cx) * s + v.px, b.oy - (y - b.cy) * s + v.py];
  }
  function toWorld(sx: number, sy: number): Vec2 {
    const b = base(), v = viewRef.current;
    const s = b.scale * v.zoom;
    return [(sx - v.px - b.ox) / s + b.cx, -(sy - v.py - b.oy) / s + b.cy];
  }
  const pxPerM = () => base().scale * viewRef.current.zoom;

  // -------- resize
  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: r.width, h: r.height, dpr };
      const c = canvasRef.current;
      if (!c) return;              // callback can arrive just after unmount (e.g. 2D fallback replaced by 3D view)
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // -------- render loop
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d")!;
      const { w, h, dpr } = sizeRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      render(ctx, w, h, performance.now());
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function render(ctx: CanvasRenderingContext2D, w: number, h: number, now: number) {
    const p = propsRef.current;
    const opt = { grid: true, trail: true, sensors: true, reference: false, ...p.options };
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    const world = p.world;
    if (!world) return;
    const s = pxPerM();
    const [x0, y1] = toScreen(0, world.height);
    const [x1, y0] = toScreen(world.width, 0);

    // arena floor
    ctx.fillStyle = C.floor;
    ctx.fillRect(x0, y1, x1 - x0, y0 - y1);

    // grid
    if (opt.grid) {
      const minor = s > 90 ? 0.25 : 0.5;
      ctx.lineWidth = 1;
      for (let gx = 0; gx <= world.width + 1e-6; gx += minor) {
        const [sx] = toScreen(gx, 0);
        ctx.strokeStyle = Math.abs(gx - Math.round(gx)) < 1e-6 ? C.gridMajor : C.gridMinor;
        ctx.beginPath(); ctx.moveTo(Math.round(sx) + 0.5, y1); ctx.lineTo(Math.round(sx) + 0.5, y0); ctx.stroke();
      }
      for (let gy = 0; gy <= world.height + 1e-6; gy += minor) {
        const [, sy] = toScreen(0, gy);
        ctx.strokeStyle = Math.abs(gy - Math.round(gy)) < 1e-6 ? C.gridMajor : C.gridMinor;
        ctx.beginPath(); ctx.moveTo(x0, Math.round(sy) + 0.5); ctx.lineTo(x1, Math.round(sy) + 0.5); ctx.stroke();
      }
      // coordinate annotations
      if (!p.compact) {
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.fillStyle = C.label;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        for (let gx = 0; gx <= world.width + 1e-6; gx += 1) {
          const [sx] = toScreen(gx, 0);
          ctx.fillText(String(gx), sx, y0 + 6);
          ctx.fillRect(sx - 0.5, y0, 1, 4);
        }
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        for (let gy = 0; gy <= world.height + 1e-6; gy += 1) {
          const [, sy] = toScreen(0, gy);
          ctx.fillText(String(gy), x0 - 8, sy);
          ctx.fillRect(x0 - 4, sy - 0.5, 4, 1);
        }
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText("x [m]", x1 + 10, y0 + 1);
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText("y [m]", x0, y1 - 8);
      }
    }
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y1) + 0.5, Math.round(x1 - x0), Math.round(y0 - y1));

    // heatmap layer (cell values normalised by max; empty cells transparent)
    if (p.heatmap) {
      const hm = p.heatmap;
      for (let r = 0; r < hm.values.length; r++) {
        for (let c = 0; c < hm.values[r].length; c++) {
          const v = hm.values[r][c];
          if (v === null || v <= 0) continue;
          const [sx, sy] = toScreen(c * hm.cell, (r + 1) * hm.cell);
          ctx.fillStyle = `rgba(${hm.rgb[0]},${hm.rgb[1]},${hm.rgb[2]},${(0.12 + 0.68 * Math.min(1, v / (hm.max || 1))).toFixed(3)})`;
          ctx.fillRect(sx, sy, hm.cell * s + 0.5, hm.cell * s + 0.5);
        }
      }
    }

    // obstacles
    const hoverRemove = p.tool === "remove" && mouse.current.inside ? toWorld(mouse.current.x, mouse.current.y) : null;
    for (const [a, b, c, d] of world.rects) {
      const [sx, sy] = toScreen(a, d);
      const rw = (c - a) * s, rh = (d - b) * s;
      const hot = hoverRemove && hoverRemove[0] >= a && hoverRemove[0] <= c && hoverRemove[1] >= b && hoverRemove[1] <= d;
      ctx.fillStyle = hot ? "rgba(240,82,79,0.18)" : C.obstacle;
      ctx.fillRect(sx, sy, rw, rh);
      ctx.fillStyle = C.obstacleTop;
      ctx.fillRect(sx, sy, rw, Math.min(3, rh));
      ctx.strokeStyle = hot ? C.bad : C.obstacleEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, rw - 1, rh - 1);
    }
    // temporary blockages (timed obstacles): dashed amber outline
    for (const t of world.timed ?? []) {
      const [sx, sy] = toScreen(t[0], t[3]);
      const rw = (t[2] - t[0]) * s, rh = (t[3] - t[1]) * s;
      ctx.fillStyle = "rgba(227,179,65,0.10)";
      ctx.fillRect(sx, sy, rw, rh);
      ctx.strokeStyle = "#e3b341"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2;
      ctx.strokeRect(sx + 0.5, sy + 0.5, rw - 1, rh - 1); ctx.setLineDash([]);
      if (!p.compact) label(ctx, `TEMPORARY ${t[4]}-${t[5].toFixed(1)}s`, sx + rw + 4, sy + 6, "#e3b341");
    }

    // dynamic obstacles
    for (const [mx, my] of world.movers) {
      const [sx, sy] = toScreen(mx, my);
      ctx.beginPath();
      ctx.arc(sx, sy, world.mover_radius * s, 0, Math.PI * 2);
      ctx.fillStyle = "#262a33";
      ctx.fill();
      ctx.strokeStyle = C.serious;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    const path = (pts: Vec2[], color: string, width: number, dash: number[] = [], alpha = 1) => {
      if (pts.length < 2) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.setLineDash(dash);
      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        const [sx, sy] = toScreen(x, y);
        i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      });
      ctx.stroke();
      ctx.restore();
    };

    // reference (A*) path and planned path
    if (opt.reference && p.referencePath?.length) path(p.referencePath, C.cyan, 1.2, [2, 5], 0.7);
    if (p.plannedPath?.length) path(p.plannedPath, C.cyan, 1.8, [7, 5], 0.95);

    // comparison overlays
    for (const o of p.overlays ?? []) {
      path(o.points, o.color, o.width ?? 2, o.dash ?? [], 0.95);
      const last = o.points[o.points.length - 1];
      if (last) {
        const [sx, sy] = toScreen(last[0], last[1]);
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fillStyle = C.floor; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = o.color; ctx.setLineDash([]); ctx.stroke();
      }
    }

    // traveled trajectory: fades from old (faint) to recent
    const trail = p.trail ?? [];
    if (opt.trail && trail.length > 1) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash([]);
      const n = trail.length;
      ctx.lineWidth = 2;
      for (let i = 1; i < n; i++) {
        const [ax, ay] = toScreen(trail[i - 1][0], trail[i - 1][1]);
        const [bx, by] = toScreen(trail[i][0], trail[i][1]);
        ctx.strokeStyle = C.violetSoft + (0.12 + 0.5 * (i / n) ** 1.4).toFixed(3) + ")";
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }
    }

    // start marker
    {
      const [sx, sy] = toScreen(world.start[0], world.start[1]);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = "#8a909c";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-5, -5, 10, 10);
      ctx.restore();
      if (!p.compact) label(ctx, "START", sx + 10, sy - 10, "#8a909c");
    }

    // goal
    {
      const [gx, gy] = toScreen(world.goal[0], world.goal[1]);
      const gr = world.goal_radius * s;
      ctx.beginPath(); ctx.arc(gx, gy, gr, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(63,185,80,0.07)"; ctx.fill();
      ctx.strokeStyle = "rgba(63,185,80,0.65)"; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      const ph = ((now / 1600) % 1);
      ctx.beginPath(); ctx.arc(gx, gy, gr * (0.35 + 0.9 * ph), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(63,185,80,${(0.45 * (1 - ph)).toFixed(3)})`; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.strokeStyle = C.good; ctx.lineWidth = 1.2;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.beginPath(); ctx.moveTo(gx + dx * 4, gy + dy * 4); ctx.lineTo(gx + dx * 9, gy + dy * 9); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(gx, gy, 2.2, 0, Math.PI * 2); ctx.fillStyle = C.good; ctx.fill();
      if (!p.compact) label(ctx, "GOAL", gx + gr + 6, gy - gr - 2, C.good);
      if (p.outcome === "success") {
        ctx.beginPath(); ctx.arc(gx, gy, gr + 6, 0, Math.PI * 2);
        ctx.strokeStyle = C.good; ctx.lineWidth = 2; ctx.stroke();
      }
    }

    // robot (interpolated)
    const pose = currentPose(now);
    if (pose) {
      const [rx, ry] = toScreen(pose.x, pose.y);
      const rr = world.robot_radius * s;
      // sensor visualisation: drawn from the TRUE (latest backend) pose the scan was taken at,
      // not the interpolated display pose, so rays always end exactly on the measured surfaces
      const sp = interp.current.to ?? pose;
      const [qx, qy] = toScreen(sp.x, sp.y);
      if (opt.sensors && p.sensor) {
        const { ranges, angles, max_range } = p.sensor;
        const pts: Vec2[] = angles.map((a, i) => {
          const r = ranges[i] ?? max_range;
          return toScreen(sp.x + r * Math.cos(sp.theta + a), sp.y + r * Math.sin(sp.theta + a));
        });
        const order = angles.map((a, i) => [a, i] as const).sort((u, v) => u[0] - v[0]).map((x) => x[1]);
        ctx.beginPath();
        order.forEach((i, k) => (k ? ctx.lineTo(pts[i][0], pts[i][1]) : ctx.moveTo(pts[i][0], pts[i][1])));
        ctx.closePath();
        ctx.fillStyle = C.violetSoft + "0.045)";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = C.violetSoft + "0.10)";
        for (const [px, py] of pts) {
          ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(px, py); ctx.stroke();
        }
        ranges.forEach((r, i) => {
          if (r === null || r >= max_range - 1e-6) return;
          const near = r < world.robot_radius + 0.2;
          ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], near ? 3 : 2, 0, Math.PI * 2);
          ctx.fillStyle = near ? C.bad : "#b3a9ff";
          ctx.fill();
        });
      }
      drawRobot(ctx, rx, ry, rr, pose.theta, pose.collided ? C.bad : C.violet, !!p.active);
    }

    // collisions
    for (const [cx, cy] of p.collisions ?? []) {
      const [sx, sy] = toScreen(cx, cy);
      ctx.strokeStyle = C.bad; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx - 7, sy - 7); ctx.lineTo(sx + 7, sy + 7); ctx.moveTo(sx + 7, sy - 7); ctx.lineTo(sx - 7, sy + 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(sx, sy, 13, 0, Math.PI * 2); ctx.lineWidth = 1; ctx.stroke();
      if (!p.compact) label(ctx, "COLLISION", sx + 16, sy - 12, C.bad);
    }

    // markers (e.g. counterfactual branch point)
    for (const m of p.markers ?? []) {
      const [sx, sy] = toScreen(m.x, m.y);
      ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2);
      ctx.strokeStyle = m.color; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI * 2); ctx.fillStyle = m.color; ctx.fill();
      if (m.label && !p.compact) label(ctx, m.label, sx + 10, sy - 10, m.color);
    }
    if (p.selection) {
      const [a0, b0, a1, b1] = p.selection;
      const [ax, ay] = toScreen(Math.min(a0, a1), Math.max(b0, b1));
      const [bx, by] = toScreen(Math.max(a0, a1), Math.min(b0, b1));
      ctx.fillStyle = "rgba(94,200,216,0.10)"; ctx.fillRect(ax, ay, bx - ax, by - ay);
      ctx.strokeStyle = "#5ec8d8"; ctx.setLineDash([5, 3]); ctx.lineWidth = 1.2;
      ctx.strokeRect(ax + 0.5, ay + 0.5, bx - ax, by - ay); ctx.setLineDash([]);
    }

    // rectangle being drawn
    const d = mouse.current.drag;
    if (d?.mode === "rect") {
      const [wx, wy] = toWorld(mouse.current.x, mouse.current.y);
      const [ax, ay] = toScreen(Math.min(d.wx, wx), Math.max(d.wy, wy));
      const [bx, by] = toScreen(Math.max(d.wx, wx), Math.min(d.wy, wy));
      ctx.fillStyle = "rgba(139,124,246,0.12)";
      ctx.fillRect(ax, ay, bx - ax, by - ay);
      ctx.strokeStyle = C.violet; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.strokeRect(ax + 0.5, ay + 0.5, bx - ax, by - ay); ctx.setLineDash([]);
      label(ctx, `${Math.abs(wx - d.wx).toFixed(2)} × ${Math.abs(wy - d.wy).toFixed(2)} m`, bx + 6, by + 4, C.violet);
    }

    // scale bar
    if (!p.compact) {
      const len = s >= 60 ? 1 : 2;
      const bx = w - 28 - len * s, by = h - 18;
      ctx.strokeStyle = "#8a909c"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + len * s, by); ctx.lineTo(bx + len * s, by - 4); ctx.stroke();
      ctx.font = "10px 'JetBrains Mono', monospace"; ctx.fillStyle = "#8a909c"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(`${len} m`, bx + (len * s) / 2, by - 4);
    }
  }

  function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
    ctx.font = "600 9.5px 'JetBrains Mono', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(11,12,15,0.85)";
    ctx.fillRect(x - 3, y - 7, tw + 6, 14);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y + 0.5);
  }

  function drawRobot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, theta: number, color: string, glow: boolean) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-theta);
    // heading indicator
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(r * 0.9, 0); ctx.lineTo(r * 2.6, 0); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(r * 2.95, 0); ctx.lineTo(r * 2.45, -r * 0.28); ctx.lineTo(r * 2.45, r * 0.28); ctx.closePath(); ctx.fill();
    // chassis = the collision footprint: a disc of exactly the robot radius. Everything that
    // is part of the robot (wheels, deck, sensor) is drawn INSIDE it, so what you see touching an
    // obstacle is exactly what the simulator tests (the heading arrow is an annotation only).
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 18; }
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = "#17142b"; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.arc(0, 0, Math.max(0.5, r - 0.8), 0, Math.PI * 2);
    ctx.lineWidth = 1.6; ctx.strokeStyle = color; ctx.stroke();
    // wheels, fully inside the footprint (outer corners at ~0.86 r)
    const ww = r * 0.9, wt = Math.max(2, r * 0.22);
    ctx.fillStyle = "#07080a"; ctx.strokeStyle = "#4b5160"; ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.roundRect(-ww / 2, side * r * 0.62 - wt / 2, ww, wt, 2);
      ctx.fill(); ctx.stroke();
    }
    // deck plate + sensor head
    ctx.beginPath(); ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(139,124,246,0.16)"; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    // caster
    ctx.beginPath(); ctx.arc(r * 0.7, 0, Math.max(1.5, r * 0.1), 0, Math.PI * 2);
    ctx.fillStyle = "#c4bcff"; ctx.fill();
    ctx.restore();
  }

  // -------- interaction
  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const before = toWorld(mx, my);
    const v = viewRef.current;
    v.zoom = Math.min(8, Math.max(0.4, v.zoom * Math.exp(-e.deltaY * 0.0015)));
    const after = toScreen(before[0], before[1]);
    v.px += mx - after[0];
    v.py += my - after[1];
    setZoomPct(Math.round(v.zoom * 100));
  };

  const onDown = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const tool = propsRef.current.tool ?? "pan";
    const [wx, wy] = toWorld(sx, sy);
    (e.target as Element).setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || tool === "pan") {
      mouse.current.drag = { sx, sy, px: viewRef.current.px, py: viewRef.current.py, mode: "pan", wx, wy };
    } else if (tool === "add" || tool === "select") {
      mouse.current.drag = { sx, sy, px: 0, py: 0, mode: "rect", wx, wy };
    } else if (propsRef.current.onTool) {
      propsRef.current.onTool(tool, [wx, wy]);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    mouse.current.x = sx; mouse.current.y = sy; mouse.current.inside = true;
    const d = mouse.current.drag;
    if (d?.mode === "pan") {
      viewRef.current.px = d.px + (sx - d.sx);
      viewRef.current.py = d.py + (sy - d.sy);
    }
    const w = toWorld(sx, sy);
    const world = propsRef.current.world;
    setCursor(world && w[0] >= 0 && w[1] >= 0 && w[0] <= world.width && w[1] <= world.height ? w : null);
  };
  const onUp = () => {
    const d = mouse.current.drag;
    mouse.current.drag = null;
    if (d?.mode === "rect" && propsRef.current.onTool) {
      const [wx, wy] = toWorld(mouse.current.x, mouse.current.y);
      const kind = propsRef.current.tool === "select" ? "select" : "add";
      if (Math.abs(wx - d.wx) > 0.04 && Math.abs(wy - d.wy) > 0.04) propsRef.current.onTool(kind, [d.wx, d.wy, wx, wy]);
    }
  };
  const fit = () => {
    viewRef.current = { zoom: 1, px: 0, py: 0 };
    setZoomPct(100);
  };
  const zoomBy = (f: number) => {
    const v = viewRef.current;
    v.zoom = Math.min(8, Math.max(0.4, v.zoom * f));
    setZoomPct(Math.round(v.zoom * 100));
  };

  const tool = props.tool ?? "pan";
  return (
    <div ref={wrapRef} className={clsx("relative h-full w-full overflow-hidden", props.className)}>
      <canvas
        ref={canvasRef}
        className={clsx("block touch-none", tool === "pan" ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair")}
        onWheel={onWheel}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => { mouse.current.inside = false; setCursor(null); }}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={fit}
        aria-label="Robot simulation viewport"
        role="img"
      />
      {!props.compact && (
        <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1">
          {props.annotation && <span className="mono text-[10.5px] tracking-wide text-ink-3">{props.annotation}</span>}
        </div>
      )}
      {!props.compact && (
        <div className="mono pointer-events-none absolute bottom-2.5 left-3 text-[10.5px] text-ink-3">
          {cursor ? `x ${cursor[0].toFixed(2)}  y ${cursor[1].toFixed(2)} m` : " "}
        </div>
      )}
      {props.showControls && (
        <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-lg border border-line-strong bg-surface/90 backdrop-blur">
          <button className="p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in"><Plus className="h-3.5 w-3.5" /></button>
          <button className="p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={() => zoomBy(0.8)} aria-label="Zoom out" title="Zoom out"><Minus className="h-3.5 w-3.5" /></button>
          <button className="border-t border-line p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={fit} aria-label="Fit to screen" title="Fit to screen (double-click)"><Maximize className="h-3.5 w-3.5" /></button>
          <span className="mono border-t border-line py-1 text-center text-[9px] text-ink-3">{zoomPct}%</span>
        </div>
      )}
    </div>
  );
}
