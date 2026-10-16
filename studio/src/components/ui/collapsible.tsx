import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

/** Expandable section. Children stay mounted while closed, so form state is never lost. */
export function Collapsible({ title, description, defaultOpen = false, forceOpen = false, children, className }: {
  title: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = open || forceOpen;
  return (
    <div className={clsx("rounded-lg border border-line", className)}>
      <button type="button" onClick={() => setOpen(!shown)} aria-expanded={shown}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-ink">{title}</div>
          {description && <div className="text-[11.5px] text-ink-3">{description}</div>}
        </div>
        <ChevronDown className={clsx("h-4 w-4 shrink-0 text-ink-3 transition-transform", shown && "rotate-180")} />
      </button>
      <div hidden={!shown} className="border-t border-line p-3">{children}</div>
    </div>
  );
}
