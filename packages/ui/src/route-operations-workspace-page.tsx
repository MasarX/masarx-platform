import "server-only";
import { createUiServerClient } from "@masarx/api/server";
import { getVerifiedUser } from "@masarx/auth";
import {
  matchesResourceCategory,
  normalizeNavigation,
  normalizeCommandRegistry,
  normalizeUiScopeType,
  resolveResourceCommandCategory,
  type UiCommandDefinition,
  type UiMe,
  type UiReadResource,
  type UiReadRegistry,
} from "@masarx/api";
import { Badge } from "./badge";
import { Button } from "./button";
import { ContextNotice } from "./context-notice";
import { EmptyState } from "./empty-state";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { ResourcePage } from "./resource-page";
import { Section } from "./section";
import { createUiTranslator } from "./i18n";
import type { NavigationItem, NavigationSection } from "./navigation";
import { buildTestId } from "./test-ids";
import { buildHref } from "./url";
import { formatUiError } from "./utils";
import { resolveSafeHref } from "./url-guard";

type SearchParams = Record<string, string | string[] | undefined>;

type RouteOperationsWorkspacePageProps = {
  appBasePath: string;
  appKey: "console" | "portal";
  searchParams?: SearchParams;
  resourceKey?: string | null;
  sectionId?: string;
  resourceSelector?: "all" | "exceptions";
  workspacePathSegment?: string;
  i18nNamespace?: "ui.routeOperations" | "ui.exceptionInbox";
  testIdPrefix?: string;
};

type WorkspaceResource = {
  key: string;
  label: string;
  capability: string | null;
  href: string | null;
  commandCategory: string | null;
  workflowCommandCount: number;
  commandHref: string | null;
  sectionLabel: string;
  count: number | null;
  disabledReason: string | null;
  exceptionSignals?: ExceptionSignals | null;
  routeSignals?: RouteMonitorSignals | null;
};

const EXCEPTION_KEYWORDS = [
  "exception",
  "exceptions",
  "error",
  "errors",
  "failed",
  "failure",
  "alert",
  "alerts",
  "incident",
  "incidents",
  "issue",
  "issues",
  "manual_review",
  "review_queue",
  "dead_letter",
  "retry",
  "retries",
  "blocked",
  "reject",
  "rejected",
  "delay",
  "delayed",
  "sla",
  "breach",
  "violation",
];

const EXCEPTION_CRITICAL_KEYWORDS = [
  "critical",
  "urgent",
  "sev1",
  "p0",
  "incident",
];

const EXCEPTION_HIGH_KEYWORDS = [
  "high",
  "sev2",
  "p1",
  "failed",
  "failure",
  "error",
  "alert",
];

const EXCEPTION_SLA_RISK_KEYWORDS = [
  "sla",
  "breach",
  "violation",
  "delay",
  "delayed",
  "late",
  "overdue",
  "timeout",
];

const EXCEPTION_SLA_COUNTDOWN_KEYWORDS = [
  "countdown",
  "deadline",
  "due_at",
  "sla_due_at",
  "expires_at",
  "remaining",
  "time_left",
  "eta",
];

const EXCEPTION_MANUAL_REVIEW_KEYWORDS = [
  "manual_review",
  "review_queue",
  "manual review",
  "dispatch_exception_review",
  "dispatch exception review",
];

const EXCEPTION_RETRY_KEYWORDS = ["retry", "retries", "dead_letter"];

const EXCEPTION_UNOWNED_KEYWORDS = [
  "unassigned",
  "unowned",
  "without_owner",
  "owner_missing",
  "assignee_missing",
  "no_owner",
];

const EXCEPTION_OWNERSHIP_KEYWORDS = [
  "owner",
  "assignee",
  "assigned_to",
  "my exception review",
  "dispatch_exception_review_mine",
  "driver",
  "courier",
  "dispatcher",
  "agent",
];

type ExceptionSignals = {
  severity: "critical" | "high" | "normal";
  hasSlaRisk: boolean;
  hasSlaCountdown: boolean;
  hasManualReview: boolean;
  hasRetry: boolean;
  hasUnownedSignal: boolean;
  hasOwnershipSignal: boolean;
  score: number;
};

const ROUTE_TIMELINE_KEYWORDS = [
  "timeline",
  "time_window",
  "time window",
  "eta",
  "arrival",
  "departure",
  "schedule",
  "sequence",
  "stop",
  "stops",
  "route",
  "routes",
  "dispatch",
];

const ROUTE_MAP_KEYWORDS = [
  "map",
  "geo",
  "geocode",
  "lat",
  "lng",
  "latitude",
  "longitude",
  "location",
  "tracking",
  "waypoint",
  "zone",
  "distance",
  "path",
  "route",
];

const ROUTE_ASSIGNMENT_KEYWORDS = [
  "assign",
  "assignment",
  "driver",
  "courier",
  "vehicle",
  "fleet",
  "dispatcher",
  "capacity",
  "load",
  "owner",
];

const ROUTE_PLANNING_KEYWORDS = [
  "plan",
  "planning",
  "optimizer",
  "optimize",
  "constraint",
  "skill",
  "capacity",
  "time_window",
  "route_plan",
  "route plan",
];

const ROUTE_RISK_KEYWORDS = [
  "risk",
  "late",
  "delay",
  "delayed",
  "breach",
  "violation",
  "blocked",
  "failed",
  "failure",
  "exception",
  "alert",
  "incident",
  "sla",
];

const ROUTE_TIME_WINDOW_KEYWORDS = [
  "time_window",
  "time window",
  "pickup_window",
  "delivery_window",
  "window_start",
  "window_end",
  "eta",
  "deadline",
  "slot",
  "schedule",
];

const ROUTE_CAPACITY_KEYWORDS = [
  "capacity",
  "vehicle_capacity",
  "load",
  "max_load",
  "weight",
  "volume",
  "box_count",
  "quota",
  "limit",
];

const ROUTE_SKILL_KEYWORDS = [
  "skill",
  "skills",
  "qualification",
  "certification",
  "service_type",
  "vehicle_type",
  "capability",
  "driver_type",
  "specialty",
];

const ROUTE_POD_KEYWORDS = [
  "pod",
  "proof_of_delivery",
  "proof of delivery",
  "delivery_photo",
  "photo",
  "image",
  "signature",
  "recipient_signature",
  "barcode",
  "scan",
  "delivered_at",
  "delivery_confirmation",
  "evidence",
];

const ROUTE_CUSTOMER_ACTION_KEYWORDS = [
  "customer",
  "recipient",
  "reschedule",
  "instruction",
  "instructions",
  "message",
  "communication",
  "feedback",
  "issue",
  "support",
  "request",
  "delivery_note",
];

type RouteMonitorSignals = {
  hasTimeline: boolean;
  hasMap: boolean;
  hasAssignment: boolean;
  hasPlanning: boolean;
  hasRisk: boolean;
  hasTimeWindowConstraint: boolean;
  hasCapacityConstraint: boolean;
  hasSkillConstraint: boolean;
  hasPodEvidence: boolean;
  hasCustomerAction: boolean;
  score: number;
};

type ResourceCommandSignals = {
  category: string | null;
  workflowCommandCount: number;
};

const AUTOMATION_COMMAND_TYPES = new Set(["workflow", "rpc"]);

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function resolveScopeLabel(me: UiMe | null, t: ReturnType<typeof createUiTranslator>) {
  const scope = me?.access_scope;
  const scopeType = normalizeUiScopeType(scope?.scope_type ?? null);
  if (!scopeType) return t("unknown");
  const scopeLabelRaw = scope?.scope_label ?? scope?.scope_id ?? "";
  const scopeLabel = typeof scopeLabelRaw === "string" ? scopeLabelRaw.trim() : "";
  if (scopeType === "global" && !scopeLabel) return scopeType;
  return t("scopeLabel", { scopeType, scopeLabel: scopeLabel || t("unknown") });
}

function flattenSectionResources(section: NavigationSection | null) {
  const entries: Array<{
    key: string;
    sectionLabel: string;
    disabledReason: string | null;
  }> = [];

  const visit = (item: NavigationItem) => {
    const resourceKey = typeof item.resource === "string" ? item.resource.trim() : "";
    if (resourceKey) {
      entries.push({
        key: resourceKey,
        sectionLabel: section?.label ?? "",
        disabledReason: item.disabled_reason ?? null,
      });
    }
    if (Array.isArray(item.items) && item.items.length > 0) {
      item.items.forEach(visit);
    }
  };

  section?.items?.forEach(visit);
  return entries;
}

function dedupeResourceEntries(
  entries: Array<{
    key: string;
    sectionLabel: string;
    disabledReason: string | null;
  }>
) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!entry.key || seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
}

async function resolveResourceCounts(
  ui: ReturnType<typeof createUiServerClient>,
  resourceKeys: string[]
) {
  const counts = new Map<string, number | null>();
  if (resourceKeys.length === 0) return counts;

  try {
    const metrics = await ui.dashboardMetrics(resourceKeys);
    if (Array.isArray(metrics?.metrics)) {
      metrics.metrics.forEach((metric) => {
        counts.set(
          metric.resource,
          typeof metric.total === "number" && Number.isFinite(metric.total)
            ? metric.total
            : null
        );
      });
    }
  } catch {
    // Fall through to per-resource fallback.
  }

  const missingKeys = resourceKeys.filter((key) => !counts.has(key));
  if (missingKeys.length === 0) return counts;

  await Promise.all(
    missingKeys.map(async (key) => {
      try {
        const list = await ui.listResource(key, {}, 1, 0, null);
        const total =
          typeof list.total === "number" && Number.isFinite(list.total)
            ? list.total
            : list.items.length;
        counts.set(key, total);
      } catch {
        counts.set(key, null);
      }
    })
  );

  return counts;
}

function normalizeResourceMeta(registry: UiReadRegistry | null, key: string) {
  const resource = registry?.resources?.find((entry) => entry.key === key);
  const labelRaw = resource?.label ?? key;
  const label =
    typeof labelRaw === "string" && labelRaw.trim() ? labelRaw.trim() : key;
  return {
    label,
    capability: resource?.capability_read ?? null,
    resource,
  };
}

function buildResourceSearchIndex(
  resource: UiReadResource | null | undefined,
  key: string,
  label: string
) {
  const parts: string[] = [key, label];
  if (resource?.relation) parts.push(resource.relation);
  if (Array.isArray(resource?.filters)) {
    resource.filters.forEach((filter) => {
      if (typeof filter?.key === "string") parts.push(filter.key);
      if (typeof filter?.column === "string") parts.push(filter.column);
      if (typeof filter?.label === "string") parts.push(filter.label);
    });
  }
  if (Array.isArray(resource?.columns)) {
    resource.columns.forEach((column) => {
      if (typeof column?.key === "string") parts.push(column.key);
      if (typeof column?.label === "string") parts.push(column.label);
      if (typeof column?.detail_section === "string") parts.push(column.detail_section);
    });
  }
  if (resource?.column_labels && typeof resource.column_labels === "object") {
    Object.keys(resource.column_labels).forEach((columnKey) => parts.push(columnKey));
    Object.values(resource.column_labels).forEach((columnLabel) => {
      if (typeof columnLabel === "string") parts.push(columnLabel);
    });
  }
  return parts.join(" ").toLowerCase();
}

function isExceptionResourceCandidate(
  resource: UiReadResource | null | undefined,
  key: string,
  label: string
) {
  const haystack = buildResourceSearchIndex(resource, key, label);
  return EXCEPTION_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function resolveExceptionSignals(
  resource: UiReadResource | null | undefined,
  key: string,
  label: string
): ExceptionSignals {
  const haystack = buildResourceSearchIndex(resource, key, label);
  const hasCritical = EXCEPTION_CRITICAL_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasHigh = EXCEPTION_HIGH_KEYWORDS.some((keyword) => haystack.includes(keyword));
  const hasSlaRisk = EXCEPTION_SLA_RISK_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasSlaCountdown = EXCEPTION_SLA_COUNTDOWN_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasManualReview = EXCEPTION_MANUAL_REVIEW_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasRetry = EXCEPTION_RETRY_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasUnownedSignal = EXCEPTION_UNOWNED_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasOwnershipSignal = EXCEPTION_OWNERSHIP_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const severity = hasCritical ? "critical" : hasHigh ? "high" : "normal";
  const score =
    (hasCritical ? 6 : 0) +
    (!hasCritical && hasHigh ? 3 : 0) +
    (hasSlaRisk ? 2 : 0) +
    (hasSlaCountdown ? 1 : 0) +
    (hasUnownedSignal ? 2 : 0) +
    (hasOwnershipSignal ? 1 : 0) +
    (hasManualReview ? 1 : 0) +
    (hasRetry ? 1 : 0);
  return {
    severity,
    hasSlaRisk,
    hasSlaCountdown,
    hasManualReview,
    hasRetry,
    hasUnownedSignal,
    hasOwnershipSignal,
    score,
  };
}

function resolveRouteMonitorSignals(
  resource: UiReadResource | null | undefined,
  key: string,
  label: string
): RouteMonitorSignals {
  const haystack = buildResourceSearchIndex(resource, key, label);
  const hasTimeline = ROUTE_TIMELINE_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasMap = ROUTE_MAP_KEYWORDS.some((keyword) => haystack.includes(keyword));
  const hasAssignment = ROUTE_ASSIGNMENT_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasPlanning = ROUTE_PLANNING_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasRisk = ROUTE_RISK_KEYWORDS.some((keyword) => haystack.includes(keyword));
  const hasTimeWindowConstraint = ROUTE_TIME_WINDOW_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasCapacityConstraint = ROUTE_CAPACITY_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasSkillConstraint = ROUTE_SKILL_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasPodEvidence = ROUTE_POD_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const hasCustomerAction = ROUTE_CUSTOMER_ACTION_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );
  const score =
    (hasTimeline ? 2 : 0) +
    (hasMap ? 2 : 0) +
    (hasAssignment ? 2 : 0) +
    (hasPlanning ? 1 : 0) +
    (hasRisk ? 2 : 0) +
    (hasTimeWindowConstraint ? 1 : 0) +
    (hasCapacityConstraint ? 1 : 0) +
    (hasSkillConstraint ? 1 : 0) +
    (hasPodEvidence ? 1 : 0) +
    (hasCustomerAction ? 1 : 0);
  return {
    hasTimeline,
    hasMap,
    hasAssignment,
    hasPlanning,
    hasRisk,
    hasTimeWindowConstraint,
    hasCapacityConstraint,
    hasSkillConstraint,
    hasPodEvidence,
    hasCustomerAction,
    score,
  };
}

function resolveRouteSignalLabel(enabled: boolean, t: ReturnType<typeof createUiTranslator>) {
  return enabled ? t("monitor.signals.enabled") : t("monitor.signals.missing");
}

function pickTopRouteLane(
  resources: WorkspaceResource[],
  predicate: (signals: RouteMonitorSignals) => boolean
) {
  return (
    resources
      .filter((entry) => entry.routeSignals && predicate(entry.routeSignals))
      .sort((left, right) => {
        const leftScore = left.routeSignals?.score ?? 0;
        const rightScore = right.routeSignals?.score ?? 0;
        if (leftScore !== rightScore) return rightScore - leftScore;
        if (left.workflowCommandCount !== right.workflowCommandCount) {
          return right.workflowCommandCount - left.workflowCommandCount;
        }
        return left.label.localeCompare(right.label);
      })[0] ?? null
  );
}

function resolveResourceCommandSignals(params: {
  resourceKey: string;
  commands: UiCommandDefinition[];
}): ResourceCommandSignals {
  const category = resolveResourceCommandCategory({
    resourceKey: params.resourceKey,
    commands: params.commands,
  });
  const workflowCommandCount = params.commands.filter((command) => {
    if (!matchesResourceCategory(command.schema_category, params.resourceKey)) {
      return false;
    }
    const executionType =
      typeof command.execution?.type === "string"
        ? command.execution.type.trim().toLowerCase()
        : "";
    if (!executionType) return true;
    return AUTOMATION_COMMAND_TYPES.has(executionType);
  }).length;

  return {
    category,
    workflowCommandCount,
  };
}

function resolveExceptionSeverityLabel(
  signals: ExceptionSignals | null | undefined,
  t: ReturnType<typeof createUiTranslator>
) {
  if (!signals) return t("triage.matrix.severityNormal");
  if (signals.severity === "critical") return t("triage.matrix.severityCritical");
  if (signals.severity === "high") return t("triage.matrix.severityHigh");
  return t("triage.matrix.severityNormal");
}

function resolveExceptionSlaLabel(
  signals: ExceptionSignals | null | undefined,
  t: ReturnType<typeof createUiTranslator>
) {
  if (!signals) return t("triage.matrix.signalNone");
  if (signals.hasSlaRisk && signals.hasSlaCountdown) {
    return t("triage.matrix.slaRiskCountdown");
  }
  if (signals.hasSlaRisk) return t("triage.matrix.slaRisk");
  if (signals.hasSlaCountdown) return t("triage.matrix.slaCountdown");
  return t("triage.matrix.signalNone");
}

function resolveExceptionOwnershipLabel(
  signals: ExceptionSignals | null | undefined,
  t: ReturnType<typeof createUiTranslator>
) {
  if (!signals) return t("triage.matrix.signalNone");
  if (signals.hasUnownedSignal) return t("triage.matrix.unowned");
  if (signals.hasManualReview) return t("triage.matrix.manualReview");
  if (signals.hasOwnershipSignal) return t("triage.matrix.owned");
  return t("triage.matrix.signalNone");
}

/**
 * Route operations workspace shell.
 * It is row-driven by ui_navigation + ui_read_registry and opens a selected lane
 * inside the shared ResourcePage table experience.
 */
export async function RouteOperationsWorkspacePage({
  appBasePath,
  appKey,
  searchParams = {},
  resourceKey,
  sectionId = "operations",
  resourceSelector = "all",
  workspacePathSegment = "routes",
  i18nNamespace = "ui.routeOperations",
  testIdPrefix,
}: RouteOperationsWorkspacePageProps) {
  const t = createUiTranslator(i18nNamespace);
  let hasSession = false;
  try {
    const { user } = await getVerifiedUser({ allowCookieSet: false });
    hasSession = Boolean(user);
  } catch {
    hasSession = false;
  }
  if (!hasSession) return null;

  const ui = createUiServerClient();
  let contextError: string | null = null;
  let registryError: string | null = null;
  let commandRegistryError: string | null = null;
  let context: Awaited<ReturnType<typeof ui.context>> | null = null;
  let registry: UiReadRegistry | null = null;
  let commands: UiCommandDefinition[] = [];

  try {
    context = await ui.context(appKey);
  } catch (error) {
    contextError = formatUiError(error, t("errors.loadContext"));
  }

  try {
    registry = await ui.readRegistry();
  } catch (error) {
    registryError = formatUiError(error, t("errors.loadRegistry"));
  }

  if (typeof ui.commandRegistry === "function") {
    try {
      commands = normalizeCommandRegistry(await ui.commandRegistry());
    } catch (error) {
      commandRegistryError = formatUiError(error, t("errors.loadCommands"));
    }
  }

  const commandsHref = resolveSafeHref(appBasePath, "/commands");

  const headerActions = (
    <div>
      {commandsHref ? (
        <Button asChild variant="ghost">
          <a href={commandsHref}>{t("actions.openCommandCatalog")}</a>
        </Button>
      ) : (
        <span className="text-sm text-ui-muted">{t("actions.openCommandCatalog")}</span>
      )}
    </div>
  );
  const settingsRequestHref = resolveSafeHref(
    appBasePath,
    "/settings/request"
  );
  const trackingHref = resolveSafeHref(appBasePath, "/tracking");

  const errorTestId = testIdPrefix ? buildTestId(testIdPrefix, "error") : undefined;
  if (!context || contextError) {
    return (
      <PageContainer className="space-y-6">
        <PageHeader
          title={t("title")}
          description={t("description")}
          actions={headerActions}
        />
        <ContextNotice
          testId={errorTestId}
          title={t("unavailable.title")}
          action={t("unavailable.action")}
          detail={contextError}
        />
      </PageContainer>
    );
  }

  const navigation = normalizeNavigation(context.navigation);
  const targetSection =
    navigation.sections.find((section) => section.id === sectionId) ??
    navigation.sections.find((section) =>
      section.id?.toLowerCase?.() === sectionId.toLowerCase()
    ) ??
    null;

  const sectionEntries = dedupeResourceEntries(flattenSectionResources(targetSection));
  const fallbackEntries =
    sectionEntries.length > 0
      ? sectionEntries
      : dedupeResourceEntries(
          navigation.sections.flatMap((section) => flattenSectionResources(section))
        );

  const entriesWithMeta = fallbackEntries.map((entry) => {
    const normalized = normalizeResourceMeta(registry, entry.key);
    return {
      ...entry,
      label: normalized.label,
      capability: normalized.capability,
      resource: normalized.resource,
    };
  });

  const selectedEntries =
    resourceSelector === "exceptions"
      ? entriesWithMeta.filter((entry) =>
          isExceptionResourceCandidate(entry.resource, entry.key, entry.label)
        )
      : entriesWithMeta;
  const usedSelectorFallback =
    resourceSelector === "exceptions" &&
    selectedEntries.length === 0 &&
    entriesWithMeta.length > 0;
  const activeEntries = usedSelectorFallback ? entriesWithMeta : selectedEntries;

  const resourceKeys = activeEntries.map((entry) => entry.key);
  const counts = await resolveResourceCounts(ui, resourceKeys);
  const workspaceBasePath = resolveSafeHref(
    appBasePath,
    `/operations/${workspacePathSegment}`
  );
  const resources: WorkspaceResource[] = activeEntries.map((entry) => {
    const exceptionSignals =
      resourceSelector === "exceptions"
        ? resolveExceptionSignals(entry.resource, entry.key, entry.label)
        : null;
    const routeSignals =
      resourceSelector === "exceptions"
        ? null
        : resolveRouteMonitorSignals(entry.resource, entry.key, entry.label);
    const commandSignals = resolveResourceCommandSignals({
      resourceKey: entry.key,
      commands,
    });
    const commandHref =
      commandSignals.workflowCommandCount > 0 && commandSignals.category
        ? resolveSafeHref(
            appBasePath,
            buildHref("/commands", {
              category: commandSignals.category,
              access: "allowed",
            })
          )
        : null;
    const entryHref = workspaceBasePath
      ? resolveSafeHref(`${workspaceBasePath}`, `/${encodeURIComponent(entry.key)}`)
      : null;
    return {
      key: entry.key,
      label: entry.label,
      capability: entry.capability,
      href: entryHref,
      commandCategory: commandSignals.category,
      workflowCommandCount: commandSignals.workflowCommandCount,
      commandHref,
      sectionLabel: entry.sectionLabel,
      count: counts.get(entry.key) ?? null,
      disabledReason: entry.disabledReason,
      exceptionSignals,
      routeSignals,
    };
  });
  if (resourceSelector === "exceptions") {
    resources.sort((left, right) => {
      const leftScore = left.exceptionSignals?.score ?? 0;
      const rightScore = right.exceptionSignals?.score ?? 0;
      if (leftScore !== rightScore) return rightScore - leftScore;
      if (left.workflowCommandCount !== right.workflowCommandCount) {
        return right.workflowCommandCount - left.workflowCommandCount;
      }
      return left.label.localeCompare(right.label);
    });
  }

  const exceptionResources =
    resourceSelector === "exceptions"
      ? resources.filter((entry) => Boolean(entry.exceptionSignals))
      : [];
  const routeResources =
    resourceSelector === "exceptions"
      ? []
      : resources.filter((entry) => Boolean(entry.routeSignals));
  const routeTimelineReadyCount = routeResources.filter(
    (entry) => entry.routeSignals?.hasTimeline
  ).length;
  const routeMapReadyCount = routeResources.filter(
    (entry) => entry.routeSignals?.hasMap
  ).length;
  const routeAssignmentReadyCount = routeResources.filter(
    (entry) => entry.routeSignals?.hasAssignment
  ).length;
  const routePlanningReadyCount = routeResources.filter(
    (entry) => entry.routeSignals?.hasPlanning
  ).length;
  const routeRiskReadyCount = routeResources.filter(
    (entry) => entry.routeSignals?.hasRisk
  ).length;
  const routeTimeWindowReadyCount = routeResources.filter(
    (entry) => entry.routeSignals?.hasTimeWindowConstraint
  ).length;
  const routeCapacityReadyCount = routeResources.filter(
    (entry) => entry.routeSignals?.hasCapacityConstraint
  ).length;
  const routeSkillReadyCount = routeResources.filter(
    (entry) => entry.routeSignals?.hasSkillConstraint
  ).length;
  const routePodReadyCount = routeResources.filter(
    (entry) => entry.routeSignals?.hasPodEvidence
  ).length;
  const routeCustomerActionReadyCount = routeResources.filter(
    (entry) => entry.routeSignals?.hasCustomerAction
  ).length;
  const topTimelineLane = pickTopRouteLane(routeResources, (signals) => signals.hasTimeline);
  const topMapLane = pickTopRouteLane(routeResources, (signals) => signals.hasMap);
  const topAssignmentLane = pickTopRouteLane(
    routeResources,
    (signals) => signals.hasAssignment
  );
  const topRiskLane = pickTopRouteLane(routeResources, (signals) => signals.hasRisk);
  const topPlanningLane = pickTopRouteLane(routeResources, (signals) => signals.hasPlanning);
  const topTimeWindowLane = pickTopRouteLane(
    routeResources,
    (signals) => signals.hasTimeWindowConstraint
  );
  const topCapacityLane = pickTopRouteLane(
    routeResources,
    (signals) => signals.hasCapacityConstraint
  );
  const topSkillLane = pickTopRouteLane(
    routeResources,
    (signals) => signals.hasSkillConstraint
  );
  const topPodLane = pickTopRouteLane(routeResources, (signals) => signals.hasPodEvidence);
  const topCustomerActionLane = pickTopRouteLane(
    routeResources,
    (signals) => signals.hasCustomerAction
  );
  const topWorkflowLane =
    routeResources
      .filter((entry) => entry.workflowCommandCount > 0)
      .sort((left, right) => {
        if (left.workflowCommandCount !== right.workflowCommandCount) {
          return right.workflowCommandCount - left.workflowCommandCount;
        }
        return left.label.localeCompare(right.label);
      })[0] ?? null;
  const routeWorkflowCommands = routeResources.reduce(
    (sum, entry) => sum + entry.workflowCommandCount,
    0
  );
  const routeWorkflowLaneCount = routeResources.filter(
    (entry) => entry.workflowCommandCount > 0
  ).length;
  const exceptionCriticalCount = exceptionResources.filter(
    (entry) => entry.exceptionSignals?.severity === "critical"
  ).length;
  const exceptionHighCount = exceptionResources.filter(
    (entry) => entry.exceptionSignals?.severity === "high"
  ).length;
  const exceptionSlaRiskCount = exceptionResources.filter(
    (entry) => entry.exceptionSignals?.hasSlaRisk
  ).length;
  const exceptionSlaCountdownCount = exceptionResources.filter(
    (entry) => entry.exceptionSignals?.hasSlaCountdown
  ).length;
  const exceptionManualReviewCount = exceptionResources.filter(
    (entry) => entry.exceptionSignals?.hasManualReview
  ).length;
  const exceptionUnownedCount = exceptionResources.filter(
    (entry) => entry.exceptionSignals?.hasUnownedSignal
  ).length;
  const highestRiskLane =
    exceptionResources.length > 0
      ? [...exceptionResources].sort((left, right) => {
          const leftScore = left.exceptionSignals?.score ?? 0;
          const rightScore = right.exceptionSignals?.score ?? 0;
          if (leftScore !== rightScore) return rightScore - leftScore;
          return left.label.localeCompare(right.label);
        })[0] ?? null
      : null;
  const highestSlaRiskLane =
    exceptionResources.find((entry) => entry.exceptionSignals?.hasSlaRisk) ?? null;
  const highestSlaCountdownLane =
    exceptionResources.find((entry) => entry.exceptionSignals?.hasSlaCountdown) ?? null;
  const highestManualReviewLane =
    exceptionResources.find((entry) => entry.exceptionSignals?.hasManualReview) ??
    null;
  const highestUnownedLane =
    exceptionResources.find((entry) => entry.exceptionSignals?.hasUnownedSignal) ??
    null;
  const highestAutomationLane =
    exceptionResources
      .filter((entry) => entry.workflowCommandCount > 0)
      .sort((left, right) => {
        if (left.workflowCommandCount !== right.workflowCommandCount) {
          return right.workflowCommandCount - left.workflowCommandCount;
        }
        return left.label.localeCompare(right.label);
      })[0] ?? null;
  const totalWorkflowCommands = exceptionResources.reduce(
    (sum, entry) => sum + entry.workflowCommandCount,
    0
  );
  const workflowEnabledLaneCount = exceptionResources.filter(
    (entry) => entry.workflowCommandCount > 0
  ).length;
  const highestRiskWorkflowHref = highestRiskLane?.commandHref ?? null;
  const highestSlaRiskWorkflowHref = highestSlaRiskLane?.commandHref ?? null;
  const highestSlaCountdownWorkflowHref = highestSlaCountdownLane?.commandHref ?? null;
  const highestManualReviewWorkflowHref = highestManualReviewLane?.commandHref ?? null;
  const highestUnownedWorkflowHref = highestUnownedLane?.commandHref ?? null;
  const highestAutomationWorkflowHref = highestAutomationLane?.commandHref ?? null;

  const selectedResourceKey =
    typeof resourceKey === "string" && resourceKey.trim()
      ? resourceKey.trim()
      : firstValue(searchParams.resource)?.trim() ?? null;
  const selectedResource = selectedResourceKey
    ? resources.find((entry) => entry.key === selectedResourceKey)
    : null;

  const selectedSearchParams: SearchParams = { ...searchParams };
  delete selectedSearchParams.resource;

  const readyTestId = testIdPrefix ? buildTestId(testIdPrefix, "ready") : undefined;
  const emptyTestId = testIdPrefix ? `${testIdPrefix}-empty` : undefined;
  const laneListTestId = testIdPrefix ? `${testIdPrefix}-lanes` : undefined;
  const invalidTestId = testIdPrefix ? `${testIdPrefix}-invalid-resource` : undefined;
  const fallbackTestId = testIdPrefix ? `${testIdPrefix}-selector-fallback` : undefined;
  const activeScope = resolveScopeLabel(context.me, t);

  return (
    <div className="space-y-6">
      <PageContainer className="space-y-6">
        <PageHeader
          title={t("title")}
          description={t("description")}
          actions={headerActions}
        />
        <Section
          title={t("summary.title")}
          description={t("summary.description")}
          variant="plain"
          collapsible
          collapseKey={`operations-${workspacePathSegment}.summary`}
        >
          <div
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            data-testid={readyTestId}
          >
            <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
              <div className="text-xs font-medium text-ui-muted">{t("summary.scope")}</div>
              <div className="mt-2 text-sm font-semibold text-ui-ink">{activeScope}</div>
            </div>
            <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
              <div className="text-xs font-medium text-ui-muted">{t("summary.lanes")}</div>
              <div className="mt-2 text-sm font-semibold text-ui-ink">
                {t("summary.lanesValue", { count: String(resources.length) })}
              </div>
            </div>
            <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
              <div className="text-xs font-medium text-ui-muted">{t("summary.section")}</div>
              <div className="mt-2 text-sm font-semibold text-ui-ink">
                {targetSection?.label ?? t("summary.fallbackSection")}
              </div>
            </div>
            {resourceSelector === "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.criticalLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(exceptionCriticalCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector === "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.highLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", { count: String(exceptionHighCount) })}
                </div>
              </div>
            ) : null}
            {resourceSelector === "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.slaRiskLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(exceptionSlaRiskCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector === "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.slaCountdownLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(exceptionSlaCountdownCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector === "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.manualReviewLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(exceptionManualReviewCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector === "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.unownedLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(exceptionUnownedCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector === "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.workflowEnabledLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(workflowEnabledLaneCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector === "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.workflowCommands")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(totalWorkflowCommands),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector !== "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.timelineLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(routeTimelineReadyCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector !== "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.mapLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(routeMapReadyCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector !== "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.dispatchLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(routeAssignmentReadyCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector !== "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.timeWindowLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(routeTimeWindowReadyCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector !== "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.capacityLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(routeCapacityReadyCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector !== "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.skillLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(routeSkillReadyCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector !== "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.podLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(routePodReadyCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector !== "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.customerActionLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(routeCustomerActionReadyCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector !== "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.workflowEnabledLanes")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(routeWorkflowLaneCount),
                  })}
                </div>
              </div>
            ) : null}
            {resourceSelector !== "exceptions" ? (
              <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
                <div className="text-xs font-medium text-ui-muted">
                  {t("summary.workflowCommands")}
                </div>
                <div className="mt-2 text-sm font-semibold text-ui-ink">
                  {t("summary.countValue", {
                    count: String(routeWorkflowCommands),
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </Section>
        {resourceSelector !== "exceptions" ? (
          <Section
            title={t("monitor.title")}
            description={t("monitor.description")}
            variant="plain"
            collapsible
            collapseKey={`operations-${workspacePathSegment}.monitor`}
          >
            {resources.length === 0 ? (
              <EmptyState variant="inline" title={t("monitor.emptyTitle")} />
            ) : (
              <div className="space-y-3">
                <div className="text-xs text-ui-muted">
                  {t("monitor.workflowCoverage", {
                    lanes: String(routeWorkflowLaneCount),
                    totalLanes: String(routeResources.length),
                    commands: String(routeWorkflowCommands),
                  })}
                </div>
                {commandRegistryError ? (
                  <div className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-3 text-xs text-ui-muted">
                    {t("monitor.commandRegistryWarning", {
                      detail: commandRegistryError,
                    })}
                  </div>
                ) : null}
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {topTimelineLane?.href ? (
                    <a
                      href={topTimelineLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("monitor.timelineLane")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{topTimelineLane.label}</div>
                    </a>
                  ) : null}
                  {topMapLane?.href ? (
                    <a
                      href={topMapLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("monitor.mapLane")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{topMapLane.label}</div>
                    </a>
                  ) : null}
                  {topAssignmentLane?.href ? (
                    <a
                      href={topAssignmentLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("monitor.dispatchLane")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {topAssignmentLane.label}
                      </div>
                    </a>
                  ) : null}
                  {topPlanningLane?.href ? (
                    <a
                      href={topPlanningLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("monitor.planningLane")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{topPlanningLane.label}</div>
                    </a>
                  ) : null}
                  {topRiskLane?.href ? (
                    <a
                      href={topRiskLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("monitor.riskLane")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{topRiskLane.label}</div>
                    </a>
                  ) : null}
                  {topWorkflowLane?.commandHref ? (
                    <a
                      href={topWorkflowLane.commandHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("monitor.runDispatchWorkflows")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("monitor.workflowCount", {
                          count: String(topWorkflowLane.workflowCommandCount),
                        })}
                      </div>
                    </a>
                  ) : null}
                  {commandsHref ? (
                    <a
                      href={commandsHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("monitor.commandCatalog")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{t("monitor.commandHint")}</div>
                    </a>
                  ) : (
                    <div className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition">
                      <div className="font-semibold text-ui-muted">{t("monitor.commandCatalog")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{t("monitor.commandHint")}</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </Section>
        ) : null}
        {resourceSelector !== "exceptions" ? (
          <Section
            title={t("constraints.title")}
            description={t("constraints.description")}
            variant="plain"
            collapsible
            collapseKey={`operations-${workspacePathSegment}.constraints`}
          >
            {resources.length === 0 ? (
              <EmptyState variant="inline" title={t("constraints.emptyTitle")} />
            ) : (
              <div className="space-y-3">
                <div className="text-xs text-ui-muted">
                  {t("constraints.coverage", {
                    timeWindows: String(routeTimeWindowReadyCount),
                    capacity: String(routeCapacityReadyCount),
                    skills: String(routeSkillReadyCount),
                    totalLanes: String(routeResources.length),
                  })}
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {topTimeWindowLane?.href ? (
                    <a
                      href={topTimeWindowLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("constraints.timeWindows")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {topTimeWindowLane.label}
                      </div>
                    </a>
                  ) : null}
                  {topCapacityLane?.href ? (
                    <a
                      href={topCapacityLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("constraints.capacity")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{topCapacityLane.label}</div>
                    </a>
                  ) : null}
                  {topSkillLane?.href ? (
                    <a
                      href={topSkillLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("constraints.skills")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{topSkillLane.label}</div>
                    </a>
                  ) : null}
                  {topPlanningLane?.commandHref ? (
                    <a
                      href={topPlanningLane.commandHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">
                        {t("constraints.runPlanningWorkflows")}
                      </div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("monitor.workflowCount", {
                          count: String(topPlanningLane.workflowCommandCount),
                        })}
                      </div>
                    </a>
                  ) : null}
                  {settingsRequestHref ? (
                    <a
                      href={settingsRequestHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("constraints.openSettingsRequests")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("constraints.openSettingsHint")}
                      </div>
                    </a>
                  ) : (
                    <div className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition">
                      <div className="font-semibold text-ui-muted">
                        {t("constraints.openSettingsRequests")}
                      </div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("constraints.openSettingsHint")}
                      </div>
                    </div>
                  )}
                  {commandsHref ? (
                    <a
                      href={commandsHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("constraints.commandCatalog")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("constraints.commandHint")}
                      </div>
                    </a>
                  ) : (
                    <div className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition">
                      <div className="font-semibold text-ui-muted">
                        {t("constraints.commandCatalog")}
                      </div>
                      <div className="mt-1 text-xs text-ui-muted">{t("constraints.commandHint")}</div>
                    </div>
                  )}
                </div>
                <div className="overflow-hidden rounded-lg border border-ui-border/60 bg-ui-surface/60">
                  <table
                    className="w-full border-collapse text-left text-xs text-ui-ink"
                    data-testid={
                      testIdPrefix ? `${testIdPrefix}-constraint-matrix` : undefined
                    }
                  >
                    <thead className="border-b border-ui-border bg-ui-paper/70 text-ui-muted">
                      <tr>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("constraints.columns.lane")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("constraints.columns.timeWindows")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("constraints.columns.capacity")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("constraints.columns.skills")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("constraints.columns.workflows")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("constraints.columns.actions")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {routeResources.slice(0, 10).map((entry) => (
                        <tr key={entry.key} className="border-b border-ui-border/40 last:border-b-0">
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium text-ui-ink">{entry.label}</div>
                            <div className="mt-0.5 font-mono text-[10px] text-ui-muted">
                              {entry.key}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top text-ui-muted">
                            {resolveRouteSignalLabel(
                              Boolean(entry.routeSignals?.hasTimeWindowConstraint),
                              t
                            )}
                          </td>
                          <td className="px-3 py-2 align-top text-ui-muted">
                            {resolveRouteSignalLabel(
                              Boolean(entry.routeSignals?.hasCapacityConstraint),
                              t
                            )}
                          </td>
                          <td className="px-3 py-2 align-top text-ui-muted">
                            {resolveRouteSignalLabel(
                              Boolean(entry.routeSignals?.hasSkillConstraint),
                              t
                            )}
                          </td>
                          <td className="px-3 py-2 align-top text-ui-muted">
                            {t("monitor.workflowCount", {
                              count: String(entry.workflowCommandCount),
                            })}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="flex flex-wrap items-center gap-2">
                              {entry.href ? (
                                <a
                                  href={entry.href}
                                  className="underline decoration-ui-border underline-offset-2"
                                >
                                  {t("lanes.openLane")}
                                </a>
                              ) : (
                                <span className="text-ui-muted">{t("lanes.openLane")}</span>
                              )}
                              {entry.commandHref ? (
                                <a
                                  href={entry.commandHref}
                                  className="underline decoration-ui-border underline-offset-2"
                                >
                                  {t("lanes.openLaneCommands", {
                                    count: String(entry.workflowCommandCount),
                                  })}
                                </a>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Section>
        ) : null}
        {resourceSelector !== "exceptions" ? (
          <Section
            title={t("experience.title")}
            description={t("experience.description")}
            variant="plain"
            collapsible
            collapseKey={`operations-${workspacePathSegment}.experience`}
          >
            {resources.length === 0 ? (
              <EmptyState variant="inline" title={t("experience.emptyTitle")} />
            ) : (
              <div className="space-y-3">
                <div className="text-xs text-ui-muted">
                  {t("experience.coverage", {
                    pod: String(routePodReadyCount),
                    customer: String(routeCustomerActionReadyCount),
                    totalLanes: String(routeResources.length),
                  })}
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {topPodLane?.href ? (
                    <a
                      href={topPodLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("experience.openPodLane")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{topPodLane.label}</div>
                    </a>
                  ) : null}
                  {topCustomerActionLane?.href ? (
                    <a
                      href={topCustomerActionLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">
                        {t("experience.openCustomerLane")}
                      </div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {topCustomerActionLane.label}
                      </div>
                    </a>
                  ) : null}
                  {topPodLane?.commandHref ? (
                    <a
                      href={topPodLane.commandHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("experience.runPodWorkflows")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("monitor.workflowCount", {
                          count: String(topPodLane.workflowCommandCount),
                        })}
                      </div>
                    </a>
                  ) : null}
                  {topCustomerActionLane?.commandHref ? (
                    <a
                      href={topCustomerActionLane.commandHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">
                        {t("experience.runCustomerWorkflows")}
                      </div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("monitor.workflowCount", {
                          count: String(topCustomerActionLane.workflowCommandCount),
                        })}
                      </div>
                    </a>
                  ) : null}
                  {trackingHref ? (
                    <a
                      href={trackingHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("experience.openTracking")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("experience.openTrackingHint")}
                      </div>
                    </a>
                  ) : (
                    <div className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition">
                      <div className="font-semibold text-ui-muted">
                        {t("experience.openTracking")}
                      </div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("experience.openTrackingHint")}
                      </div>
                    </div>
                  )}
                  {commandsHref ? (
                    <a
                      href={commandsHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("experience.commandCatalog")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("experience.commandHint")}
                      </div>
                    </a>
                  ) : (
                    <div className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition">
                      <div className="font-semibold text-ui-muted">
                        {t("experience.commandCatalog")}
                      </div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("experience.commandHint")}
                      </div>
                    </div>
                  )}
                </div>
                <div className="overflow-hidden rounded-lg border border-ui-border/60 bg-ui-surface/60">
                  <table
                    className="w-full border-collapse text-left text-xs text-ui-ink"
                    data-testid={
                      testIdPrefix ? `${testIdPrefix}-pod-customer-matrix` : undefined
                    }
                  >
                    <thead className="border-b border-ui-border bg-ui-paper/70 text-ui-muted">
                      <tr>
                        <th scope="col" className="px-3 py-2 font-medium">{t("experience.columns.lane")}</th>
                        <th scope="col" className="px-3 py-2 font-medium">{t("experience.columns.pod")}</th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("experience.columns.customer")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("experience.columns.workflows")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("experience.columns.actions")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {routeResources.slice(0, 10).map((entry) => (
                        <tr key={entry.key} className="border-b border-ui-border/40 last:border-b-0">
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium text-ui-ink">{entry.label}</div>
                            <div className="mt-0.5 font-mono text-[10px] text-ui-muted">
                              {entry.key}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top text-ui-muted">
                            {resolveRouteSignalLabel(
                              Boolean(entry.routeSignals?.hasPodEvidence),
                              t
                            )}
                          </td>
                          <td className="px-3 py-2 align-top text-ui-muted">
                            {resolveRouteSignalLabel(
                              Boolean(entry.routeSignals?.hasCustomerAction),
                              t
                            )}
                          </td>
                          <td className="px-3 py-2 align-top text-ui-muted">
                            {t("monitor.workflowCount", {
                              count: String(entry.workflowCommandCount),
                            })}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="flex flex-wrap items-center gap-2">
                              {entry.href ? (
                                <a
                                  href={entry.href}
                                  className="underline decoration-ui-border underline-offset-2"
                                >
                                  {t("lanes.openLane")}
                                </a>
                              ) : (
                                <span className="text-ui-muted">{t("lanes.openLane")}</span>
                              )}
                              {entry.commandHref ? (
                                <a
                                  href={entry.commandHref}
                                  className="underline decoration-ui-border underline-offset-2"
                                >
                                  {t("lanes.openLaneCommands", {
                                    count: String(entry.workflowCommandCount),
                                  })}
                                </a>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Section>
        ) : null}
        {resourceSelector !== "exceptions" ? (
          <Section
            title={t("board.title")}
            description={t("board.description")}
            variant="plain"
            collapsible
            collapseKey={`operations-${workspacePathSegment}.board`}
          >
            {resources.length === 0 ? (
              <EmptyState variant="inline" title={t("board.emptyTitle")} />
            ) : (
              <div className="overflow-hidden rounded-lg border border-ui-border/60 bg-ui-surface/60">
                <table
                  className="w-full border-collapse text-left text-xs text-ui-ink"
                  data-testid={testIdPrefix ? `${testIdPrefix}-dispatch-board` : undefined}
                >
                  <thead className="border-b border-ui-border bg-ui-paper/70 text-ui-muted">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">{t("board.columns.lane")}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t("board.columns.timeline")}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t("board.columns.map")}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t("board.columns.dispatch")}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t("board.columns.risk")}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t("board.columns.planning")}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t("board.columns.workflows")}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t("board.columns.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routeResources.slice(0, 12).map((entry) => (
                      <tr key={entry.key} className="border-b border-ui-border/40 last:border-b-0">
                        <td className="px-3 py-2 align-top">
                          <div className="font-medium text-ui-ink">{entry.label}</div>
                          <div className="mt-0.5 font-mono text-[10px] text-ui-muted">
                            {entry.key}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top text-ui-muted">
                          {resolveRouteSignalLabel(
                            Boolean(entry.routeSignals?.hasTimeline),
                            t
                          )}
                        </td>
                        <td className="px-3 py-2 align-top text-ui-muted">
                          {resolveRouteSignalLabel(Boolean(entry.routeSignals?.hasMap), t)}
                        </td>
                        <td className="px-3 py-2 align-top text-ui-muted">
                          {resolveRouteSignalLabel(
                            Boolean(entry.routeSignals?.hasAssignment),
                            t
                          )}
                        </td>
                        <td className="px-3 py-2 align-top text-ui-muted">
                          {resolveRouteSignalLabel(Boolean(entry.routeSignals?.hasRisk), t)}
                        </td>
                        <td className="px-3 py-2 align-top text-ui-muted">
                          {resolveRouteSignalLabel(
                            Boolean(entry.routeSignals?.hasPlanning),
                            t
                          )}
                        </td>
                        <td className="px-3 py-2 align-top text-ui-muted">
                          {t("monitor.workflowCount", {
                            count: String(entry.workflowCommandCount),
                          })}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="flex flex-wrap items-center gap-2">
                            {entry.href ? (
                              <a
                                href={entry.href}
                                className="underline decoration-ui-border underline-offset-2"
                              >
                                {t("lanes.openLane")}
                              </a>
                            ) : (
                              <span className="text-ui-muted">{t("lanes.openLane")}</span>
                            )}
                            {entry.commandHref ? (
                              <a
                                href={entry.commandHref}
                                className="underline decoration-ui-border underline-offset-2"
                              >
                                {t("lanes.openLaneCommands", {
                                  count: String(entry.workflowCommandCount),
                                })}
                              </a>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        ) : null}
        {resourceSelector === "exceptions" ? (
          <Section
            title={t("triage.title")}
            description={t("triage.description")}
            variant="plain"
            collapsible
            collapseKey={`operations-${workspacePathSegment}.triage`}
          >
            {resources.length === 0 ? (
              <EmptyState variant="inline" title={t("triage.emptyTitle")} />
            ) : (
              <div className="space-y-3">
                <div className="text-xs text-ui-muted">
                  {t("triage.workflowCoverage", {
                    lanes: String(workflowEnabledLaneCount),
                    totalLanes: String(exceptionResources.length),
                    commands: String(totalWorkflowCommands),
                  })}
                </div>
                {commandRegistryError ? (
                  <div className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-3 text-xs text-ui-muted">
                    {t("triage.commandRegistryWarning", {
                      detail: commandRegistryError,
                    })}
                  </div>
                ) : null}
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {highestRiskLane?.href ? (
                    <a
                      href={highestRiskLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.highestRisk")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{highestRiskLane.label}</div>
                    </a>
                  ) : null}
                  {highestSlaRiskLane?.href ? (
                    <a
                      href={highestSlaRiskLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.slaRisk")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{highestSlaRiskLane.label}</div>
                    </a>
                  ) : null}
                  {highestManualReviewLane?.href ? (
                    <a
                      href={highestManualReviewLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.manualReview")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {highestManualReviewLane.label}
                      </div>
                    </a>
                  ) : null}
                  {highestSlaCountdownLane?.href ? (
                    <a
                      href={highestSlaCountdownLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.slaCountdown")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {highestSlaCountdownLane.label}
                      </div>
                    </a>
                  ) : null}
                  {highestUnownedLane?.href ? (
                    <a
                      href={highestUnownedLane.href}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.unowned")}</div>
                      <div className="mt-1 text-xs text-ui-muted">{highestUnownedLane.label}</div>
                    </a>
                  ) : null}
                  {highestRiskWorkflowHref ? (
                    <a
                      href={highestRiskWorkflowHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.runHighestRisk")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("triage.workflowCount", {
                          count: String(highestRiskLane?.workflowCommandCount ?? 0),
                        })}
                      </div>
                    </a>
                  ) : null}
                  {highestSlaRiskWorkflowHref ? (
                    <a
                      href={highestSlaRiskWorkflowHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.runSlaRisk")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("triage.workflowCount", {
                          count: String(highestSlaRiskLane?.workflowCommandCount ?? 0),
                        })}
                      </div>
                    </a>
                  ) : null}
                  {highestManualReviewWorkflowHref ? (
                    <a
                      href={highestManualReviewWorkflowHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.runManualReview")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("triage.workflowCount", {
                          count: String(
                            highestManualReviewLane?.workflowCommandCount ?? 0
                          ),
                        })}
                      </div>
                    </a>
                  ) : null}
                  {highestSlaCountdownWorkflowHref ? (
                    <a
                      href={highestSlaCountdownWorkflowHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.runSlaCountdown")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("triage.workflowCount", {
                          count: String(
                            highestSlaCountdownLane?.workflowCommandCount ?? 0
                          ),
                        })}
                      </div>
                    </a>
                  ) : null}
                  {highestUnownedWorkflowHref ? (
                    <a
                      href={highestUnownedWorkflowHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.runUnowned")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("triage.workflowCount", {
                          count: String(highestUnownedLane?.workflowCommandCount ?? 0),
                        })}
                      </div>
                    </a>
                  ) : null}
                  {highestAutomationWorkflowHref ? (
                    <a
                      href={highestAutomationWorkflowHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.runAutomationReady")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("triage.workflowCount", {
                          count: String(highestAutomationLane?.workflowCommandCount ?? 0),
                        })}
                      </div>
                    </a>
                  ) : null}
                  {commandsHref ? (
                    <a
                      href={commandsHref}
                      className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition hover:bg-ui-highlight/60"
                    >
                      <div className="font-semibold">{t("triage.commandCatalog")}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("triage.commandHint")}
                      </div>
                    </a>
                  ) : (
                    <div className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-ink transition">
                      <div className="font-semibold text-ui-muted">
                        {t("triage.commandCatalog")}
                      </div>
                      <div className="mt-1 text-xs text-ui-muted">{t("triage.commandHint")}</div>
                    </div>
                  )}
                </div>
                <div className="overflow-hidden rounded-lg border border-ui-border/60 bg-ui-surface/60">
                  <table
                    className="w-full border-collapse text-left text-xs text-ui-ink"
                    data-testid={
                      testIdPrefix ? `${testIdPrefix}-triage-matrix` : undefined
                    }
                  >
                    <thead className="border-b border-ui-border bg-ui-paper/70 text-ui-muted">
                      <tr>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("triage.matrix.columns.lane")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("triage.matrix.columns.severity")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("triage.matrix.columns.sla")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("triage.matrix.columns.ownership")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("triage.matrix.columns.workflows")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          {t("triage.matrix.columns.actions")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {exceptionResources.slice(0, 8).map((entry) => (
                        <tr key={entry.key} className="border-b border-ui-border/40 last:border-b-0">
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium text-ui-ink">{entry.label}</div>
                            <div className="mt-0.5 font-mono text-[10px] text-ui-muted">
                              {entry.key}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top text-ui-muted">
                            {resolveExceptionSeverityLabel(entry.exceptionSignals, t)}
                          </td>
                          <td className="px-3 py-2 align-top text-ui-muted">
                            {resolveExceptionSlaLabel(entry.exceptionSignals, t)}
                          </td>
                          <td className="px-3 py-2 align-top text-ui-muted">
                            {resolveExceptionOwnershipLabel(entry.exceptionSignals, t)}
                          </td>
                          <td className="px-3 py-2 align-top text-ui-muted">
                            {t("triage.workflowCount", {
                              count: String(entry.workflowCommandCount),
                            })}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="flex flex-wrap items-center gap-2">
                              {entry.href ? (
                                <a
                                  href={entry.href}
                                  className="underline decoration-ui-border underline-offset-2"
                                >
                                  {t("lanes.openLane")}
                                </a>
                              ) : (
                                <span className="text-ui-muted">{t("lanes.openLane")}</span>
                              )}
                              {entry.commandHref ? (
                                <a
                                  href={entry.commandHref}
                                  className="underline decoration-ui-border underline-offset-2"
                                >
                                  {t("lanes.openLaneCommands", {
                                    count: String(entry.workflowCommandCount),
                                  })}
                                </a>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Section>
        ) : null}
        <Section
          title={t("lanes.title")}
          description={t("lanes.description")}
          variant="plain"
          collapsible
          collapseKey={`operations-${workspacePathSegment}.lanes`}
        >
          {resources.length === 0 ? (
            <ContextNotice
              testId={emptyTestId}
              title={t("lanes.emptyTitle")}
              action={t("lanes.emptyAction")}
              detail={registryError}
            />
          ) : (
            <div className="space-y-3">
              {usedSelectorFallback ? (
                <ContextNotice
                  testId={fallbackTestId}
                  title={t("lanes.selectorFallbackTitle")}
                  action={t("lanes.selectorFallbackAction")}
                />
              ) : null}
              <div className="grid gap-3 lg:grid-cols-2" data-testid={laneListTestId}>
                {resources.map((entry) => (
                  <div
                    key={entry.key}
                    className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-4 transition hover:bg-ui-highlight/60"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-ui-ink">{entry.label}</div>
                        <div className="mt-1 text-xs text-ui-muted">{entry.key}</div>
                      </div>
                      <Badge tone="neutral">
                        {typeof entry.count === "number"
                          ? t("lanes.records", { count: String(entry.count) })
                          : t("lanes.recordsUnknown")}
                      </Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ui-muted">
                      {entry.sectionLabel ? (
                        <span>{t("lanes.sectionLabel", { section: entry.sectionLabel })}</span>
                      ) : null}
                      {entry.disabledReason ? (
                        <span>{entry.disabledReason}</span>
                      ) : null}
                      {entry.capability ? (
                        <span className="font-mono text-[10px]">{entry.capability}</span>
                      ) : null}
                      {entry.workflowCommandCount > 0 ? (
                        <span>
                          {t("lanes.laneCommands", {
                            count: String(entry.workflowCommandCount),
                          })}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                          <Button asChild size="sm" variant="ghost">
                            {entry.href ? (
                              <a href={entry.href}>{t("lanes.openLane")}</a>
                            ) : (
                              <span>{t("lanes.openLane")}</span>
                            )}
                          </Button>
                      {entry.commandHref ? (
                        <Button asChild size="sm" variant="ghost">
                          <a href={entry.commandHref}>
                            {t("lanes.openLaneCommands", {
                              count: String(entry.workflowCommandCount),
                            })}
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
      </PageContainer>
      {selectedResourceKey && !selectedResource ? (
        <PageContainer>
          <ContextNotice
            testId={invalidTestId}
            title={t("selected.invalidTitle")}
            action={t("selected.invalidAction")}
            detail={t("selected.invalidDetail", { resourceKey: selectedResourceKey })}
          />
        </PageContainer>
      ) : null}
      {selectedResource ? (
        <ResourcePage
          appKey={appKey}
          resourceKey={selectedResource.key}
          searchParams={selectedSearchParams}
          appBasePath={appBasePath}
          baseHref={`${workspaceBasePath}/${encodeURIComponent(selectedResource.key)}`}
          description={t("selected.description", { label: selectedResource.label })}
          testIdPrefix={testIdPrefix ? `${testIdPrefix}-resource` : undefined}
        />
      ) : (
        <PageContainer>
          <Section
            title={t("selected.title")}
            description={t("selected.help")}
            variant="plain"
            collapsible
            collapseKey={`operations-${workspacePathSegment}.selected`}
          >
            <EmptyState variant="inline" title={t("selected.emptyTitle")} />
          </Section>
        </PageContainer>
      )}
    </div>
  );
}

