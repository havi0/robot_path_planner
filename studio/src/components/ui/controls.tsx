import clsx from "clsx";
import { Info } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Tooltip } from "./feedback";

export function Field({ label, hint, error, children, inline }: { label: string; hint?: string; error?: string | null; children: ReactNode; inline?: boolean }) {
  return (
    <label className={clsx("block", inline && "flex items-center justify-between gap-3")}>
      <span className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-ink-2">
        {label}
        {hint && (
          <Tooltip content={hint}>
            <Info className="h-3 w-3 text-ink-3" />
          </Tooltip>
        )}
      </span>
      {children}
      {error && <span className="mt-1 block text-[11px] text-bad">{error}</span>}
    </label>
  );
}

const inputCls =
  "mono h-8 w-full rounded-lg border border-line-strong bg-surface-2 px-2.5 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-[#3a404c] focus:border-violet focus:bg-surface-3 disabled:opacity-40";

/** Numeric input that keeps the user's text while typing and reports parse/range errors. */
export function NumberInput({ value, onChange, min, max, step, disabled, placeholder, allowEmpty, integer }: {
  value: number | null;
  onChange: (v: number | null, valid: boolean) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  placeholder?: string;
  allowEmpty?: boolean;
  integer?: boolean;
}) {
  const [text, setText] = useState(value === null || value === undefined ? "" : String(value));
  const [err, setErr] = useState(false);
  useEffect(() => {
    const parsed = text.trim() === "" ? null : Number(text);
    if (parsed !== value) setText(value === null || value === undefined ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      inputMode="decimal"
      className={clsx(inputCls, err && "!border-bad")}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      step={step}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === "" && allowEmpty) {
          setErr(false);
          onChange(null, true);
          return;
        }
        const n = Number(t);
        const ok = t.trim() !== "" && Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max) && (!integer || Number.isInteger(n));
        setErr(!ok);
        onChange(Number.isFinite(n) ? n : null, ok);
      }}
    />
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputCls, "font-sans", props.className)} />;
}

export function Select<T extends string>({ value, onChange, options, disabled }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={clsx(inputCls, "cursor-pointer appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%236c7380%22 stroke-width=%222%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-[length:12px] bg-[right_8px_center] bg-no-repeat pr-7 font-sans")}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} className="bg-surface-2">
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({ checked, onChange, label, disabled, description }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; description?: ReactNode }) {
  const id = useId();
  return (
    <div className={clsx("flex items-center justify-between gap-3", disabled && "opacity-40")}>
      {label && (
        <label htmlFor={id} className="cursor-pointer">
          <div className="text-[12.5px] text-ink">{label}</div>
          {description && <div className="text-[11.5px] text-ink-3">{description}</div>}
        </label>
      )}
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx("relative h-[18px] w-8 shrink-0 rounded-full border transition-colors duration-150", checked ? "border-violet bg-violet" : "border-line-strong bg-surface-3")}
      >
        <span className={clsx("absolute top-[2px] h-3 w-3 rounded-full bg-white shadow transition-transform duration-150", checked ? "translate-x-[15px]" : "translate-x-[2px]")} />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = "md" }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  size?: "sm" | "md";
}) {
  return (
    <div role="tablist" className="inline-flex rounded-lg border border-line-strong bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx(
            "inline-flex items-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35",
            size === "sm" ? "h-6 px-2 text-[11.5px]" : "h-7 px-2.5 text-[12px]",
            value === o.value ? "bg-surface-3 text-ink shadow-[0_0_0_1px_#2f3440]" : "text-ink-3 hover:text-ink-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, step, onChange, format }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-[#8b7cf6]"
      />
      <span className="mono w-14 text-right text-[12px] text-ink-2">{format ? format(value) : value}</span>
    </div>
  );
}
