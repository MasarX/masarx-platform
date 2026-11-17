"use client";

import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { cn } from "./utils";

type ToastProviderProps = React.ComponentPropsWithoutRef<typeof ToastPrimitive.Provider>;

/**
 * Toast provider with default viewport placement.
 */
export function ToastProvider({ children, ...props }: ToastProviderProps) {
  return (
    <ToastPrimitive.Provider swipeDirection="right" {...props}>
      {children}
      <ToastViewport />
    </ToastPrimitive.Provider>
  );
}

export const ToastTitle = ToastPrimitive.Title;
export const ToastDescription = ToastPrimitive.Description;
export const ToastClose = ToastPrimitive.Close;

export function ToastViewport({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      className={cn(
        "fixed bottom-4 right-4 z-50 flex w-[320px] flex-col gap-2 outline-none",
        className
      )}
      {...props}
    />
  );
}

export function Toast({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root>) {
  return (
    <ToastPrimitive.Root
      className={cn(
        "ui-toast rounded-xl border border-ui-border bg-ui-paper p-4 text-sm text-ui-ink shadow-xl",
        className
      )}
      {...props}
    />
  );
}
