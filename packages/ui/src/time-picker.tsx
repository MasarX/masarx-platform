"use client";

import * as React from "react";
import { cn } from "./utils";
import { formFieldClasses } from "./form-classes";

export type TimePickerProps = {
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
  ariaLabel?: string;
  min?: string;
  max?: string;
  step?: number;
};

/**
 * Time input component styled with shared form field classes.
 */
export const TimePicker = React.forwardRef<HTMLInputElement, TimePickerProps>(
  (
    { value, onChange, disabled, name, id, className, ariaLabel, min, max, step },
    ref
  ) => (
    <input
      ref={ref}
      type="time"
      id={id}
      name={name}
      value={value ?? ""}
      onChange={(event) => onChange?.(event.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      className={cn(formFieldClasses, className)}
    />
  )
);

TimePicker.displayName = "TimePicker";
