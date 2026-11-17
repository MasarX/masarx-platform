"use client";
import * as React from "react";
import { ResourceBulkActions, type ResourceBulkActionsProps } from "./resource-bulk-actions";

type ResourceDetailActionsProps = {
  detailId: string | null;
  bulkActions: Omit<ResourceBulkActionsProps, "selectedIds"> | null;
};

export function ResourceDetailActions({
  detailId,
  bulkActions,
}: ResourceDetailActionsProps) {
  const resolvedId = detailId?.trim() ?? "";
  if (!resolvedId || !bulkActions) return null;
  return <ResourceBulkActions {...bulkActions} selectedIds={[resolvedId]} />;
}
