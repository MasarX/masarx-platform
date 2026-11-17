"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "./utils";

export const Modal = Dialog.Root;
export const ModalTrigger = Dialog.Trigger;
export const ModalClose = Dialog.Close;

type ModalContentProps = React.ComponentPropsWithoutRef<typeof Dialog.Content>;

/**
 * Modal content wrapper with overlay and centered panel.
 */
export function ModalContent({ className, children, ...props }: ModalContentProps) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm motion-safe:animate-fade-in" />
      <Dialog.Content
        className={cn(
          "fixed left-1/2 top-1/2 w-[90vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-ui-border bg-ui-surface p-6 shadow-soft motion-safe:animate-scale-in",
          className
        )}
        {...props}
      >
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

export function ModalHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-2", className)} {...props} />;
}

export function ModalTitle(props: React.ComponentPropsWithoutRef<typeof Dialog.Title>) {
  return <Dialog.Title className="text-lg font-semibold text-ui-ink" {...props} />;
}

export function ModalDescription(
  props: React.ComponentPropsWithoutRef<typeof Dialog.Description>
) {
  return <Dialog.Description className="text-sm text-ui-muted" {...props} />;
}

export function ModalBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-sm text-ui-ink", className)} {...props} />;
}

export function ModalFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-wrap justify-end gap-3", className)} {...props} />;
}
