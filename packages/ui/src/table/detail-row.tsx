"use client";

import { cn } from "../utils";
import { formatIdValue, formatResourceValue, resolveRecordLabel } from "../resource-utils";
import { resolveColumnLabel, type ResourceColumn } from "./columns";
import type { DetailRow } from "./row-types";
import type { TranslateFn } from "./types";

type TableDetailRowProps = {
  t: TranslateFn;
  row: DetailRow;
  detailColumns: ResourceColumn[];
  detailSelected: boolean;
  safeColumnCount: number;
  cellPadding: string;
};

export function TableDetailRow({
  t,
  row,
  detailColumns,
  detailSelected,
  safeColumnCount,
  cellPadding,
}: TableDetailRowProps) {
  const detailLabel = resolveRecordLabel(row.item);
  const fallbackId = row.parentId
    ? formatIdValue(row.parentId)
    : formatIdValue(row.parentKey);
  const detailTitle = detailLabel
    ? t("detail.titleWithLabel", { label: detailLabel })
    : row.parentId
      ? t("detail.titleWithId", { id: fallbackId })
      : t("detail.title");
  const detailIndent = row.depth > 0 ? { paddingLeft: `${row.depth * 16}px` } : undefined;
  const detailEntries = detailColumns.map((column) => ({
    key: column.key,
    label: resolveColumnLabel(column),
    value: formatResourceValue(row.item[column.key], {
      renderType: column.renderType ?? null,
      formatOptions: column.formatOptions ?? null,
    }),
  }));

  return (
    <tr
      key={row.id}
      data-testid={`row-detail-${row.parentKey}`}
      className="border-t border-ui-border/10"
    >
      <td colSpan={safeColumnCount} className="px-4 py-3">
        <div
          className={cn(
            "rounded-lg border border-ui-border/15 bg-ui-surface p-5 shadow-sm motion-safe:table-animate-slide-down",
            detailSelected && "ring-1 ring-ui-accent/20"
          )}
          style={detailIndent}
        >
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-medium text-ui-muted">
              {detailTitle}
            </span>
          </div>
          {detailEntries.length > 0 ? (
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
              {detailEntries.map((entry) => (
                <div key={entry.key} className="space-y-1">
                  <dt className="text-[11px] font-medium text-ui-muted">
                    {entry.label}
                  </dt>
                  <dd className="text-sm text-ui-ink whitespace-pre-wrap break-words">
                    {entry.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="text-xs text-ui-muted">{t("detail.empty")}</div>
          )}
        </div>
      </td>
    </tr>
  );
}
