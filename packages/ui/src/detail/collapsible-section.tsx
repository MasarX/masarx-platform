"use client";

import * as React from "react";

type CollapsibleSectionProps = Omit<
  React.ComponentPropsWithoutRef<"details">,
  "defaultOpen" | "open"
> & {
  id: string;
  storagePrefix?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
};

function readCollapsed(storageKey: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function persistCollapsed(storageKey: string, collapsed: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, String(collapsed));
  } catch {
    // ignore storage failures
  }
}

/**
 * Wrapper around <details> that persists open/closed state to localStorage.
 */
export function CollapsibleSection({
  id,
  storagePrefix = "detail-section",
  defaultOpen = true,
  className,
  children,
  onToggle,
  ...props
}: CollapsibleSectionProps) {
  const storageKey = `${storagePrefix}:${id}`;
  const [open, setOpen] = React.useState(defaultOpen);

  React.useEffect(() => {
    const stored = readCollapsed(storageKey);
    setOpen(stored !== null ? !stored : defaultOpen);
  }, [defaultOpen, storageKey]);

  const handleToggle = React.useCallback(
    (event: React.ToggleEvent<HTMLDetailsElement>) => {
      const nextOpen = event.currentTarget.open;
      setOpen(nextOpen);
      persistCollapsed(storageKey, !nextOpen);
      onToggle?.(event);
    },
    [onToggle, storageKey]
  );

  return (
    <details
      {...props}
      open={open}
      onToggle={handleToggle}
      className={className}
    >
      {children}
    </details>
  );
}
