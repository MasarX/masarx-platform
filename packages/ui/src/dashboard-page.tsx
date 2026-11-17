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
  buildDashboardSections,
  collectResourceKeys,
  type DashboardSection,
} from "./dashboard-utils";
import { ContextNotice } from "./context-notice";
import { createUiTranslator } from "./i18n";
import type { AbstractIntlMessages } from "next-intl";
import { buildTestId } from "./test-ids";
import { PageHeader } from "./page-header";
import { PageContainer } from "./page-container";
import { Section } from "./section";
import { formatReferenceValue } from "./resource-utils";
import { formatUiError, cn } from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { resolveSafeHref } from "./url-guard";

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
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const maxSections =
    clampNumber(raw.max_sections ?? DEFAULT_DASHBOARD.maxSections, 1, 20) ??
    DEFAULT_DASHBOARD.maxSections;
  const maxItemsPerSection =
    clampNumber(
      raw.max_items_per_section ?? DEFAULT_DASHBOARD.maxItemsPerSection,
      1,
      50
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
  };
}

const formatValue = (value: string | null | undefined, t: (key: string) => string) => {
  if (!value) return t("unknown");
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : t("unknown");
};

const formatCount = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value.toLocaleString();
};

function resolveScopeLabel(me: UiMe | null, t: (key: string, values?: Record<string, string>) => string) {
  const scope = me?.access_scope;
  const scopeType = normalizeUiScopeType(scope?.scope_type ?? null);
  if (!scopeType) return t("unknown");
  const labelRaw = scope?.scope_label ?? scope?.scope_id ?? "";
  const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
  if (scopeType === "global" && !label) return scopeType;
  return t("scopeLabel", { scopeType, scopeLabel: formatValue(label, t) });
}

function buildActionCards(
  commands: UiCommandDefinition[],
  appBasePath: string,
  appKey: string,
  capabilities: Set<string>
): ActionCard[] {
  return commands
    .map((command) => {
      const href = resolveCommandHref(command, appBasePath, appKey);
      if (!href) return null;
      const capability = command.capability ?? null;
      const allowed = hasCapability(capabilities, capability);
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
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function resolveResourceCounts(
  ui: ReturnType<typeof createUiServerClient>,
  sections: DashboardSection[],
  maxMetrics: number
) {
  const resourceKeys = collectResourceKeys(sections).slice(0, maxMetrics);
  const counts = new Map<string, number | null>();
  if (resourceKeys.length === 0) return counts;

  const applyCount = (resource: string, total: number | null | undefined) => {
    counts.set(resource, Number.isFinite(total as number) ? Number(total) : null);
  };

  try {
    const aggregated = await ui.dashboardMetrics(resourceKeys);
    if (Array.isArray(aggregated?.metrics) && aggregated.metrics.length > 0) {
      aggregated.metrics.forEach((metric) => {
        applyCount(metric.resource, metric.total ?? null);
      });
      resourceKeys.forEach((resourceKey) => {
        if (!counts.has(resourceKey)) counts.set(resourceKey, null);
      });
      return counts;
    }
  } catch (_error) {
    // Fall back to per-resource listing.
  }

  await Promise.all(
    resourceKeys.map(async (resourceKey) => {
      try {
        const list = await ui.listResource(resourceKey, {}, 1, 0, null);
        const total =
          typeof list.total === "number" ? list.total : list.items.length;
        applyCount(resourceKey, total);
      } catch (_error) {
        counts.set(resourceKey, null);
      }
    })
  );
  return counts;
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

  try {
    readRegistry = await ui.readRegistry();
  } catch (_error) {
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

  const navigation = normalizeNavigation(context.navigation);
  const resolvedMaxSections =
    typeof maxSections === "number" ? maxSections : dashboardConfig.maxSections;
  const resolvedMaxItems =
    typeof maxItemsPerSection === "number"
      ? maxItemsPerSection
      : dashboardConfig.maxItemsPerSection;
  const dashboardSections = buildDashboardSections(navigation.sections, {
    maxItemsPerSection: resolvedMaxItems,
    maxSections: resolvedMaxSections,
  });
  const me = context.me;
  const capabilities = resolveCapabilitySet(me.capabilities);
  const actions = buildActionCards(
    commandRegistry,
    appBasePath,
    appKey,
    capabilities
  ).slice(0, dashboardConfig.maxActions);
  const registryCount = Array.isArray(readRegistry?.resources)
    ? readRegistry!.resources.length
    : 0;
  const healthChecks = buildContextHealthChecks({
    me,
    navigationCount: navigation.sections.length,
    commandCount: commandRegistry.length,
    resourceCount: registryCount,
  }, t);
  const commandsHref = resolveSafeHref(appBasePath, "/commands");
  const resourceCounts = await resolveResourceCounts(
    ui,
    dashboardSections,
    dashboardConfig.maxMetrics
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
          <div className="rounded-lg border border-ui-border/60 border-s-[3px] border-s-ui-accent bg-ui-accent-soft/20 p-5">
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
          <div className="rounded-lg border border-ui-border/60 border-s-[3px] border-s-[rgb(var(--ui-success))] bg-[rgb(var(--ui-success)/0.08)] p-5">
            <div className="text-xs font-medium text-ui-muted">
              {t("scopeTitle")}
            </div>
            <div className="mt-2 text-sm font-semibold text-ui-ink">
              {resolveScopeLabel(me, t)}
            </div>
            <div className="mt-2 text-xs text-ui-muted">
              {t("scopeOrg", { org: formatValue(me.org?.name ?? me.org?.id, t) })}
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
              <Badge>{t("capabilitiesResources", { count: String(registryCount) })}</Badge>
            </div>
            <div className="mt-3 text-xs text-ui-muted">
              {t("settingsResolutionLabel")}{" "}
              <span
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
                      : "bg-ui-highlight/40"
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-ui-ink">
                  {check.label}
                </div>
                <Badge tone={check.status === "ok" ? "success" : check.status === "warn" ? "warning" : check.status === "error" ? "danger" : "neutral"}>
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
            <span className="text-sm text-ui-muted">{t("quickActionsLink")}</span>
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
                  action.allowed && "border-s-2 border-s-[rgb(var(--ui-success)/0.5)]"
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
                    {action.allowed ? t("actionAllowed") : t("actionRestricted")}
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
                      <a href={action.href}>{t("actionStart")}</a>
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
                      const disabled = !item.href || Boolean(item.disabledReason);
                      const countLabel = formatCount(
                        item.resourceKey
                          ? resourceCounts.get(item.resourceKey)
                          : null
                      );
                      const meta = disabled
                        ? item.disabledReason ?? t("moduleUnavailable")
                        : countLabel
                          ? t("moduleRecords", { count: countLabel })
                          : t("moduleOpen");
                      const content = (
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm text-ui-ink">{item.label}</div>
                          <div className="text-xs text-ui-muted">{meta}</div>
                        </div>
                      );
                      if (item.href && !disabled) {
                        return (
                          <a
                            key={item.id}
                            className="block px-4 py-3 text-sm text-ui-ink transition hover:bg-ui-highlight/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-surface"
                            href={item.href}
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
