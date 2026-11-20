"use client";

import type { ToastOptions } from "./use-toast";

type MutationToastOptions = {
  successMessage?: string;
  errorMessage?: string;
  onRetry?: () => void;
};

type ToastFn = (options: ToastOptions) => string;

/**
 * Wraps an async mutation promise with success/error toasts.
 *
 * On success: shows a green toast with the successMessage.
 * On error: shows a red toast with the errorMessage, the error detail,
 *           and a "Copy details" hint in the description.
 *
 * Usage with useToast():
 *   const { toast } = useToast();
 *   await withMutationToast(toast, myAsyncFn(), { successMessage: "Saved!" });
 */
export async function withMutationToast<T>(
  toast: ToastFn,
  promise: Promise<T>,
  options: MutationToastOptions = {}
): Promise<T> {
  const {
    successMessage = "Operation completed successfully",
    errorMessage = "Operation failed",
    onRetry,
  } = options;

  try {
    const result = await promise;
    toast({
      title: successMessage,
      tone: "success",
    });
    return result;
  } catch (err: unknown) {
    const detail =
      err instanceof Error ? err.message : String(err);
    toast({
      title: errorMessage,
      description: detail,
      tone: "error",
      durationMs: 10000,
      action: onRetry ? { label: "Retry", onClick: onRetry } : undefined,
    });
    throw err;
  }
}
