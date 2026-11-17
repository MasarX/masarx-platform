"use client";

import * as React from "react";
import {
  formatDisplayIdentifierValue,
  formatIdValue,
  formatReferenceValue,
  formatResourceValue,
  isUuidValue,
  resolveRecordDescriptor,
} from "../resource-utils";
import { resolveDisplayIdentifier } from "../display-identifiers";
import type { ResourceColumn } from "./columns";
import type { CellDisplay } from "./cell-display";
import type { ResourceViewEntry } from "./view-types";
import type { SortDirection, SortInput, SortState } from "./sorting";

export function normalizeSortState(value: SortInput): SortState[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  return list
    .filter((entry): entry is SortState => Boolean(entry && entry.key))
    .map((entry) => {
      const direction: SortDirection =
        entry.direction === "desc" ? "desc" : "asc";
      return {
        key: entry.key,
        direction,
      };
    })
    .filter((entry) => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    });
}

export function normalizeDebounceOptions(values: number[] | null | undefined) {
  if (!values) return [];
  return Array.from(
    new Set(
      values
        .map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry) && entry >= 0)
    )
  ).sort((a, b) => a - b);
}

export function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value);
      return;
    }
    const handle = globalThis.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      globalThis.clearTimeout(handle);
    };
  }, [value, delayMs]);

  return delayMs <= 0 ? value : debounced;
}

function truncateValue(value: string, limit: number) {
  if (value.length <= limit) return { display: value, title: value };
  const cutoff = Math.max(limit - 3, 0);
  return { display: `${value.slice(0, cutoff)}...`, title: value };
}

function resolveLabelCandidate(item: Record<string, unknown>, candidates: string[]) {
  for (const key of candidates) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function resolveIdentifierCandidateKeys(columnKey: string, labelKeys: string[]) {
  const baseKey =
    columnKey === "id" ? "" : columnKey.slice(0, Math.max(0, columnKey.length - 3));
  const scopedKeys = baseKey
    ? [
        `${baseKey}_display_id`,
        `${baseKey}_public_id`,
        `${baseKey}_external_id`,
        `${baseKey}_tracking_number`,
        `${baseKey}_reference`,
        `${baseKey}_code`,
        `${baseKey}_number`,
      ]
    : [];
  const labelScopedKeys = baseKey
    ? labelKeys.map((candidate) => `${baseKey}_${candidate}`)
    : labelKeys;
  return [...scopedKeys, ...labelScopedKeys];
}

function resolveScopedKeys(baseKey: string, keys: string[]) {
  if (!baseKey) return keys;
  return keys.map((key) => `${baseKey}_${key}`);
}

function normalizeIdentifierValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeIdentifierKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

export function resolveCellDisplay(
  item: Record<string, unknown>,
  column: ResourceColumn,
  truncateLength: number,
  labelKeys: string[],
  descriptorKeys: string[] = [],
  showInternalIdHints: boolean = false
): CellDisplay {
  const columnKey = column.key;
  const raw = item[columnKey];
  const text = formatResourceValue(raw, {
    renderType: column.renderType ?? null,
    formatOptions: column.formatOptions ?? null,
  });
  const { display, title } = truncateValue(text, truncateLength);
  const trimmed = text.trim();
  const isIdColumn = columnKey === "id" || columnKey.endsWith("_id");
  if (!isIdColumn) {
    if (trimmed && isUuidValue(trimmed)) {
      const formattedReference = truncateValue(
        formatReferenceValue(trimmed),
        truncateLength
      );
      const internalHint = showInternalIdHints
        ? truncateValue(formatIdValue(trimmed), truncateLength)
        : null;
      return {
        primary: formattedReference.display,
        primaryTitle: trimmed,
        secondary: internalHint?.display ?? null,
        secondaryTitle:
          internalHint?.title ?? (showInternalIdHints ? trimmed : undefined),
      };
    }
    return { primary: display, primaryTitle: title };
  }

  const baseKey =
    columnKey === "id" ? "" : columnKey.slice(0, Math.max(0, columnKey.length - 3));
  const labelCandidates =
    columnKey === "id" ? labelKeys : resolveScopedKeys(baseKey, labelKeys);
  const descriptorCandidates =
    columnKey === "id"
      ? descriptorKeys
      : resolveScopedKeys(baseKey, descriptorKeys);
  const descriptor = resolveRecordDescriptor(item, descriptorCandidates);
  const displayIdentifier = resolveDisplayIdentifier(item, {
    fallback: trimmed,
    preferredKeys: resolveIdentifierCandidateKeys(columnKey, labelKeys),
  });
  if (displayIdentifier) {
    const compactDisplayIdentifier = formatDisplayIdentifierValue(
      displayIdentifier.value
    );
    const formattedIdentifier = truncateValue(
      compactDisplayIdentifier,
      truncateLength
    );
    const label = resolveLabelCandidate(item, labelCandidates);
    const normalizedLabelCandidates = new Set(
      labelCandidates.map((entry) => normalizeIdentifierKey(entry))
    );
    const identifierIsLabelLike = normalizedLabelCandidates.has(
      normalizeIdentifierKey(displayIdentifier.key)
    );
    const showLabel =
      label && label.toLowerCase() !== displayIdentifier.value.toLowerCase()
        ? truncateValue(label, truncateLength)
        : null;
    const showDescriptor =
      descriptor &&
      normalizeIdentifierValue(descriptor) !==
        normalizeIdentifierValue(displayIdentifier.value)
        ? truncateValue(descriptor, truncateLength)
        : null;
    const showInternalId =
      showInternalIdHints &&
      !showLabel &&
      !showDescriptor &&
      !identifierIsLabelLike &&
      trimmed &&
      normalizeIdentifierValue(displayIdentifier.value) !==
        normalizeIdentifierValue(trimmed)
        ? truncateValue(formatIdValue(trimmed), truncateLength)
        : null;
    return {
      primary: formattedIdentifier.display,
      primaryTitle: displayIdentifier.value,
      secondary:
        showDescriptor?.display ??
        showLabel?.display ??
        showInternalId?.display ??
        null,
      secondaryTitle:
        showDescriptor?.title ?? showLabel?.title ?? showInternalId?.title,
    };
  }

  const label = resolveLabelCandidate(item, labelCandidates);
  if (label) {
    const showDescriptor =
      descriptor &&
      normalizeIdentifierValue(descriptor) !== normalizeIdentifierValue(label)
        ? truncateValue(descriptor, truncateLength)
        : null;
    const formattedLabel = truncateValue(label, truncateLength);
    return {
      primary: formattedLabel.display,
      primaryTitle: formattedLabel.title,
      secondary:
        showDescriptor?.display ??
        (showInternalIdHints && trimmed ? formatIdValue(trimmed) : null),
      secondaryTitle:
        showDescriptor?.title ??
        (showInternalIdHints && trimmed ? trimmed : undefined),
    };
  }
  if (trimmed.length > 12) {
    const formattedReference = truncateValue(formatReferenceValue(trimmed), truncateLength);
    return {
      primary: formattedReference.display,
      primaryTitle: trimmed,
      secondary: showInternalIdHints ? formatIdValue(trimmed) : null,
      secondaryTitle: showInternalIdHints ? trimmed : undefined,
    };
  }
  return { primary: display, primaryTitle: title };
}

function normalizeSortValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && String(value).trim() !== "") {
    return asNumber;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value).toLowerCase();
    } catch {
      return String(value).toLowerCase();
    }
  }
  return String(value).toLowerCase();
}

export function compareValues(a: unknown, b: unknown, direction: SortDirection) {
  const left = normalizeSortValue(a);
  const right = normalizeSortValue(b);
  if (left === right) return 0;
  const order = left > right ? 1 : -1;
  return direction === "asc" ? order : -order;
}

export function resolveActiveView(
  views: ResourceViewEntry[],
  activeViewId?: string | null
) {
  if (!views.length) return null;
  if (activeViewId) {
    const match = views.find((view) => view.id === activeViewId);
    if (match) return match;
  }
  return views[0] ?? null;
}
