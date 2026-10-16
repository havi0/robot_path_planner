import clsx from "clsx";
import { updatePrefs, usePrefs, type UiMode } from "../../lib/prefs";

/** Beginner / Advanced interface switch (UI only — training and simulation state are untouched). */
export function ModeSwitch({ className }: { className?: string }) {
  const { uiMode } = usePrefs();
  return (
    <div role="radiogroup" aria-label="Interface mode" className={clsx("inline-flex rounded-lg border border-line-strong bg-surface-2 p-0.5", className)}>
      {(["beginner", "advanced"] as UiMode[]).map((m) => (
        <button key={m} role="radio" aria-checked={uiMode === m} data-learn={m === "beginner" ? "mode-beginner" : "mode-advanced"}
          onClick={() => updatePrefs((p) => ({ ...p, uiMode: m }))}
          className={clsx("h-7 rounded-md px-2.5 text-[12px] font-medium transition-colors",
            uiMode === m ? "bg-surface-3 text-ink shadow-[0_0_0_1px_#2f3440]" : "text-ink-3 hover:text-ink-2")}>
          {m === "beginner" ? "Beginner" : "Advanced"}
        </button>
      ))}
    </div>
  );
}
