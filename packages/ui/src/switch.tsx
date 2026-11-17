"use client";

import * as React from "react";
import { cn } from "./utils";
import { switchThumbClasses, switchTrackClasses } from "./form-classes";

export type SwitchProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
>;

/**
 * Toggle switch with 44px touch target and animated thumb.
 */
export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, disabled, ...props }, ref) => (
    <label
      className={cn(
        "inline-flex min-h-[44px] min-w-[44px] items-center justify-center",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        className
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        role="switch"
        className="peer sr-only"
        disabled={disabled}
        {...props}
      />
      <span className={switchTrackClasses} aria-hidden="true">
        <span className={switchThumbClasses} />
      </span>
    </label>
  )
);

Switch.displayName = "Switch";
