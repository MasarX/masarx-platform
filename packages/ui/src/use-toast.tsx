"use client";

import * as React from "react";
import { Toast, ToastAction as ToastActionPrimitive, ToastClose, ToastDescription, ToastProvider, ToastTitle } from "./toast";
import { createUiTranslator } from "./i18n";
import { cn } from "./utils";

export type ToastTone = "neutral" | "success" | "error" | "warning" | "info";

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type ToastOptions = {
  id?: string;
  title?: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
  action?: ToastAction;
};

type ToastItem = ToastOptions & { id: string };

type ToastContextValue = {
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);
const DEFAULT_DURATION_MS = 5000;

function createToastId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `toast_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function resolveToneStyles(tone?: ToastTone) {
  switch (tone) {
    case "success":
      return { borderColor: "rgb(var(--ui-success))" };
    case "error":
      return { borderColor: "rgb(var(--ui-danger))" };
    case "warning":
      return { borderColor: "rgb(var(--ui-warning))" };
    case "info":
      return { borderColor: "rgb(var(--ui-info))" };
    default:
      return { borderColor: "rgb(var(--ui-border))" };
  }
}

export function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastHost");
  }
  return context;
}

/**
 * Toast host that manages queue, timers, and dismissal.
 */
export function ToastHost({ children }: { children: React.ReactNode }) {
  const t = createUiTranslator("ui.toast");
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const timersRef = React.useRef(new Map<string, number>());

  const dismiss = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = React.useCallback(
    (options: ToastOptions) => {
      const id = options.id ?? createToastId();
      const durationMs =
        options.durationMs === undefined ? DEFAULT_DURATION_MS : options.durationMs;
      setToasts((prev) => [...prev, { ...options, id }]);
      if (durationMs > 0) {
        const timer = window.setTimeout(() => dismiss(id), durationMs);
        timersRef.current.set(id, timer);
      }
      return id;
    },
    [dismiss]
  );

  React.useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const contextValue = React.useMemo(
    () => ({
      toast,
      dismiss,
    }),
    [toast, dismiss]
  );

  return (
    <ToastProvider>
      <ToastContext.Provider value={contextValue}>
        {children}
        {toasts.map((item) => (
          <Toast
            key={item.id}
            data-tone={item.tone ?? "neutral"}
            className={cn("ui-toast")}
            style={resolveToneStyles(item.tone)}
            onOpenChange={(open) => {
              if (!open) dismiss(item.id);
            }}
          >
            <div className="space-y-1">
              {item.title ? <ToastTitle>{item.title}</ToastTitle> : null}
              {/* Error fallbacks reuse the title as description; show that text once. */}
              {item.description && item.description !== item.title ? (
                <ToastDescription>{item.description}</ToastDescription>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {item.action ? (
                <ToastActionPrimitive
                  altText={item.action.label}
                  className="rounded-md bg-ui-accent px-2 py-1 text-xs font-medium text-ui-accent-ink hover:bg-ui-accent-hover"
                  onClick={item.action.onClick}
                >
                  {item.action.label}
                </ToastActionPrimitive>
              ) : null}
              <ToastClose className="text-xs text-ui-muted">
                {t("dismiss")}
              </ToastClose>
            </div>
          </Toast>
        ))}
      </ToastContext.Provider>
    </ToastProvider>
  );
}
