"use client";

import * as React from "react";

type DeleteState = {
  isPending: boolean;
  error: string | null;
  confirmOpen: boolean;
  openConfirm: () => void;
  closeConfirm: () => void;
  executeDelete: () => Promise<void>;
};

type UseResourceDeleteOptions = {
  resourceKey: string;
  recordId: string | null;
  recordLabel?: string | null;
  onDelete: (resource: string, id: string) => Promise<void>;
  onSuccess?: () => void;
};

/**
 * Hook for resource deletion with confirmation state management.
 * Returns confirm dialog state and delete execution.
 *
 * Usage:
 *   const del = useResourceDelete({
 *     resourceKey: "shipments",
 *     recordId: id,
 *     onDelete: (resource, id) => ui.deleteResource({ resource, id }),
 *     onSuccess: () => router.push("/resources/shipments"),
 *   });
 *
 *   <button onClick={del.openConfirm}>Delete</button>
 *   <ConfirmDialog open={del.confirmOpen} onConfirm={del.executeDelete} ... />
 */
export function useResourceDelete({
  resourceKey,
  recordId,
  onDelete,
  onSuccess,
}: UseResourceDeleteOptions): DeleteState {
  const [isPending, setIsPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const openConfirm = React.useCallback(() => setConfirmOpen(true), []);
  const closeConfirm = React.useCallback(() => setConfirmOpen(false), []);

  const executeDelete = React.useCallback(async () => {
    if (!recordId) return;
    setIsPending(true);
    setError(null);
    try {
      await onDelete(resourceKey, recordId);
      setConfirmOpen(false);
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setIsPending(false);
    }
  }, [resourceKey, recordId, onDelete, onSuccess]);

  return {
    isPending,
    error,
    confirmOpen,
    openConfirm,
    closeConfirm,
    executeDelete,
  };
}
