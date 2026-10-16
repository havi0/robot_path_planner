/**
 * Procedural 3D robot bodies (three.js primitives only - no external assets).
 * Local frame: +x = robot forward (heading), y = up, z = lateral. Sizes come from the
 * robot profile's visual dimensions, which the backend keeps inside the collision disc,
 * so the drawn body is never larger than what the simulator collides with.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { RobotVisual } from "../../lib/types";

export const ACCENT = { violet: "#8b7cf6", cyan: "#5ec8d8", blue: "#5aa2ff", bad: "#f0524f", rubber: "#0e0f13", metal: "#1a1d25" };

/** Rounded, bevelled box whose footprint is exactly w x d (bevel kept inside). */
export function roundedBox(w: number, d: number, h: number, r = 0.05) {
  const bevel = Math.min(0.018, w / 6, d / 6, h / 4);
  const iw = Math.max(0.01, w - 2 * bevel), id = Math.max(0.01, d - 2 * bevel);
  const rr = Math.max(0.001, Math.min(r, iw / 2 - 0.001, id / 2 - 0.001));
  const x = -iw / 2, y = -id / 2;
  const s = new THREE.Shape();
  s.moveTo(x + rr, y);
  s.lineTo(x + iw - rr, y); s.quadraticCurveTo(x + iw, y, x + iw, y + rr);
  s.lineTo(x + iw, y + id - rr); s.quadraticCurveTo(x + iw, y + id, x + iw - rr, y + id);
  s.lineTo(x + rr, y + id); s.quadraticCurveTo(x, y + id, x, y + id - rr);
  s.lineTo(x, y + rr); s.quadraticCurveTo(x, y, x + rr, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.005, h - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 6 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, bevel, 0);
  return g;
}

function useGeo<T extends THREE.BufferGeometry>(make: () => T, deps: unknown[]) {
  const g = useMemo(make, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => g.dispose(), [g]);
  return g;
}

interface BodyProps { visual: RobotVisual; radius: number; active?: boolean; collided?: boolean; spin?: boolean }

function Shell({ color, collided }: { color: string; collided?: boolean }) {
  return <meshPhysicalMaterial color={collided ? ACCENT.bad : color} roughness={0.3} metalness={0.05} clearcoat={1} clearcoatRoughness={0.18}
    emissive={collided ? ACCENT.bad : "#000"} emissiveIntensity={collided ? 0.55 : 0} />;
}

function Lidar({ y, spin, active, size = 1 }: { y: number; spin?: boolean; active?: boolean; size?: number }) {
  const ring = useRef<THREE.Group>(null);
  useFrame((_, dt) => { if (spin && ring.current) ring.current.rotation.y += dt * (active ? 9 : 2); });
  return (
    <group position-y={y} scale={size}>
      <mesh castShadow>
        <cylinderGeometry args={[0.042, 0.048, 0.04, 32]} />
        <meshStandardMaterial color="#14161c" metalness={0.8} roughness={0.25} />
      </mesh>
      {/* horizontal scanning arc spinning around the vertical axis */}
      <group ref={ring} position-y={0.012}>
        <mesh rotation-x={Math.PI / 2}>
          <torusGeometry args={[0.046, 0.004, 8, 40, Math.PI * 1.2]} />
          <meshStandardMaterial color={ACCENT.cyan} emissive={ACCENT.cyan} emissiveIntensity={2.5} />
        </mesh>
      </group>
    </group>
  );
}

function Wheel({ position, r, w, mecanum }: { position: [number, number, number]; r: number; w: number; mecanum?: boolean }) {
  return (
    <group position={position} rotation-x={Math.PI / 2}>
      <mesh castShadow>
        <cylinderGeometry args={[r, r, w, 28]} />
        <meshStandardMaterial color={ACCENT.rubber} roughness={0.9} />
      </mesh>
      <mesh>
        <cylinderGeometry args={[r * 0.45, r * 0.45, w * 1.04, 20]} />
        <meshStandardMaterial color="#3a3f4c" metalness={0.8} roughness={0.3} />
      </mesh>
      {mecanum && Array.from({ length: 10 }).map((_, i) => {
        const a = (i / 10) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * r * 0.98, 0, Math.sin(a) * r * 0.98]} rotation={[Math.PI / 4, -a, 0]}>
            <capsuleGeometry args={[r * 0.13, w * 0.9, 4, 8]} />
            <meshStandardMaterial color="#2a2e38" metalness={0.5} roughness={0.4} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Differential drive: round shell, two drive wheels, rear caster. */
function Scout({ visual, radius: R, active, collided, spin }: BodyProps) {
  return (
    <group>
      <mesh position-y={0.024} castShadow>
        <cylinderGeometry args={[R, R, 0.026, 48]} />
        <meshStandardMaterial color={ACCENT.metal} metalness={0.5} roughness={0.45} />
      </mesh>
      <mesh position-y={0.068} castShadow>
        <cylinderGeometry args={[R * 0.97, R, 0.064, 48]} />
        <Shell color={visual.color} collided={collided} />
      </mesh>
      <mesh position-y={0.101} rotation-x={Math.PI / 2}>
        <torusGeometry args={[R * 0.97, 0.0055, 10, 64]} />
        <meshStandardMaterial color={ACCENT.violet} emissive={ACCENT.violet} emissiveIntensity={active ? 3 : 1.6} />
      </mesh>
      <mesh position-y={0.103}>
        <cylinderGeometry args={[R * 0.5, R * 0.56, 0.01, 40]} />
        <meshPhysicalMaterial color="#1b1d26" metalness={0.4} roughness={0.15} clearcoat={1} />
      </mesh>
      <Lidar y={0.125} spin={spin} active={active} />
      {[1, -1].map((s) => <Wheel key={s} position={[0, 0.042, s * R * 0.93]} r={0.042} w={0.024} />)}
      <mesh position={[-R * 0.72, 0.014, 0]} castShadow>
        <sphereGeometry args={[0.014, 16, 12]} />
        <meshStandardMaterial color="#5b6170" metalness={0.8} roughness={0.2} />
      </mesh>
      <mesh position={[R * 0.95, 0.07, 0]}>
        <boxGeometry args={[0.012, 0.016, 0.07]} />
        <meshStandardMaterial color={ACCENT.blue} emissive={ACCENT.blue} emissiveIntensity={2.6} />
      </mesh>
    </group>
  );
}

/** Four-wheel skid-steer: boxy rover, four chunky wheels, headlights, mast. */
function Hauler({ visual, active, collided, spin }: BodyProps) {
  const L = visual.length, W = visual.width, H = visual.height;
  const wr = 0.05, ww = 0.036;
  const body = useGeo(() => roundedBox(L * 0.98, W - ww * 1.6, H * 0.55, 0.03), [L, W, H]);
  const deck = useGeo(() => roundedBox(L * 0.7, (W - ww * 1.6) * 0.8, 0.02, 0.02), [L, W]);
  return (
    <group>
      <mesh geometry={body} position-y={wr * 0.75} castShadow><Shell color={visual.color} collided={collided} /></mesh>
      <mesh geometry={deck} position-y={wr * 0.75 + H * 0.55} castShadow>
        <meshPhysicalMaterial color="#20232c" metalness={0.6} roughness={0.3} clearcoat={0.8} />
      </mesh>
      {[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => (
        <Wheel key={`${sx}${sz}`} position={[sx * L * 0.3, wr, sz * (W / 2 - ww / 2)]} r={wr} w={ww} />
      ))}
      {[1, -1].map((s) => (
        <mesh key={s} position={[L / 2 - 0.006, wr * 0.75 + H * 0.3, s * W * 0.22]}>
          <boxGeometry args={[0.01, 0.018, 0.034]} />
          <meshStandardMaterial color={ACCENT.blue} emissive={ACCENT.blue} emissiveIntensity={3} />
        </mesh>
      ))}
      <mesh position={[L * 0.47, wr * 0.75 + 0.02, 0]}>
        <boxGeometry args={[0.02, 0.025, W * 0.7]} />
        <meshStandardMaterial color="#2a2e3a" metalness={0.8} roughness={0.3} />
      </mesh>
      <mesh position={[-L * 0.1, wr * 0.75 + H * 0.55 + 0.02, 0]} rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.05, 0.004, 8, 40]} />
        <meshStandardMaterial color={ACCENT.violet} emissive={ACCENT.violet} emissiveIntensity={active ? 3 : 1.6} />
      </mesh>
      <Lidar y={wr * 0.75 + H * 0.55 + 0.04} spin={spin} active={active} />
    </group>
  );
}

/** Mecanum omnidirectional: low platform, four roller wheels, cyan "omni" band. */
function Glide({ visual, active, collided, spin }: BodyProps) {
  const L = visual.length, W = visual.width, H = visual.height;
  const wr = 0.038, ww = 0.03;
  const body = useGeo(() => roundedBox(L, W - ww * 1.7, H * 0.5, 0.05), [L, W, H]);
  const top = useGeo(() => roundedBox(L * 0.8, (W - ww * 1.7) * 0.82, 0.016, 0.04), [L, W]);
  const y0 = wr * 0.9;
  return (
    <group>
      <mesh geometry={body} position-y={y0} castShadow><Shell color={visual.color} collided={collided} /></mesh>
      <mesh geometry={top} position-y={y0 + H * 0.5} castShadow>
        <meshPhysicalMaterial color="#1b1e27" metalness={0.5} roughness={0.2} clearcoat={1} />
      </mesh>
      <mesh position-y={y0 + H * 0.2}>
        <boxGeometry args={[L * 1.002, 0.006, (W - ww * 1.7) * 1.002]} />
        <meshStandardMaterial color={ACCENT.cyan} emissive={ACCENT.cyan} emissiveIntensity={active ? 2.6 : 1.4} />
      </mesh>
      {[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => (
        <Wheel key={`${sx}${sz}`} position={[sx * L * 0.32, wr, sz * (W / 2 - ww / 2)]} r={wr} w={ww} mecanum />
      ))}
      <mesh position={[L / 2 - 0.004, y0 + H * 0.32, 0]}>
        <boxGeometry args={[0.008, 0.014, 0.06]} />
        <meshStandardMaterial color={ACCENT.blue} emissive={ACCENT.blue} emissiveIntensity={2.6} />
      </mesh>
      <Lidar y={y0 + H * 0.5 + 0.03} spin={spin} active={active} size={0.9} />
    </group>
  );
}

/** Indoor delivery robot: tall rounded body with a cargo lid, face panel and sensor band. */
function Courier({ visual, active, collided, spin }: BodyProps) {
  const L = visual.length, W = visual.width, H = visual.height;
  const base = useGeo(() => roundedBox(L, W, 0.06, 0.07), [L, W]);
  const body = useGeo(() => roundedBox(L * 0.94, W * 0.94, H - 0.1, 0.08), [L, W, H]);
  const lid = useGeo(() => roundedBox(L * 0.9, W * 0.9, 0.03, 0.07), [L, W]);
  const blink = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!blink.current || !spin) return;
    const t = clock.elapsedTime % 4;
    blink.current.scale.y = t > 3.85 ? 0.15 : 1;
  });
  return (
    <group>
      <mesh geometry={base} position-y={0.018} castShadow>
        <meshStandardMaterial color="#1c1f27" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position-y={0.05}>
        <boxGeometry args={[L * 0.96, 0.012, W * 0.96]} />
        <meshStandardMaterial color={ACCENT.cyan} emissive={ACCENT.cyan} emissiveIntensity={active ? 2.4 : 1.2} />
      </mesh>
      <mesh geometry={body} position-y={0.075} castShadow><Shell color={visual.color} collided={collided} /></mesh>
      <mesh geometry={lid} position-y={0.075 + H - 0.1} castShadow>
        <meshPhysicalMaterial color="#d9dbe3" roughness={0.25} clearcoat={1} />
      </mesh>
      <mesh position-y={0.075 + H - 0.1 - 0.002}>
        <boxGeometry args={[L * 0.95, 0.006, W * 0.95]} />
        <meshStandardMaterial color={ACCENT.violet} emissive={ACCENT.violet} emissiveIntensity={1.4} />
      </mesh>
      {/* face panel with eyes */}
      <mesh position={[L * 0.47 + 0.001, 0.075 + H * 0.55, 0]}>
        <boxGeometry args={[0.006, H * 0.24, W * 0.62]} />
        <meshPhysicalMaterial color="#0f1117" metalness={0.3} roughness={0.08} clearcoat={1} />
      </mesh>
      <group ref={blink} position={[L * 0.47 + 0.006, 0.075 + H * 0.56, 0]}>
        {[1, -1].map((s) => (
          <mesh key={s} position-z={s * W * 0.12} rotation-z={Math.PI / 2}>
            <capsuleGeometry args={[0.012, 0.022, 4, 10]} />
            <meshStandardMaterial color={ACCENT.blue} emissive={ACCENT.blue} emissiveIntensity={3} />
          </mesh>
        ))}
      </group>
      {/* safety flag antenna */}
      <mesh position={[-L * 0.32, 0.075 + H + 0.08, W * 0.3]}>
        <cylinderGeometry args={[0.003, 0.003, 0.2, 8]} />
        <meshStandardMaterial color="#8a909c" />
      </mesh>
      <mesh position={[-L * 0.32, 0.075 + H + 0.18, W * 0.3]}>
        <sphereGeometry args={[0.012, 16, 12]} />
        <meshStandardMaterial color={ACCENT.violet} emissive={ACCENT.violet} emissiveIntensity={2.5} />
      </mesh>
      <Lidar y={0.075 + H - 0.1 + 0.05} spin={spin} active={active} size={0.85} />
    </group>
  );
}

/** Custom: round (Scout-like) or box (Hauler-like) body in the user's colour and height. */
function Custom(p: BodyProps) {
  const v = p.visual;
  if (v.body === "box") return <Hauler {...p} visual={{ ...v, height: v.height }} />;
  return (
    <group scale={[1, Math.max(0.6, v.height / 0.14), 1]}>
      <Scout {...p} />
    </group>
  );
}

export function RobotBody(p: BodyProps) {
  switch (p.visual.model) {
    case "hauler": return <Hauler {...p} />;
    case "glide": return <Glide {...p} />;
    case "courier": return <Courier {...p} />;
    case "custom": return <Custom {...p} />;
    default: return <Scout {...p} />;
  }
}

/** Height of the top of the body (for placing sensor beams). */
export function bodyHeight(v: RobotVisual) {
  switch (v.model) {
    case "courier": return 0.075 + v.height + 0.02;
    case "hauler": return 0.05 * 0.75 + v.height * 0.55 + 0.05;
    case "glide": return 0.038 * 0.9 + v.height * 0.5 + 0.05;
    case "custom": return v.body === "box" ? 0.05 * 0.75 + v.height * 0.55 + 0.05 : 0.13 * Math.max(0.6, v.height / 0.14);
    default: return 0.13;
  }
}

/** Scale-in when the robot model changes (smooth robot switching). */
export function SwapIn({ k, animate, children }: { k: string; animate: boolean; children: React.ReactNode }) {
  const g = useRef<THREE.Group>(null);
  const t0 = useRef<number | null>(null);
  const firstKey = useRef(k);                    // no entrance on first mount - only when the robot changes
  useEffect(() => { t0.current = null; }, [k]);
  useFrame(({ clock }) => {
    if (!g.current) return;
    if (!animate || k === firstKey.current) { g.current.scale.setScalar(1); g.current.position.y = 0; return; }
    if (t0.current === null) t0.current = clock.elapsedTime;
    const u = Math.min(1, (clock.elapsedTime - t0.current) / 0.55);
    const e = 1 - Math.pow(1 - u, 3);
    g.current.scale.setScalar(0.6 + 0.4 * e);
    g.current.position.y = (1 - e) * 0.12;
  });
  return <group ref={g} key={k}>{children}</group>;
}
