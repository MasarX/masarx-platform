import type { UiScopeOption } from "@masarx/api";
import { buildLookupFallbackValue } from "./lookup-friendly-label";
import { STATUS_CREATED, STATUS_PENDING } from "./status-defaults";

export type LookupValueRow = {
  value: string;
  label?: string | null;
  sort_order?: number | null;
  is_default?: boolean | null;
};

export type LookupOption = {
  value: string;
  label: string;
  sortOrder: number | null;
  isDefault: boolean;
};

function trimLookupValue(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function formatContextFallbackValue(value: string | null | undefined) {
  return buildLookupFallbackValue(value);
}

export const DEFAULT_SHIPMENT_SERVICE_OPTIONS: readonly LookupOption[] = [
  { value: "delivery", label: "Delivery", sortOrder: 1, isDefault: true },
  { value: "pickup", label: "Pickup", sortOrder: 2, isDefault: false },
  { value: "swap", label: "Swap", sortOrder: 3, isDefault: false },
  { value: "return_to_origin", label: "Return to Origin", sortOrder: 4, isDefault: false },
];

export const DEFAULT_SHIPMENT_CREATE_STATUS_OPTIONS: readonly LookupOption[] = [
  { value: STATUS_PENDING, label: "Pending", sortOrder: 1, isDefault: true },
  { value: STATUS_CREATED, label: "Created", sortOrder: 5, isDefault: false },
];

export const DEFAULT_LANGUAGE_CODE_OPTIONS: readonly LookupOption[] = [
  { value: "ar", label: "Arabic", sortOrder: 10, isDefault: true },
  { value: "en", label: "English", sortOrder: 20, isDefault: false },
];

export const DEFAULT_SHIPMENT_REFERENCE_TYPE_OPTIONS: readonly LookupOption[] = [
  {
    value: "client_reference_number",
    label: "Client Reference",
    sortOrder: 10,
    isDefault: false,
  },
  {
    value: "carrier_reference_number",
    label: "Carrier Reference",
    sortOrder: 20,
    isDefault: false,
  },
  {
    value: "logistics_reference_number",
    label: "Logistics Reference",
    sortOrder: 30,
    isDefault: false,
  },
  {
    value: "platform_reference_number",
    label: "Platform Reference",
    sortOrder: 40,
    isDefault: false,
  },
  {
    value: "legacy_lmd_system_reference",
    label: "Legacy LMD Reference",
    sortOrder: 90,
    isDefault: false,
  },
];

export const SHIPMENT_CREATE_STATUS_VALUES: ReadonlySet<string> = new Set([
  STATUS_PENDING,
  STATUS_CREATED,
]);

export function humanizeLookupValue(value: string) {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

export function sortLookupOptions(left: LookupOption, right: LookupOption) {
  const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
}

let regionDisplayNames: Intl.DisplayNames | null | undefined;

function getRegionDisplayNames() {
  if (regionDisplayNames !== undefined) {
    return regionDisplayNames;
  }
  try {
    regionDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    regionDisplayNames = null;
  }
  return regionDisplayNames;
}

export function formatCountryCodeLabel(value: string) {
  const normalized = trimLookupValue(value).toUpperCase();
  if (!normalized) return "";
  if (!/^[A-Z]{2}$/.test(normalized)) {
    return humanizeLookupValue(normalized);
  }
  try {
    return getRegionDisplayNames()?.of(normalized) ?? normalized;
  } catch {
    return normalized;
  }
}

export function buildSeedLookupOptions(params: {
  values: readonly (string | null | undefined)[];
  fallback?: readonly LookupOption[];
  resolveLabel?: (value: string) => string;
}) {
  const {
    values,
    fallback = [],
    resolveLabel = humanizeLookupValue,
  } = params;
  const options = new Map<string, LookupOption>();
  for (const option of fallback) {
    const normalized = trimLookupValue(option.value);
    if (!normalized) continue;
    options.set(normalized, {
      ...option,
      value: normalized,
    });
  }
  for (const value of values) {
    const normalized = trimLookupValue(value);
    if (!normalized || options.has(normalized)) continue;
    options.set(normalized, {
      value: normalized,
      label: resolveLabel(normalized) || normalized,
      sortOrder: null,
      isDefault: false,
    });
  }
  return Array.from(options.values()).sort(sortLookupOptions);
}

export function mergeLookupOptions(
  options: readonly LookupOption[],
  seedOptions: readonly LookupOption[],
) {
  const merged = new Map<string, LookupOption>();
  for (const option of options) {
    const normalized = trimLookupValue(option.value);
    if (!normalized) continue;
    merged.set(normalized, {
      ...option,
      value: normalized,
    });
  }
  for (const option of seedOptions) {
    const normalized = trimLookupValue(option.value);
    if (!normalized || merged.has(normalized)) continue;
    merged.set(normalized, {
      ...option,
      value: normalized,
    });
  }
  return Array.from(merged.values()).sort(sortLookupOptions);
}

export function buildLookupOptions(params: {
  rows: LookupValueRow[] | null | undefined;
  fallback: readonly LookupOption[];
  allowedValues?: ReadonlySet<string>;
}) {
  const { rows, fallback, allowedValues } = params;
  const filteredRows = Array.isArray(rows)
    ? rows.filter((row) => {
        const value = String(row?.value ?? "").trim();
        if (!value) return false;
        if (allowedValues && !allowedValues.has(value)) return false;
        return true;
      })
    : [];

  if (filteredRows.length === 0) {
    return [...fallback];
  }

  const options = filteredRows.map((row) => {
    const value = String(row.value ?? "").trim();
    return {
      value,
      label: String(row.label ?? "").trim() || humanizeLookupValue(value),
      sortOrder:
        typeof row.sort_order === "number" && Number.isFinite(row.sort_order)
          ? row.sort_order
          : null,
      isDefault: row.is_default === true,
    } satisfies LookupOption;
  });

  options.sort(sortLookupOptions);
  return options;
}

export function resolveLookupSelection(
  currentValue: string,
  options: readonly LookupOption[],
  fallbackValue = "",
) {
  const normalizedCurrent = currentValue.trim();
  if (normalizedCurrent && options.some((option) => option.value === normalizedCurrent)) {
    return normalizedCurrent;
  }
  return options.find((option) => option.isDefault)?.value ?? options[0]?.value ?? fallbackValue;
}

function resolveRegistryScopeLabel(
  scope: {
    scope_type?: string | null;
    scope_id?: string | null;
  } | null | undefined,
  scopeOptions?: UiScopeOption[] | null,
) {
  if (!Array.isArray(scopeOptions)) return "";
  const scopeType = String(scope?.scope_type ?? "").trim().toLowerCase();
  const scopeId = String(scope?.scope_id ?? "").trim();
  if (!scopeType || !scopeId) return "";

  for (const option of scopeOptions) {
    const optionScopeType = String(option?.scope_type ?? "").trim().toLowerCase();
    const optionScopeId = String(option?.scope_id ?? "").trim();
    if (optionScopeType !== scopeType || optionScopeId !== scopeId) continue;
    const optionLabel = String(option?.scope_label ?? "").trim();
    if (optionLabel) return optionLabel;
  }

  return "";
}

export function resolveScopeDisplayLabel(
  scope: {
    scope_type?: string | null;
    scope_id?: string | null;
    scope_label?: string | null;
  } | null | undefined,
  scopeOptions?: UiScopeOption[] | null,
) {
  const label = typeof scope?.scope_label === "string" ? scope.scope_label.trim() : "";
  if (label) return label;
  const registryLabel = resolveRegistryScopeLabel(scope, scopeOptions);
  if (registryLabel) return registryLabel;
  return formatContextFallbackValue(scope?.scope_id);
}

export function resolveOrganizationDisplayLabel(params: {
  organizationId?: string | null;
  organizationName?: string | null;
}) {
  const name = trimLookupValue(params.organizationName);
  if (name) return name;
  return formatContextFallbackValue(params.organizationId);
}
