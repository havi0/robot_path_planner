/** Single-robot showcase: pedestal, footprint ring, soft studio lighting, orbit/touch inspection. */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { RobotVisual } from "../../lib/types";
import { RobotBody, SwapIn } from "./robotModels";

export interface RobotStageProps {
  visual: RobotVisual;
  radius: number;
  /** Extra yaw (radians) applied smoothly - used by the keyboard/touch rotate buttons. */
  yaw?: number;
  interactive?: boolean;
  autoRotate?: boolean;
  /** Render continuously (hover / focus) vs. once (static card thumbnails). */
  live?: boolean;
  reducedMotion?: boolean;
  zoom?: number;
}

function Pedestal({ radius }: { radius: number }) {
  const r = Math.max(radius * 1.45, 0.24);
  return (
    <group>
      <mesh position-y={-0.012} receiveShadow>
        <cylinderGeometry args={[r, r * 1.04, 0.024, 72]} />
        <meshPhysicalMaterial color="#16181f" metalness={0.25} roughness={0.55} clearcoat={0.3} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.0005}>
        <ringGeometry args={[r * 0.985, r, 96]} />
        <meshBasicMaterial color="#8b7cf6" transparent opacity={0.65} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.001}>
        <ringGeometry args={[radius - 0.003, radius, 72]} />
        <meshBasicMaterial color="#c4bcff" transparent opacity={0.4} depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.03}>
        <circleGeometry args={[r * 3.2, 64]} />
        <meshBasicMaterial color="#8b7cf6" transparent opacity={0.06} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  );
}

function Turntable({ yaw, autoRotate, children }: { yaw: number; autoRotate: boolean; children: React.ReactNode }) {
  const g = useRef<THREE.Group>(null);
  const spin = useRef(0);
  useFrame((_, dt) => {
    if (!g.current) return;
    if (autoRotate) spin.current += dt * 0.35;
    const target = -0.6 + yaw + spin.current;
    g.current.rotation.y += (target - g.current.rotation.y) * Math.min(1, dt * 6);
  });
  return <group ref={g} rotation-y={-0.6 + yaw}>{children}</group>;
}

function Controls({ interactive, zoom }: { interactive: boolean; zoom: number }) {
  const { camera, gl, invalidate } = useThree();
  const controls = useMemo(() => {
    if (!interactive) return null;
    const c = new OrbitControls(camera, gl.domElement);
    c.enableDamping = true; c.enablePan = false; c.minDistance = 0.35; c.maxDistance = 2.0;
    c.minPolarAngle = 0.35; c.maxPolarAngle = Math.PI * 0.47;
    c.target.set(0, 0.1, 0);
    return c;
  }, [camera, gl, interactive]);
  useEffect(() => {
    camera.position.set(0.7 * zoom, 0.42 * zoom, 0.7 * zoom);
    camera.lookAt(0, 0.1, 0);
    if (!controls) return;
    const on = () => invalidate();
    controls.addEventListener("change", on);
    return () => { controls.removeEventListener("change", on); controls.dispose(); };
  }, [controls, camera, zoom, invalidate]);
  useFrame(() => controls?.update());
  return null;
}

export default function RobotStage({ visual, radius, yaw = 0, interactive = false, autoRotate = false, live = false, reducedMotion = false, zoom = 1 }: RobotStageProps) {
  const animate = live && !reducedMotion;
  return (
    <Canvas
      shadows="soft"
      dpr={[1, 1.75]}
      frameloop={animate || interactive ? "always" : "demand"}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: false }}
      camera={{ fov: 32, near: 0.02, far: 20, position: [0.7 * zoom, 0.42 * zoom, 0.7 * zoom] }}
      onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.15; }}
      aria-hidden
    >
      <fog attach="fog" args={["#0a0b0f", 2.2, 5]} />
      <hemisphereLight args={["#8a86a8", "#07080b", 0.45]} />
      <directionalLight position={[-1.2, 2.4, 1.4]} intensity={2.4} color="#f4f1ff" castShadow shadow-mapSize={[1024, 1024]} shadow-radius={6} />
      <pointLight position={[1.1, 0.7, -1.0]} color="#8b7cf6" intensity={3.2} distance={4} />
      <pointLight position={[-1.2, 0.4, -0.4]} color="#5aa2ff" intensity={1.4} distance={3.5} />
      <Pedestal radius={radius} />
      <Turntable yaw={yaw} autoRotate={animate && autoRotate}>
        <SwapIn k={`${visual.model}-${visual.color}-${visual.body ?? ""}-${visual.height}-${radius}`} animate={!reducedMotion}>
          <RobotBody visual={visual} radius={radius} active={animate} spin={animate} />
        </SwapIn>
      </Turntable>
      <Controls interactive={interactive} zoom={zoom} />
    </Canvas>
  );
}
