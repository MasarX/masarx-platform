"use client";

import { useQuery } from "@tanstack/react-query";
import { createUiClient } from "@masarx/api";

export type SchemaRegistryEntry = {
  id: string;
  category: string;
  version: number;
  schema: unknown;
  description: string | null;
  examples: unknown;
  isActive: boolean | null;
  createdAt: string | null;
};

function normalizeText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  return null;
}

function normalizeSchemaEntry(value: Record<string, unknown>): SchemaRegistryEntry | null {
  const id = normalizeText(value.id);
  const category = normalizeText(value.category);
  const version = normalizeNumber(value.version);
  if (!id || !category || version === null) return null;
  return {
    id,
    category,
    version,
    schema: value.schema ?? null,
    description: normalizeText(value.description),
    examples: value.examples ?? null,
    isActive: normalizeBoolean(value.is_active),
    createdAt: normalizeText(value.created_at),
  };
}

type SchemaRegistryOptions = {
  enabled?: boolean;
  staleTime?: number;
};

export function useSchemaRegistryEntry(category: string, options?: SchemaRegistryOptions) {
  const normalizedCategory = category.trim();
  return useQuery({
    queryKey: ["schema_registry", normalizedCategory] as const,
    queryFn: async () => {
      const ui = createUiClient();
      const list = await ui.listResource(
        "schema_registry",
        { category: normalizedCategory, is_active: true },
        1,
        0,
        { key: "version", direction: "desc" }
      );
      const first =
        Array.isArray(list.items) && list.items.length > 0
          ? (list.items[0] as Record<string, unknown>)
          : null;
      if (!first) return null;
      return normalizeSchemaEntry(first);
    },
    enabled: Boolean(normalizedCategory) && (options?.enabled ?? true),
    staleTime: options?.staleTime,
  });
}

