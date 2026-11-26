import "server-only";
import { createUiServerClient } from "@masarx/api/server";
import { getVerifiedUser } from "@masarx/auth";
import {
  normalizeNavigation,
  normalizeUiScopeType,
  UiCommandDefinition,
  UiDashboardConfig,
  UiMe,
  UiNavigation,
  UiReadRegistry,
} from "@masarx/api";
import { getUiDefaults } from "@masarx/config";
import { Badge } from "./badge";
import { Button } from "./button";
import { fetchCommandRegistry } from "./command-registry";
import { resolveCommandHref } from "./command-utils";
import { buildContextHealthChecks } from "./context-health";
import {
  buildDashboardCommandCenterLanes,
  buildDashboardCommandCenterSummary,
  buildDashboardSections,
  collectDashboardCommandAuthorityConflicts,
  collectDashboardNavigationAuthorityConflicts,
  collectResourceKeys,
  collectDashboardResourceAuthorityConflicts,
  commandResourceReadAllowed,
  normalizeDashboardCommands,
  resolveDashboardResourceReadState,
  selectDashboardSections,
} from "./dashboard-utils";
import { resolveShipmentReporting } from "./dashboard-shipment-reporting";
import { ContextNotice } from "./context-notice";
import { createUiTranslator, localizeNavigation } from "./i18n";
import type { AbstractIntlMessages } from "next-intl";
import { buildTestId } from "./test-ids";
import { normalizeAppHref } from "./navigation-paths";
import { PageHeader } from "./page-header";
import { PageContainer } from "./page-container";
import { Section } from "./section";
import { formatReferenceValue } from "./resource-utils";
import { fetchResourceMetrics } from "./metrics-fetch";
import { DashboardMetricsPanel } from "./dashboard-metrics-panel";
import { formatUiError, cn } from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";

type DashboardPageProps = {
  appLabel: string;
  appKey: string;
  appBasePath: string;
  testIdPrefix: string;
  maxSections?: number;
  maxItemsPerSection?: number;
  locale?: string;
  messages?: AbstractIntlMessages;
};

type ActionCard = {
  key: string;
  label: string;
  description: string | null;
  href: string;
  capability: string | null;
  allowed: boolean;
};

const uiDefaults = getUiDefaults();
const DEFAULT_DASHBOARD = uiDefaults.dashboard;

const clampNumber = (value: unknown, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, min), max);
};

function resolveDashboardConfig(value?: UiDashboardConfig | null) {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const maxSections =
    clampNumber(raw.max_sections ?? DEFAULT_DASHBOARD.maxSections, 1, 20) ??
    DEFAULT_DASHBOARD.maxSections;
  const maxItemsPerSection =
    clampNumber(
      raw.max_items_per_section ?? DEFAULT_DASHBOARD.maxItemsPerSection,
      1,
      50,
    ) ?? DEFAULT_DASHBOARD.maxItemsPerSection;
  const maxActions =
    clampNumber(raw.max_actions ?? DEFAULT_DASHBOARD.maxActions, 1, 20) ??
    DEFAULT_DASHBOARD.maxActions;
  const maxMetrics =
    clampNumber(raw.max_metrics ?? DEFAULT_DASHBOARD.maxMetrics, 1, 50) ??
    DEFAULT_DASHBOARD.maxMetrics;
  return {
    maxSections,
    maxItemsPerSection,
    maxActions,
    maxMetrics,
    shipmentReporting: raw.shipment_reporting,
  };
}

const formatValue = (
  value: string | null | undefined,
  t: (key: string) => string,
) => {
  if (!value) return t("unknown");
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : t("unknown");
};

const stringValue = (value: unknown) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const formatCount = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value.toLocaleString();
};

const DASHBOARD_APP_ROOTS = ["/console", "/portal"];

function hasUnsafeDashboardPathSegment(pathValue: string) {
  if (/[\u0000-\u001f\u007f]/.test(pathValue)) return true;
  if (pathValue.includes("\\")) return true;
  const path = pathValue.split(/[?#]/, 1)[0] ?? "";
  return path.split("/").some((segment) => {
    let decoded = segment;
    let stabilized = false;
    for (let depth = 0; depth <= segment.length; depth += 1) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        return true;
      }
      if (next === decoded) {
        stabilized = true;
        break;
      }
      decoded = next;
    }
    if (!stabilized) return true;
    return (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    );
  });
}

function isPathWithinBase(pathValue: string, basePath: string) {
  if (!basePath) return pathValue.startsWith("/");
  return pathValue === basePath || pathValue.startsWith(`${basePath}/`);
}

const resolveDashboardNavigationHref = (
  appBasePath: string,
  href: string | null | undefined,
) => {
  const trimmed = href?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return null;
  }
  const normalizedBase = resolveSafeAppBasePath(appBasePath);
  if (normalizedBase === null || hasUnsafeDashboardPathSegment(normalizedBase)) return null;
  if (hasUnsafeDashboardPathSegment(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, "https://dashboard.invalid");
  } catch {
    return null;
  }
  if (
    normalizedBase &&
    parsed.pathname.startsWith(normalizedBase) &&
    parsed.pathname !== normalizedBase &&
    !parsed.pathname.startsWith(`${normalizedBase}/`)
  ) {
    return null;
  }
  const explicitAppRoot = DASHBOARD_APP_ROOTS.find(
    (root) =>
      parsed.pathname === root || parsed.pathname.startsWith(`${root}/`),
  );
  if (explicitAppRoot && normalizedBase && explicitAppRoot !== normalizedBase) {
    return null;
  }
  const normalizedPath = normalizeAppHref(
    `${parsed.pathname}${parsed.search}${parsed.hash}`,
    normalizedBase || undefined,
  );
  if (!normalizedPath) return null;
  if (
    isPathWithinBase(normalizedPath.split(/[?#]/, 1)[0] ?? "", normalizedBase)
  ) {
    return normalizedPath;
  }
  const resolved = resolveSafeHref(normalizedBase, normalizedPath);
  if (!resolved) return null;
  const resolvedPath = resolved.split(/[?#]/, 1)[0] ?? "";
  return isPathWithinBase(resolvedPath, normalizedBase) ? resolved : null;
};

function resolveScopeLabel(
  me: UiMe | null,
  t: (key: string, values?: Record<string, string>) => string,
) {
  const scope = me?.access_scope;
  const scopeType = normalizeUiScopeType(scope?.scope_type ?? null);
  if (!scopeType) return t("unknown");
  const scopeId = stringValue(scope?.scope_id);
  const label =
    stringValue(scope?.scope_label) ??
    (scopeId ? formatReferenceValue(scopeId) : null);
  if (scopeType === "global" && !label) return scopeType;
  return t("scopeLabel", { scopeType, scopeLabel: formatValue(label, t) });
}

function buildActionCards(
  commands: UiCommandDefinition[],
  appBasePath: string,
  appKey: string,
  capabilities: Set<string>,
  readRegistry: UiReadRegistry | null,
): ActionCard[] {
  return commands
    .map((command) => {
      const href = resolveDashboardCommandHref(command, appBasePath, appKey);
      if (!href) return null;
      const capability = command.capability ?? null;
      const allowed =
        hasCapability(capabilities, capability) &&
        commandResourceReadAllowed(command, readRegistry, capabilities);
      return {
        key: command.key,
        label: command.label ?? command.key,
        description: command.description ?? null,
        href,
        capability,
        allowed,
      };
    })
    .filter((command): command is ActionCard => Boolean(command))
    .sort(
      (a, b) =>
        Number(b.allowed) - Number(a.allowed) ||
        a.label.localeCompare(b.label),
    );
}

function resolveDashboardCommandHref(
  command: UiCommandDefinition,
  appBasePath: string,
  appKey: string,
) {
  const normalizedAppKey = appKey.trim().toLowerCase();
  const routeTargets = (
    command as {
      route_targets?: Record<string, { path?: unknown } | null> | null;
    }
  ).route_targets;
  const routePath =
    normalizedAppKey && routeTargets && typeof routeTargets === "object"
      ? routeTargets[normalizedAppKey]?.path
      : null;
  const fallbackHref = (command as { href?: unknown }).href;
  const rawHref =
    typeof routePath === "string"
      ? routePath
      : typeof fallbackHref === "string"
        ? fallbackHref
        : null;
  if (!resolveDashboardNavigationHref(appBasePath, rawHref)) return null;
  return resolveDashboardNavigationHref(
    appBasePath,
    resolveCommandHref(command, appBasePath, appKey),
  );
}

function normalizeDashboardResourceKey(resourceKey?: string | null) {
  const normalized =
    typeof resourceKey === "string"
      ? resourceKey.trim().toLowerCase()
      : "";
  return normalized || null;
}

function filterReadableMetricResourceKeys(
  resourceKeys: string[],
  readRegistry: UiReadRegistry | null,
  capabilities: Set<string>,
) {
  return resourceKeys.filter(
    (resourceKey) =>
      resolveDashboardResourceReadState(
        resourceKey,
        readRegistry,
        capabilities,
      ).readAllowed,
  );
}

/**
 * Dashboard landing page with workflow-first summary blocks.
 */
export async function DashboardPage({
  appLabel,
  appKey,
  appBasePath,
  testIdPrefix,
  maxItemsPerSection,
  maxSections,
  locale,
  messages,
}: DashboardPageProps) {
  const t = createUiTranslator("ui.dashboard", { locale, messages });
  let hasSession = false;
  try {
    const { user } = await getVerifiedUser({ allowCookieSet: false });
    hasSession = Boolean(user);
  } catch {
    hasSession = false;
  }

  if (!hasSession) {
    return null;
  }

  const ui = createUiServerClient();
  let context: { me: UiMe; navigation: UiNavigation } | null = null;
  let commandRegistry: UiCommandDefinition[] = [];
  let readRegistry: UiReadRegistry | null = null;
  let errorMessage: string | null = null;
  let commandRegistryError: string | null = null;
  let readRegistryError: string | null = null;
  const dashboardDefaults = resolveDashboardConfig(null);
  let dashboardConfig = dashboardDefaults;

  try {
    context = await ui.context(appKey);
  } catch (error) {
    errorMessage = formatUiError(error, t("errors.loadContext"));
  }

  try {
    const resolved = await ui.dashboardConfig();
    dashboardConfig = resolveDashboardConfig(resolved);
  } catch {
    dashboardConfig = dashboardDefaults;
  }

  const registryResult = await fetchCommandRegistry(ui);
  commandRegistry = registryResult.commands;
  if (registryResult.error) {
    commandRegistryError = formatUiError(
      registryResult.error,
      t("errors.loadCommands"),
    );
  }

  try {
    readRegistry = await ui.readRegistry();
  } catch (error) {
    readRegistryError = formatUiError(error, t("errors.loadRegistry"));
    readRegistry = null;
  }

  if (!context || errorMessage) {
    return (
      <PageContainer className="space-y-6">
        <PageHeader
          title={t("title", { appLabel })}
          description={t("subtitle")}
        />
        <ContextNotice
          testId={buildTestId(testIdPrefix, "error")}
          title={t("unavailableTitle")}
          action={t("unavailableAction")}
          detail={errorMessage}
        />
      </PageContainer>
    );
  }

  const navigation = localizeNavigation(normalizeNavigation(context.navigation), locale);
  const resolvedMaxSections =
    typeof maxSections === "number" ? maxSections : dashboardConfig.maxSections;
  const resolvedMaxItems =
    typeof maxItemsPerSection === "number"
      ? maxItemsPerSection
      : dashboardConfig.maxItemsPerSection;
  const me = context.me;
  const capabilities = resolveCapabilitySet(me.capabilities);
  const canonicalCommands = normalizeDashboardCommands(commandRegistry);
  const authorityConflictCount =
    collectDashboardNavigationAuthorityConflicts(navigation.sections).length +
    collectDashboardResourceAuthorityConflicts(readRegistry).length +
    collectDashboardCommandAuthorityConflicts(commandRegistry).length;
  const dashboardCandidates = buildDashboardSections(navigation.sections, {
    capabilities,
    includeResourceOnly: true,
    maxItemsPerSection: Number.POSITIVE_INFINITY,
    maxSections: Number.POSITIVE_INFINITY,
  });
  const dashboardSections = selectDashboardSections(dashboardCandidates, {
    includeItem: (item) =>
      Boolean(resolveDashboardNavigationHref(appBasePath, item.href)) &&
      resolveDashboardResourceReadState(
        item.resourceKey,
        readRegistry,
        capabilities,
      ).readAllowed,
    maxItemsPerSection: resolvedMaxItems,
    maxSections: resolvedMaxSections,
  });
  const actions = buildActionCards(
    canonicalCommands,
    appBasePath,
    appKey,
    capabilities,
    readRegistry,
  ).slice(0, dashboardConfig.maxActions);
  const registryCount = Array.isArray(readRegistry?.resources)
    ? readRegistry!.resources.length
    : 0;
  const healthChecks = buildContextHealthChecks(
    {
      me,
      navigationCount: navigation.sections.length,
      commandCount: canonicalCommands.length,
      resourceCount: registryCount,
    },
    t,
  );
  const commandsHref = resolveSafeHref(appBasePath, "/commands");
  const metricResourceKeys = filterReadableMetricResourceKeys(
    collectResourceKeys(dashboardCandidates),
    readRegistry,
    capabilities,
  ).slice(0, dashboardConfig.maxMetrics);
  const userId = me.user?.id;
  const readAssignedReviews =
    Boolean(userId) && metricResourceKeys.includes("manual_review_tasks");
  const [resourceCounts, shipmentReporting, assignedReviewCount] = await Promise.all([
    fetchResourceMetrics(ui, metricResourceKeys),
    resolveShipmentReporting(dashboardConfig.shipmentReporting, appKey, readRegistry, capabilities, ui.resourceMetrics),
    readAssignedReviews
      ? ui
          .listResource("manual_review_tasks", { assigned_to: userId }, 1, 0, null)
          .then((list) =>
            typeof list.total === "number" && Number.isFinite(list.total)
              ? list.total
              : list.items.length,
          )
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  if (readAssignedReviews) {
    resourceCounts.set("manual_review_tasks.assigned", assignedReviewCount);
  }
  const commandCenterLanes = buildDashboardCommandCenterLanes({
    sections: dashboardCandidates,
    readRegistry,
    commands: canonicalCommands,
    capabilities,
    resourceCounts,
    maxLanes: dashboardConfig.maxMetrics,
  });
  const commandCenterSummary = buildDashboardCommandCenterSummary({
    lanes: commandCenterLanes,
  });
  const missingMetricCount = Math.max(
    commandCenterSummary.metricLaneCount -
      commandCenterSummary.metricReadyCount,
    0,
  );
  const commandCenterIssues = [
    commandRegistryError
      ? {
          key: "commands",
          label: t("commandCenter.degraded.commands"),
          detail: commandRegistryError,
        }
      : null,
    readRegistryError
      ? {
          key: "resources",
          label: t("commandCenter.degraded.resources"),
          detail: readRegistryError,
        }
      : null,
    authorityConflictCount > 0
      ? {
          key: "authority",
          label: t("commandCenter.degraded.authority"),
          detail: t("commandCenter.degraded.authorityDetail", {
            count: String(authorityConflictCount),
          }),
        }
      : null,
    missingMetricCount > 0
      ? {
          key: "metrics",
          label: t("commandCenter.degraded.metrics"),
          detail: t("commandCenter.degraded.metricsDetail", {
            ready: String(commandCenterSummary.metricReadyCount),
            total: String(commandCenterSummary.metricLaneCount),
          }),
        }
      : null,
    readAssignedReviews && assignedReviewCount === null
      ? {
          key: "my-day",
          label: t("commandCenter.myDay.title"),
          detail: t("commandCenter.myDay.unavailable"),
        }
      : null,
  ].filter((issue): issue is { key: string; label: string; detail: string } =>
    Boolean(issue),
  );
  const settingsResolutionReadable = me.settings_resolution_id
    ? formatReferenceValue(me.settings_resolution_id)
    : t("unknown");

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title={t("title", { appLabel })}
        description={t("subtitle")}
      />
      {shipmentReporting ? (
        <div id="shipment-reporting" data-testid={`${testIdPrefix}-shipment-reporting`}>
          <Section title={t("reporting.title")} variant="plain">
            <p className="text-sm text-ui-muted">{t("reporting.allTime")}</p>
            {shipmentReporting.unavailable ? (
              <p role="status" className="text-sm text-ui-muted">{t("reporting.partial")}</p>
            ) : null}
            <DashboardMetricsPanel
              kpis={shipmentReporting.cards.map((card) => ({
                title: t(`reporting.${card.key}`),
                value: card.value === null ? t("reporting.unavailable")
                  : card.percent ? `${card.value}%` : card.value.toLocaleString(locale),
              }))}
              donutData={[]}
            />
            {shipmentReporting.statuses.length > 0 ? (
              <>
                <h3 className="mt-4 font-semibold">{t("reporting.breakdown")}</h3>
                <dl className="grid gap-2 sm:grid-cols-2">
                  {shipmentReporting.statuses.map((status) => (
                    <div key={status.key} className="flex justify-between gap-4">
                      <dt>{t.has(`reporting.statuses.${status.labelKey}`)
                        ? t(`reporting.statuses.${status.labelKey}`)
                        : status.key.replace(/[_-]+/g, " ").trim() || status.key}</dt>
                      <dd>{status.value === null ? t("reporting.unavailable")
                        : status.value.toLocaleString(locale)}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : null}
          </Section>
        </div>
      ) : null}
      <Section
        title={t("sections.overviewTitle")}
        variant="plain"
        collapsible
        collapseKey="dashboard.overview"
      >
        <div
          data-testid={buildTestId(testIdPrefix, "ready")}
          className="grid gap-4 lg:grid-cols-3"
        >
          <div
            data-evidence-mask="dashboard-identity"
            className="rounded-lg border border-ui-border/60 border-s-[3px] border-s-ui-accent bg-ui-accent-soft/20 p-5"
          >
            <div className="text-xs font-medium text-ui-muted">
              {t("identityTitle")}
            </div>
            <div className="mt-2 text-sm font-semibold text-ui-ink">
              {formatValue(me.user?.email ?? me.user?.id, t)}
            </div>
            <div className="mt-2 text-xs text-ui-muted">
              {t("identityRole", { role: formatValue(me.user?.user_type, t) })}
            </div>
          </div>
          <div
            data-evidence-mask="dashboard-identity"
            className="rounded-lg border border-ui-border/60 border-s-[3px] border-s-[rgb(var(--ui-success))] bg-[rgb(var(--ui-success)/0.08)] p-5"
          >
            <div className="text-xs font-medium text-ui-muted">
              {t("scopeTitle")}
            </div>
            <div className="mt-2 text-sm font-semibold text-ui-ink">
              {resolveScopeLabel(me, t)}
            </div>
            <div className="mt-2 text-xs text-ui-muted">
              {t("scopeOrg", {
                org: formatValue(me.org?.name ?? me.org?.id, t),
              })}
            </div>
          </div>
          <div className="rounded-lg border border-ui-border/60 border-s-[3px] border-s-[rgb(var(--ui-info))] bg-[rgb(var(--ui-info)/0.08)] p-5">
            <div className="text-xs font-medium text-ui-muted">
              {t("capabilitiesTitle")}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge tone="accent">
                {t("capabilitiesActive", { count: String(capabilities.size) })}
              </Badge>
              <Badge>
                {t("capabilitiesResources", { count: String(registryCount) })}
              </Badge>
            </div>
            <div className="mt-3 text-xs text-ui-muted">
              {t("settingsResolutionLabel")}{" "}
              <span
                data-testid={
                  testIdPrefix ? `${testIdPrefix}-settings-resolution` : undefined
                }
                className="font-mono text-ui-ink"
                title={me.settings_resolution_id ?? undefined}
              >
                {settingsResolutionReadable}
              </span>
            </div>
          </div>
        </div>
      </Section>
      <Section
        title={t("contextHealthTitle")}
        variant="plain"
        collapsible
        collapseKey="dashboard.health"
      >
        <div
          className="grid gap-3 sm:grid-cols-2"
          data-testid={`${testIdPrefix}-health`}
        >
          {healthChecks.map((check) => (
            <div
              key={check.id}
              className={cn(
                "rounded-lg border border-ui-border/60 p-4",
                check.status === "ok"
                  ? "bg-[rgb(var(--ui-success)/0.10)]"
                  : check.status === "warn"
                    ? "bg-[rgb(var(--ui-warning)/0.10)]"
                    : check.status === "error"
                      ? "bg-[rgb(var(--ui-danger)/0.10)]"
                      : "bg-ui-highlight/40",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-ui-ink">
                  {check.label}
                </div>
                <Badge
                  tone={
                    check.status === "ok"
                      ? "success"
                      : check.status === "warn"
                        ? "warning"
                        : check.status === "error"
                          ? "danger"
                          : "neutral"
                  }
                >
                  {check.status === "ok"
                    ? t("health.ok")
                    : check.status === "error"
                      ? t("health.blocked")
                      : t("health.review")}
                </Badge>
              </div>
              <div className="mt-2 text-xs text-ui-muted">{check.detail}</div>
            </div>
          ))}
        </div>
      </Section>
      <Section
        title={t("commandCenter.title")}
        description={t("commandCenter.description")}
        variant="plain"
        collapsible
        collapseKey="dashboard.command-center"
      >
        <div
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          data-testid={`${testIdPrefix}-command-center`}
        >
          <div className="rounded-lg border border-ui-border/60 bg-ui-highlight/40 p-4">
            <div className="text-xs font-medium text-ui-muted">
              {t("commandCenter.summary.metricReadback")}
            </div>
            <div className="mt-2 text-lg font-semibold text-ui-ink">
              {t("commandCenter.summary.metricReadbackValue", {
                ready: String(commandCenterSummary.metricReadyCount),
                total: String(commandCenterSummary.metricLaneCount),
              })}
            </div>
            <div className="mt-1 text-xs text-ui-muted">
              {missingMetricCount > 0
                ? t("commandCenter.summary.metricReadbackPartialDetail", {
                    ready: String(commandCenterSummary.metricReadyCount),
                    total: String(commandCenterSummary.metricLaneCount),
                  })
                : t("commandCenter.summary.metricReadbackDetail")}
            </div>
          </div>
          <div className="rounded-lg border border-ui-border/60 bg-ui-surface p-4">
            <div className="text-xs font-medium text-ui-muted">
              {t("commandCenter.summary.workflowCommands")}
            </div>
            <div className="mt-2 text-lg font-semibold text-ui-ink">
              {commandRegistryError
                ? t("commandCenter.summary.unavailableValue")
                : (formatCount(commandCenterSummary.workflowCommandCount) ??
                  "0")}
            </div>
            <div className="mt-1 text-xs text-ui-muted">
              {commandRegistryError
                ? t("commandCenter.summary.workflowCommandsUnavailableDetail")
                : t("commandCenter.summary.workflowCommandsDetail")}
            </div>
          </div>
          <div className="rounded-lg border border-ui-border/60 bg-ui-surface p-4">
            <div className="text-xs font-medium text-ui-muted">
              {t("commandCenter.summary.allowedCommands")}
            </div>
            <div className="mt-2 text-lg font-semibold text-ui-ink">
              {commandRegistryError
                ? t("commandCenter.summary.unavailableValue")
                : t("commandCenter.summary.allowedCommandsValue", {
                    allowed: String(commandCenterSummary.allowedCommandCount),
                    total: String(commandCenterSummary.commandCount),
                  })}
            </div>
            <div className="mt-1 text-xs text-ui-muted">
              {commandRegistryError
                ? t("commandCenter.summary.allowedCommandsUnavailableDetail")
                : t("commandCenter.summary.allowedCommandsDetail", {
                    restricted: String(
                      commandCenterSummary.restrictedCommandCount,
                    ),
                  })}
            </div>
          </div>
          <div
            className={cn(
              "rounded-lg border border-ui-border/60 p-4",
              commandCenterIssues.length > 0
                ? "bg-[rgb(var(--ui-warning)/0.10)]"
                : "bg-[rgb(var(--ui-success)/0.10)]",
            )}
          >
            <div className="text-xs font-medium text-ui-muted">
              {t("commandCenter.summary.registryReadback")}
            </div>
            <div className="mt-2 text-lg font-semibold text-ui-ink">
              {commandCenterIssues.length > 0
                ? t("commandCenter.summary.registryReadbackReview")
                : t("commandCenter.summary.registryReadbackReady")}
            </div>
            <div className="mt-1 text-xs text-ui-muted">
              {commandCenterIssues.length > 0
                ? t("commandCenter.summary.registryReadbackIssues", {
                    count: String(commandCenterIssues.length),
                  })
                : t("commandCenter.summary.registryReadbackDetail")}
            </div>
          </div>
        </div>
        {commandCenterIssues.length > 0 ? (
          <div
            className="mt-4 space-y-2 rounded-lg border border-ui-border/60 bg-[rgb(var(--ui-warning)/0.08)] p-4"
            data-testid={`${testIdPrefix}-command-center-degraded`}
          >
            {commandCenterIssues.map((issue) => (
              <div key={issue.key} className="text-sm text-ui-ink">
                <span className="font-semibold">{issue.label}</span>
                <span className="text-ui-muted"> {issue.detail}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {commandCenterLanes.length === 0 ? (
            <div className="rounded-lg border border-ui-border/60 bg-ui-surface p-4 text-sm text-ui-muted shadow-sm">
              {t("commandCenter.lanes.empty")}
            </div>
          ) : (
            commandCenterLanes.map((lane) => {
              const laneCommandHref = resolveSafeHref(
                appBasePath,
                `/commands?category=${encodeURIComponent(
                  lane.commandCategory,
                )}&access=allowed`,
              );
              const laneHref = resolveDashboardNavigationHref(
                appBasePath,
                lane.href,
              );
              const disabled =
                !laneHref || Boolean(lane.disabledReason) || !lane.readAllowed;
              const disabledReason =
                lane.disabledReason ??
                (!lane.registryBacked
                  ? t("moduleUnavailable")
                  : !lane.readAllowed
                    ? t("commandCenter.lanes.permissionRequired")
                    : t("moduleUnavailable"));
              const recordsLabel =
                formatCount(lane.metricTotal) ??
                t("commandCenter.lanes.metricUnavailable");
              return (
                <div
                  key={lane.resourceKey}
                  className="rounded-lg border border-ui-border/60 bg-ui-surface p-5 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-ui-ink">
                        {lane.resourceLabel}
                      </div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("commandCenter.lanes.records", {
                          count: recordsLabel,
                        })}
                      </div>
                    </div>
                    <Badge
                      tone={
                        !commandRegistryError && lane.allowedCommandCount > 0
                          ? "accent"
                          : "neutral"
                      }
                    >
                      {commandRegistryError
                        ? t("commandCenter.summary.unavailableValue")
                        : t("commandCenter.lanes.commands", {
                            count: String(lane.allowedCommandCount),
                            total: String(lane.commandCount),
                          })}
                    </Badge>
                  </div>
                  {lane.assignedMetricTotal !== undefined ? (
                    <div className="mt-3 text-sm text-ui-ink">
                      <span className="font-semibold">
                        {t("commandCenter.myDay.title")}
                      </span>{" "}
                      {t("commandCenter.myDay.assigned", {
                        count:
                          formatCount(lane.assignedMetricTotal) ??
                          t("commandCenter.lanes.metricUnavailable"),
                      })}
                    </div>
                  ) : null}
                  {lane.capability ? (
                    <div className="mt-3 text-xs text-ui-muted">
                      {t("commandCenter.lanes.capability")}{" "}
                      <span className="font-mono text-ui-ink">
                        {lane.capability}
                      </span>
                    </div>
                  ) : null}
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {laneHref && !disabled ? (
                      <Button asChild variant="ghost">
                        <a
                          aria-label={`${t("commandCenter.lanes.openLane")}: ${lane.resourceLabel}`}
                          href={laneHref}
                        >
                          {t("commandCenter.lanes.openLane")}
                        </a>
                      </Button>
                    ) : null}
                    {lane.readAllowed &&
                    lane.allowedCommandCount > 0 &&
                    laneCommandHref ? (
                      <Button asChild>
                        <a
                          aria-label={`${t("commandCenter.lanes.openCommands")}: ${lane.resourceLabel}`}
                          href={laneCommandHref}
                        >
                          {t("commandCenter.lanes.openCommands")}
                        </a>
                      </Button>
                    ) : null}
                    {disabled ? (
                      <span className="text-xs text-ui-muted">
                        {disabledReason}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Section>
      <Section
        title={t("quickActionsTitle")}
        description={t("quickActionsSubtitle")}
        variant="plain"
        collapsible
        collapseKey="dashboard.quick-actions"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          {commandsHref ? (
            <Button asChild variant="ghost">
              <a href={commandsHref}>{t("quickActionsLink")}</a>
            </Button>
          ) : (
            <span className="text-sm text-ui-muted">
              {t("quickActionsLink")}
            </span>
          )}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {actions.length === 0 ? (
            <div className="rounded-lg border border-ui-border/60 bg-ui-surface p-4 text-sm text-ui-muted shadow-sm">
              {t("quickActionsEmpty")}
            </div>
          ) : (
            actions.map((action) => (
              <div
                key={action.key}
                className={cn(
                  "rounded-lg border border-ui-border/60 bg-ui-surface p-5 shadow-sm",
                  action.allowed &&
                    "border-s-2 border-s-[rgb(var(--ui-success)/0.5)]",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-ui-ink">
                      {action.label}
                    </div>
                    {action.description ? (
                      <p className="mt-2 text-xs text-ui-muted">
                        {action.description}
                      </p>
                    ) : null}
                  </div>
                  <Badge tone={action.allowed ? "accent" : "neutral"}>
                    {action.allowed
                      ? t("actionAllowed")
                      : t("actionRestricted")}
                  </Badge>
                </div>
                {action.capability ? (
                  <div className="mt-3 text-xs text-ui-muted">
                    {t("actionCapabilityLabel")}{" "}
                    <span className="font-mono text-ui-ink">
                      {action.capability}
                    </span>
                  </div>
                ) : null}
                {action.allowed ? (
                  <div className="mt-4">
                    <Button asChild>
                      <a href={action.href} data-testid={`${testIdPrefix}-action-${action.key}`}>{t("actionStart")}</a>
                    </Button>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </Section>
      <Section
        title={t("modulesTitle")}
        variant="plain"
        collapsible
        collapseKey="dashboard.modules"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {dashboardSections.length === 0 ? (
            <div className="rounded-lg border border-ui-border/60 bg-ui-surface p-4 text-sm text-ui-muted shadow-sm">
              {t("modulesEmpty")}
            </div>
          ) : (
            dashboardSections.map((section) => (
              <div
                key={section.id}
                className="rounded-lg border border-ui-border/60 bg-ui-surface p-5 shadow-sm"
              >
                <div className="text-sm font-semibold text-ui-ink">
                  {section.label}
                </div>
                <div className="mt-4 overflow-hidden rounded-lg border border-ui-border/60 bg-ui-surface/60">
                  <div className="divide-y divide-ui-border/60">
                    {section.items.map((item) => {
                      const itemHref = resolveDashboardNavigationHref(
                        appBasePath,
                        item.href,
                      );
                      const itemReadState = resolveDashboardResourceReadState(
                        item.resourceKey,
                        readRegistry,
                        capabilities,
                      );
                      const disabled =
                        !itemHref ||
                        Boolean(item.disabledReason) ||
                        !itemReadState.readAllowed;
                      const readDisabledReason = !itemReadState.registryBacked
                        ? t("moduleUnavailable")
                        : !itemReadState.readAllowed
                          ? t("commandCenter.lanes.permissionRequired")
                          : t("moduleUnavailable");
                      const countLabel = formatCount(
                        item.resourceKey
                          ? resourceCounts.get(item.resourceKey)
                          : null,
                      );
                      const meta = disabled
                        ? (item.disabledReason ?? readDisabledReason)
                        : countLabel
                          ? t("moduleRecords", { count: countLabel })
                          : t("moduleOpen");
                      const content = (
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm text-ui-ink">
                            {item.label}
                          </div>
                          <div className="text-xs text-ui-muted">{meta}</div>
                        </div>
                      );
                      if (itemHref && !disabled) {
                        return (
                          <a
                            key={item.id}
                            className="block px-4 py-3 text-sm text-ui-ink transition hover:bg-ui-highlight/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-surface"
                            href={itemHref}
                            data-testid={`${testIdPrefix}-module-${item.id}`}
                          >
                            {content}
                          </a>
                        );
                      }
                      return (
                        <div
                          key={item.id}
                          className="block px-4 py-3 text-sm text-ui-muted"
                        >
                          {content}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </Section>
    </PageContainer>
  );
}
