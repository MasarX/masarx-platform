import * as React from "react";
import { createUiClient } from "@masarx/api";
import { formatReferenceValue, isUuidValue } from "./resource-utils";

export type ResourceLookupConfig = {
  resource: string;
  valueKey?: string | null;
  labelKeys?: string[] | null;
  filters?: Record<string, unknown> | null;
  limit?: number | null;
};

export type ResourceLookupOption = {
  value: string;
  label: string;
};

export type ResourceLookupState = {
  items: ResourceLookupOption[];
  loading: boolean;
  error: string | null;
};

function normalizeOptionText(value: unknown) {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeIdentifier(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isRawLookupLabel(value: string, id: string) {
  const normalized = value.trim();
  if (!normalized) return true;
  if (normalized.toLowerCase() === id.trim().toLowerCase()) return true;
  return isUuidValue(normalized);
}

function resolveLabelKeys(config: ResourceLookupConfig) {
  const keys = Array.isArray(config.labelKeys)
    ? config.labelKeys
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : [];
  return keys.length > 0 ? keys : ["name"];
}

function resolveOptionLabel(record: Record<string, unknown>, config: ResourceLookupConfig, id: string) {
  const labelKeys = resolveLabelKeys(config);
  const labelParts = labelKeys
    .map((key) => normalizeOptionText(record[key]))
    .filter((entry): entry is string => Boolean(entry))
    .filter((entry) => !isRawLookupLabel(entry, id));
  if (labelParts.length > 0) {
    return labelParts.join(" | ");
  }
  const name = normalizeOptionText(record.name);
  if (name && !isRawLookupLabel(name, id)) return name;
  return formatReferenceValue(id);
}

export function buildResourceLookupComboboxOptions(params: {
  items: ResourceLookupOption[];
  selectedValue: string;
  fallbackLabel: string;
}) {
  const selectedValue = params.selectedValue.trim();
  const resolved = params.items.map((item) => ({
    label: item.label,
    value: item.value,
  }));
  if (!selectedValue) return resolved;
  if (resolved.some((item) => item.value === selectedValue)) return resolved;
  return [
    {
      label: params.fallbackLabel,
      value: selectedValue,
    },
    ...resolved,
  ];
}

export function useResourceLookupOptions(
  config: ResourceLookupConfig | null,
  enabled: boolean,
): ResourceLookupState {
  const [state, setState] = React.useState<ResourceLookupState>({
    items: [],
    loading: false,
    error: null,
  });

  React.useEffect(() => {
    if (!enabled || !config) {
      setState({ items: [], loading: false, error: null });
      return undefined;
    }

    const ui = createUiClient();
    let cancelled = false;

    setState((current) => ({ items: current.items, loading: true, error: null }));

    void (async () => {
      try {
        const valueKey = config.valueKey?.trim() || "id";
        const labelKeys = resolveLabelKeys(config);
        const orderKey = labelKeys[0] ?? "name";
        const limit = Math.max(1, Math.min(500, config.limit ?? 100));
        const result = await ui.listResource(
          config.resource,
          config.filters ?? {},
          limit,
          0,
          { key: orderKey, direction: "asc" },
        );

        if (cancelled) return;

        const items = Array.isArray(result.items)
          ? result.items
              .map((row) => {
                const record =
                  row && typeof row === "object" && !Array.isArray(row)
                    ? (row as Record<string, unknown>)
                    : null;
                if (!record) return null;
                const id = normalizeIdentifier(
                  normalizeOptionText(record[valueKey] ?? record.id),
                );
                if (!id) return null;
                return {
                  value: id,
                  label: resolveOptionLabel(record, { ...config, labelKeys }, id),
                };
              })
              .filter((item): item is ResourceLookupOption => item !== null)
          : [];

        const seen = new Set<string>();
        const unique = items.filter((item) => {
          if (seen.has(item.value)) return false;
          seen.add(item.value);
          return true;
        });

        setState({ items: unique, loading: false, error: null });
      } catch (error) {
        if (cancelled) return;
        const message =
          error && typeof error === "object" && "message" in error
            ? String((error as { message?: unknown }).message ?? "").trim()
            : "";
        setState({
          items: [],
          loading: false,
          error: message || "Resource options unavailable.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [config, enabled]);

  return state;
}
