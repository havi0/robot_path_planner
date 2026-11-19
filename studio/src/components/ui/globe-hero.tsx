/**
 * DotGlobeHero - full-screen hero with a slowly rotating wireframe + dot globe behind
 * centred content. Adapted from the shadcn-style "globe-hero" component for this project:
 * relative imports instead of "@/", NEXUS colour tokens instead of shadcn's, the camera
 * set on <Canvas> instead of drei's PerspectiveCamera (no extra dependency), a dot shell
 * for depth, and a static globe when reduced motion is requested.
 */
import { Canvas, useFrame } from "@react-three/fiber";
import clsx from "clsx";
import React, { useMemo, useRef } from "react";
import * as THREE from "three";

interface DotGlobeHeroProps extends React.HTMLAttributes<HTMLDivElement> {
  rotationSpeed?: number;
  globeRadius?: number;
  /** three.js colour of the wireframe and dots (CSS variables don't work inside WebGL). */
  color?: string;
  /** Disable rotation (reduced motion) */
  still?: boolean;
  /** Skip the WebGL canvas entirely (no WebGL available) */
  noCanvas?: boolean;
  children?: React.ReactNode;
}

const Globe: React.FC<{ rotationSpeed: number; radius: number; color: string }> = ({ rotationSpeed, radius, color }) => {
  const groupRef = useRef<THREE.Group>(null!);
  const dots = useMemo(() => {
    // evenly spread points on the sphere (Fibonacci lattice)
    const n = 900, pts = new Float32Array(n * 3), golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), th = golden * i;
      pts.set([Math.cos(th) * r * radius * 1.002, y * radius * 1.002, Math.sin(th) * r * radius * 1.002], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    return g;
  }, [radius]);

  useFrame(() => {
    if (groupRef.current && rotationSpeed) {
      groupRef.current.rotation.y += rotationSpeed;
      groupRef.current.rotation.x += rotationSpeed * 0.3;
      groupRef.current.rotation.z += rotationSpeed * 0.1;
    }
  });

  return (
    <group ref={groupRef} rotation={[0.35, 0, 0.12]}>
      <mesh>
        <sphereGeometry args={[radius, 64, 64]} />
        <meshBasicMaterial color={color} transparent opacity={0.15} wireframe />
      </mesh>
      <points geometry={dots}>
        <pointsMaterial color={color} size={0.01} transparent opacity={0.55} sizeAttenuation depthWrite={false} />
      </points>
    </group>
  );
};

const DotGlobeHero = React.forwardRef<HTMLDivElement, DotGlobeHeroProps>(
  ({ rotationSpeed = 0.005, globeRadius = 1, color = "#9a8dff", still = false, noCanvas = false, className, children, ...props }, ref) => (
    <div ref={ref} className={clsx("relative h-screen w-full overflow-hidden bg-bg", className)} {...props}>
      <div className="relative z-10 flex h-full flex-col items-center justify-center">{children}</div>
      {!noCanvas && (
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
          <Canvas camera={{ position: [0, 0, 3], fov: 75 }} dpr={[1, 1.75]} frameloop={still ? "demand" : "always"} gl={{ alpha: true, antialias: true }}>
            <ambientLight intensity={0.5} />
            <pointLight position={[10, 10, 10]} intensity={1} />
            <Globe rotationSpeed={still ? 0 : rotationSpeed} radius={globeRadius} color={color} />
          </Canvas>
        </div>
      )}
    </div>
  ),
);

DotGlobeHero.displayName = "DotGlobeHero";

export { DotGlobeHero, type DotGlobeHeroProps };
