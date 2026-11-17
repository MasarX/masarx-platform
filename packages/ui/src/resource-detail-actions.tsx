"use client";
import * as React from "react";
import { ResourceBulkActions, type ResourceBulkActionsProps } from "./resource-bulk-actions";
import { useRouter } from "next/navigation";
import { useResourceListInvalidate } from "./hooks/use-resource-query";

type ResourceDetailActionsProps = {
  detailId: string | null;
  bulkActions: Omit<ResourceBulkActionsProps, "selectedIds"> | null;
};

export function ResourceDetailActions({
  detailId,
  bulkActions,
}: ResourceDetailActionsProps) {
  const resolvedId = detailId?.trim() ?? "";
  const router = useRouter();
  const invalidateResourceList = useResourceListInvalidate(bulkActions?.resourceKey ?? "");
  const onSuccess = bulkActions?.onSuccess;
  const handleSuccess = React.useCallback<NonNullable<ResourceBulkActionsProps["onSuccess"]>>(
    async (input) => {
      try {
        await onSuccess?.(input);
      } finally {
        try {
          await invalidateResourceList();
        } finally {
          router.refresh();
        }
      }
    },
    [invalidateResourceList, onSuccess, router],
  );
  if (!resolvedId || !bulkActions) return null;
  return <ResourceBulkActions {...bulkActions} selectedIds={[resolvedId]} onSuccess={handleSuccess} />;
}
