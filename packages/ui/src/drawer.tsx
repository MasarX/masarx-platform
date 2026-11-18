"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "./utils";

export const Drawer = Dialog.Root;
export const DrawerTrigger = Dialog.Trigger;
export const DrawerClose = Dialog.Close;

type DrawerContentProps = React.ComponentPropsWithoutRef<typeof Dialog.Content> & {
  side?: "left" | "right";
};

/**
 * Drawer content wrapper with overlay and side position.
 */
export function DrawerContent({
  className,
  children,
  side = "right",
  ...props
}: DrawerContentProps) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/55 backdrop-blur-sm motion-safe:animate-fade-in" />
      <Dialog.Content
        className={cn(
          "fixed inset-y-0 z-[90] w-full max-w-md overflow-y-auto border border-ui-border bg-ui-paper p-6 shadow-2xl motion-safe:animate-slide-up",
          side === "left" ? "left-0" : "right-0",
          className
        )}
        {...props}
      >
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

export function DrawerHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-2", className)} {...props} />;
}

export function DrawerTitle(
  props: React.ComponentPropsWithoutRef<typeof Dialog.Title>
) {
  return <Dialog.Title className="text-lg font-semibold text-ui-ink" {...props} />;
}

export function DrawerDescription(
  props: React.ComponentPropsWithoutRef<typeof Dialog.Description>
) {
  return <Dialog.Description className="text-sm text-ui-muted" {...props} />;
}

export function DrawerBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-sm text-ui-ink", className)} {...props} />;
}

export function DrawerFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-wrap justify-end gap-3", className)} {...props} />;
}
