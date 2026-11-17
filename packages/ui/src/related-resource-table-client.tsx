"use client";

import * as React from "react";
import type { UiReadReorder } from "@masarx/api";
import { createUiClient } from "@masarx/api";
import { Button } from "./button";
import { ResourceTable, type ResourceColumn } from "./resource-table";
import { createUiTranslator } from "./i18n";
import { useToast } from "./use-toast";
import { cn, formatUiError } from "./utils";
import { formatIdValue, resolveRecordLabel } from "./resource-utils";
import { moveItem } from "./table/list-utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";

type RelatedResourceTableClientProps = {
  resourceKey: string;
  columns: ResourceColumn[];
  items: Record<string, unknown>[];
  idKey: string;
  baseHref: string;
  appBasePath: string;
  emptyMessage?: string | null;
  reorder?: UiReadReorder | null;
  capabilities?: string[] | null;
  capabilityWrite?: string | null;
  testIdPrefix?: string | null;
};

function resolveItemId(item: Record<string, unknown>, idKey: string) {
  const raw = item[idKey];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

function resolveItemTitle(item: Record<string, unknown>, idKey: string) {
  const operationName = item.operation_name;
  if (typeof operationName === "string") {
    const trimmed = operationName.trim();
    if (trimmed) return trimmed;
  }
  const label = resolveRecordLabel(item);
  if (label) return label;
  const id = resolveItemId(item, idKey);
  return id ? formatIdValue(id) : null;
}

export function RelatedResourceTableClient({
  resourceKey,
  columns,
  items,
  idKey,
  baseHref,
  appBasePath,
  emptyMessage,
  reorder,
  capabilities,
  capabilityWrite,
  testIdPrefix,
}: RelatedResourceTableClientProps) {
  const t = createUiTranslator("ui.resourcePage");
  const { toast } = useToast();
  const [mode, setMode] = React.useState<"table" | "reorder">("table");
  const [orderedItems, setOrderedItems] = React.useState<Record<string, unknown>[]>(() => items);
  const [saving, setSaving] = React.useState(false);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dragOverId, setDragOverId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setOrderedItems(items);
    setMode("table");
    setDraggingId(null);
    setDragOverId(null);
    setSaving(false);
  }, [items]);

  const reorderColumn = reorder?.order_column?.trim() || null;
  const reorderEnabled = Boolean(reorderColumn);
  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities),
    [capabilities]
  );
  const reorderCapability = reorder?.capability?.trim() || capabilityWrite?.trim() || null;
  const reorderAllowed = hasCapability(capabilitySet, reorderCapability);

  const resolvedIds = React.useMemo(() => {
    const ids: string[] = [];
    orderedItems.forEach((item) => {
      const resolved = resolveItemId(item, idKey);
      if (!resolved) return;
      ids.push(resolved);
    });
    return ids;
  }, [orderedItems, idKey]);

  const canReorder =
    reorderEnabled &&
    reorderAllowed &&
    orderedItems.length > 1 &&
    resolvedIds.length === orderedItems.length;

  const handleOpenReorder = React.useCallback(() => {
    setMode("reorder");
  }, []);

  const handleCancelReorder = React.useCallback(() => {
    setOrderedItems(items);
    setMode("table");
    setDraggingId(null);
    setDragOverId(null);
  }, [items]);

  const handleDragStart = React.useCallback(
    (rowId: string) => (event: React.DragEvent) => {
      if (!canReorder) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", rowId);
      setDraggingId(rowId);
    },
    [canReorder]
  );

  const handleDragOver = React.useCallback(
    (rowId: string) => (event: React.DragEvent) => {
      if (!canReorder) return;
      if (!draggingId || draggingId === rowId) return;
      event.preventDefault();
      setDragOverId(rowId);
    },
    [canReorder, draggingId]
  );

  const handleDrop = React.useCallback(
    (rowId: string) => (event: React.DragEvent) => {
      if (!canReorder) return;
      event.preventDefault();
      const sourceId =
        draggingId || event.dataTransfer.getData("text/plain") || "";
      if (!sourceId || sourceId === rowId) return;

      setOrderedItems((current) => {
        const fromIndex = current.findIndex(
          (item) => resolveItemId(item, idKey) === sourceId
        );
        const toIndex = current.findIndex(
          (item) => resolveItemId(item, idKey) === rowId
        );
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;
        return moveItem(current, fromIndex, toIndex);
      });
      setDraggingId(null);
      setDragOverId(null);
    },
    [canReorder, draggingId, idKey]
  );

  const handleDragEnd = React.useCallback(() => {
    setDraggingId(null);
    setDragOverId(null);
  }, []);

  const handleMove = React.useCallback(
    (fromIndex: number, delta: number) => () => {
      if (!canReorder) return;
      setOrderedItems((current) => {
        const toIndex = fromIndex + delta;
        if (toIndex < 0 || toIndex >= current.length) return current;
        return moveItem(current, fromIndex, toIndex);
      });
    },
    [canReorder]
  );

  const handleSave = React.useCallback(async () => {
    if (!canReorder || !reorderColumn) return;
    const ui = createUiClient();
    setSaving(true);

    try {
      await ui.reorderResource({ resource: resourceKey, ids: resolvedIds });

      setOrderedItems((current) =>
        current.map((item, index) => ({
          ...item,
          [reorderColumn]: index + 1,
        }))
      );
      toast({
        title: t("detail.related.reorder.toast.success"),
        tone: "success",
      });
      setMode("table");
    } catch (error) {
      toast({
        title: t("detail.related.reorder.toast.error"),
        description: formatUiError(error, t("detail.related.reorder.toast.error")),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  }, [canReorder, reorderColumn, resourceKey, resolvedIds, t, toast]);

  if (mode === "reorder") {
    const resolvedTestIdPrefix = testIdPrefix?.trim() || "";

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-ui-muted">
            {t("detail.related.reorder.instructions")}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCancelReorder}
              disabled={saving}
            >
              {t("detail.related.reorder.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={!canReorder || saving}
              data-testid={
                resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-reorder-save` : undefined
              }
            >
              {saving ? t("detail.related.reorder.saving") : t("detail.related.reorder.save")}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {orderedItems.map((item, index) => {
            const rowId = resolveItemId(item, idKey) ?? `row-${index}`;
            const title = resolveItemTitle(item, idKey) ?? t("detail.related.reorder.untitled");
            const orderValueRaw =
              reorderColumn && typeof item[reorderColumn] !== "undefined"
                ? String(item[reorderColumn] ?? "")
                : "";
            const orderValue = orderValueRaw.trim();
            const isDragOver = draggingId && dragOverId === rowId;
            const isDragging = draggingId === rowId;

            return (
              <div
                key={rowId}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-xl border border-ui-border bg-ui-paper/60 p-3",
                  isDragOver ? "ring-2 ring-ui-border" : null,
                  isDragging ? "opacity-70" : null
                )}
                draggable={canReorder}
                onDragStart={handleDragStart(rowId)}
                onDragOver={handleDragOver(rowId)}
                onDrop={handleDrop(rowId)}
                onDragEnd={handleDragEnd}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ui-ink">{title}</span>
                    {orderValue ? (
                      <span className="rounded-full border border-ui-border bg-ui-surface px-2 py-0.5 text-[10px] text-ui-muted">
                        {orderValue}
                      </span>
                    ) : null}
                  </div>
                  {rowId ? (
                    <div className="text-xs text-ui-muted">{formatIdValue(rowId)}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 min-h-0 w-8 px-0 py-0"
                    onClick={handleMove(index, -1)}
                    disabled={saving || index === 0}
                    aria-label={t("detail.related.reorder.moveUp")}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 min-h-0 w-8 px-0 py-0"
                    onClick={handleMove(index, 1)}
                    disabled={saving || index === orderedItems.length - 1}
                    aria-label={t("detail.related.reorder.moveDown")}
                  >
                    ↓
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {canReorder ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleOpenReorder}
            data-testid={testIdPrefix ? `${testIdPrefix}-reorder-open` : undefined}
          >
            {t("detail.related.reorder.open")}
          </Button>
        ) : (
          <div />
        )}
        <a className="text-sm text-ui-ink underline underline-offset-4" href={baseHref}>
          {t("detail.related.openFullView")}
        </a>
      </div>
      <ResourceTable
        columns={columns}
        items={orderedItems}
        idKey={idKey}
        resourceKey={resourceKey}
        capabilities={capabilities ?? null}
        capabilityWrite={capabilityWrite ?? null}
        baseHref={baseHref}
        appBasePath={appBasePath}
        emptyMessage={emptyMessage ?? null}
        testIdPrefix={testIdPrefix}
      />
    </div>
  );
}
