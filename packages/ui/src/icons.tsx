import * as React from "react";
import { cn } from "./utils";

type IconProps = Omit<React.SVGProps<SVGSVGElement>, "children"> & {
  className?: string;
};

export function ChevronDownIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-4 w-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M5 7l5 6 5-6" />
    </svg>
  );
}

export function ChevronUpIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-4 w-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M5 13l5-6 5 6" />
    </svg>
  );
}

export function ExternalLinkIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-4 w-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M8 4H5.5C4.7 4 4 4.7 4 5.5v9C4 15.3 4.7 16 5.5 16h9c.8 0 1.5-.7 1.5-1.5V12" />
      <path d="M11 4h5v5" />
      <path d="M10 10L16 4" />
    </svg>
  );
}

export function PinIcon({
  className,
  pressed = false,
  ...props
}: IconProps & { pressed?: boolean }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-4 w-4", className)}
      fill={pressed ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M8 3h4l1.5 5.2c.1.4 0 .8-.3 1.1L11 12v5l-1-1-1 1v-5L6.8 9.3c-.3-.3-.4-.7-.3-1.1L8 3z" />
    </svg>
  );
}

export function MinusIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-4 w-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4 10h12" />
    </svg>
  );
}

export function PlusIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-4 w-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M10 4v12" />
      <path d="M4 10h12" />
    </svg>
  );
}

export function ColumnTypeTextIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-3.5 w-3.5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4 6h12" />
      <path d="M10 6v10" />
      <path d="M7 16h6" />
    </svg>
  );
}

export function ColumnTypeNumberIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-3.5 w-3.5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M7 4l-2 12" />
      <path d="M15 4l-2 12" />
      <path d="M4 8h14" />
      <path d="M3 12h14" />
    </svg>
  );
}

export function ColumnTypeBooleanIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-3.5 w-3.5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <path d="M6.5 10l2.5 2.5 5-5" />
    </svg>
  );
}

export function ColumnTypeDateIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-3.5 w-3.5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="4" width="14" height="13" rx="2" />
      <path d="M3 8h14" />
      <path d="M7 2v4" />
      <path d="M13 2v4" />
    </svg>
  );
}

export function ColumnTypeSelectIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-3.5 w-3.5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M5.5 8l4.5 4.5L14.5 8" />
    </svg>
  );
}

export function ColumnTypeIdIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 20"
      className={cn("h-3.5 w-3.5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12.5 3l-5 14" />
      <path d="M5 8h10" />
      <path d="M5 12h10" />
    </svg>
  );
}
