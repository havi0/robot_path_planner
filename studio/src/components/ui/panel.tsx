import clsx from "clsx";
import type { ReactNode } from "react";

export function Panel({ title, eyebrow, actions, children, className, bodyClassName, dense }: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  dense?: boolean;
}) {
  return (
    <section className={clsx("panel flex min-w-0 flex-col", className)}>
      {(title || actions || eyebrow) && (
        <header className={clsx("flex items-center justify-between gap-3 border-b border-line", dense ? "px-3 py-2" : "px-4 py-3")}>
          <div className="min-w-0">
            {eyebrow && <div className="eyebrow mb-0.5">{eyebrow}</div>}
            {title && <h3 className="truncate text-[13px] font-semibold tracking-tight text-ink">{title}</h3>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={clsx(dense ? "p-3" : "p-4", "min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

export function KeyValue({ label, value, mono = true, tone }: { label: ReactNode; value: ReactNode; mono?: boolean; tone?: "good" | "bad" | "warn" | "muted" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[5px]">
      <span className="text-[12px] text-ink-3">{label}</span>
      <span
        className={clsx(
          "truncate text-right text-[12.5px]",
          mono && "mono",
          tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "muted" ? "text-ink-3" : "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}
