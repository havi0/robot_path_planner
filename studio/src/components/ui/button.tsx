import clsx from "clsx";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "icon";

const variants: Record<Variant, string> = {
  primary:
    "bg-[linear-gradient(180deg,#9b8eff,#7b6cf0)] text-white hover:brightness-110 active:brightness-95 shadow-[inset_0_1px_0_#ffffff40,0_0_0_1px_#8b7cf6,0_8px_22px_-8px_#8b7cf6b3]",
  secondary: "bg-[linear-gradient(180deg,#22252f,#1a1d25)] text-ink border border-line-strong shadow-[inset_0_1px_0_#ffffff0d,0_4px_12px_-8px_#000] hover:border-[#424857] hover:brightness-110 active:brightness-95",
  outline: "bg-transparent text-ink-2 border border-line-strong hover:text-ink hover:border-[#3d4350] hover:bg-surface-2",
  ghost: "bg-transparent text-ink-2 hover:text-ink hover:bg-surface-3 active:bg-surface-2",
  danger: "bg-bad/90 text-white hover:bg-bad active:bg-[#d23f3c] shadow-[0_6px_20px_-8px_#f0524faa]",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1.5 rounded-md",
  md: "h-8 px-3 text-[13px] gap-2 rounded-lg",
  lg: "h-10 px-4 text-[14px] gap-2 rounded-lg",
  icon: "h-8 w-8 rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  active?: boolean;
}

export function Button({ variant = "secondary", size = "md", loading, icon, active, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background,color,border,transform,box-shadow] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-40",
        variants[variant],
        sizes[size],
        active && "!bg-violet-soft !text-[#c4bcff] !border-[#8b7cf655]",
        className,
      )}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}
