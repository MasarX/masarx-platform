import * as React from "react";
import { cn } from "./utils";
import { formFieldClasses } from "./form-classes";

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Select dropdown styled with the shared form field classes.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn(formFieldClasses, className)} {...props}>
      {children}
    </select>
  )
);

Select.displayName = "Select";
