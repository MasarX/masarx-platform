import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "./utils";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
  variant?: "solid" | "ghost" | "soft";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
};

const sizeClasses = {
  sm: "px-3 py-1.5 text-sm min-h-[36px]",
  md: "px-4 py-2.5 text-sm min-h-[44px]",
  lg: "px-6 py-3 text-base min-h-[52px]",
};

/**
 * Button with solid/ghost variants, size presets, and optional loading state.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      asChild,
      variant = "solid",
      size = "md",
      loading = false,
      className,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";
    const content = asChild ? (
      children
    ) : (
      <>
        {loading ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
        ) : null}
        {children}
      </>
    );
    return (
      <Comp
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper",
          sizeClasses[size],
          variant === "solid"
            ? "bg-ui-accent text-ui-accent-ink shadow-sm hover:bg-ui-accent-hover"
            : variant === "soft"
              ? "bg-ui-accent-soft/50 text-ui-accent hover:bg-ui-accent-soft/80"
              : "bg-transparent text-ui-muted hover:bg-ui-highlight/70 hover:text-ui-ink",
          className
        )}
        aria-busy={loading || undefined}
        disabled={disabled || loading}
        {...props}
      >
        {content}
      </Comp>
    );
  }
);

Button.displayName = "Button";
