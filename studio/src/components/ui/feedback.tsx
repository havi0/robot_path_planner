import clsx from "clsx";
import type { ReactNode } from "react";

export type Tone = "good" | "warn" | "bad" | "info" | "violet" | "muted";

const toneText: Record<Tone, string> = {
  good: "text-good", warn: "text-warn", bad: "text-bad", info: "text-cyan", violet: "text-[#b3a9ff]", muted: "text-ink-3",
};
const toneDot: Record<Tone, string> = {
  good: "bg-good", warn: "bg-warn", bad: "bg-bad", info: "bg-cyan", violet: "bg-violet", muted: "bg-ink-3",
};

export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {pulse && <span className={clsx("absolute inset-0 rounded-full opacity-60 animate-ping", toneDot[tone])} />}
      <span className={clsx("relative inline-flex h-2 w-2 rounded-full", toneDot[tone])} />
    </span>
  );
}

/** Status badge: colour is never the only signal - always a dot + label. */
export function Badge({ tone = "muted", children, pulse, className }: { tone?: Tone; children: ReactNode; pulse?: boolean; className?: string }) {
  return (
    <span className={clsx("inline-flex h-6 items-center gap-1.5 rounded-md border border-line-strong bg-surface-2 px-2 text-[11.5px] font-medium", toneText[tone], className)}>
      <StatusDot tone={tone} pulse={pulse} />
      <span className="text-ink-2">{children}</span>
    </span>
  );
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx("mono inline-flex h-5 items-center whitespace-nowrap rounded border border-line bg-surface-2 px-1.5 text-[10.5px] text-ink-2", className)}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mono inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-surface-3 px-1 text-[10px] text-ink-2">{children}</kbd>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded-md bg-surface-3", className)} />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      {icon && <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg border border-line-strong bg-surface-2 text-ink-3">{icon}</div>}
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {children && <div className="max-w-sm text-[12.5px] leading-relaxed text-ink-3">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "right" }) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={clsx(
          "pointer-events-none absolute z-50 w-max max-w-[260px] rounded-md border border-line-strong bg-[#1a1d24] px-2.5 py-1.5 text-[11.5px] leading-snug text-ink-2 opacity-0 shadow-xl transition-opacity duration-150 delay-200 group-hover/tt:opacity-100 group-focus-within/tt:opacity-100",
          side === "top" && "bottom-full left-1/2 mb-2 -translate-x-1/2",
          side === "bottom" && "top-full left-1/2 mt-2 -translate-x-1/2",
          side === "right" && "left-full top-1/2 ml-2 -translate-y-1/2",
        )}
      >
        {content}
      </span>
    </span>
  );
}
