"use client";

import * as React from "react";
import Link from "next/link";
import { createUiClient } from "@masarx/api";
import type { ResourceColumn } from "./table/columns";
import { resolveColumnLabel } from "./table/columns";
import { formatResourceValue } from "./resource-utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { CopyFieldButton } from "./detail/copy-field-button";
import { DetailFieldEditor } from "./detail/detail-field-editor";
import { useDetailInlineEdit } from "./detail/use-detail-inline-edit";
import { createUiTranslator } from "./i18n";
import { Button } from "./button";
import {
  normalizeEditOptions,
  resolveEditOptionDisplayValue,
} from "./edit-option-utils";

type RelatedResourceInlineDetailProps = {
  resourceKey: string;
  columns: ResourceColumn[];
  item: Record<string, unknown> | null;
  idKey: string;
  baseHref: string;
  capabilities?: string[] | null;
  capabilityWrite?: string | null;
  testIdPrefix?: string | null;
};

function resolveRecordId(
  item: Record<string, unknown>,
  idKey: string
): string | null {
  const raw = item[idKey];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

export function RelatedResourceInlineDetail({
  resourceKey,
  columns,
  item,
  idKey,
  baseHref,
  capabilities,
  capabilityWrite,
  testIdPrefix,
}: RelatedResourceInlineDetailProps) {
  const t = createUiTranslator("ui");

  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities),
    [capabilities]
  );
  const writeAllowed = Boolean(capabilityWrite && hasCapability(capabilitySet, capabilityWrite));

  const recordId = item ? resolveRecordId(item, idKey) : null;

  const handleUpdate = React.useCallback(
    async (patch: Record<string, unknown>) => {
      if (!recordId) return;
      const ui = createUiClient();
      await ui.updateResource({ resource: resourceKey, id: recordId, patch });
    },
    [resourceKey, recordId]
  );

  const { editState, startEdit, cancelEdit, commitEdit, editingField } =
    useDetailInlineEdit({
      resourceKey,
      recordId,
      onUpdate: handleUpdate,
    });

  const resolvedTestId = testIdPrefix?.trim() || null;

  if (!item) {
    return (
      <div
        className="rounded-xl border border-ui-border bg-ui-surface/60 p-4 text-center text-sm text-ui-muted"
        data-testid={resolvedTestId ? `${resolvedTestId}-inline-detail-empty` : undefined}
      >
        {t("resourcePage.detail.related.empty")}
      </div>
    );
  }

  return (
    <div
      className="space-y-3"
      data-testid={resolvedTestId ? `${resolvedTestId}-inline-detail` : undefined}
    >
      <div className="rounded-xl border border-ui-border bg-ui-surface/60 p-4">
        <dl className="grid gap-3 sm:grid-cols-2">
          {columns.map((column) => {
            const key = column.key;
            const rawValue = item[key];
            const editOptions = normalizeEditOptions(column.editOptions);
            const optionDisplayValue = resolveEditOptionDisplayValue(
              rawValue,
              editOptions
            );
            const fallbackDisplayValue = formatResourceValue(rawValue, {
              renderType: column.renderType ?? null,
              formatOptions: column.formatOptions ?? null,
            });
            const displayValue = optionDisplayValue ?? fallbackDisplayValue;
            const label = resolveColumnLabel(column);
            const isEditing = editingField === key;
            const hasLookupOptions = editOptions.length > 0;
            const isEditable =
              writeAllowed &&
              column.editMode === "inline" &&
              key !== "id" &&
              (!key.endsWith("_id") || hasLookupOptions);

            if (isEditing && editState) {
              return (
                <div key={key} className="py-2 sm:col-span-2">
                  <DetailFieldEditor
                    fieldKey={key}
                    label={label}
                    editType={column.editType ?? "text"}
                    value={rawValue}
                    options={editOptions}
                    saving={editState.status === "saving"}
                    error={editState.error}
                    onSave={commitEdit}
                    onCancel={cancelEdit}
                  />
                </div>
              );
            }

            return (
              <div key={key} className="group/field relative py-2">
                <dt className="text-xs font-medium text-ui-muted">{label}</dt>
                <dd
                  className="mt-2 flex items-start gap-1 text-sm text-ui-ink"
                >
                  <span className="min-w-0 flex-1">{displayValue}</span>
                  <div className="flex items-center gap-1">
                    {displayValue && displayValue !== "-" ? (
                      <CopyFieldButton value={displayValue} label={label} />
                    ) : null}
                    {isEditable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-6 px-2 text-[10px] opacity-0 transition group-hover/field:opacity-100 focus-visible:opacity-100"
                        onClick={() => startEdit(key, rawValue)}
                      >
                        {t("resourceTable.contextMenu.edit")}
                      </Button>
                    ) : null}
                  </div>
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
      <div className="flex justify-end">
        <Link
          className="text-sm text-ui-ink underline underline-offset-4"
          href={baseHref}
        >
          {t("resourcePage.detail.related.openFullView")}
        </Link>
      </div>
    </div>
  );
}
