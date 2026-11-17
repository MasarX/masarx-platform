import type { ReadRegistry, CommandDefinition, NavigationSection } from "./role-matrix";
import { collectAccessibleResourceKeys } from "./action-matrix";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { createAuthedSupabaseClient, rpcWithRetry, signOutSupabaseClient } from "./supabase";
import {
  matchesResourceCategory,
  resolveResourceBulkActions,
} from "../../../packages/ui/src/resource-actions-core";
import type { TranslateFn } from "../../../packages/ui/src/table/types";

type ResourceScore = {
  key: string;
  score: number;
};

type ResourceListResult = {
  id: string | null;
  total: number;
};

type ResourceFieldResult = {
  value: string | null;
  total: number;
};
type ResourceRowResult = {
  item: Record<string, unknown> | null;
  total: number;
};

type ResourceActionTarget = {
  resourceKey: string;
  actionKey: string;
};

const fallbackTranslate: TranslateFn = (key) => key;

function inferAppKeyFromBasePath(appBasePath: string): "console" | "portal" {
  const normalized = appBasePath.trim().toLowerCase();
  return normalized.includes("portal") ? "portal" : "console";
}

export function resolveResourceKeyByLabel(params: {
  readRegistry: ReadRegistry | null;
  resourceKeys?: string[];
  keyword: string;
}) {
  const keyword = params.keyword.trim().toLowerCase();
  if (!keyword) return null;
  const resources = Array.isArray(params.readRegistry?.resources)
    ? params.readRegistry?.resources
    : [];
  const allowed = params.resourceKeys
    ? new Set(params.resourceKeys)
    : null;
  const scored = resources
    .filter((resource) => !allowed || allowed.has(resource.key))
    .map((resource) => {
      const key = resource.key;
      const label = (resource.label ?? "").trim().toLowerCase();
      const keyLower = key.trim().toLowerCase();
      const labelMatch = label.includes(keyword);
      const keyMatch = keyLower.includes(keyword);
      const score = (labelMatch ? 2 : 0) + (keyMatch ? 1 : 0);
      return { key, score };
    })
    .filter((entry) => entry.score > 0);
  if (scored.length === 0) return null;
  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return left.key.localeCompare(right.key);
  });
  return scored[0]?.key ?? null;
}

export function resolveResourceKeyByActionTypes(params: {
  resourceKeys: string[];
  readRegistry: ReadRegistry | null;
  commandRegistry: CommandDefinition[];
  capabilities?: string[] | null;
  appKey?: "console" | "portal";
  appBasePath: string;
  downloadBasePath: string;
  requiredTypes: string[];
}) {
  const {
    resourceKeys,
    readRegistry,
    commandRegistry,
    capabilities,
    appKey,
    appBasePath,
    downloadBasePath,
    requiredTypes,
  } = params;
  const resolvedAppKey = appKey ?? inferAppKeyFromBasePath(appBasePath);
  const resources = Array.isArray(readRegistry?.resources)
    ? readRegistry?.resources
    : [];
  const required = requiredTypes.filter((value) => value.trim().length > 0);
  let bestMatch: { key: string; score: number } | null = null;
  for (const resourceKey of resourceKeys) {
    const resource =
      resources.find((entry) => entry?.key === resourceKey) ?? null;
    const commands = commandRegistry.filter((command) =>
      matchesResourceCategory(command?.schema_category ?? null, resourceKey)
    );
    const actions = resolveResourceBulkActions({
      t: fallbackTranslate,
      resourceKey,
      resource,
      commands,
      appKey: resolvedAppKey,
      appBasePath,
      downloadBasePath,
      userCapabilities: capabilities ?? [],
    });
    const types = new Set(
      actions
        .map((action) => action.execution?.type ?? "navigate")
        .filter((type): type is string => Boolean(type))
    );
    const score = required.reduce(
      (count, type) => count + (types.has(type) ? 1 : 0),
      0
    );
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { key: resourceKey, score };
    }
    if (score === required.length) {
      return resourceKey;
    }
  }
  return bestMatch?.score ? bestMatch.key : null;
}

export function resolveResourceKeysForUser(params: {
  sections: NavigationSection[];
  readRegistry: ReadRegistry | null;
  commandRegistry: CommandDefinition[];
  capabilities?: string[] | null;
}): string[] {
  const { sections, readRegistry, commandRegistry, capabilities } = params;
  let keys = collectAccessibleResourceKeys({
    sections,
    capabilities,
  });
  if (keys.length === 0) {
    keys = Array.isArray(readRegistry?.resources)
      ? readRegistry?.resources
          .map((entry) => entry?.key?.trim() ?? "")
          .filter(Boolean)
      : [];
  }

  const resources = Array.isArray(readRegistry?.resources)
    ? readRegistry?.resources
    : [];
  const scores: ResourceScore[] = keys.map((key) => {
    const resource = resources.find((entry) => entry?.key === key) ?? null;
    const hasFilters = (resource?.filters?.length ?? 0) > 0;
    const hasDownload = Boolean(resource?.download);
    const commandCount = commandRegistry.filter((command) =>
      matchesResourceCategory(command?.schema_category ?? null, key)
    ).length;
    const score =
      (commandCount > 0 ? 2 : 0) + (hasFilters ? 1 : 0) + (hasDownload ? 1 : 0);
    return { key, score };
  });

  return scores
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return left.key.localeCompare(right.key);
    })
    .map((entry) => entry.key);
}

const DEFAULT_CORE_RESOURCE_LIMIT = 12;

function parseResourceLimit(rawLimit: string, fallback: number) {
  const trimmed = rawLimit.trim().toLowerCase();
  if (!trimmed) return { limit: fallback, apply: true };
  if (trimmed === "all" || trimmed === "0") return { limit: 0, apply: false };
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { limit: fallback, apply: true };
  }
  return { limit: parsed, apply: true };
}

export function applyResourceLimit(
  keys: string[],
  envVar = "E2E_CORE_RESOURCE_LIMIT",
  fallbackLimit = DEFAULT_CORE_RESOURCE_LIMIT
): string[] {
  const rawLimit = String(process.env[envVar] || "");
  const { limit, apply } = parseResourceLimit(rawLimit, fallbackLimit);
  if (!apply) return keys;
  return keys.slice(0, Math.min(keys.length, limit));
}

export function deriveMissingResourceKey(keys: string[]): string {
  const base = keys[0]?.trim() || "resource";
  let candidate = `${base}_missing`;
  const keySet = new Set(keys);
  while (keySet.has(candidate)) {
    candidate = `${candidate}_x`;
  }
  return candidate;
}

export function resolveConfirmableActions(params: {
  resourceKey: string;
  commandRegistry: CommandDefinition[];
  capabilities?: string[] | null;
}): string[] {
  const { resourceKey, commandRegistry, capabilities } = params;
  const capabilitySet = resolveCapabilitySet(capabilities);
  return commandRegistry
    .filter((command) =>
      matchesResourceCategory(command?.schema_category ?? null, resourceKey)
    )
    .filter((command) => {
      const capability = command?.capability?.trim() ?? "";
      if (capability && !hasCapability(capabilitySet, capability)) return false;
      return Boolean(command?.execution?.confirm);
    })
    .map((command) => command?.key)
    .filter((key): key is string => Boolean(key && key.trim()))
    .map((key) => key.trim());
}

export function resolveResourceActionTarget(params: {
  resourceKeys: string[];
  readRegistry: ReadRegistry | null;
  commandRegistry: CommandDefinition[];
  capabilities?: string[] | null;
  appKey?: "console" | "portal";
  appBasePath: string;
  downloadBasePath: string;
  actionType: string;
  requireConfirm?: boolean;
}): ResourceActionTarget | null {
  const {
    resourceKeys,
    readRegistry,
    commandRegistry,
    capabilities,
    appKey,
    appBasePath,
    downloadBasePath,
    actionType,
    requireConfirm = false,
  } = params;
  const resolvedAppKey = appKey ?? inferAppKeyFromBasePath(appBasePath);
  const resources = Array.isArray(readRegistry?.resources)
    ? readRegistry?.resources
    : [];
  const userCapabilities = capabilities ?? [];
  for (const resourceKey of resourceKeys) {
    const resource =
      resources.find((entry) => entry?.key === resourceKey) ?? null;
    const commands = commandRegistry.filter((command) =>
      matchesResourceCategory(command?.schema_category ?? null, resourceKey)
    );
    const actions = resolveResourceBulkActions({
      t: fallbackTranslate,
      resourceKey,
      resource,
      commands,
      appKey: resolvedAppKey,
      appBasePath,
      downloadBasePath,
      userCapabilities,
    });
    const match = actions.find((action) => {
      if (action.execution?.type !== actionType) return false;
      if (!requireConfirm) return true;
      return Boolean(action.execution?.confirm);
    });
    if (match) {
      return { resourceKey, actionKey: match.key };
    }
  }
  return null;
}

export async function fetchResourceSampleId(params: {
  resourceKey: string;
  idColumn?: string | null;
  email: string;
  password: string;
}): Promise<ResourceListResult> {
  const { resourceKey, idColumn, email, password } = params;
  const sample = await fetchResourceSampleRow({
    resourceKey,
    email,
    password,
  });
  if (!sample.item) return { id: null, total: sample.total };
  const idKey = (idColumn || "id").trim() || "id";
  const idValue = sample.item[idKey] ?? sample.item.id ?? null;
  return { id: idValue ? String(idValue) : null, total: sample.total };
}

export async function fetchResourceSampleField(params: {
  resourceKey: string;
  fieldCandidates: string[];
  email: string;
  password: string;
}): Promise<ResourceFieldResult> {
  const { resourceKey, fieldCandidates, email, password } = params;
  const sample = await fetchResourceSampleRow({
    resourceKey,
    email,
    password,
  });
  if (!sample.item) return { value: null, total: sample.total };
  const value = resolveItemFieldValue(sample.item, fieldCandidates);
  return { value, total: sample.total };
}

export async function fetchResourceSampleRow(params: {
  resourceKey: string;
  email: string;
  password: string;
}): Promise<ResourceRowResult> {
  const { resourceKey, email, password } = params;
  const supabase = await createAuthedSupabaseClient({
    email,
    password,
    label: `resource-sample:${resourceKey}:${email}`,
  });

  try {
    const { data, error } = await rpcWithRetry<any>(supabase, "ui_list_resource_v1", {
      p_resource: resourceKey,
      p_filters: {},
      p_limit: 1,
      p_offset: 0,
      p_sort: null,
    }, {
      label: `ui_list_resource_v1:${resourceKey}:${email}`,
    });
    if (error || !data) {
      throw new Error(
        `Failed to list resource ${resourceKey}: ${(error as any)?.message || "no data"}`
      );
    }
    const items = Array.isArray(data.items) ? data.items : [];
    const total =
      typeof data.total === "number" ? data.total : items.length;
    const item =
      items.length > 0 && items[0] && typeof items[0] === "object"
        ? (items[0] as Record<string, unknown>)
        : null;
    return { item, total };
  } finally {
    await signOutSupabaseClient(supabase, { label: `resource-sample:${resourceKey}:${email}` });
  }
}

export function resolveItemFieldValue(
  item: Record<string, unknown>,
  fieldCandidates: string[]
): string | null {
  const keys = Object.keys(item);
  const keyMap = new Map(keys.map((key) => [key.toLowerCase(), key]));
  const normalizedCandidates = fieldCandidates
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  for (const candidate of normalizedCandidates) {
    const direct = keyMap.get(candidate.toLowerCase());
    if (direct) {
      const value = item[direct];
      if (typeof value === "string" || typeof value === "number") {
        return String(value);
      }
    }
    const loose = keys.find((key) =>
      key.toLowerCase().includes(candidate.toLowerCase())
    );
    if (loose) {
      const value = item[loose];
      if (typeof value === "string" || typeof value === "number") {
        return String(value);
      }
    }
  }
  return null;
}
