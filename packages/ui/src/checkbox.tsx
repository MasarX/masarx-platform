import * as React from "react";
import { cn } from "./utils";
import { checkboxClasses } from "./form-classes";

export type CheckboxProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Checkbox input with 44px touch target and themed accent.
 */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type ?? "checkbox"}
      className={cn(checkboxClasses, className)}
      {...props}
    />
  )
);

Checkbox.displayName = "Checkbox";
