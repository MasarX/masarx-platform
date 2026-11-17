import * as React from "react";
import { cn } from "./utils";
import { formFieldClasses } from "./form-classes";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Text input styled with the shared form field classes.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(formFieldClasses, className)}
      {...props}
    />
  )
);

Input.displayName = "Input";
