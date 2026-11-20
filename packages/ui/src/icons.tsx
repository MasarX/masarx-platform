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

/* ── Status icons for accessible badges ── */

/** Checkmark icon for success/active/healthy/delivered statuses. */
export function StatusCheckIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 16 16"
      className={cn("h-3 w-3", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3 8.5l3.5 3.5 6.5-8" />
    </svg>
  );
}

/** Clock icon for warning/pending/processing statuses. */
export function StatusClockIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 16 16"
      className={cn("h-3 w-3", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

/** X icon for error/failed/cancelled statuses. */
export function StatusXIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 16 16"
      className={cn("h-3 w-3", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4 4l8 8" />
      <path d="M12 4l-8 8" />
    </svg>
  );
}

/** Arrow icon for info/in_transit statuses. */
export function StatusArrowIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 16 16"
      className={cn("h-3 w-3", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3 8h10" />
      <path d="M9 4l4 4-4 4" />
    </svg>
  );
}

/* ── Section icons for sidebar navigation ── */

/**
 * SVG path data keyed by icon name.
 * Each entry is rendered inside a 24x24 viewBox with stroke styling.
 */
const SECTION_ICON_PATHS: Record<string, React.ReactNode> = {
  home: (
    <>
      <path d="M3 9.5L12 3l9 6.5" />
      <path d="M5 10v8a1 1 0 001 1h4v-5h4v5h4a1 1 0 001-1v-8" />
    </>
  ),
  workflow: (
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M7 6h10" />
      <path d="M5 8v4a2 2 0 002 2h3" />
      <path d="M19 8v4a2 2 0 01-2 2h-3" />
    </>
  ),
  truck: (
    <>
      <path d="M1 3h15v13H1z" />
      <path d="M16 8h4l3 3v5h-7V8z" />
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 -2.83 2.83l-.06-.06a1.65 1.65 0 0 0 -1.82-.33 1.65 1.65 0 0 0 -1 1.51V21a2 2 0 0 1 -4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0 -1.82.33l-.06.06a2 2 0 0 1 -2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0 -1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0 -.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0 -1.51 1z" />
    </>
  ),
  shield: (
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  ),
  activity: (
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  ),
  plug: (
    <>
      <path d="M12 22v-5" />
      <path d="M9 7V2" />
      <path d="M15 7V2" />
      <path d="M6 13V7h12v6a4 4 0 01-4 4h-4a4 4 0 01-4-4z" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 21v-7" />
      <path d="M4 10V3" />
      <path d="M12 21v-9" />
      <path d="M12 8V3" />
      <path d="M20 21v-5" />
      <path d="M20 12V3" />
      <path d="M1 14h6" />
      <path d="M9 8h6" />
      <path d="M17 16h6" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </>
  ),
  tag: (
    <>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </>
  ),
  store: (
    <>
      <path d="M3 9l1.5-5h15L21 9" />
      <path d="M3 9h18v12a1 1 0 01-1 1H4a1 1 0 01-1-1V9z" />
      <path d="M9 21V14h6v7" />
      <path d="M3 9c0 1.1.9 2 2 2s2-.9 2-2" />
      <path d="M7 9c0 1.1.9 2 2 2s2-.9 2-2" />
      <path d="M11 9c0 1.1.9 2 2 2s2-.9 2-2" />
      <path d="M15 9c0 1.1.9 2 2 2s2-.9 2-2" />
    </>
  ),
  package: (
    <>
      <path d="M16.5 9.4l-9-5.19" />
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <path d="M3.27 6.96L12 12.01l8.73-5.05" />
      <path d="M12 22.08V12" />
    </>
  ),
  "alert-triangle": (
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
  ),
  clipboard: (
    <>
      <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </>
  ),
};

/** Renders a small inline icon for sidebar section headers. */
export function SectionIcon({
  name,
  className,
  ...props
}: { name: string } & IconProps) {
  const paths = SECTION_ICON_PATHS[name];
  if (!paths) return null;
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 24 24"
      className={cn("h-3.5 w-3.5 shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths}
    </svg>
  );
}
