"use client";

import type * as React from "react";

export type RowOverrides = Record<string, Record<string, unknown>>;
export type SetRowOverrides = React.Dispatch<React.SetStateAction<RowOverrides>>;

type OptimisticPatchParams = {
  rowId: string;
  patch: Record<string, unknown>;
  setRowOverrides: SetRowOverrides;
};

type OptimisticRollbackParams = {
  rowId: string;
  snapshot: Record<string, unknown> | null;
  setRowOverrides: SetRowOverrides;
};

/**
 * Apply an optimistic patch to a row and return the prior snapshot for rollback.
 */
export function applyOptimisticRowPatch({
  rowId,
  patch,
  setRowOverrides,
}: OptimisticPatchParams): Record<string, unknown> | null {
  let snapshot: Record<string, unknown> | null = null;
  setRowOverrides((current) => {
    snapshot = current[rowId] ?? null;
    return {
      ...current,
      [rowId]: {
        ...(current[rowId] ?? {}),
        ...patch,
      },
    };
  });
  return snapshot;
}

/**
 * Roll back an optimistic patch using the captured snapshot.
 */
export function rollbackOptimisticRowPatch({
  rowId,
  snapshot,
  setRowOverrides,
}: OptimisticRollbackParams) {
  setRowOverrides((current) => {
    if (!snapshot) {
      const next = { ...current };
      delete next[rowId];
      return next;
    }
    return {
      ...current,
      [rowId]: snapshot,
    };
  });
}
