import * as React from "react";
import { cn } from "./utils";
import { formFieldClasses } from "./form-classes";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  /** When true, renders the input with a danger border and aria-invalid. */
  invalid?: boolean;
  /** Error message displayed below the input. */
  errorMessage?: string | null;
};

/**
 * Text input styled with the shared form field classes.
 * Supports inline error display via `invalid` and `errorMessage` props.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", invalid, errorMessage, id, "aria-describedby": describedBy, "aria-invalid": ariaInvalid, ...props }, ref) => {
    const generatedId = React.useId();
    const errorId = errorMessage ? `${id ?? generatedId}-error` : undefined;
    return (
      <>
        <input
          ref={ref}
          type={type}
          id={id}
          aria-invalid={invalid || errorMessage ? true : ariaInvalid}
          aria-describedby={[describedBy, errorId].filter(Boolean).join(" ") || undefined}
          className={cn(
            formFieldClasses,
            invalid && "border-[rgb(var(--ui-danger))] ring-1 ring-[rgb(var(--ui-danger)/0.2)]",
            className
          )}
          {...props}
        />
        {errorMessage ? (
          <p id={errorId} className="mt-1 text-xs text-[rgb(var(--ui-danger))]" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </>
    );
  }
);

Input.displayName = "Input";
