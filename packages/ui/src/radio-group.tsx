import * as React from "react";
import { cn } from "./utils";
import { radioClasses } from "./form-classes";

export type RadioGroupProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * Radio group container that stacks radio items by default.
 */
export function RadioGroup({ className, ...props }: RadioGroupProps) {
  return (
    <div
      role="radiogroup"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

export type RadioGroupItemProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Radio input styled to match form control sizing.
 */
export const RadioGroupItem = React.forwardRef<
  HTMLInputElement,
  RadioGroupItemProps
>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type={type ?? "radio"}
    className={cn(radioClasses, className)}
    {...props}
  />
));

RadioGroupItem.displayName = "RadioGroupItem";
