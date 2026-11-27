import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import type { UiOnboardingReadiness } from "@masarx/api";
import { Badge } from "./badge";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { formatUiError } from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { createUiTranslator } from "./i18n";

type SearchParams = Record<string, string | string[] | undefined>;

type OnboardingReadinessPageProps = {
  appKey: "console" | "portal";
  appBasePath: string;
  baseHref: string;
  testIdPrefix: string;
  visibility?: "full" | "client_safe";
  searchParams?: SearchParams;
};

type JsonRecord = Record<string, unknown>;
type Translate = ReturnType<typeof createUiTranslator>;

const SETTINGS_CAPABILITY = "settings.read";
const WORKFLOWS_CAPABILITY = "workflow_runs.read";
const PLUGINS_CAPABILITY = "integration_plugins.read";

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function recordValue(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function arrayValue<T = unknown>(value: unknown) {
  return Array.isArray(value) ? (value as T[]) : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : false;
}

function toneForStatus(value: string | null) {
  if (value === "healthy" || value === "ready") return "success" as const;
  if (value === "pending_credentials" || value === "warning") return "warning" as const;
  if (value === "blocked") return "danger" as const;
  return "neutral" as const;
}

function formatStatusLabel(t: Translate, value: string | null) {
  if (!value) return t("summary.unknown");
  return value.replace(/_/g, " ");
}

function countLabel(t: Translate, current: number, total: number) {
  if (total <= 0) return t("summary.noRequiredDefaults");
  return t("summary.readyCount", { current, total });
}

export async function OnboardingReadinessPage({
  appKey,
  appBasePath,
  baseHref,
  testIdPrefix,
  visibility = "full",
  searchParams,
}: OnboardingReadinessPageProps) {
  const t = createUiTranslator("ui.onboardingReadiness");
  const ui = createUiServerClient();

  let meError: string | null = null;
  let readinessError: string | null = null;
  let capabilities: string[] = [];
  let requestedScopeType = firstValue(searchParams?.scope_type) ?? null;
  let requestedScopeId = firstValue(searchParams?.scope_id) ?? null;
  let readiness: UiOnboardingReadiness | null = null;

  try {
    const me = await ui.me();
    capabilities = me?.capabilities ?? [];
    requestedScopeType ||= me?.access_scope?.scope_type ?? null;
    requestedScopeId ||= me?.access_scope?.scope_id ?? null;
  } catch (error) {
    meError = formatUiError(error, t("errors.loadScope"));
  }

  const capabilitySet = resolveCapabilitySet(capabilities);
  const canReadSettings = hasCapability(capabilitySet, SETTINGS_CAPABILITY);
  const canReadWorkflows = hasCapability(capabilitySet, WORKFLOWS_CAPABILITY);
  const canReadPlugins = hasCapability(capabilitySet, PLUGINS_CAPABILITY);
  const canReadAny = canReadSettings || canReadWorkflows || canReadPlugins;

  if (requestedScopeType && canReadAny) {
    try {
      readiness = await ui.onboardingReadiness(requestedScopeType, requestedScopeId);
    } catch (error) {
      readinessError = formatUiError(error, t("errors.loadReadiness"));
    }
  } else if (!meError) {
    readinessError = t("errors.noScope");
  }

  const settings = recordValue(readiness?.settings_defaults ?? null);
  const workflows = recordValue(readiness?.workflow_bindings ?? null);
  const plugins = recordValue(readiness?.integration_plugins ?? null);
  const labelDesign = readiness?.label_design;
  const labelPresent = numberValue(labelDesign?.present_count ?? labelDesign?.healthy_count);
  const labelRequired = numberValue(labelDesign?.required_count ?? labelPresent);
  const labelStatus = stringValue(labelDesign?.status);
  const labelStatusKey = ["healthy", "ready", "warning", "blocked", "not_applicable"].includes(labelStatus ?? "")
    ? labelStatus
    : "unknown";
  const tLabel = createUiTranslator("ui.onboardingReadiness.labelDesign");
  const pluginItems = arrayValue<JsonRecord>(plugins?.items);
  const blockingFindings = arrayValue<JsonRecord>(readiness?.blocking_findings);
  const overallStatus = stringValue(readiness?.overall_status) ?? null;
  const clientSafeVisibility = visibility === "client_safe";
  const readAtIso = stringValue(readiness?.generated_at) ?? new Date().toISOString();
  const readyTestId = `${testIdPrefix}-ready`;
  const errorTestId = `${testIdPrefix}-error`;
  const blockedTestId = `${testIdPrefix}-blocked`;

  const quickLinks = clientSafeVisibility
    ? []
    : [
        {
          href: `${appBasePath}/workflows/bindings`,
          label: t("summary.workflowBindings"),
        },
        ...(appKey === "console"
          ? [
              {
                href: `${appBasePath}/integrations/plugins`,
                label: t("summary.integrationPlugins"),
              },
            ]
          : []),
      ];

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title={t("page.title")}
        eyebrow={appKey === "console" ? t("page.eyebrowConsole") : t("page.eyebrowPortal")}
        description={t("page.description")}
      />

      <Section
        title={t("scope.title")}
        description={t("scope.description")}
      >
        <div className="grid gap-3 text-sm sm:grid-cols-4" data-testid={`${testIdPrefix}-scope`}>
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
            <div className="text-xs uppercase tracking-wide text-ui-muted">{t("scope.scopeType")}</div>
            <div className="mt-1 font-medium text-ui-ink">
              {requestedScopeType ?? t("scope.notAvailable")}
            </div>
          </div>
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
            <div className="text-xs uppercase tracking-wide text-ui-muted">{t("scope.scopeId")}</div>
            <div className="mt-1 break-all font-medium text-ui-ink">
              {requestedScopeId ?? t("scope.notAvailable")}
            </div>
          </div>
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
            <div className="text-xs uppercase tracking-wide text-ui-muted">{t("scope.capabilities")}</div>
            <div className="mt-1 flex flex-wrap gap-2">
              <Badge tone={canReadSettings ? "success" : "neutral"}>
                {canReadSettings ? SETTINGS_CAPABILITY : t("scope.settingsMissing")}
              </Badge>
              <Badge tone={canReadWorkflows ? "success" : "neutral"}>
                {canReadWorkflows ? WORKFLOWS_CAPABILITY : t("scope.workflowMissing")}
              </Badge>
              <Badge tone={canReadPlugins ? "success" : "neutral"}>
                {canReadPlugins ? PLUGINS_CAPABILITY : t("scope.pluginsMissing")}
              </Badge>
            </div>
          </div>
          <div
            className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4"
            data-testid={`${testIdPrefix}-read-at`}
          >
            <div className="text-xs uppercase tracking-wide text-ui-muted">{t("scope.snapshotRead")}</div>
            <div className="mt-1 break-all font-medium text-ui-ink">{readAtIso}</div>
          </div>
        </div>
        {meError ? <p className="mt-3 text-xs text-ui-muted">{meError}</p> : null}
      </Section>

      <Section
        title={t("summary.title")}
        description={t("summary.description")}
      >
        {!canReadAny ? (
          <div
            className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted"
            data-testid={blockedTestId}
          >
            {t("summary.readRequired")}
          </div>
        ) : readinessError ? (
          <div
            className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted"
            data-testid={errorTestId}
          >
            {readinessError}
          </div>
        ) : !readiness ? (
          <div
            className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted"
            data-testid={blockedTestId}
          >
            {t("summary.noSnapshot")}
          </div>
        ) : (
          <div className="space-y-4" data-testid={readyTestId}>
            <div
              className="flex flex-wrap items-center gap-3 rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4"
              data-testid={`${testIdPrefix}-overall`}
            >
              <Badge tone={toneForStatus(overallStatus)}>
                {formatStatusLabel(t, overallStatus)}
              </Badge>
              <div className="text-sm text-ui-muted">
                {booleanValue(readiness.healthy)
                  ? t("summary.healthy")
                  : t("summary.notHealthy")}
              </div>
              <div className="ml-auto flex flex-wrap gap-3 text-xs">
                {quickLinks.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    className="text-ui-accent underline-offset-4 hover:underline"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-3" data-testid={`${testIdPrefix}-cards`}>
              <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ui-muted">{t("summary.settingsDefaults")}</div>
                    <div className="mt-1 text-sm text-ui-muted">
                      {countLabel(
                        t,
                        numberValue(settings?.present_count),
                        numberValue(settings?.required_count),
                      )}
                    </div>
                  </div>
                  <Badge tone={toneForStatus(stringValue(settings?.status))}>
                    {formatStatusLabel(t, stringValue(settings?.status))}
                  </Badge>
                </div>
              </div>

              <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ui-muted">{t("summary.workflowBindings")}</div>
                    <div className="mt-1 text-sm text-ui-muted">
                      {countLabel(
                        t,
                        numberValue(workflows?.present_count),
                        numberValue(workflows?.required_count),
                      )}
                    </div>
                    {stringValue(workflows?.baseline_profile) ? (
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("summary.baselineProfile", { profile: stringValue(workflows?.baseline_profile) ?? "" })}
                      </div>
                    ) : null}
                  </div>
                  <Badge tone={toneForStatus(stringValue(workflows?.status))}>
                    {formatStatusLabel(t, stringValue(workflows?.status))}
                  </Badge>
                </div>
              </div>

              <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ui-muted">{t("summary.integrationPlugins")}</div>
                    <div className="mt-1 text-sm text-ui-muted">
                      {countLabel(
                        t,
                        numberValue(plugins?.healthy_count) +
                          numberValue(plugins?.pending_credentials_count),
                        numberValue(plugins?.required_count),
                      )}
                    </div>
                    {stringValue(plugins?.baseline_profile) ? (
                      <div className="mt-1 text-xs text-ui-muted">
                        {t("summary.baselineProfile", { profile: stringValue(plugins?.baseline_profile) ?? "" })}
                      </div>
                    ) : null}
                  </div>
                  <Badge tone={toneForStatus(stringValue(plugins?.status))}>
                    {formatStatusLabel(t, stringValue(plugins?.status))}
                  </Badge>
                </div>
              </div>
              {labelDesign ? (
                <div
                  className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4"
                  data-testid={`${testIdPrefix}-label-design`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-ui-muted">{tLabel("title")}</div>
                      <div className="mt-1 text-sm text-ui-muted">
                        {tLabel("readyCount", { current: labelPresent, total: labelRequired })}
                      </div>
                    </div>
                    <Badge tone={toneForStatus(labelStatus)} data-testid={`${testIdPrefix}-label-design-status`}>
                      {tLabel(`status.${labelStatusKey}`)}
                    </Badge>
                  </div>
                  <div className="mt-2 text-sm text-ui-muted">
                    <div>{tLabel("blockingCount", { count: numberValue(labelDesign.blocking_count) })}</div>
                    <div>{tLabel("warningCount", { count: numberValue(labelDesign.warning_count) })}</div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </Section>

      <Section
        title={t("findings.title")}
        description={
          clientSafeVisibility
            ? t("findings.descriptionClientSafe")
            : t("findings.descriptionFull")
        }
        testId={`${testIdPrefix}-findings-section`}
      >
        {blockingFindings.length === 0 ? (
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted">
            {t("findings.empty")}
          </div>
        ) : clientSafeVisibility ? (
          <div
            className="rounded-xl border border-[rgb(var(--ui-warning)/0.24)] bg-[rgb(var(--ui-warning)/0.08)] p-4 text-sm text-ui-muted"
            data-testid={`${testIdPrefix}-findings-summary`}
          >
            {t("findings.clientSafeSummary", { count: blockingFindings.length })}
          </div>
        ) : (
          <div className="space-y-3" data-testid={`${testIdPrefix}-findings`}>
            {blockingFindings.map((finding, index) => (
              <div
                key={`${stringValue(finding.code) ?? "finding"}-${index}`}
                className="rounded-xl border border-[rgb(var(--ui-danger)/0.2)] bg-[rgb(var(--ui-danger)/0.06)] p-4"
              >
                <div className="flex items-center gap-2">
                  <Badge tone="danger">{stringValue(finding.code) ?? t("findings.fallbackCode")}</Badge>
                  <div className="text-xs uppercase tracking-wide text-ui-muted">
                    {stringValue(finding.component) ?? t("findings.fallbackComponent")}
                  </div>
                </div>
                <p className="mt-2 text-sm text-ui-ink">
                  {stringValue(finding.message) ?? t("findings.fallbackMessage")}
                </p>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={t("plugins.title")}
        description={
          clientSafeVisibility
            ? t("plugins.descriptionClientSafe")
            : t("plugins.descriptionFull")
        }
        collapsible
        collapseKey="onboarding-readiness.plugins"
        testId={`${testIdPrefix}-plugins-section`}
      >
        {pluginItems.length === 0 ? (
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted">
            {t("plugins.empty")}
          </div>
        ) : clientSafeVisibility ? (
          <div
            className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted"
            data-testid={`${testIdPrefix}-plugins-summary`}
          >
            <div className="font-medium text-ui-ink">
              {countLabel(
                t,
                numberValue(plugins?.healthy_count) +
                  numberValue(plugins?.pending_credentials_count),
                numberValue(plugins?.required_count),
              )}
            </div>
            <div className="mt-2">
              {t("plugins.clientSafeCounts", {
                healthy: numberValue(plugins?.healthy_count),
                pending: numberValue(plugins?.pending_credentials_count),
              })}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-start text-sm" data-testid={`${testIdPrefix}-plugins-table`}>
              <thead className="text-xs uppercase tracking-wide text-ui-muted">
                <tr className="border-b border-ui-border/60">
                  <th className="px-3 py-3">{t("plugins.columns.plugin")}</th>
                  <th className="px-3 py-3">{t("plugins.columns.mode")}</th>
                  <th className="px-3 py-3">{t("plugins.columns.status")}</th>
                  <th className="px-3 py-3">{t("plugins.columns.version")}</th>
                  <th className="px-3 py-3">{t("plugins.columns.bindings")}</th>
                  <th className="px-3 py-3">{t("plugins.columns.tasks")}</th>
                </tr>
              </thead>
              <tbody>
                {pluginItems.map((item, index) => (
                  <tr
                    key={stringValue(item.plugin_key) ?? `plugin-${index}`}
                    className="border-b border-ui-border/40 align-top"
                  >
                    <td className="px-3 py-4">
                      <div className="font-medium text-ui-ink">
                        {stringValue(item.plugin_name) ?? stringValue(item.plugin_key) ?? t("plugins.unknownPlugin")}
                      </div>
                      <div className="text-xs text-ui-muted">{stringValue(item.plugin_key) ?? t("plugins.unknownKey")}</div>
                    </td>
                    <td className="px-3 py-4">
                      <Badge tone="neutral">
                        {formatStatusLabel(t, stringValue(item.activation_mode))}
                      </Badge>
                    </td>
                    <td className="px-3 py-4">
                      <Badge tone={toneForStatus(stringValue(item.status))}>
                        {formatStatusLabel(t, stringValue(item.status))}
                      </Badge>
                    </td>
                    <td className="px-3 py-4 text-ui-muted">
                      {stringValue(item.effective_version_status) ?? t("plugins.versionMissing")}
                    </td>
                    <td className="px-3 py-4 text-ui-muted">
                      {numberValue(item.binding_count)}
                    </td>
                    <td className="px-3 py-4 text-ui-muted">
                      {booleanValue(item.pending_task_exists) ? t("plugins.taskOpen") : t("plugins.noTask")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="text-xs text-ui-muted">
        <a href={baseHref} className="underline-offset-4 hover:underline">
          {t("page.refresh")}
        </a>
      </div>
    </PageContainer>
  );
}
