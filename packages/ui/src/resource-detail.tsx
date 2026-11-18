import Link from "next/link";
import { resolveFkLinkHref } from "./detail/detail-sections";
import * as React from "react";
import { getUiDefaults } from "@masarx/config";
import { resolveDisplayIdentifier } from "./display-identifiers";
import { labelFromKey } from "./resource-query";
import {
  formatDisplayIdentifierValue,
  formatIdValue,
  formatReferenceValue,
  formatResourceValue,
  isUuidValue,
  resolveRecordDescriptor,
} from "./resource-utils";
import { EmptyState } from "./empty-state";
import { CopyFieldButton } from "./detail/copy-field-button";
import { CollapsibleSection } from "./detail/collapsible-section";
import { cn } from "./utils";
import { createUiTranslator } from "./i18n";
import { resolveTrustedExternalDataUrl } from "./url-guard";

const uiDefaults = getUiDefaults();

type ResourceDetailProps = {
  title?: string;
  data?: Record<string, unknown> | null;
  emptyMessage?: string;
  columns?: ResourceDetailColumn[] | null;
  showInternalIdHints?: boolean;
  appBasePath?: string | null;
  testIdPrefix?: string | null;
};

type ResourceDetailColumn = {
  key: string;
  label?: string | null;
  detailSection?: string | null;
  renderType?: string | null;
  formatOptions?: Record<string, unknown> | null;
};

type ResourceDetailMediaEntry = {
  url: string;
  kind: "image" | "file";
};

type ResourceDetailEntry = {
  key: string;
  label: string;
  displayValue: string;
  title?: string;
  hint?: string | null;
  linkHref?: string | null;
  sectionId: string;
  sectionLabel: string;
  hideDisplayValue?: boolean;
  mediaEntries: ResourceDetailMediaEntry[];
};

type ResourceDetailSection = {
  id: string;
  label: string;
  entries: ResourceDetailEntry[];
};

const GENERAL_SECTION_ID = "general";
const MAX_MEDIA_EXTRACTION_DEPTH = 4;
const MEDIA_URL_KEYS = [
  "url",
  "href",
  "link",
  "signed_url",
  "signedurl",
  "download_url",
  "downloadurl",
  "file_url",
  "fileurl",
  "image_url",
  "imageurl",
  "photo_url",
  "photourl",
  "signature_url",
  "signatureurl",
  "barcode_url",
  "barcodeurl",
];

function resolveColumnLabel(column: ResourceDetailColumn | undefined, key: string) {
  const label = column?.label?.trim();
  if (label) return label;
  return labelFromKey(key);
}

function resolveSectionId(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return GENERAL_SECTION_ID;
  return trimmed.toLowerCase();
}

function resolveSectionLabel(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return labelFromKey(trimmed);
}

function resolveDetailIdentifierKeys(key: string) {
  if (key === "id") {
    return [
      "display_id",
      "public_id",
      "external_id",
      "tracking_number",
      "reference",
      "code",
      "number",
    ];
  }
  if (!key.endsWith("_id")) return null;
  const baseKey = key.slice(0, Math.max(0, key.length - 3));
  return [
    `${baseKey}_display_id`,
    `${baseKey}_public_id`,
    `${baseKey}_external_id`,
    `${baseKey}_tracking_number`,
    `${baseKey}_reference`,
    `${baseKey}_code`,
    `${baseKey}_number`,
    `${baseKey}_name`,
  ];
}

function normalizeUrl(value: unknown) {
  if (typeof value !== "string") return null;
  return resolveTrustedExternalDataUrl(value);
}

function resolveMediaKindHints({
  renderType,
  detailSection,
  key,
}: {
  renderType?: string | null;
  detailSection?: string | null;
  key: string;
}) {
  const normalize = (value?: string | null) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");
  const renderTypeHint = normalize(renderType);
  const sectionHint = normalize(detailSection);
  const keyHint = normalize(key);
  const imageMarkers = [
    "image",
    "photo",
    "signature",
    "pod_photo",
    "proof_of_delivery",
    "thumbnail",
  ];
  const hasImageMarker = imageMarkers.some(
    (marker) =>
      renderTypeHint.includes(marker) ||
      sectionHint.includes(marker) ||
      keyHint.includes(marker)
  );
  return hasImageMarker ? "image" : "file";
}

function isImageUrl(url: string) {
  const normalized = url.toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg)(?:\?|#|$)/i.test(normalized);
}

function collectMediaUrls(
  value: unknown,
  depth: number,
  collector: Set<string>
) {
  if (depth > MAX_MEDIA_EXTRACTION_DEPTH || value === null || value === undefined) return;
  const directUrl = normalizeUrl(value);
  if (directUrl) {
    collector.add(directUrl);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectMediaUrls(entry, depth + 1, collector));
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  Object.entries(record).forEach(([rawKey, rawValue]) => {
    const normalizedKey = rawKey
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");
    if (MEDIA_URL_KEYS.includes(normalizedKey)) {
      collectMediaUrls(rawValue, depth + 1, collector);
      return;
    }
    if (Array.isArray(rawValue) || (rawValue && typeof rawValue === "object")) {
      collectMediaUrls(rawValue, depth + 1, collector);
    }
  });
}

function resolveMediaEntries({
  value,
  column,
  key,
}: {
  value: unknown;
  column: ResourceDetailColumn | undefined;
  key: string;
}): ResourceDetailMediaEntry[] {
  const urls = new Set<string>();
  collectMediaUrls(value, 0, urls);
  if (urls.size === 0) return [];
  const hintedKind = resolveMediaKindHints({
    renderType: column?.renderType,
    detailSection: column?.detailSection,
    key,
  });
  return Array.from(urls).map((url): ResourceDetailMediaEntry => ({
    url,
    kind: hintedKind === "image" || isImageUrl(url) ? "image" : "file",
  }));
}

function buildDetailSections(
  data: Record<string, unknown>,
  columns: ResourceDetailColumn[] | null | undefined,
  generalLabel: string,
  internalIdLabel: string,
  showInternalIdHints: boolean,
  appBasePath?: string | null
): ResourceDetailSection[] {
  const columnMap = new Map<string, ResourceDetailColumn>();
  const orderMap = new Map<string, number>();
  (columns ?? []).forEach((column, index) => {
    if (!column?.key) return;
    columnMap.set(column.key, column);
    orderMap.set(column.key, index);
  });

  const entries: ResourceDetailEntry[] = Object.entries(data).map(
    ([key, value]) => {
      const column = columnMap.get(key);
      const mediaEntries = resolveMediaEntries({ value, column, key });
      const textValue = formatResourceValue(value, {
        renderType: column?.renderType ?? null,
        formatOptions: column?.formatOptions ?? null,
      });
      const isIdKey = key === "id" || key.endsWith("_id");
      const isUuidLiteralValue =
        !isIdKey && typeof value === "string" && isUuidValue(value);
      const uuidReferenceValue = isUuidLiteralValue
        ? formatReferenceValue(String(value))
        : null;
      const displayIdentifier = isIdKey
        ? resolveDisplayIdentifier(data, {
            fallback: textValue,
            preferredKeys: resolveDetailIdentifierKeys(key) ?? undefined,
            skipGlobalFallback: key !== "id",
          })
        : null;
      const rawIdValue =
        isIdKey && value !== null && value !== undefined
          ? String(value)
          : "";
      const idFallbackValue = isIdKey
        ? formatResourceValue(rawIdValue, { renderType: "id" })
        : null;
      const compactDisplayIdentifier = displayIdentifier?.value
        ? formatDisplayIdentifierValue(displayIdentifier.value)
        : null;
      const displayValue = compactDisplayIdentifier
        ? compactDisplayIdentifier
        : isIdKey
          ? idFallbackValue ?? textValue
          : uuidReferenceValue ?? textValue;
      const title = displayIdentifier?.value
        ? displayIdentifier.value
        : isIdKey && rawIdValue && displayValue !== rawIdValue
          ? rawIdValue
          : isUuidLiteralValue
            ? String(value)
          : undefined;
      const internalIdHintValue = rawIdValue
        ? formatIdValue(rawIdValue)
        : isUuidLiteralValue
          ? formatIdValue(String(value))
          : isIdKey && textValue !== "-"
          ? formatIdValue(textValue)
          : null;
      const hint =
        (isIdKey || isUuidLiteralValue) && showInternalIdHints && internalIdHintValue
          ? `${internalIdLabel}: ${internalIdHintValue}`
          : null;
      const hideDisplayValue =
        mediaEntries.length > 0 &&
        (typeof value === "string" ||
          Array.isArray(value) ||
          (typeof value === "object" &&
            value !== null &&
            displayValue.startsWith("{")));
      const sectionId = resolveSectionId(column?.detailSection);
      const sectionLabel = resolveSectionLabel(column?.detailSection, generalLabel);
      return {
        key,
        label: resolveColumnLabel(column, key),
        displayValue,
        title,
        hint,
        sectionId,
        sectionLabel,
        hideDisplayValue,
        mediaEntries,
        linkHref: resolveFkLinkHref(key, value, appBasePath),
      };
    }
  );

  entries.sort((left, right) => {
    const leftIndex = orderMap.get(left.key);
    const rightIndex = orderMap.get(right.key);
    if (leftIndex !== undefined || rightIndex !== undefined) {
      return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return left.label.localeCompare(right.label);
  });

  const sections = new Map<string, ResourceDetailSection>();
  entries.forEach((entry) => {
    const existing = sections.get(entry.sectionId);
    if (existing) {
      existing.entries.push(entry);
      return;
    }
    sections.set(entry.sectionId, {
      id: entry.sectionId,
      label: entry.sectionLabel,
      entries: [entry],
    });
  });
  return Array.from(sections.values());
}

/**
 * Detail panel for a single resource row.
 */
export function ResourceDetail({
  title,
  data,
  emptyMessage,
  columns,
  showInternalIdHints,
  appBasePath = null,
  testIdPrefix,
}: ResourceDetailProps) {
  const t = createUiTranslator("ui.resourceDetail");
  const resolvedTitle = title ?? t("title");
  const resolvedEmptyMessage = emptyMessage ?? t("emptyMessage");
  const generalLabel = t("sections.general");
  const internalIdLabel = t("internalIdLabel");
  const resolvedShowInternalIdHints =
    typeof showInternalIdHints === "boolean"
      ? showInternalIdHints
      : uiDefaults.table.showInternalIdHints;
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const detailTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-detail`
    : undefined;
  if (!data) {
    return (
      <EmptyState
        variant="card"
        title={resolvedEmptyMessage}
      />
    );
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
    resolvedShowInternalIdHints,
    appBasePath
  );

  return (
    <div
      className="py-2"
      data-testid={detailTestId}
    >
      <div
        className="text-sm font-semibold text-ui-ink"
        data-testid="resource-detail-primary-identifier"
      >
        {resolvedTitle}
      </div>
      {primaryRecordValue || showPrimaryRecordDescription || primaryInternalId ? (
        <div className="mt-2 text-xs" data-testid="resource-detail-primary-identifier">
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
            data-testid={
              resolvedTestIdPrefix
                ? `${resolvedTestIdPrefix}-detail-section-${section.id}`
                : undefined
            }
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-medium text-ui-muted">
              <span>{section.label}</span>
              <span className="text-[10px] text-ui-muted">
                {section.entries.length}
              </span>
            </summary>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              {section.entries.map((entry) => (
                <div
                  key={entry.key}
                  data-field-key={entry.key}
                  className="group/field relative py-2"
                >
                  <dt className="text-xs font-medium text-ui-muted">
                    {entry.label}
                  </dt>
                  {entry.hideDisplayValue ? null : (
                    <dd className="mt-2 flex items-start gap-1 text-sm text-ui-ink" title={entry.title}>
                      <span className="min-w-0 flex-1">
                        {entry.linkHref ? <Link href={entry.linkHref} className="underline underline-offset-2">{entry.displayValue}</Link> : entry.displayValue}
                      </span>
                      {entry.displayValue && entry.displayValue !== "-" ? (
                        <CopyFieldButton value={entry.displayValue} label={entry.label} />
                      ) : null}
                    </dd>
                  )}
                  {entry.hint ? (
                    <div className="mt-1 text-[11px] text-ui-muted">{entry.hint}</div>
                  ) : null}
                  {entry.mediaEntries.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {entry.mediaEntries.map((media, index) => {
                        const order = index + 1;
                        const label =
                          media.kind === "image"
                            ? t("media.openImage", { index: order })
                            : t("media.openFile", { index: order });
                        return (
                          <div key={`${entry.key}-${media.url}`} className="space-y-2">
                            <a
                              className="text-xs text-ui-ink underline underline-offset-4"
                              href={media.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {label}
                            </a>
                            {media.kind === "image" ? (
                              <a
                                href={media.url}
                                target="_blank"
                                rel="noreferrer"
                                className="block overflow-hidden rounded-lg border border-ui-border/70 bg-ui-surface/40"
                              >
                                <img
                                  src={media.url}
                                  alt={t("media.imagePreviewAlt", {
                                    label: entry.label,
                                    index: order,
                                  })}
                                  loading="lazy"
                                  className="max-h-40 w-full object-contain"
                                />
                              </a>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ))}
            </dl>
          </CollapsibleSection>
        ))}
      </div>
    </div>
  );
}
