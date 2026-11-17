"use client";

import * as React from "react";

type DetailInlineEditState = {
  fieldKey: string;
  value: unknown;
  status: "idle" | "saving" | "error";
  error?: string | null;
} | null;

type UseDetailInlineEditParams = {
  resourceKey: string | null;
  recordId: string | null;
  onUpdate: (patch: Record<string, unknown>) => Promise<void>;
};

export function useDetailInlineEdit({
  resourceKey,
  recordId,
  onUpdate,
}: UseDetailInlineEditParams) {
  const [editState, setEditState] = React.useState<DetailInlineEditState>(null);

  const startEdit = React.useCallback((fieldKey: string, value: unknown) => {
    setEditState({ fieldKey, value, status: "idle", error: null });
  }, []);

  const cancelEdit = React.useCallback(() => {
    setEditState(null);
  }, []);

  const commitEdit = React.useCallback(
    async (fieldKey: string, value: unknown) => {
      if (!resourceKey || !recordId) return;
      setEditState((current) =>
        current ? { ...current, status: "saving", error: null } : current
      );
      try {
        await onUpdate({ [fieldKey]: value });
        setEditState(null);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Update failed";
        setEditState((current) =>
          current ? { ...current, status: "error", error: message } : current
        );
      }
    },
    [onUpdate, recordId, resourceKey]
  );

  return {
    editState,
    startEdit,
    cancelEdit,
    commitEdit,
    isEditing: editState !== null,
    editingField: editState?.fieldKey ?? null,
  };
}
