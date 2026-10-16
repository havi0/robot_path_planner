import { Component, lazy, Suspense, useSyncExternalStore, type ReactNode } from "react";
import { usePrefs } from "../../lib/prefs";
import type { NavScene3DProps } from "./NavScene3D";

/** three.js is loaded on demand so the rest of the studio stays light. */
const NavScene3D = lazy(() => import("./NavScene3D"));

let webgl: boolean | null = null;
export function webglAvailable() {
  if (webgl === null) {
    try {
      const c = document.createElement("canvas");
      webgl = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      webgl = false;
    }
  }
  return webgl;
}

const mq = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
function useSystemReducedMotion() {
  return useSyncExternalStore(
    (l) => { mq?.addEventListener("change", l); return () => mq?.removeEventListener("change", l); },
    () => !!mq?.matches,
  );
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.warn("3D view unavailable, using 2D fallback:", e); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/**
 * 3D scene with graceful degradation: no WebGL, a render error or a slow chunk load
 * all show `fallback` (normally the existing 2D canvas). Honors reduced motion.
 */
export function Scene3DView({ fallback, ...props }: Omit<NavScene3DProps, "reducedMotion"> & { fallback: ReactNode }) {
  const { reduceMotion } = usePrefs();
  const sysReduced = useSystemReducedMotion();
  if (!webglAvailable()) return <>{fallback}</>;
  return (
    <Boundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <NavScene3D {...props} reducedMotion={reduceMotion || sysReduced} />
      </Suspense>
    </Boundary>
  );
}
