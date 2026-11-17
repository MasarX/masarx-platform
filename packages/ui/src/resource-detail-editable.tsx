"use client";

import * as React from "react";
import { EmptyState } from "./empty-state";
import { CollapsibleSection } from "./detail/collapsible-section";
import { CopyFieldButton } from "./detail/copy-field-button";
import { DetailFieldEditor } from "./detail/detail-field-editor";
import { useDetailInlineEdit } from "./detail/use-detail-inline-edit";
import {
  buildDetailSections,
  type ResourceDetailColumn,
} from "./detail/detail-sections";
import { resolveDisplayIdentifier } from "./display-identifiers";
import {
  formatDisplayIdentifierValue,
  formatIdValue,
  formatReferenceValue,
  resolveRecordDescriptor,
} from "./resource-utils";
import { getUiDefaults } from "@masarx/config";
import { createUiTranslator } from "./i18n";
import { Button } from "./button";
import { cn } from "./utils";

const uiDefaults = getUiDefaults();

type ResourceDetailEditableProps = {
  title?: string;
  data?: Record<string, unknown> | null;
  emptyMessage?: string;
  columns?: ResourceDetailColumn[] | null;
  showInternalIdHints?: boolean;
  resourceKey?: string | null;
  recordId?: string | null;
  onUpdate: (patch: Record<string, unknown>) => Promise<void>;
  testIdPrefix?: string | null;
};

export function ResourceDetailEditable({
  title,
  data,
  emptyMessage,
  columns,
  showInternalIdHints,
  resourceKey = null,
  recordId = null,
  onUpdate,
  testIdPrefix,
}: ResourceDetailEditableProps) {
  const t = createUiTranslator("ui.resourceDetail");
  const resolvedTitle = title ?? t("title");
  const resolvedEmptyMessage = emptyMessage ?? t("emptyMessage");
  const generalLabel = t("sections.general");
  const internalIdLabel = t("internalIdLabel");
  const resolvedShowInternalIdHints =
    typeof showInternalIdHints === "boolean"
      ? showInternalIdHints
      : uiDefaults.table.showInternalIdHints;

  const { editState, startEdit, cancelEdit, commitEdit, editingField } =
    useDetailInlineEdit({
      resourceKey,
      recordId,
      onUpdate,
    });

  if (!data) {
    return <EmptyState variant="card" title={resolvedEmptyMessage} />;
  }

  const primaryRecordIdRaw =
    data.id !== null && data.id !== undefined ? String(data.id) : null;
  const primaryRecordIdentifier = resolveDisplayIdentifier(data, {
    fallback: primaryRecordIdRaw,
  });
  const primaryRecordValue =
    primaryRecordIdentifier?.value ??
    (primaryRecordIdRaw ? formatReferenceValue(primaryRecordIdRaw) : null);
  const primaryRecordDescription = resolveRecordDescriptor(data);
  const showPrimaryRecordDescription =
    primaryRecordDescription &&
    primaryRecordDescription.toLowerCase() !==
      String(primaryRecordValue ?? "").toLowerCase();
  const primaryInternalId =
    resolvedShowInternalIdHints && primaryRecordIdRaw
      ? `${internalIdLabel}: ${formatIdValue(primaryRecordIdRaw)}`
      : null;

  const sections = buildDetailSections(
    data,
    columns,
    generalLabel,
    internalIdLabel,
    resolvedShowInternalIdHints
  );

  return (
    <div className="py-2" data-testid={testIdPrefix ? `${testIdPrefix}-detail-editable` : undefined}>
      <div className="text-sm font-semibold text-ui-ink">{resolvedTitle}</div>
      {primaryRecordValue || showPrimaryRecordDescription || primaryInternalId ? (
        <div className="mt-2 text-xs">
          {primaryRecordValue ? (
            <div className="font-medium text-ui-ink">{primaryRecordValue}</div>
          ) : null}
          {showPrimaryRecordDescription ? (
            <div className="mt-1 text-ui-muted">{primaryRecordDescription}</div>
          ) : null}
          {primaryInternalId ? (
            <div className="mt-1 text-[11px] text-ui-muted">{primaryInternalId}</div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-4 space-y-3">
        {sections.map((section) => (
          <CollapsibleSection
            key={section.id}
            id={section.id}
            className="border-b border-ui-border/20 pb-3"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-medium text-ui-muted">
              <span>{section.label}</span>
              <span className="text-[10px] text-ui-muted/70">
                {section.entries.length}
              </span>
            </summary>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              {section.entries.map((entry) => {
                const isEditing = editingField === entry.key;
                const column = columns?.find((c) => c.key === entry.key);
                const isEditable =
                  column?.editMode === "inline" &&
                  entry.key !== "id" &&
                  !entry.key.endsWith("_id");

                if (isEditing && editState) {
                  return (
                    <div key={entry.key} className="py-2 sm:col-span-2">
                      <DetailFieldEditor
                        fieldKey={entry.key}
                        label={entry.label}
                        editType={column?.editType ?? "text"}
                        value={entry.rawValue}
                        saving={editState.status === "saving"}
                        error={editState.error}
                        onSave={commitEdit}
                        onCancel={cancelEdit}
                      />
                    </div>
                  );
                }

                return (
                  <div key={entry.key} className="group/field relative py-2">
                    <dt className="text-xs font-medium text-ui-muted">
                      {entry.label}
                    </dt>
                    <dd className="mt-2 flex items-start gap-1 text-sm text-ui-ink" title={entry.title}>
                      <span className="min-w-0 flex-1">{entry.displayValue}</span>
                      <div className="flex items-center gap-1">
                        {entry.displayValue && entry.displayValue !== "-" ? (
                          <CopyFieldButton value={entry.displayValue} label={entry.label} />
                        ) : null}
                        {isEditable ? (
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-6 px-2 text-[10px] opacity-0 transition group-hover/field:opacity-100"
                            onClick={() => startEdit(entry.key, entry.rawValue)}
                          >
                            Edit
                          </Button>
                        ) : null}
                      </div>
                    </dd>
                    {entry.hint ? (
                      <div className="mt-1 text-[11px] text-ui-muted">{entry.hint}</div>
                    ) : null}
                  </div>
                );
              })}
            </dl>
          </CollapsibleSection>
        ))}
      </div>
    </div>
  );
}
