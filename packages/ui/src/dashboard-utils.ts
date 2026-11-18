import {
  hasCapability,
  matchesResourceCategory,
  resolveResourceCommandCategory,
  type UiCommandDefinition,
  type UiReadRegistry,
  type UiReadResource,
} from "@masarx/api";
import type { NavigationItem, NavigationSection } from "./navigation";

export type DashboardItem = {
  id: string;
  label: string;
  href?: string | null;
  resourceKey?: string | null;
  navigationCapability?: string | null;
  navigationAuthorityConflict?: boolean;
  disabledReason?: string | null;
};

export type DashboardSection = {
  id: string;
  label: string;
  items: DashboardItem[];
};

export type DashboardResourceReadState = {
  registryBacked: boolean;
  ambiguous: boolean;
  readAllowed: boolean;
  capability: string | null;
  resource: UiReadResource | null;
};

export type DashboardCommandCenterLane = DashboardItem & {
  resourceKey: string;
  resourceLabel: string;
  capability: string | null;
  registryBacked: boolean;
  readAllowed: boolean;
  commandCategory: string;
  commandCount: number;
  allowedCommandCount: number;
  workflowCommandCount: number;
  metricTotal: number | null;
  assignedMetricTotal?: number | null;
};

export type DashboardCommandCenterSummary = {
  laneCount: number;
  metricLaneCount: number;
  metricReadyCount: number;
  commandCount: number;
  allowedCommandCount: number;
  restrictedCommandCount: number;
  workflowCommandCount: number;
};

export type DashboardOptions = {
  capabilities?: Set<string>;
  includeResourceOnly?: boolean;
  maxSections?: number;
  maxItemsPerSection?: number;
};

export type DashboardSectionSelectionOptions = {
  includeItem?: (item: DashboardItem) => boolean;
  maxSections?: number;
  maxItemsPerSection?: number;
};

const RESOURCE_PATH = /\/resources\/([^/?#]+)/i;

function normalizeResourceKey(resourceKey?: string | null) {
  const normalized = typeof resourceKey === "string" ? resourceKey.trim().toLowerCase() : "";
  return normalized || null;
}

function normalizeCapability(capability?: string | null) {
  const normalized = typeof capability === "string" ? capability.trim() : "";
  return normalized || null;
}

function normalizeOptionalText(value?: string | null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function resolveLimit(value: number | undefined, fallback: number) {
  if (value === Number.POSITIVE_INFINITY) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const next = (value as Record<string, unknown>)[key];
      if (next !== undefined) acc[key] = stableValue(next);
      return acc;
    }, {});
}

function signature(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function resolveUniqueAuthority<T extends object>(group: T[]): T | null {
  const first = group[0];
  if (!first) return null;
  return new Set(group.map(signature)).size === 1 ? first : null;
}

function normalizeDashboardItem(item: NavigationItem): DashboardItem {
  const explicitResourceKey = normalizeResourceKey(item.resource);
  const hrefResourceKey = extractResourceKeyFromHref(item.href);
  const resourceKey = explicitResourceKey ?? hrefResourceKey;
  return {
    id: item.id,
    label: item.label,
    href: normalizeOptionalText(item.href),
    resourceKey,
    navigationCapability: normalizeCapability(item.capability),
    navigationAuthorityConflict: Boolean(
      explicitResourceKey &&
        hrefResourceKey &&
        explicitResourceKey !== hrefResourceKey,
    ),
    disabledReason: normalizeOptionalText(item.disabled_reason),
  };
}

function flattenItems(items: NavigationItem[], out: DashboardItem[]) {
  items.forEach((item) => {
    if (item.href || item.resource) out.push(normalizeDashboardItem(item));
    if (Array.isArray(item.items) && item.items.length > 0) {
      flattenItems(item.items, out);
    }
  });
}

function navigationAuthoritySignature(item: DashboardItem) {
  return signature({
    href: normalizeOptionalText(item.href),
    navigationCapability: normalizeCapability(item.navigationCapability),
    disabledReason: normalizeOptionalText(item.disabledReason),
  });
}

function buildNavigationAuthorityGroups(items: DashboardItem[]) {
  const groups = new Map<string, DashboardItem[]>();
  items.forEach((item) => {
    const resourceKey = normalizeResourceKey(item.resourceKey);
    if (!resourceKey) return;
    const group = groups.get(resourceKey) ?? [];
    group.push(item);
    groups.set(resourceKey, group);
  });
  return groups;
}

function canonicalizeDashboardItems(items: DashboardItem[]) {
  const groups = buildNavigationAuthorityGroups(items);
  const conflicted = new Set<string>();
  groups.forEach((group, key) => {
    if (
      group.some((item) => item.navigationAuthorityConflict) ||
      new Set(group.map(navigationAuthoritySignature)).size > 1
    ) {
      conflicted.add(key);
    }
  });

  const seen = new Set<string>();
  return items.filter((item) => {
    const resourceKey = normalizeResourceKey(item.resourceKey);
    if (!resourceKey) return true;
    if (conflicted.has(resourceKey) || seen.has(resourceKey)) return false;
    seen.add(resourceKey);
    return true;
  });
}

export function collectDashboardNavigationAuthorityConflicts(
  sections: NavigationSection[],
) {
  const items: DashboardItem[] = [];
  sections.forEach((section) => flattenItems(section.items ?? [], items));
  return Array.from(buildNavigationAuthorityGroups(items).entries())
    .filter(
      ([, group]) =>
        group.some((item) => item.navigationAuthorityConflict) ||
        new Set(group.map(navigationAuthoritySignature)).size > 1,
    )
    .map(([key]) => key);
}

function navigationAllowed(item: DashboardItem, capabilities?: Set<string>) {
  if (item.disabledReason) return false;
  if (!capabilities) return true;
  return hasCapability(capabilities, item.navigationCapability);
}

function normalizeResourceDefinition(resource: UiReadResource): UiReadResource | null {
  const key = normalizeResourceKey(resource?.key);
  const relation = normalizeOptionalText(resource?.relation);
  if (!key || !relation) return null;
  return {
    ...resource,
    key,
    relation,
    capability_read: normalizeCapability(resource.capability_read),
    capability_write: normalizeCapability(resource.capability_write),
  };
}

function buildResourceAuthorityIndex(registry: UiReadRegistry | null | undefined) {
  const groups = new Map<string, UiReadResource[]>();
  registry?.resources?.forEach((resource) => {
    const normalized = normalizeResourceDefinition(resource);
    if (!normalized) return;
    const group = groups.get(normalized.key) ?? [];
    group.push(normalized);
    groups.set(normalized.key, group);
  });

  const resources = new Map<string, UiReadResource>();
  const ambiguous = new Set<string>();
  groups.forEach((group, key) => {
    const resource = resolveUniqueAuthority(group);
    if (!resource) {
      ambiguous.add(key);
      return;
    }
    resources.set(key, resource);
  });
  return {
    registryResolved: Array.isArray(registry?.resources),
    resources,
    ambiguous,
  };
}

export function collectDashboardResourceAuthorityConflicts(
  registry: UiReadRegistry | null | undefined,
) {
  return Array.from(buildResourceAuthorityIndex(registry).ambiguous);
}

function normalizeCommandDefinition(command: UiCommandDefinition): UiCommandDefinition | null {
  const key = normalizeOptionalText(command?.key)?.toLowerCase() ?? null;
  if (!key) return null;
  return {
    ...command,
    key,
    label: String(command.label || "").trim(),
    capability: normalizeCapability(command.capability),
    workflow_key: normalizeOptionalText(command.workflow_key),
    binding_key: normalizeOptionalText(command.binding_key),
    stage_key: normalizeOptionalText(command.stage_key),
  };
}

function buildCommandAuthorityGroups(commands: UiCommandDefinition[]) {
  const groups = new Map<string, UiCommandDefinition[]>();
  commands.forEach((command) => {
    const normalized = normalizeCommandDefinition(command);
    if (!normalized) return;
    const group = groups.get(normalized.key) ?? [];
    group.push(normalized);
    groups.set(normalized.key, group);
  });
  return groups;
}

export function normalizeDashboardCommands(commands: UiCommandDefinition[]) {
  const result: UiCommandDefinition[] = [];
  buildCommandAuthorityGroups(commands).forEach((group) => {
    const command = resolveUniqueAuthority(group);
    if (command) result.push(command);
  });
  return result;
}

export function collectDashboardCommandAuthorityConflicts(
  commands: UiCommandDefinition[],
) {
  return Array.from(buildCommandAuthorityGroups(commands).entries())
    .filter(([, group]) => !resolveUniqueAuthority(group))
    .map(([key]) => key);
}

export function extractResourceKeyFromHref(href?: string | null) {
  if (!href) return null;
  const match = href.match(RESOURCE_PATH);
  return match ? normalizeResourceKey(match[1]) : null;
}

export function buildDashboardSections(
  sections: NavigationSection[],
  options: DashboardOptions = {},
): DashboardSection[] {
  const includeResourceOnly = options.includeResourceOnly === true;
  const candidates = sections.map((section) => {
    const items: DashboardItem[] = [];
    flattenItems(section.items ?? [], items);
    return { id: section.id, label: section.label, items };
  });
  const canonicalItems = canonicalizeDashboardItems(
    candidates.flatMap((section) => section.items),
  );
  const canonicalSet = new Set(canonicalItems);
  const filtered = candidates
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          canonicalSet.has(item) &&
          navigationAllowed(item, options.capabilities) &&
          Boolean(item.href || (includeResourceOnly && item.resourceKey)),
      ),
    }))
    .filter((section) => section.items.length > 0);

  return selectDashboardSections(filtered, options);
}

export function selectDashboardSections(
  sections: DashboardSection[],
  options: DashboardSectionSelectionOptions = {},
) {
  const maxSections = resolveLimit(options.maxSections, sections.length);
  const maxItems = resolveLimit(options.maxItemsPerSection, 6);
  return sections
    .map((section) => ({
      ...section,
      items: section.items
        .filter((item) => options.includeItem?.(item) ?? true)
        .slice(0, maxItems),
    }))
    .filter((section) => section.items.length > 0)
    .slice(0, maxSections);
}

export function collectResourceKeys(sections: DashboardSection[]) {
  const keys = new Set<string>();
  sections.forEach((section) => {
    section.items.forEach((item) => {
      const resourceKey = normalizeResourceKey(item.resourceKey);
      if (resourceKey) keys.add(resourceKey);
    });
  });
  return Array.from(keys);
}

export function resolveDashboardResourceReadState(
  resourceKey: string | null | undefined,
  registry: UiReadRegistry | null | undefined,
  capabilities: Set<string>,
): DashboardResourceReadState {
  const normalizedKey = normalizeResourceKey(resourceKey);
  if (!normalizedKey) {
    return {
      registryBacked: true,
      ambiguous: false,
      readAllowed: true,
      capability: null,
      resource: null,
    };
  }
  const index = buildResourceAuthorityIndex(registry);
  if (index.ambiguous.has(normalizedKey)) {
    return {
      registryBacked: false,
      ambiguous: true,
      readAllowed: false,
      capability: null,
      resource: null,
    };
  }
  const resource = index.resources.get(normalizedKey) ?? null;
  const capability = normalizeCapability(resource?.capability_read);
  const readAllowed =
    index.registryResolved &&
    Boolean(resource) &&
    Boolean(capability) &&
    hasCapability(capabilities, capability);
  return {
    registryBacked: index.registryResolved && Boolean(resource),
    ambiguous: false,
    readAllowed,
    capability,
    resource,
  };
}

export function commandResourceReadAllowed(
  command: UiCommandDefinition,
  registry: UiReadRegistry | null | undefined,
  capabilities: Set<string>,
) {
  const index = buildResourceAuthorityIndex(registry);
  if (!index.registryResolved) return false;
  const resourceKey = resolveCommandResourceKey(command, index);
  if (!resourceKey) return false;
  return resolveDashboardResourceReadState(
    resourceKey,
    registry,
    capabilities,
  ).readAllowed;
}

function resolveCommandResourceKey(
  command: UiCommandDefinition,
  index: ReturnType<typeof buildResourceAuthorityIndex>,
) {
  if (
    Array.from(index.ambiguous).some((key) =>
      matchesResourceCategory(command.schema_category, key),
    )
  ) {
    return null;
  }
  const matching = Array.from(index.resources.keys()).filter((key) =>
    matchesResourceCategory(command.schema_category, key),
  );
  return matching.length === 1 ? matching[0] : null;
}

function collectDashboardItems(sections: DashboardSection[]) {
  return canonicalizeDashboardItems(sections.flatMap((section) => section.items));
}

function isWorkflowCommand(command: UiCommandDefinition) {
  return (
    command.execution?.type === "workflow" ||
    command.execution?.type === "workflow_binding" ||
    Boolean(command.workflow_key)
  );
}

export function buildDashboardCommandCenterLanes(params: {
  sections: DashboardSection[];
  readRegistry?: UiReadRegistry | null;
  commands: UiCommandDefinition[];
  capabilities: Set<string>;
  resourceCounts: Map<string, number | null>;
  maxLanes?: number;
}): DashboardCommandCenterLane[] {
  const commands = normalizeDashboardCommands(params.commands);
  const resourceIndex = buildResourceAuthorityIndex(params.readRegistry);
  const lanes: DashboardCommandCenterLane[] = [];
  const maxLanes =
    typeof params.maxLanes === "number" && params.maxLanes > 0
      ? Math.floor(params.maxLanes)
      : Number.POSITIVE_INFINITY;

  collectDashboardItems(params.sections).forEach((item) => {
    if (lanes.length >= maxLanes) return;
    const resourceKey = normalizeResourceKey(item.resourceKey);
    if (
      !resourceKey ||
      item.disabledReason ||
      !hasCapability(params.capabilities, item.navigationCapability)
    ) {
      return;
    }
    const readState = resolveDashboardResourceReadState(
      resourceKey,
      params.readRegistry,
      params.capabilities,
    );
    if (!readState.readAllowed || !readState.resource) return;

    const resourceCommands = commands.filter(
      (command) =>
        resolveCommandResourceKey(command, resourceIndex) === resourceKey,
    );
    const categoryCommands = [...resourceCommands].sort((left, right) => {
      const categoryOrder = String(left.schema_category || "").localeCompare(
        String(right.schema_category || ""),
      );
      return categoryOrder || left.key.localeCompare(right.key);
    });
    const commandCategory =
      resolveResourceCommandCategory({
        resourceKey,
        commands: categoryCommands,
      }) ?? "resource:" + resourceKey;
    const catalogCommands = resourceCommands.filter(
      (command) => command.schema_category === commandCategory,
    );
    const allowedCommandCount = catalogCommands.filter((command) =>
      hasCapability(params.capabilities, command.capability),
    ).length;
    const labelRaw = readState.resource.label ?? item.label ?? resourceKey;
    const resourceLabel =
      typeof labelRaw === "string" && labelRaw.trim()
        ? labelRaw.trim()
        : resourceKey;

    lanes.push({
      ...item,
      resourceKey,
      resourceLabel,
      capability: readState.capability,
      registryBacked: true,
      readAllowed: true,
      commandCategory,
      commandCount: catalogCommands.length,
      allowedCommandCount,
      workflowCommandCount: catalogCommands.filter(isWorkflowCommand).length,
      metricTotal: params.resourceCounts.has(resourceKey)
        ? (params.resourceCounts.get(resourceKey) ?? null)
        : null,
      ...(resourceKey === "manual_review_tasks" &&
      params.resourceCounts.has("manual_review_tasks.assigned")
        ? {
            assignedMetricTotal:
              params.resourceCounts.get("manual_review_tasks.assigned") ?? null,
          }
        : {}),
    });
  });

  return lanes;
}

export function buildDashboardCommandCenterSummary(params: {
  lanes: DashboardCommandCenterLane[];
}): DashboardCommandCenterSummary {
  const lanes = params.lanes.filter((lane) => lane.readAllowed);
  const commandCount = lanes.reduce(
    (total, lane) => total + lane.commandCount,
    0,
  );
  const allowedCommandCount = lanes.reduce(
    (total, lane) => total + lane.allowedCommandCount,
    0,
  );
  const workflowCommandCount = lanes.reduce(
    (total, lane) => total + lane.workflowCommandCount,
    0,
  );
  return {
    laneCount: lanes.length,
    metricLaneCount: lanes.length,
    metricReadyCount: lanes.filter((lane) => lane.metricTotal !== null).length,
    commandCount,
    allowedCommandCount,
    restrictedCommandCount: Math.max(commandCount - allowedCommandCount, 0),
    workflowCommandCount,
  };
}
