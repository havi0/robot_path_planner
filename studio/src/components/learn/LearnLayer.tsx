import clsx from "clsx";
import { GraduationCap, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { lookupId, lookupText, pageGuide, type LearnEntry } from "./glossary";

/**
 * Hover-to-Learn. A single document-level layer: it never wraps, re-renders or
 * attaches handlers to existing components. It finds short labels whose visible
 * text matches the glossary (or any element with `data-learn="<id>"`) and shows an
 * explanation on hover / keyboard focus. Listeners are passive and never call
 * preventDefault or stopPropagation, and every element it draws has
 * pointer-events: none — so existing clicks, hovers, charts and shortcuts are untouched.
 *
 * Learn mode (opt-in) outlines every explainable label on the page and opens a
 * guide panel. State lives in its own localStorage key; existing prefs are not touched.
 */

// ------------------------------------------------------------------ store
interface LearnState { mode: boolean; hover: boolean }
const KEY = "nexus.learn.v1";
let state: LearnState = load();
const listeners = new Set<() => void>();

function load(): LearnState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { mode: false, hover: true, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { mode: false, hover: true };
}

export function setLearn(patch: Partial<LearnState>) {
  state = { ...state, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}

export function useLearn(): LearnState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

// ------------------------------------------------------------------ matching
const EXCLUDE = "nav, input, textarea, select, svg, canvas, [role=tooltip], [data-learn-ignore], [contenteditable=true]";
const CANDIDATES = "[data-learn], span, div, h1, h2, h3, h4, p, label, th, td, button, a, dt, dd, li";
interface Match { el: HTMLElement; entry: LearnEntry }

function matchElement(el: HTMLElement): LearnEntry | undefined {
  const id = el.getAttribute("data-learn");
  if (id) return lookupId(id);
  if (el.childElementCount > 3) return undefined;
  const text = el.textContent ?? "";
  return text.length <= 64 ? lookupText(text) : undefined;
}

function findMatch(target: EventTarget | null): Match | null {
  if (!(target instanceof Element)) return null;
  let el: Element | null = target instanceof HTMLElement ? target : target.parentElement;
  if (!el) return null;
  // explicit opt-in (e.g. navigation items) wins over the automatic exclusions
  const explicit = el.closest<HTMLElement>("[data-learn]");
  if (explicit && !explicit.closest("[data-learn-ignore]")) {
    const entry = lookupId(explicit.getAttribute("data-learn") ?? "");
    if (entry) return { el: explicit, entry };
  }
  if (el.closest(EXCLUDE)) return null;
  for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.tagName === "MAIN" || el.tagName === "BODY") break;
    const entry = matchElement(el);
    if (entry) return { el, entry };
  }
  return null;
}

/** Bounds of the label's text (block elements would otherwise outline their full width). */
function labelRect(el: HTMLElement): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(el);
  const r = range.getBoundingClientRect();
  return r.width > 0 ? r : el.getBoundingClientRect();
}

const inPanel = (t: EventTarget | null) => t instanceof Element && !!t.closest("[data-learn-panel]");

function scanPage(root: Element): Match[] {
  const found: Match[] = [];
  root.querySelectorAll<HTMLElement>(CANDIDATES).forEach((el) => {
    if (el.closest(EXCLUDE)) return;
    const entry = matchElement(el);
    if (entry && el.getClientRects().length) found.push({ el, entry });
  });
  // keep the innermost element when a label and its wrapper match the same concept
  return found.filter((m) => !found.some((o) => o !== m && o.entry.id === m.entry.id && m.el.contains(o.el)));
}

// ------------------------------------------------------------------ tooltip
function Tip({ match, onTouch }: { match: Match; onTouch?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = labelRect(match.el);
    const box = ref.current?.getBoundingClientRect();
    const w = box?.width ?? 320, h = box?.height ?? 120, gap = 8, vw = window.innerWidth, vh = window.innerHeight;
    if (match.el.getAttribute("data-learn-side") === "right") {
      const r = match.el.getBoundingClientRect();   // whole item, not just its text
      setPos({ left: Math.min(r.right + 10, vw - w - 8), top: Math.min(Math.max(8, r.top + r.height / 2 - h / 2), vh - h - 8) });
      return;
    }
    const below = r.bottom + gap + h <= vh - 8 || r.top - gap - h < 8;
    setPos({
      left: Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8),
      top: below ? Math.min(r.bottom + gap, vh - h - 8) : r.top - gap - h,
    });
  }, [match]);
  const { entry } = match;
  return createPortal(
    <div
      ref={ref}
      id="nexus-learn-tip"
      role="tooltip"
      className="pointer-events-none fixed z-[300] w-[320px] max-w-[calc(100vw-16px)] rounded-lg border border-line-strong bg-[#1a1d24] px-3.5 py-3 shadow-2xl transition-opacity duration-100"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, opacity: pos ? 1 : 0 }}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
        <GraduationCap className="h-3.5 w-3.5 shrink-0 text-violet" /> {entry.title}
      </div>
      <p className="text-[12px] leading-relaxed text-ink-2">{entry.body}</p>
      {entry.read && <p className="mt-1.5 border-t border-line pt-1.5 text-[11.5px] leading-relaxed text-ink-3">{entry.read}</p>}
      {onTouch && <p className="mt-1.5 text-[10.5px] text-ink-3">Tap elsewhere to close.</p>}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ layer
export function LearnLayer() {
  const { mode, hover } = useLearn();
  const loc = useLocation();
  const [tip, setTip] = useState<(Match & { touch?: boolean }) | null>(null);
  const [marks, setMarks] = useState<Match[]>([]);
  const [rects, setRects] = useState<DOMRect[]>([]);
  const [clip, setClip] = useState<DOMRect | null>(null);
  const [flash, setFlash] = useState<HTMLElement | null>(null);
  const tipRef = useRef(tip);
  tipRef.current = tip;
  const timer = useRef<number | undefined>(undefined);
  const marksRef = useRef<Match[]>([]);
  const enabled = hover || mode;

  // element we added aria-describedby to (only ever one we set ourselves; never overwrite the page's own)
  const described = useRef<HTMLElement | null>(null);
  const show = useCallback((m: Match | null, touch = false, focused?: HTMLElement) => {
    if (described.current && described.current !== focused) {
      described.current.removeAttribute("aria-describedby");
      described.current = null;
    }
    if (m && focused && !focused.hasAttribute("aria-describedby")) {
      focused.setAttribute("aria-describedby", "nexus-learn-tip");
      described.current = focused;
    }
    setTip(m ? { ...m, touch } : null);
  }, []);

  // hover / focus / touch / escape — passive, never blocks the page's own handlers
  useEffect(() => {
    if (!enabled) { show(null); return; }
    const delay = mode ? 120 : 550;
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch" || inPanel(e.target)) return;
      const m = findMatch(e.target);
      if (m && m.el === tipRef.current?.el) { window.clearTimeout(timer.current); return; }
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => show(m), m ? (tipRef.current ? 60 : delay) : 80);
    };
    const onLeaveDoc = (e: PointerEvent) => { if (!e.relatedTarget) { window.clearTimeout(timer.current); show(null); } };
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.matches?.(":focus-visible")) return;
      const m = findMatch(t);
      if (m) show(m, false, t);
    };
    const onBlur = (e: FocusEvent) => { const t = tipRef.current; if (t && (t.el.contains(e.target as Node) || e.target === described.current)) show(null); };
    const onDown = (e: PointerEvent) => {
      if (inPanel(e.target)) return;
      window.clearTimeout(timer.current);
      if (e.pointerType === "touch" && mode) { const m = findMatch(e.target); show(m, true); }
      else if (tipRef.current) show(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && tipRef.current) show(null); };
    const onScroll = () => { if (tipRef.current && !tipRef.current.touch) show(null); };
    const opts = { capture: true, passive: true } as const;
    document.addEventListener("pointerover", onOver, opts);
    document.addEventListener("pointerout", onLeaveDoc, opts);
    document.addEventListener("focusin", onFocus, opts);
    document.addEventListener("focusout", onBlur, opts);
    document.addEventListener("pointerdown", onDown, opts);
    document.addEventListener("keydown", onKey, opts);
    window.addEventListener("scroll", onScroll, opts);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("pointerover", onOver, opts);
      document.removeEventListener("pointerout", onLeaveDoc, opts);
      document.removeEventListener("focusin", onFocus, opts);
      document.removeEventListener("focusout", onBlur, opts);
      document.removeEventListener("pointerdown", onDown, opts);
      document.removeEventListener("keydown", onKey, opts);
      window.removeEventListener("scroll", onScroll, opts);
    };
  }, [enabled, mode, show]);

  // hide a tip whose element left the DOM (page change, live re-render)
  useEffect(() => { show(null); }, [loc.pathname, show]);

  // learn mode: find explainable labels and outline them (overlay only)
  useEffect(() => {
    if (!mode) { setMarks([]); setRects([]); return; }
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const main = document.querySelector("main");
        setClip(main?.getBoundingClientRect() ?? null);
        setRects(marksRef.current.map((m) => labelRect(m.el)));
      });
    };
    const rescan = () => {
      const main = document.querySelector("main");
      const dialog = document.querySelector("[role=dialog]");
      const found = main && !dialog ? scanPage(main) : [];
      marksRef.current = found;
      setMarks(found);
      measure();
    };
    rescan();
    const iv = window.setInterval(rescan, 700);
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("scroll", measure, opts);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(iv);
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", measure, opts);
      window.removeEventListener("resize", measure);
    };
  }, [mode, loc.pathname]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(t);
  }, [flash]);

  const guide = pageGuide(loc.pathname);
  const concepts = [...new Map(marks.map((m) => [m.entry.id, m])).values()];

  return (
    <>
      {mode && clip && createPortal(
        <div className="pointer-events-none fixed z-[90] overflow-hidden" style={{ left: clip.left, top: clip.top, width: clip.width, height: clip.height }} aria-hidden>
          {rects.map((r, i) => r.width > 0 && (
            <div
              key={i}
              className={clsx("absolute rounded-[5px] border border-dashed transition-colors",
                marks[i]?.el === flash || marks[i]?.el === tip?.el ? "border-violet bg-violet-soft" : "border-[#8b7cf680]")}
              style={{ left: r.left - clip.left - 3, top: r.top - clip.top - 2, width: r.width + 6, height: r.height + 4 }}
            />
          ))}
        </div>,
        document.body,
      )}

      {mode && createPortal(
        <aside data-learn-ignore data-learn-panel className="panel fixed bottom-4 right-4 z-[95] flex max-h-[62vh] w-[340px] max-w-[calc(100vw-32px)] flex-col shadow-2xl" aria-label="Learn this dashboard">
          <header className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              <GraduationCap className="h-4 w-4 text-violet" /> Learn this dashboard
            </div>
            <button onClick={() => setLearn({ mode: false })} className="rounded-md p-1 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Exit learn mode" title="Exit learn mode">
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
            {guide && (
              <>
                <div className="eyebrow mb-1">{guide.title}</div>
                <p className="text-[12px] leading-relaxed text-ink-2">{guide.text}</p>
              </>
            )}
            <div className="eyebrow mb-1.5 mt-3">Concepts on this page · {concepts.length}</div>
            {concepts.length === 0 ? (
              <p className="text-[12px] text-ink-3">No explainable labels are visible here right now.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {concepts.map((m) => (
                  <button
                    key={m.entry.id}
                    onMouseEnter={() => show(m)}
                    onFocus={() => show(m)}
                    onMouseLeave={() => show(null)}
                    onBlur={() => show(null)}
                    onClick={() => { m.el.scrollIntoView({ block: "nearest", behavior: "smooth" }); setFlash(m.el); }}
                    className="rounded-md border border-line-strong bg-surface-2 px-2 py-0.5 text-[11.5px] text-ink-2 hover:border-[#8b7cf680] hover:text-ink"
                  >
                    {m.entry.title}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
              Hover, focus or tap an outlined label to see what it means. Explanations describe concepts; the numbers on the page are the measured data.
            </p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 border-t border-line px-3.5 py-2.5 text-[11.5px] text-ink-2">
            <input type="checkbox" checked={hover} onChange={(e) => setLearn({ hover: e.target.checked })} className="accent-[#8b7cf6]" />
            Show explanations on hover when learn mode is off
          </label>
        </aside>,
        document.body,
      )}

      {tip && tip.el.isConnected && <Tip match={tip} onTouch={tip.touch} />}
    </>
  );
}

/** Top-bar toggle for learn mode. */
export function LearnButton() {
  const { mode } = useLearn();
  return (
    <button
      onClick={() => setLearn({ mode: !mode })}
      aria-pressed={mode}
      aria-label="Learn this dashboard"
      title="Learn this dashboard"
      data-learn-ignore
      className={clsx("rounded-lg p-2 hover:bg-surface-3 hover:text-ink", mode ? "bg-violet-soft text-[#c4bcff]" : "text-ink-3")}
    >
      <GraduationCap className="h-4 w-4" />
    </button>
  );
}
