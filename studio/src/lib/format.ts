export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function fmt(v: number | null | undefined, digits = 2, fallback = "—"): string {
  return isNum(v) ? v.toFixed(digits) : fallback;
}

export function pct(v: number | null | undefined, digits = 0, fallback = "—"): string {
  return isNum(v) ? `${(v * 100).toFixed(digits)}%` : fallback;
}

export function int(v: number | null | undefined, fallback = "—"): string {
  return isNum(v) ? Math.round(v).toLocaleString("en-US") : fallback;
}

export function duration(s: number | null | undefined): string {
  if (!isNum(s)) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec.toString().padStart(2, "0")}s` : `${sec}s`;
}

export function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString("en-GB", { hour12: false });
}

export function dateTime(t: number | null | undefined): string {
  if (!isNum(t)) return "—";
  return new Date(t * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function bytes(n: number): string {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`;
}

/** Trailing moving average (window w). */
export function smooth(values: number[], w: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= w) sum -= values[i - w];
    out.push(sum / Math.min(i + 1, w));
  }
  return out;
}

export const humanize = (s: string) => s.replace(/_/g, " ");

/** True when a keyboard event originates from a text field (shortcuts must not fire). */
export function isTypingTarget(e: Event): boolean {
  const t = e.target as Element | null;
  return !!t && typeof (t as Element).closest === "function" && !!(t as Element).closest("input,select,textarea,[contenteditable=true]");
}
