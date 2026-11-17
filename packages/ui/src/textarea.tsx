import * as React from "react";
import { cn } from "./utils";
import { formFieldClasses } from "./form-classes";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/**
 * Multiline textarea styled with the shared form field classes.
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(formFieldClasses, className)} {...props} />
  )
);

Textarea.displayName = "Textarea";
