import * as React from "react";
import { cn } from "./utils";
import { formFieldClasses } from "./form-classes";

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
  errorMessage?: string | null;
};

/**
 * Select dropdown styled with the shared form field classes.
 * Supports inline error display via `invalid` and `errorMessage` props.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, invalid, errorMessage, id, "aria-describedby": describedBy, "aria-invalid": ariaInvalid, ...props }, ref) => {
    const generatedId = React.useId();
    const errorId = errorMessage ? `${id ?? generatedId}-error` : undefined;
    return (
      <>
        <select
          ref={ref}
          id={id}
          aria-invalid={invalid || errorMessage ? true : ariaInvalid}
          aria-describedby={[describedBy, errorId].filter(Boolean).join(" ") || undefined}
          className={cn(
            formFieldClasses,
            invalid && "border-[rgb(var(--ui-danger))] ring-1 ring-[rgb(var(--ui-danger)/0.2)]",
            className
          )}
          {...props}
        >
          {children}
        </select>
        {errorMessage ? (
          <p id={errorId} className="mt-1 text-xs text-[rgb(var(--ui-danger))]" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </>
    );
  }
);

Select.displayName = "Select";
