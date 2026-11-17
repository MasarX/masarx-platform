import type { UiReadColumn, UiReadResource, UiResourceList } from "@masarx/api";
import { labelFromKey } from "./resource-query";

export type ResourceColumn = {
  key: string;
  label?: string | null;
  renderType?: string | null;
  formatOptions?: Record<string, unknown> | null;
  editMode?: string | null;
  editType?: string | null;
  editAllowId?: boolean | null;
  editPermission?: string | null;
  editOptions?:
    | Array<
        | string
        | number
        | {
            label?: string | number | null;
            value?: string | number | null;
          }
      >
    | null;
  detailSection?: string | null;
  aggregation?: {
    enabled?: boolean | null;
    methods?: string[] | null;
  } | null;
};

function normalizeColumnKeyForRenderHeuristic(value: string) {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isIdLikeColumnKey(value: string) {
  const normalized = normalizeColumnKeyForRenderHeuristic(value);
  if (!normalized) return false;
  if (normalized === "id") return true;
  const tokens = normalized.split("_").filter(Boolean);
  const suffix = tokens[tokens.length - 1];
  return suffix === "id" || suffix === "uuid";
}

function resolveInferredRenderType(
  columnKey: string,
  configuredRenderType: string | null | undefined
) {
  const configured = typeof configuredRenderType === "string"
    ? configuredRenderType.trim()
    : "";
  if (configured) return configured;
  return isIdLikeColumnKey(columnKey) ? "id" : null;
}

function resolveColumnLabel(resource: UiReadResource | null | undefined, key: string) {
  const labels = resource?.column_labels;
  if (labels && typeof labels === "object") {
    const raw = labels[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return labelFromKey(key);
}

function toResourceColumn(
  resource: UiReadResource | null | undefined,
  column: UiReadColumn
): ResourceColumn | null {
  if (!column?.key) return null;
  const columnWithEditMeta = column as UiReadColumn & {
    edit_allow_id?: boolean | null;
    edit_options?:
      | Array<
          | string
          | number
          | {
              label?: string | number | null;
              value?: string | number | null;
            }
        >
      | null;
  };
  return {
    key: column.key,
    label: column.label ?? resolveColumnLabel(resource, column.key),
    renderType: resolveInferredRenderType(column.key, column.render_type),
    formatOptions: column.format_options ?? null,
    editMode: column.edit_mode ?? null,
    editType: column.edit_type ?? null,
    editAllowId: columnWithEditMeta.edit_allow_id ?? null,
    editPermission: column.edit_permission ?? null,
    editOptions: columnWithEditMeta.edit_options ?? null,
    detailSection: column.detail_section ?? null,
    aggregation: column.aggregation ?? null,
  };
}

function normalizeListKeys(list: UiResourceList | null): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();

  const rawKeys = list?.keys;
  const hasPreferredOrder = Array.isArray(rawKeys) && rawKeys.length > 0;
  if (Array.isArray(rawKeys)) {
    rawKeys.forEach((value) => {
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      if (!trimmed) return;
      if (seen.has(trimmed)) return;
      seen.add(trimmed);
      keys.push(trimmed);
    });
  }

  const items = Array.isArray(list?.items) ? list.items : [];
  const additionalKeys: string[] = [];
  const additionalSeen = new Set<string>();

  items.forEach((item) => {
    if (!item || typeof item !== "object") return;
    Object.keys(item).forEach((key) => {
      if (seen.has(key)) return;
      if (additionalSeen.has(key)) return;
      additionalSeen.add(key);
      additionalKeys.push(key);
    });
  });

  if (hasPreferredOrder) {
    additionalKeys.sort((left, right) => left.localeCompare(right));
  }

  additionalKeys.forEach((key) => {
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  });

  return keys;
}

function normalizeResourceKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function tokenizeResourceKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function levenshteinDistance(left: string, right: string) {
  const a = normalizeResourceKey(left);
  const b = normalizeResourceKey(right);
  if (!a) return b.length;
  if (!b) return a.length;
  const matrix: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i += 1) {
    const row = matrix[i];
    if (!row) continue;
    row[0] = i;
  }
  const firstRow = matrix[0];
  if (!firstRow) return Math.max(a.length, b.length);
  for (let j = 0; j <= b.length; j += 1) {
    firstRow[j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    const row = matrix[i];
    const prevRow = matrix[i - 1];
    if (!row || !prevRow) continue;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (prevRow[j] ?? Number.POSITIVE_INFINITY) + 1,
        (row[j - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (prevRow[j - 1] ?? Number.POSITIVE_INFINITY) + cost
      );
    }
  }
  return matrix[a.length]?.[b.length] ?? Math.max(a.length, b.length);
}

function hasTokenSimilarity(leftTokens: string[], rightTokens: string[]) {
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  return leftTokens.some((leftToken) =>
    rightTokens.some((rightToken) => {
      if (leftToken === rightToken) return true;
      const prefixMatch =
        leftToken.startsWith(rightToken) || rightToken.startsWith(leftToken);
      if (prefixMatch) return true;
      const containsMatch =
        leftToken.includes(rightToken) || rightToken.includes(leftToken);
      if (containsMatch) return true;
      const distance = levenshteinDistance(leftToken, rightToken);
      const threshold = Math.max(
        1,
        Math.round(Math.max(leftToken.length, rightToken.length) * 0.34)
      );
      return distance <= threshold;
    })
  );
}

export function suggestResourceKeys(
  requestedKey: string,
  resources: Array<Pick<UiReadResource, "key"> | null | undefined>,
  limit = 3
) {
  const requested = String(requestedKey ?? "").trim();
  if (!requested) return [];
  const normalizedRequested = normalizeResourceKey(requested);
  if (!normalizedRequested) return [];
  const requestedTokens = tokenizeResourceKey(requested);

  const maxSuggestions = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 3;
  const uniqueKeys: string[] = [];
  const seenNormalized = new Set<string>();

  resources.forEach((resource) => {
    const key = String(resource?.key ?? "").trim();
    if (!key) return;
    const normalized = normalizeResourceKey(key);
    if (!normalized) return;
    if (normalized === normalizedRequested) return;
    if (seenNormalized.has(normalized)) return;
    seenNormalized.add(normalized);
    uniqueKeys.push(key);
  });

  const ranked = uniqueKeys
    .map((key) => {
      const normalized = normalizeResourceKey(key);
      if (!normalized) return null;
      const distance = levenshteinDistance(normalizedRequested, normalized);
      const maxLength = Math.max(normalizedRequested.length, normalized.length);
      const threshold = Math.max(2, Math.round(maxLength * 0.4));
      const prefixMatch =
        normalized.startsWith(normalizedRequested) ||
        normalizedRequested.startsWith(normalized);
      const containsMatch =
        normalized.includes(normalizedRequested) ||
        normalizedRequested.includes(normalized);
      const tokenSimilarity = hasTokenSimilarity(
        requestedTokens,
        tokenizeResourceKey(key)
      );
      if (!prefixMatch && !containsMatch && distance > threshold && !tokenSimilarity) {
        return null;
      }
      const score =
        distance +
        Math.abs(normalizedRequested.length - normalized.length) * 0.25 -
        (prefixMatch ? 2 : 0) -
        (containsMatch ? 1 : 0) -
        (tokenSimilarity ? 0.75 : 0);
      return { key, score };
    })
    .filter((entry): entry is { key: string; score: number } => Boolean(entry))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      return left.key.localeCompare(right.key);
    })
    .slice(0, maxSuggestions)
    .map((entry) => entry.key);

  return ranked;
}

export function resolveColumns(
  resource: UiReadResource | null | undefined,
  list: UiResourceList | null
): ResourceColumn[] {
  const configured: ResourceColumn[] = [];
  const configuredKeys: string[] = [];
  const configuredMap = new Map<string, ResourceColumn>();

  if (Array.isArray(resource?.columns) && resource.columns.length > 0) {
    resource.columns.forEach((column) => {
      const resolved = toResourceColumn(resource, column);
      if (!resolved) return;
      configured.push(resolved);
      configuredKeys.push(resolved.key);
      configuredMap.set(resolved.key, resolved);
    });
  } else if (resource?.select && resource.select.length > 0) {
    resource.select.forEach((key) => {
      const trimmed = key?.trim();
      if (!trimmed) return;
      const column = { key: trimmed, label: resolveColumnLabel(resource, trimmed) };
      configured.push(column);
      configuredKeys.push(trimmed);
      configuredMap.set(trimmed, column);
    });
  }

  const listKeys = normalizeListKeys(list);
  const strictColumns = resource?.strict_columns === true;
  const orderedKeys: string[] = [];
  const seen = new Set<string>();

  const addKey = (key: string) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    orderedKeys.push(trimmed);
  };

  if (configuredKeys.length > 0) {
    configuredKeys.forEach(addKey);
  } else {
    listKeys.forEach(addKey);
  }

  if (!strictColumns) {
    listKeys.forEach(addKey);
    configuredKeys.forEach(addKey);
  }

  return orderedKeys.map((key) => {
    const configuredColumn = configuredMap.get(key);
    if (configuredColumn) return configuredColumn;
    const inferredRenderType = resolveInferredRenderType(key, null);
    return {
      key,
      label: resolveColumnLabel(resource, key),
      ...(inferredRenderType ? { renderType: inferredRenderType } : {}),
    };
  });
}
