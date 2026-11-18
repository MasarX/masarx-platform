"use client";

import type {
  MappingArtifact,
  MappingCoercion,
  MappingDiagnostic,
  MappingOperationReport,
  MappingStudioReview,
  UiReadResource,
} from "@masarx/api";

export type StudioFieldRule = {
  target_field: string;
  source_path?: string | null;
  source_paths?: string[];
  source_column?: string | null;
  sample_value?: unknown;
  confidence?: number | null;
  source?: string | null;
};

export type StudioRequestConfig = {
  method?: string | null;
  url_template?: string | null;
  headers_template?: Record<string, unknown> | null;
  body_template?: Record<string, unknown> | null;
  request_mappings?: Record<string, unknown> | null;
  timeout_seconds?: number | null;
};

export function stringifyPretty(value: unknown, fallback = "{}") {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return fallback;
  }
}

export function parseJsonText<T = unknown>(value: string, fallback: T): T {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return JSON.parse(trimmed) as T;
}

export function normalizeKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function collectLeafPaths(value: unknown, prefix = "$"): string[] {
  if (value === null || value === undefined) return [prefix];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[*]`];
    return collectLeafPaths(value[0], `${prefix}[*]`);
  }
  if (typeof value !== "object") return [prefix];

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return [prefix];
  return keys.flatMap((key) => collectLeafPaths(record[key], `${prefix}.${key}`));
}

export function buildResourceSchema(resource: UiReadResource | null | undefined) {
  const properties: Record<string, unknown> = {};
  const columns = Array.isArray(resource?.columns) ? resource.columns : [];
  columns.forEach((column) => {
    const rawType = String(column.edit_type ?? column.render_type ?? "string").toLowerCase();
    let type: string = "string";
    let format: string | null = null;
    if (rawType.includes("bool")) type = "boolean";
    else if (rawType.includes("int")) type = "integer";
    else if (rawType.includes("number") || rawType.includes("float")) type = "number";
    else if (rawType.includes("date") && rawType.includes("time")) {
      type = "string";
      format = "date-time";
    } else if (rawType.includes("date")) {
      type = "string";
      format = "date";
    } else if (rawType.includes("array") || rawType.includes("multi")) {
      type = "array";
    }
    properties[column.key] = format ? { type, format } : { type };
  });
  return {
    type: "object",
    properties,
    required: [],
  };
}

export function inferTabularRules(
  columns: string[],
  targetSchema: Record<string, unknown> | null | undefined,
) {
  const schema = targetSchema && typeof targetSchema === "object" ? targetSchema : {};
  const properties =
    schema && typeof schema === "object" && "properties" in schema
      ? ((schema as Record<string, unknown>).properties as Record<string, unknown> | undefined)
      : undefined;
  const targets = Object.keys(properties ?? {});
  const normalizedColumns = new Map(columns.map((column) => [normalizeKey(column), column]));

  const rules: StudioFieldRule[] = [];
  targets.forEach((target) => {
    const normalizedTarget = normalizeKey(target);
    const matchedColumn = normalizedColumns.get(normalizedTarget);
    if (!matchedColumn) return;
    rules.push({
      target_field: target,
      source_path: `column:${matchedColumn}`,
      source_column: matchedColumn,
      confidence: 0.85,
      source: "tabular_header_match",
    });
  });

  return rules;
}

export function normalizeRulesFromMappingConfig(mappingConfig: Record<string, unknown> | null | undefined) {
  if (!mappingConfig) return [] as StudioFieldRule[];

  if (Array.isArray(mappingConfig.fields)) {
    return mappingConfig.fields
      .map((entry) => (entry && typeof entry === "object" ? (entry as StudioFieldRule) : null))
      .filter((entry): entry is StudioFieldRule => Boolean(entry));
  }

  const fieldMappings =
    mappingConfig.field_mappings && typeof mappingConfig.field_mappings === "object"
      ? (mappingConfig.field_mappings as Record<string, unknown>)
      : null;
  if (!fieldMappings) return [] as StudioFieldRule[];

  return Object.entries(fieldMappings).map(([target, raw]) => {
    if (Array.isArray(raw) && raw.some((entry) => typeof entry !== "string")) {
      throw new Error(`Mapping fallback paths for ${target} must all be strings.`);
    }
    const first = Array.isArray(raw)
      ? raw.find((entry): entry is string => typeof entry === "string") ?? null
      : typeof raw === "string"
        ? raw
        : null;
    return {
      target_field: target,
      source_path: first,
      ...(Array.isArray(raw) ? { source_paths: [...raw] as string[] } : {}),
      source_column: first?.startsWith("column:") ? first.slice("column:".length) : null,
      confidence: 1,
      source: "runtime_mapping",
    };
  });
}

export function buildReviewMappingConfig(
  artifact: MappingArtifact,
  rules: StudioFieldRule[],
  extra?: Record<string, unknown> | null,
) {
  const fields = rules
    .map((rule) => ({
      target_field: rule.target_field,
      source_path: rule.source_path ?? (rule.source_column ? `column:${rule.source_column}` : null),
      ...(rule.source_paths ? { source_paths: [...rule.source_paths] } : {}),
      source_column: rule.source_column ?? null,
      sample_value: rule.sample_value ?? null,
      confidence: rule.confidence ?? null,
      source: rule.source ?? "manual",
    }))
    .filter((rule) => typeof rule.target_field === "string" && rule.target_field.trim().length > 0);

  return {
    version: 1,
    artifact,
    fields,
    ...(extra ?? {}),
  };
}

export function buildRuntimeMappingConfig(
  artifact: MappingArtifact,
  rules: StudioFieldRule[],
  extra?: Record<string, unknown> | null,
  original?: Record<string, unknown> | null,
) {
  if (artifact === "tabular_import") {
    return {
      version: 1,
      artifact,
      fields: rules.map((rule) => ({
        target_field: rule.target_field,
        source_path: rule.source_path ?? (rule.source_column ? `column:${rule.source_column}` : null),
      })),
      ...(extra ?? {}),
    };
  }

  const field_mappings: Record<string, string | string[]> = {};
  rules.forEach((rule) => {
    const targetField = rule.target_field.trim();
    if (!targetField) return;
    const sourcePath = (rule.source_path ?? (rule.source_column ? `column:${rule.source_column}` : "")).trim();
    if (rule.source_paths) {
      field_mappings[targetField] = rule.source_paths.length === 0 && !sourcePath
        ? []
        : [rule.source_path ?? "", ...rule.source_paths.slice(1)].filter((path) => path.trim().length > 0);
      return;
    }
    if (!sourcePath) return;
    field_mappings[targetField] = sourcePath;
  });

  return {
    version: 1,
    ...(original ?? {}),
    ...(rules.length === 0 && original?.transforms && !original.field_mappings ? {} : { field_mappings }),
    ...(extra ?? {}),
    artifact,
  };
}

export function buildDownloadBlob(filename: string, value: unknown) {
  const blob = new Blob([stringifyPretty(value, "null")], {
    type: "application/json;charset=utf-8;",
  });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

export function summarizeReview(review: MappingStudioReview | null | undefined) {
  return {
    blocking: Array.isArray(review?.diagnostics)
      ? review.diagnostics.filter((entry) => entry.blocking)
      : ([] as MappingDiagnostic[]),
    warnings: Array.isArray(review?.diagnostics)
      ? review.diagnostics.filter((entry) => !entry.blocking && entry.level === "warning")
      : ([] as MappingDiagnostic[]),
    coercions: Array.isArray(review?.coercions) ? review.coercions : ([] as MappingCoercion[]),
    nextSteps:
      review?.review_summary?.next_steps && Array.isArray(review.review_summary.next_steps)
        ? review.review_summary.next_steps
        : ([] as string[]),
  };
}

export function deriveSourceTypeLabel(sourceType: string) {
  const normalized = sourceType.trim().toLowerCase();
  if (normalized === "webhook_sample") return "JSON payload";
  if (normalized === "curl") return "cURL";
  if (normalized === "openapi") return "OpenAPI";
  if (normalized === "csv") return "CSV";
  if (normalized === "xlsx") return "XLSX";
  return sourceType || "Manual";
}

export function buildReportFilename(report: MappingOperationReport | null | undefined) {
  const reportId = report?.id?.trim() || "mapping-operation-report";
  return `${reportId}.json`;
}
