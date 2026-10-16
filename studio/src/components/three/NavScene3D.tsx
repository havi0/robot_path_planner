/**
 * Real-time 3D presentation of the navigation world (React Three Fiber).
 *
 * Pure view layer: it renders exactly the data the 2D SimCanvas receives (world rects,
 * moving / temporary obstacles, start, goal, robot pose, LiDAR scan, trail, planned and
 * reference paths, collision points) and never talks to the backend or changes state.
 * World coordinates (x right, y up, metres) map to three.js as (x - W/2, height, -(y - H/2)).
 * Obstacle heights are visual only — the simulator is 2D.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Outcome, RobotPose, SensorState, Vec2, WorldState } from "../../lib/types";

export type CameraMode = "orbit" | "top" | "follow";

export interface NavScene3DProps {
  world: WorldState;
  robot?: RobotPose | null;
  trail?: Vec2[];
  sensor?: SensorState | null;
  plannedPath?: Vec2[];
  referencePath?: Vec2[];
  collisions?: Vec2[];
  outcome?: Outcome;
  active?: boolean;
  variant: "hero" | "studio";
  showSensors?: boolean;
  showTrail?: boolean;
  showReference?: boolean;
  /** Hero: draw the reference path as the luminous route when no planned path exists. */
  routeFromReference?: boolean;
  cameraMode?: CameraMode;
  reducedMotion?: boolean;
  className?: string;
}

const C = {
  floor: "#121319",
  ground: "#0a0b0f",
  fog: "#0a0b0f",
  obstacle: "#2a2d36",
  edge: "#b3a9ff",
  violet: "#8b7cf6",
  lavender: "#c4bcff",
  blue: "#5aa2ff",
  cyan: "#5ec8d8",
  good: "#3fb950",
  bad: "#f0524f",
  amber: "#e3b341",
  orange: "#ec835a",
};

// ------------------------------------------------------------------ helpers
type Frame = { W: number; H: number };
const v3 = (f: Frame, x: number, y: number, h = 0) => new THREE.Vector3(x - f.W / 2, h, -(y - f.H / 2));

function hash(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Rounded, bevelled box whose footprint is exactly w x d (bevel kept inside the footprint). */
function roundedBox(w: number, d: number, h: number, r = 0.05) {
  const bevel = Math.min(0.018, w / 6, d / 6);
  const iw = Math.max(0.01, w - 2 * bevel), id = Math.max(0.01, d - 2 * bevel);
  const rr = Math.max(0.001, Math.min(r, iw / 2 - 0.001, id / 2 - 0.001));
  const x = -iw / 2, y = -id / 2;
  const s = new THREE.Shape();
  s.moveTo(x + rr, y);
  s.lineTo(x + iw - rr, y); s.quadraticCurveTo(x + iw, y, x + iw, y + rr);
  s.lineTo(x + iw, y + id - rr); s.quadraticCurveTo(x + iw, y + id, x + iw - rr, y + id);
  s.lineTo(x + rr, y + id); s.quadraticCurveTo(x, y + id, x, y + id - rr);
  s.lineTo(x, y + rr); s.quadraticCurveTo(x, y, x + rr, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.01, h - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 5 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, bevel, 0);
  return g;
}

function downsample<T>(pts: T[], max: number): T[] {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}

let dotTex: THREE.Texture | null = null;
/** Soft round sprite so point clouds render as dots, not squares. */
function dot() {
  if (!dotTex) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.45, "rgba(255,255,255,0.85)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    dotTex = new THREE.CanvasTexture(c);
  }
  return dotTex;
}

function useDispose(...objs: { dispose: () => void }[]) {
  useEffect(() => () => objs.forEach((o) => o.dispose()), objs); // eslint-disable-line react-hooks/exhaustive-deps
}

// ------------------------------------------------------------------ arena
function Arena({ f }: { f: Frame }) {
  const grid = useMemo(() => {
    const minor: number[] = [], major: number[] = [];
    for (let x = 0; x <= f.W + 1e-6; x += 0.5) (Math.abs(x - Math.round(x)) < 1e-6 ? major : minor).push(x - f.W / 2, 0.002, -f.H / 2, x - f.W / 2, 0.002, f.H / 2);
    for (let y = 0; y <= f.H + 1e-6; y += 0.5) (Math.abs(y - Math.round(y)) < 1e-6 ? major : minor).push(-f.W / 2, 0.002, y - f.H / 2, f.W / 2, 0.002, y - f.H / 2);
    const mk = (arr: number[], opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: C.lavender, transparent: true, opacity, depthWrite: false }));
    };
    return [mk(minor, 0.035), mk(major, 0.075)];
  }, [f.W, f.H]);
  useEffect(() => () => grid.forEach((l) => { l.geometry.dispose(); (l.material as THREE.Material).dispose(); }), [grid]);
  const wall = 0.035, wh = 0.07;
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.004} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color={C.ground} roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[f.W, f.H]} />
        <meshStandardMaterial color={C.floor} roughness={0.7} metalness={0.2} />
      </mesh>
      {grid.map((l, i) => <primitive key={i} object={l} />)}
      {/* low metallic frame */}
      {[
        [0, f.H / 2 + wall / 2, f.W + 2 * wall, wall],
        [0, -f.H / 2 - wall / 2, f.W + 2 * wall, wall],
        [f.W / 2 + wall / 2, 0, wall, f.H],
        [-f.W / 2 - wall / 2, 0, wall, f.H],
      ].map(([x, z, w, d], i) => (
        <mesh key={i} position={[x, wh / 2, z]} castShadow receiveShadow>
          <boxGeometry args={[w, wh, d]} />
          <meshStandardMaterial color="#2a2e3a" metalness={0.75} roughness={0.32} emissive={C.violet} emissiveIntensity={0.06} />
        </mesh>
      ))}
    </group>
  );
}

function Obstacles({ f, world }: { f: Frame; world: WorldState }) {
  const items = useMemo(() => world.rects.map(([x0, y0, x1, y1], i) => {
    const w = x1 - x0, d = y1 - y0;
    const h = 0.26 + 0.26 * hash(i + x0 * 7 + y0 * 13);
    const geo = roundedBox(w, d, h, 0.045);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 35), new THREE.LineBasicMaterial({ color: C.edge, transparent: true, opacity: 0.16, depthWrite: false }));
    return { geo, edges, pos: v3(f, (x0 + x1) / 2, (y0 + y1) / 2) };
  }), [world.rects, f]);
  useEffect(() => () => items.forEach((o) => { o.geo.dispose(); o.edges.geometry.dispose(); (o.edges.material as THREE.Material).dispose(); }), [items]);
  const mat = useMemo(() => new THREE.MeshPhysicalMaterial({ color: C.obstacle, roughness: 0.36, metalness: 0.12, clearcoat: 0.7, clearcoatRoughness: 0.28, sheen: 0.18, sheenColor: new THREE.Color(C.lavender) }), []);
  useDispose(mat);
  return (
    <group>
      {items.map((o, i) => (
        <group key={i} position={o.pos}>
          <mesh geometry={o.geo} material={mat} castShadow receiveShadow />
          <primitive object={o.edges} />
        </group>
      ))}
    </group>
  );
}

function TimedObstacles({ f, world }: { f: Frame; world: WorldState }) {
  return (
    <group>
      {(world.timed ?? []).map((t, i) => {
        const [x0, y0, x1, y1] = t;
        return (
          <mesh key={i} position={v3(f, (x0 + x1) / 2, (y0 + y1) / 2, 0.15)}>
            <boxGeometry args={[x1 - x0, 0.3, y1 - y0]} />
            <meshStandardMaterial color={C.amber} transparent opacity={0.16} emissive={C.amber} emissiveIntensity={0.25} depthWrite={false} />
          </mesh>
        );
      })}
    </group>
  );
}

function Movers({ f, world }: { f: Frame; world: WorldState }) {
  const r = world.mover_radius;
  return (
    <group>
      {world.movers.map(([x, y], i) => (
        <group key={i} position={v3(f, x, y)}>
          <mesh position-y={0.15} castShadow>
            <cylinderGeometry args={[r, r, 0.3, 40]} />
            <meshPhysicalMaterial color="#2a2f3b" metalness={0.6} roughness={0.3} clearcoat={0.6} />
          </mesh>
          <mesh position-y={0.302} rotation-x={-Math.PI / 2}>
            <ringGeometry args={[r * 0.72, r * 0.86, 40]} />
            <meshBasicMaterial color={C.orange} transparent opacity={0.9} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ------------------------------------------------------------------ markers
function Goal({ f, world, reached, animate }: { f: Frame; world: WorldState; reached: boolean; animate: boolean }) {
  const pulse = useRef<THREE.Mesh>(null);
  const beam = useRef<THREE.Mesh>(null);
  const r = world.goal_radius;
  useFrame(({ clock }) => {
    if (!animate) return;
    const t = (clock.elapsedTime * 0.55) % 1;
    if (pulse.current) {
      pulse.current.scale.setScalar(1 + t * 0.9);
      (pulse.current.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - t);
    }
    if (beam.current) (beam.current.material as THREE.MeshBasicMaterial).opacity = 0.045 + 0.02 * Math.sin(clock.elapsedTime * 1.6);
  });
  return (
    <group position={v3(f, world.goal[0], world.goal[1])}>
      <mesh rotation-x={-Math.PI / 2} position-y={0.004}>
        <circleGeometry args={[r, 64]} />
        <meshBasicMaterial color={C.good} transparent opacity={reached ? 0.22 : 0.08} depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.012}>
        <torusGeometry args={[r, 0.012, 12, 96]} />
        <meshStandardMaterial color={C.good} emissive={C.good} emissiveIntensity={2.2} />
      </mesh>
      <mesh ref={pulse} rotation-x={-Math.PI / 2} position-y={0.01}>
        <torusGeometry args={[r, 0.006, 8, 96]} />
        <meshBasicMaterial color={C.good} transparent opacity={0.4} depthWrite={false} />
      </mesh>
      <mesh ref={beam} position-y={0.9}>
        <cylinderGeometry args={[r * 0.18, r * 0.5, 1.6, 40, 1, true]} />
        <meshBasicMaterial color={C.good} transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh position-y={0.035}>
        <sphereGeometry args={[0.028, 24, 16]} />
        <meshStandardMaterial color={C.good} emissive={C.good} emissiveIntensity={3} />
      </mesh>
      <pointLight color={C.good} intensity={0.9} distance={1.6} position-y={0.35} />
    </group>
  );
}

function StartMarker({ f, world }: { f: Frame; world: WorldState }) {
  return (
    <mesh position={v3(f, world.start[0], world.start[1], 0.006)} rotation={[-Math.PI / 2, 0, Math.PI / 4]}>
      <ringGeometry args={[0.07, 0.085, 4]} />
      <meshBasicMaterial color="#8a909c" transparent opacity={0.85} />
    </mesh>
  );
}

function CollisionMarks({ f, points }: { f: Frame; points: Vec2[] }) {
  return (
    <group>
      {points.map(([x, y], i) => (
        <group key={i} position={v3(f, x, y, 0.02)}>
          {[Math.PI / 4, -Math.PI / 4].map((a) => (
            <mesh key={a} rotation-y={a}>
              <boxGeometry args={[0.2, 0.012, 0.022]} />
              <meshStandardMaterial color={C.bad} emissive={C.bad} emissiveIntensity={2.4} />
            </mesh>
          ))}
          <mesh rotation-x={-Math.PI / 2}>
            <torusGeometry args={[0.15, 0.005, 8, 48]} />
            <meshBasicMaterial color={C.bad} transparent opacity={0.6} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ------------------------------------------------------------------ paths
function Tube({ f, points, color, radius, opacity = 1, glow = 0, intensity = 1.6 }: { f: Frame; points: Vec2[]; color: string; radius: number; opacity?: number; glow?: number; intensity?: number }) {
  const geo = useMemo(() => {
    const pts = downsample(points, 320);
    if (pts.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(pts.map(([x, y]) => v3(f, x, y, 0.03)), false, "centripetal");
    return { tube: new THREE.TubeGeometry(curve, Math.min(900, pts.length * 4), radius, 8, false), glow: glow ? new THREE.TubeGeometry(curve, Math.min(600, pts.length * 3), glow, 8, false) : null };
  }, [points, f, radius, glow]);
  useEffect(() => () => { geo?.tube.dispose(); geo?.glow?.dispose(); }, [geo]);
  if (!geo) return null;
  return (
    <group>
      <mesh geometry={geo.tube}>
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={intensity} transparent={opacity < 1} opacity={opacity} />
      </mesh>
      {geo.glow && (
        <mesh geometry={geo.glow}>
          <meshBasicMaterial color={color} transparent opacity={0.1} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      )}
    </group>
  );
}

/** Luminous route with direction chevrons travelling along it and a clear endpoint. */
function Route({ f, points, color, animate }: { f: Frame; points: Vec2[]; color: string; animate: boolean }) {
  const curve = useMemo(() => (points.length >= 2 ? new THREE.CatmullRomCurve3(downsample(points, 320).map(([x, y]) => v3(f, x, y, 0.035)), false, "centripetal") : null), [points, f]);
  const chev = useRef<THREE.Group>(null);
  const n = curve ? Math.max(2, Math.min(28, Math.round(curve.getLength() / 0.42))) : 0;
  const place = (offset: number) => {
    if (!curve || !chev.current) return;
    chev.current.children.forEach((c, i) => {
      const u = ((i + offset) / n) % 1;
      const p = curve.getPointAt(u), t = curve.getTangentAt(u);
      c.position.copy(p);
      c.rotation.set(0, Math.atan2(t.x, t.z), 0);
      c.rotateX(Math.PI / 2);
    });
  };
  useEffect(() => place(0.5));
  useFrame(({ clock }) => { if (animate) place((clock.elapsedTime * 0.35) % 1); });
  if (!curve) return null;
  const end = points[points.length - 1];
  return (
    <group>
      <Tube f={f} points={points} color={color} radius={0.011} glow={0.045} intensity={2.2} />
      <group ref={chev}>
        {Array.from({ length: n }).map((_, i) => (
          <mesh key={i}>
            <coneGeometry args={[0.028, 0.07, 12]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2.6} />
          </mesh>
        ))}
      </group>
      <mesh position={v3(f, end[0], end[1], 0.04)}>
        <sphereGeometry args={[0.035, 20, 14]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={3} />
      </mesh>
    </group>
  );
}

// ------------------------------------------------------------------ robot
function Robot({ f, pose, radius, collided, active, sensor, showSensors, animate, poseRef }: {
  f: Frame; pose: RobotPose; radius: number; collided: boolean; active: boolean; sensor?: SensorState | null; showSensors: boolean; animate: boolean;
  poseRef: React.MutableRefObject<THREE.Vector3>;
}) {
  const g = useRef<THREE.Group>(null);
  const lidar = useRef<THREE.Mesh>(null);
  const target = useMemo(() => v3(f, pose.x, pose.y), [f, pose.x, pose.y]);
  const yaw = pose.theta;
  const first = useRef(true);
  useFrame(({ clock }, dt) => {
    const o = g.current;
    if (!o) return;
    if (first.current || !animate) {
      o.position.copy(target); o.rotation.y = yaw; first.current = false;
    } else {
      const k = 1 - Math.exp(-dt * 14);
      o.position.lerp(target, k);
      let d = yaw - o.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      o.rotation.y += d * k;
    }
    o.position.y = animate && !active ? 0.006 * Math.sin(clock.elapsedTime * 2) + 0.006 : 0;
    poseRef.current.copy(o.position);
    if (lidar.current && animate) lidar.current.rotation.y += dt * (active ? 9 : 2);
  });

  const beams = useMemo(() => {
    if (!sensor || !showSensors) return null;
    const pos: number[] = [], hits: number[] = [];
    sensor.angles.forEach((a, i) => {
      const r = sensor.ranges[i] ?? sensor.max_range;
      const x = Math.cos(a) * r, z = -Math.sin(a) * r;
      pos.push(0, 0.13, 0, x, 0.13, z);
      if (sensor.ranges[i] !== null && r < sensor.max_range - 1e-3) hits.push(x, 0.13, z);
    });
    const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const hg = new THREE.BufferGeometry(); hg.setAttribute("position", new THREE.Float32BufferAttribute(hits, 3));
    return {
      lines: new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: C.violet, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending })),
      pts: new THREE.Points(hg, new THREE.PointsMaterial({ color: C.lavender, size: 0.05, map: dot(), transparent: true, opacity: 0.95, depthWrite: false, alphaTest: 0.02 })),
    };
  }, [sensor, showSensors]);
  useEffect(() => () => { if (beams) { [beams.lines, beams.pts].forEach((o) => { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }); } }, [beams]);

  const R = radius;
  const shell = collided ? C.bad : "#eceef4";
  return (
    <group ref={g}>
      {/* soft violet halo so the robot reads at a glance (UI cue, not part of the footprint) */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.002}>
        <circleGeometry args={[R * 2.1, 48]} />
        <meshBasicMaterial color={collided ? C.bad : C.violet} transparent opacity={active ? 0.2 : 0.12} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {/* contact shadow */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.003}>
        <circleGeometry args={[R * 1.12, 40]} />
        <meshBasicMaterial color="#000" transparent opacity={0.45} depthWrite={false} />
      </mesh>
      <mesh position-y={0.024} castShadow>
        <cylinderGeometry args={[R, R, 0.026, 48]} />
        <meshStandardMaterial color="#191c24" metalness={0.5} roughness={0.45} />
      </mesh>
      <mesh position-y={0.068} castShadow>
        <cylinderGeometry args={[R * 0.97, R, 0.064, 48]} />
        <meshPhysicalMaterial color={shell} roughness={0.3} metalness={0.05} clearcoat={1} clearcoatRoughness={0.18} emissive={collided ? C.bad : "#000"} emissiveIntensity={collided ? 0.6 : 0} />
      </mesh>
      <mesh position-y={0.101} rotation-x={Math.PI / 2}>
        <torusGeometry args={[R * 0.97, 0.0055, 10, 64]} />
        <meshStandardMaterial color={C.violet} emissive={C.violet} emissiveIntensity={active ? 3 : 1.6} />
      </mesh>
      <mesh position-y={0.103}>
        <cylinderGeometry args={[R * 0.5, R * 0.56, 0.01, 40]} />
        <meshPhysicalMaterial color="#1b1d26" metalness={0.4} roughness={0.15} clearcoat={1} />
      </mesh>
      {/* LiDAR */}
      <mesh position-y={0.125} castShadow>
        <cylinderGeometry args={[0.042, 0.048, 0.04, 32]} />
        <meshStandardMaterial color="#14161c" metalness={0.8} roughness={0.25} />
      </mesh>
      <mesh ref={lidar} position-y={0.13}>
        <torusGeometry args={[0.045, 0.004, 8, 40, Math.PI * 1.4]} />
        <meshStandardMaterial color={C.cyan} emissive={C.cyan} emissiveIntensity={2.5} />
      </mesh>
      {/* wheels */}
      {[1, -1].map((s) => (
        <mesh key={s} position={[0, 0.042, s * R * 0.93]} rotation-x={Math.PI / 2} castShadow>
          <cylinderGeometry args={[0.042, 0.042, 0.024, 28]} />
          <meshStandardMaterial color="#0e0f13" roughness={0.9} />
        </mesh>
      ))}
      {/* front sensor window (robot heading = local +x) */}
      <mesh position={[R * 0.95, 0.07, 0]}>
        <boxGeometry args={[0.012, 0.016, 0.07]} />
        <meshStandardMaterial color={C.blue} emissive={C.blue} emissiveIntensity={2.6} />
      </mesh>
      {active && <pointLight color={C.violet} intensity={0.8} distance={1.2} position-y={0.3} />}
      {beams && <primitive object={beams.lines} />}
      {beams && <primitive object={beams.pts} />}
    </group>
  );
}

// ------------------------------------------------------------------ atmosphere
function Dust({ f, animate, count = 160 }: { f: Frame; animate: boolean; count?: number }) {
  const pts = useMemo(() => {
    const p = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      p[i * 3] = (hash(i * 3.1) - 0.5) * (f.W + 3);
      p[i * 3 + 1] = 0.15 + hash(i * 5.7) * 2.6;
      p[i * 3 + 2] = (hash(i * 9.3) - 0.5) * (f.H + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: C.lavender, size: 0.03, map: dot(), transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
  }, [f, count]);
  useEffect(() => () => { pts.geometry.dispose(); (pts.material as THREE.Material).dispose(); }, [pts]);
  useFrame((_, dt) => {
    if (!animate) return;
    const a = pts.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      let y = a.getY(i) + dt * (0.025 + 0.02 * hash(i));
      if (y > 2.8) y = 0.15;
      a.setY(i, y);
    }
    a.needsUpdate = true;
  });
  return <primitive object={pts} />;
}

function Lights({ f }: { f: Frame }) {
  const key = useRef<THREE.DirectionalLight>(null);
  useEffect(() => {
    const l = key.current;
    if (!l) return;
    const s = Math.max(f.W, f.H) * 0.75;
    Object.assign(l.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.5, far: 30 });
    l.shadow.camera.updateProjectionMatrix();
    l.shadow.mapSize.set(2048, 2048);
    l.shadow.bias = -0.0004;
    l.shadow.radius = 6;
  }, [f]);
  return (
    <>
      <hemisphereLight args={["#8a86a8", "#07080b", 0.34]} />
      <ambientLight intensity={0.16} />
      <directionalLight ref={key} position={[-f.W * 0.6, 7, f.H * 0.55]} intensity={2.3} color="#f4f1ff" castShadow />
      {/* violet rim from behind, cool blue fill from the side */}
      <pointLight position={[f.W * 0.55, 1.4, -f.H * 0.62]} color={C.violet} intensity={4.2} distance={8} decay={1.7} />
      <pointLight position={[-f.W * 0.62, 1.0, f.H * 0.1]} color={C.blue} intensity={1.5} distance={6} decay={1.7} />
    </>
  );
}

// ------------------------------------------------------------------ cameras
function HeroRig({ f, animate }: { f: Frame; animate: boolean }) {
  const { camera, size } = useThree();
  const look = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock, pointer }) => {
    const m = Math.max(f.W, f.H);
    const wide = size.width / Math.max(1, size.height);
    const t = animate ? clock.elapsedTime : 0;
    const az = -0.5 + Math.sin(t * 0.07) * 0.18 + (animate ? pointer.x * 0.1 : 0);
    const el = 0.72 + (animate ? pointer.y * 0.04 : 0);
    const d = m * (wide > 1.6 ? 1.5 : 1.75);
    camera.position.set(d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
    // aim left of the arena centre on wide layouts so the scene sits right of the headline
    look.set(wide > 1.6 ? -m * 0.3 : 0, -0.25, wide > 1.6 ? -m * 0.04 : 0);
    camera.lookAt(look);
  });
  return null;
}

const PRESETS = {
  orbit: (f: Frame) => ({ pos: new THREE.Vector3(-f.W * 0.05, Math.max(f.W, f.H) * 0.95, f.H * 1.05), target: new THREE.Vector3(0, 0, 0) }),
  top: (f: Frame) => ({ pos: new THREE.Vector3(0, Math.max(f.W, f.H) * 1.55, 0.001), target: new THREE.Vector3(0, 0, 0) }),
};

function StudioRig({ f, mode, robotPos, animate }: { f: Frame; mode: CameraMode; robotPos: React.MutableRefObject<THREE.Vector3>; animate: boolean }) {
  const { camera, gl, invalidate } = useThree();
  const controls = useMemo(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.enableDamping = true; c.dampingFactor = 0.08;
    c.maxPolarAngle = Math.PI * 0.47; c.minDistance = 1.2; c.maxDistance = 22;
    c.screenSpacePanning = true;
    return c;
  }, [camera, gl]);
  const moving = useRef(true);
  useEffect(() => {
    const onChange = () => invalidate();
    controls.addEventListener("change", onChange);
    return () => { controls.removeEventListener("change", onChange); controls.dispose(); };
  }, [controls, invalidate]);
  useEffect(() => { moving.current = true; invalidate(); }, [mode, f, invalidate]);
  useFrame((_, dt) => {
    const k = animate ? 1 - Math.exp(-dt * 4) : 1;
    if (mode === "follow") {
      const p = robotPos.current;
      const off = new THREE.Vector3(-1.6, 1.5, 1.6);
      controls.target.lerp(p, k);
      if (moving.current) {
        camera.position.lerp(p.clone().add(off), k);
        if (camera.position.distanceTo(p.clone().add(off)) < 0.02) moving.current = false;
      }
    } else if (moving.current) {
      const pr = PRESETS[mode](f);
      camera.position.lerp(pr.pos, k);
      controls.target.lerp(pr.target, k);
      if (camera.position.distanceTo(pr.pos) < 0.02) moving.current = false;
    }
    controls.update();
  });
  return null;
}

// ------------------------------------------------------------------ scene
function Scene(p: NavScene3DProps & { animate: boolean }) {
  const f = useMemo<Frame>(() => ({ W: p.world.width, H: p.world.height }), [p.world.width, p.world.height]);
  const robotPos = useRef(new THREE.Vector3());
  const route = p.plannedPath && p.plannedPath.length > 1 ? p.plannedPath : p.routeFromReference ? p.referencePath ?? [] : [];
  const m = Math.max(f.W, f.H);
  return (
    <>
      <fog attach="fog" args={[C.fog, m * 1.4, m * 4.2]} />
      <Lights f={f} />
      <Arena f={f} />
      <Obstacles f={f} world={p.world} />
      <TimedObstacles f={f} world={p.world} />
      <Movers f={f} world={p.world} />
      <StartMarker f={f} world={p.world} />
      <Goal f={f} world={p.world} reached={p.outcome === "success"} animate={p.animate} />
      {p.showTrail !== false && p.trail && <Tube f={f} points={p.trail} color={C.violet} radius={0.012} opacity={0.9} intensity={1.4} />}
      {route.length > 1 && <Route f={f} points={route} color={C.blue} animate={p.animate} />}
      {p.showReference && !p.routeFromReference && p.referencePath && p.referencePath.length > 1 && (
        <Tube f={f} points={p.referencePath} color={C.cyan} radius={0.006} opacity={0.55} intensity={1} />
      )}
      {p.collisions && <CollisionMarks f={f} points={p.collisions} />}
      {p.robot && (
        <Robot f={f} pose={p.robot} radius={p.world.robot_radius} collided={!!p.robot.collided || p.outcome === "collision"} active={!!p.active}
          sensor={p.sensor} showSensors={p.showSensors !== false} animate={p.animate} poseRef={robotPos} />
      )}
      <Dust f={f} animate={p.animate} count={p.variant === "hero" ? 200 : 110} />
      {p.variant === "hero" ? <HeroRig f={f} animate={p.animate} /> : <StudioRig f={f} mode={p.cameraMode ?? "orbit"} robotPos={robotPos} animate={p.animate} />}
    </>
  );
}

export default function NavScene3D(props: NavScene3DProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.01 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const animate = !props.reducedMotion;
  const m = Math.max(props.world.width, props.world.height);
  return (
    <div ref={wrap} className={props.className} style={{ position: "absolute", inset: 0 }}>
      <Canvas
        shadows="soft"
        dpr={[1, 1.75]}
        frameloop={!visible ? "never" : animate ? "always" : "demand"}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        camera={{ fov: props.variant === "hero" ? 32 : 40, near: 0.05, far: 120, position: [0, m * 1.2, m * 1.2] }}
        onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.15; }}
        aria-label={props.variant === "hero" ? "3D view of the live navigation scene" : "3D simulation viewport"}
      >
        <Scene {...props} animate={animate} />
      </Canvas>
    </div>
  );
}
