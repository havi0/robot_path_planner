import { useCallback, useState, type CSSProperties, type PointerEvent } from "react";
import { usePrefs } from "../../lib/prefs";

/**
 * Restrained pointer tilt for a few hero-level tiles (max ±4°, mouse/pen only).
 * Returns handlers + style to spread on an existing element; its own handlers are untouched.
 */
export function useTilt(max = 4) {
  const { reduceMotion } = usePrefs();
  const [t, setT] = useState({ x: 0, y: 0, on: false });
  const onPointerMove = useCallback((e: PointerEvent<HTMLElement>) => {
    if (reduceMotion || e.pointerType === "touch") return;
    const r = e.currentTarget.getBoundingClientRect();
    setT({ x: ((e.clientY - r.top) / r.height - 0.5) * -2 * max, y: ((e.clientX - r.left) / r.width - 0.5) * 2 * max, on: true });
  }, [max, reduceMotion]);
  const onPointerLeave = useCallback(() => setT({ x: 0, y: 0, on: false }), []);
  const style: CSSProperties = {
    transform: `perspective(700px) rotateX(${t.x.toFixed(2)}deg) rotateY(${t.y.toFixed(2)}deg) translateY(${t.on ? -2 : 0}px)`,
    transition: t.on ? "transform 80ms linear, box-shadow 200ms" : "transform 380ms cubic-bezier(.2,.8,.2,1), box-shadow 200ms",
  };
  return { onPointerMove, onPointerLeave, style };
}
