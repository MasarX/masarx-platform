"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "./utils";

export const Dropdown = DropdownMenu.Root;
export const DropdownTrigger = DropdownMenu.Trigger;

type DropdownContentProps = React.ComponentPropsWithoutRef<typeof DropdownMenu.Content>;

/**
 * Dropdown content panel with default spacing and shadow.
 */
export function DropdownContent({ className, ...props }: DropdownContentProps) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={cn(
          "min-w-[180px] rounded-xl border border-ui-border bg-ui-paper p-2 shadow-xl",
          className
        )}
        sideOffset={8}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

export function DropdownItem({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenu.Item>) {
  return (
    <DropdownMenu.Item
      className={cn(
        "flex cursor-pointer select-none items-center rounded-lg px-3 py-2 text-sm text-ui-ink outline-none focus:bg-ui-accent-soft",
        className
      )}
      {...props}
    />
  );
}

export function DropdownLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenu.Label>) {
  return (
    <DropdownMenu.Label
      className={cn("px-3 py-1 text-xs uppercase tracking-wide text-ui-muted", className)}
      {...props}
    />
  );
}

export function DropdownSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenu.Separator>) {
  return (
    <DropdownMenu.Separator
      className={cn("my-1 h-px bg-ui-border", className)}
      {...props}
    />
  );
}
