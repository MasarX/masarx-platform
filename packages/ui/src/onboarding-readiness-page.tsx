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

function formatStatusLabel(value: string | null) {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ");
}

function countLabel(current: number, total: number) {
  if (total <= 0) return "No required defaults";
  return `${current}/${total} ready`;
}

export async function OnboardingReadinessPage({
  appKey,
  appBasePath,
  baseHref,
  testIdPrefix,
  visibility = "full",
  searchParams,
}: OnboardingReadinessPageProps) {
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
    meError = formatUiError(error, "Unable to load current scope.");
  }

  const capabilitySet = resolveCapabilitySet(capabilities);
  const canReadSettings = hasCapability(capabilitySet, "settings.read");
  const canReadWorkflows = hasCapability(capabilitySet, "workflow_runs.read");
  const canReadPlugins = hasCapability(capabilitySet, "integration_plugins.read");
  const canReadAny = canReadSettings || canReadWorkflows || canReadPlugins;

  if (requestedScopeType && canReadAny) {
    try {
      readiness = await ui.onboardingReadiness(requestedScopeType, requestedScopeId);
    } catch (error) {
      readinessError = formatUiError(error, "Unable to load onboarding readiness.");
    }
  } else if (!meError) {
    readinessError = "No scope could be resolved for the current user.";
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
          label: "Workflow bindings",
        },
        ...(appKey === "console"
          ? [
              {
                href: `${appBasePath}/integrations/plugins`,
                label: "Integration plugins",
              },
            ]
          : []),
      ];

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Onboarding readiness"
        eyebrow={appKey === "console" ? "Console" : "Portal"}
        description="Review the resolved onboarding defaults for the current scope, including required settings, cloned workflow bindings, and baseline integration plugin health."
      />

      <Section
        title="Resolved scope"
        description="The readiness snapshot is evaluated against the currently requested scope. Approval-required onboarding still depends on governance, but this page removes the need for manual SQL inspection."
      >
        <div className="grid gap-3 text-sm sm:grid-cols-4" data-testid={`${testIdPrefix}-scope`}>
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Scope type</div>
            <div className="mt-1 font-medium text-ui-ink">
              {requestedScopeType ?? "Not available"}
            </div>
          </div>
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Scope id</div>
            <div className="mt-1 break-all font-medium text-ui-ink">
              {requestedScopeId ?? "Not available"}
            </div>
          </div>
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Capabilities</div>
            <div className="mt-1 flex flex-wrap gap-2">
              <Badge tone={canReadSettings ? "success" : "neutral"}>
                {canReadSettings ? "settings.read" : "settings missing"}
              </Badge>
              <Badge tone={canReadWorkflows ? "success" : "neutral"}>
                {canReadWorkflows ? "workflow_runs.read" : "workflow missing"}
              </Badge>
              <Badge tone={canReadPlugins ? "success" : "neutral"}>
                {canReadPlugins ? "integration_plugins.read" : "plugins missing"}
              </Badge>
            </div>
          </div>
          <div
            className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4"
            data-testid={`${testIdPrefix}-read-at`}
          >
            <div className="text-xs uppercase tracking-wide text-ui-muted">Snapshot read</div>
            <div className="mt-1 break-all font-medium text-ui-ink">{readAtIso}</div>
          </div>
        </div>
        {meError ? <p className="mt-3 text-xs text-ui-muted">{meError}</p> : null}
      </Section>

      <Section
        title="Status"
        description="A green status means the required defaults for this scope are present and healthy. Pending credentials means the baseline was installed automatically but still needs an operator-managed credential handoff."
      >
        {!canReadAny ? (
          <div
            className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted"
            data-testid={blockedTestId}
          >
            This surface requires at least one of `settings.read`, `workflow_runs.read`, or `integration_plugins.read`.
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
            No readiness snapshot is available for this scope yet.
          </div>
        ) : (
          <div className="space-y-4" data-testid={readyTestId}>
            <div
              className="flex flex-wrap items-center gap-3 rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4"
              data-testid={`${testIdPrefix}-overall`}
            >
              <Badge tone={toneForStatus(overallStatus)}>
                {formatStatusLabel(overallStatus)}
              </Badge>
              <div className="text-sm text-ui-muted">
                {booleanValue(readiness.healthy)
                  ? "All required onboarding defaults for this scope are currently ready."
                  : "The scope still has blocking drift or pending operator work."}
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
                    <div className="text-xs uppercase tracking-wide text-ui-muted">Settings defaults</div>
                    <div className="mt-1 text-sm text-ui-muted">
                      {countLabel(
                        numberValue(settings?.present_count),
                        numberValue(settings?.required_count),
                      )}
                    </div>
                  </div>
                  <Badge tone={toneForStatus(stringValue(settings?.status))}>
                    {formatStatusLabel(stringValue(settings?.status))}
                  </Badge>
                </div>
              </div>

              <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ui-muted">Workflow bindings</div>
                    <div className="mt-1 text-sm text-ui-muted">
                      {countLabel(
                        numberValue(workflows?.present_count),
                        numberValue(workflows?.required_count),
                      )}
                    </div>
                    {stringValue(workflows?.baseline_profile) ? (
                      <div className="mt-1 text-xs text-ui-muted">
                        Baseline profile: {stringValue(workflows?.baseline_profile)}
                      </div>
                    ) : null}
                  </div>
                  <Badge tone={toneForStatus(stringValue(workflows?.status))}>
                    {formatStatusLabel(stringValue(workflows?.status))}
                  </Badge>
                </div>
              </div>

              <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ui-muted">Integration plugins</div>
                    <div className="mt-1 text-sm text-ui-muted">
                      {countLabel(
                        numberValue(plugins?.healthy_count) +
                          numberValue(plugins?.pending_credentials_count),
                        numberValue(plugins?.required_count),
                      )}
                    </div>
                    {stringValue(plugins?.baseline_profile) ? (
                      <div className="mt-1 text-xs text-ui-muted">
                        Baseline profile: {stringValue(plugins?.baseline_profile)}
                      </div>
                    ) : null}
                  </div>
                  <Badge tone={toneForStatus(stringValue(plugins?.status))}>
                    {formatStatusLabel(stringValue(plugins?.status))}
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
        title="Blocking findings"
        description={
          clientSafeVisibility
            ? "Portal exposes only a safe readiness summary. Detailed findings remain operator-facing."
            : "Every finding below is fail-closed evidence for why this scope is not fully ready."
        }
        testId={`${testIdPrefix}-findings-section`}
      >
        {blockingFindings.length === 0 ? (
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted">
            No blocking findings were reported for the current scope.
          </div>
        ) : clientSafeVisibility ? (
          <div
            className="rounded-xl border border-[rgb(var(--ui-warning)/0.24)] bg-[rgb(var(--ui-warning)/0.08)] p-4 text-sm text-ui-muted"
            data-testid={`${testIdPrefix}-findings-summary`}
          >
            {blockingFindings.length} onboarding readiness blocker(s) remain for this scope. Contact your operator if baseline credentials, workflow defaults, or approval follow-up is still pending.
          </div>
        ) : (
          <div className="space-y-3" data-testid={`${testIdPrefix}-findings`}>
            {blockingFindings.map((finding, index) => (
              <div
                key={`${stringValue(finding.code) ?? "finding"}-${index}`}
                className="rounded-xl border border-[rgb(var(--ui-danger)/0.2)] bg-[rgb(var(--ui-danger)/0.06)] p-4"
              >
                <div className="flex items-center gap-2">
                  <Badge tone="danger">{stringValue(finding.code) ?? "blocking"}</Badge>
                  <div className="text-xs uppercase tracking-wide text-ui-muted">
                    {stringValue(finding.component) ?? "onboarding"}
                  </div>
                </div>
                <p className="mt-2 text-sm text-ui-ink">
                  {stringValue(finding.message) ?? "A blocking onboarding readiness issue was reported."}
                </p>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Plugin baseline"
        description={
          clientSafeVisibility
            ? "Portal shows only the client-safe baseline summary. Detailed plugin inventory remains operator-facing."
            : "Baseline plugins are installed automatically during onboarding. `auto_activate` items must be live before day-1 operations; pending-credential items stay visible until an operator finishes the credential handoff."
        }
        collapsible
        collapseKey="onboarding-readiness.plugins"
        testId={`${testIdPrefix}-plugins-section`}
      >
        {pluginItems.length === 0 ? (
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted">
            No baseline plugins are configured for this scope.
          </div>
        ) : clientSafeVisibility ? (
          <div
            className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted"
            data-testid={`${testIdPrefix}-plugins-summary`}
          >
            <div className="font-medium text-ui-ink">
              {countLabel(
                numberValue(plugins?.healthy_count) +
                  numberValue(plugins?.pending_credentials_count),
                numberValue(plugins?.required_count),
              )}
            </div>
            <div className="mt-2">
              Healthy plugins: {numberValue(plugins?.healthy_count)}. Pending credential handoffs:{" "}
              {numberValue(plugins?.pending_credentials_count)}.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-start text-sm" data-testid={`${testIdPrefix}-plugins-table`}>
              <thead className="text-xs uppercase tracking-wide text-ui-muted">
                <tr className="border-b border-ui-border/60">
                  <th className="px-3 py-3">Plugin</th>
                  <th className="px-3 py-3">Mode</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Version</th>
                  <th className="px-3 py-3">Bindings</th>
                  <th className="px-3 py-3">Tasks</th>
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
                        {stringValue(item.plugin_name) ?? stringValue(item.plugin_key) ?? "Unknown plugin"}
                      </div>
                      <div className="text-xs text-ui-muted">{stringValue(item.plugin_key) ?? "unknown"}</div>
                    </td>
                    <td className="px-3 py-4">
                      <Badge tone="neutral">
                        {formatStatusLabel(stringValue(item.activation_mode))}
                      </Badge>
                    </td>
                    <td className="px-3 py-4">
                      <Badge tone={toneForStatus(stringValue(item.status))}>
                        {formatStatusLabel(stringValue(item.status))}
                      </Badge>
                    </td>
                    <td className="px-3 py-4 text-ui-muted">
                      {stringValue(item.effective_version_status) ?? "missing"}
                    </td>
                    <td className="px-3 py-4 text-ui-muted">
                      {numberValue(item.binding_count)}
                    </td>
                    <td className="px-3 py-4 text-ui-muted">
                      {booleanValue(item.pending_task_exists) ? "Task open" : "No task"}
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
          Refresh this readiness snapshot
        </a>
      </div>
    </PageContainer>
  );
}
