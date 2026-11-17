import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import type { UiReadRegistry, UiResourceList } from "@masarx/api";
import { createUiTranslator } from "./i18n";
import { PageHeader } from "./page-header";
import { HashTabs } from "./hash-tabs";
import { ResourceDetail } from "./resource-detail";
import { RelatedResourceTableClient } from "./related-resource-table-client";
import { Section } from "./section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
import { WorkflowTemplateStudioActions } from "./workflow-template-studio-actions";
import { WorkflowTemplateStepsBuilder } from "./workflow-template-steps-builder";
import { WorkflowScheduleTriggersPanel } from "./workflow-schedule-triggers-panel";
import { WorkflowRunTriggersPanel } from "./workflow-run-triggers-panel";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { formatUiError } from "./utils";
import { resolvePaginationSettings } from "./pagination-utils";
import { resolveColumns } from "./resource-page-utils";
import { listAllResources } from "./resource-list-utils";
import { findRegistryResource } from "./ui-registry-utils";
import { resolveWorkflowScheduleTemplateGuide } from "./workflow-schedule-template-guide";
import { resolveSafeHref } from "./url-guard";

type WorkflowTemplateStudioPageProps = {
  templateId: string;
  appBasePath: string;
  testIdPrefix?: string | null;
};

function resolveTemplateTitle(detail: Record<string, unknown> | null) {
  if (!detail) return null;
  const raw = detail.name;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function resolveTemplateStatus(detail: Record<string, unknown> | null) {
  if (!detail) return null;
  const raw = detail.status;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function normalizeText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
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

type WorkflowTemplateDefinitionOverlap = {
  templateId: string;
  templateName: string | null;
  status: string | null;
  scopeType: string | null;
  scopeId: string | null;
  updatedAt: string | null;
};

type WorkflowTemplateTrigger = {
  webhookSourceId: string;
  sourceIdentifier: string | null;
  name: string | null;
  providerType: string | null;
  enabled: boolean | null;
  policyScopeType: string | null;
  policyScopeId: string | null;
};

function resolveWorkflowTemplateIdFromPolicy(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const workflow = (value as { workflow?: unknown }).workflow;
  if (!workflow || typeof workflow !== "object") return null;
  const templateId = (workflow as { template_id?: unknown }).template_id;
  return normalizeText(templateId);
}

function isNotFoundLikeUiError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "string") {
    return error.toLowerCase().includes("not found");
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("not found") ||
      message.includes("invalid input syntax for type uuid")
    );
  }
  if (typeof error !== "object") return false;

  const typed = error as {
    code?: string | number;
    status?: string | number;
    message?: string;
    details?: string;
    error?: string;
  };

  const normalizedCode = typed.code ? String(typed.code).trim().toUpperCase() : null;
  if (normalizedCode === "PGRST116") return true;
  if (normalizedCode === "22P02") return true;

  const normalizedStatus = typed.status ? Number(typed.status) : null;
  if (normalizedStatus === 404) return true;

  const message = String(typed.message ?? typed.details ?? typed.error ?? "")
    .trim()
    .toLowerCase();
  if (!message) return false;
  return (
    message.includes("not found") ||
    message.includes("invalid input syntax for type uuid") ||
    message.includes("no rows") ||
    message.includes("0 rows")
  );
}

/**
 * Workflow template studio: template detail with editable/reorderable steps.
 */
export async function WorkflowTemplateStudioPage({
  templateId,
  appBasePath,
  testIdPrefix,
}: WorkflowTemplateStudioPageProps) {
  const t = createUiTranslator("ui.workflowStudio");
  const ui = createUiServerClient();

  let registry: UiReadRegistry | null = null;
  let userCapabilities: string[] | null = null;
  let detail: Record<string, unknown> | null = null;
  let detailError: string | null = null;
  let stepsList: UiResourceList | null = null;
  let steps: Record<string, unknown>[] = [];
  let stepsTotal: number | null = null;
  let stepsError: string | null = null;
  let runsList: UiResourceList | null = null;
  let runs: Record<string, unknown>[] = [];
  let runsTotal: number | null = null;
  let runsError: string | null = null;
  let scheduleTriggersList: UiResourceList | null = null;
  let scheduleTriggers: Record<string, unknown>[] = [];
  let scheduleTriggersTotal: number | null = null;
  let scheduleTriggersError: string | null = null;
  let workflowTemplatesList: UiResourceList | null = null;
  let workflowTemplates: Record<string, unknown>[] = [];
  let workflowTemplatesError: string | null = null;
  let incomingRunTriggersList: UiResourceList | null = null;
  let incomingRunTriggers: Record<string, unknown>[] = [];
  let incomingRunTriggersTotal: number | null = null;
  let incomingRunTriggersError: string | null = null;
  let outgoingRunTriggersList: UiResourceList | null = null;
  let outgoingRunTriggers: Record<string, unknown>[] = [];
  let outgoingRunTriggersTotal: number | null = null;
  let outgoingRunTriggersError: string | null = null;
  let triggers: WorkflowTemplateTrigger[] = [];
  let webhookTriggersDeniedReason: string | null = null;
  let webhookTriggersError: string | null = null;
  let overlaps: WorkflowTemplateDefinitionOverlap[] = [];
  let overlapsError: string | null = null;
  let paginationSettings = resolvePaginationSettings(null);
  let detailNotFound = false;

  try {
    registry = await ui.readRegistry();
  } catch (_error) {
    registry = null;
  }

  try {
    const me = await ui.me();
    userCapabilities = Array.isArray(me?.capabilities) ? me.capabilities : null;
  } catch (_error) {
    userCapabilities = null;
  }

  try {
    const preview = await ui.settingsPreview({ category: "ui_pagination" });
    paginationSettings = resolvePaginationSettings(preview?.value);
  } catch (_error) {
    paginationSettings = resolvePaginationSettings(null);
  }

  try {
    detail = await ui.getResource("workflow_templates", templateId);
  } catch (error) {
    detailError = formatUiError(error, t("errors.loadTemplate"));
    detailNotFound = isNotFoundLikeUiError(error);
  }

  try {
    const stepLimit = Math.max(1, paginationSettings.maxPageSize);
    stepsList = await listAllResources(
      ui,
      "workflow_template_steps",
      { workflow_template_id: templateId },
      stepLimit
    );
    steps = Array.isArray(stepsList.items) ? stepsList.items : [];
    stepsTotal = typeof stepsList.total === "number" ? stepsList.total : null;
  } catch (error) {
    stepsError = formatUiError(error, t("errors.loadSteps"));
  }

  try {
    const runLimit = Math.max(1, Math.min(paginationSettings.maxPageSize, 25));
    runsList = await ui.listResource(
      "workflow_runs",
      { workflow_template_id: templateId },
      runLimit,
      0,
      { key: "created_at", direction: "desc" }
    );
    runs = Array.isArray(runsList.items) ? runsList.items : [];
    runsTotal = typeof runsList.total === "number" ? runsList.total : null;
  } catch (error) {
    runsError = formatUiError(error, t("errors.loadRuns"));
  }

  try {
    const triggerLimit = Math.max(25, Math.min(paginationSettings.maxPageSize, 200));
    scheduleTriggersList = await listAllResources(
      ui,
      "workflow_schedule_triggers",
      { workflow_template_id: templateId },
      triggerLimit,
      { key: "next_run_at", direction: "asc" }
    );
    scheduleTriggers = Array.isArray(scheduleTriggersList.items)
      ? scheduleTriggersList.items
      : [];
    scheduleTriggersTotal =
      typeof scheduleTriggersList.total === "number" ? scheduleTriggersList.total : null;
  } catch (error) {
    scheduleTriggers = [];
    scheduleTriggersError = formatUiError(error, t("errors.loadScheduleTriggers"));
  }

  try {
    const templateLimit = Math.max(25, Math.min(paginationSettings.maxPageSize, 200));
    workflowTemplatesList = await listAllResources(
      ui,
      "workflow_templates",
      {},
      templateLimit,
      { key: "name", direction: "asc" }
    );
    workflowTemplates = Array.isArray(workflowTemplatesList.items)
      ? workflowTemplatesList.items
      : [];
  } catch (error) {
    workflowTemplates = [];
    workflowTemplatesError = formatUiError(error, t("errors.loadWorkflowTemplates"));
  }

  try {
    const triggerLimit = Math.max(25, Math.min(paginationSettings.maxPageSize, 200));
    incomingRunTriggersList = await listAllResources(
      ui,
      "workflow_run_triggers",
      { target_workflow_template_id: templateId },
      triggerLimit,
      { key: "updated_at", direction: "desc" }
    );
    incomingRunTriggers = Array.isArray(incomingRunTriggersList.items)
      ? incomingRunTriggersList.items
      : [];
    incomingRunTriggersTotal =
      typeof incomingRunTriggersList.total === "number" ? incomingRunTriggersList.total : null;
  } catch (error) {
    incomingRunTriggers = [];
    incomingRunTriggersError = formatUiError(error, t("errors.loadWorkflowRunTriggers"));
  }

  try {
    const triggerLimit = Math.max(25, Math.min(paginationSettings.maxPageSize, 200));
    outgoingRunTriggersList = await listAllResources(
      ui,
      "workflow_run_triggers",
      { source_workflow_template_id: templateId },
      triggerLimit,
      { key: "updated_at", direction: "desc" }
    );
    outgoingRunTriggers = Array.isArray(outgoingRunTriggersList.items)
      ? outgoingRunTriggersList.items
      : [];
    outgoingRunTriggersTotal =
      typeof outgoingRunTriggersList.total === "number" ? outgoingRunTriggersList.total : null;
  } catch (error) {
    outgoingRunTriggers = [];
    outgoingRunTriggersError = formatUiError(error, t("errors.loadWorkflowRunTriggers"));
  }

  try {
    const capabilitySet = resolveCapabilitySet(userCapabilities);
    if (!hasCapability(capabilitySet, "webhooks.read")) {
      webhookTriggersDeniedReason = "webhooks.read";
    } else if (!hasCapability(capabilitySet, "settings.read")) {
      webhookTriggersDeniedReason = "settings.read";
    } else {
      const sourceLimit = Math.max(25, Math.min(paginationSettings.maxPageSize, 200));
      const sources = await ui.listResource(
        "webhook_sources",
        {},
        sourceLimit,
        0,
        { key: "created_at", direction: "desc" }
      );
      const items = Array.isArray(sources.items) ? sources.items : [];
      const matches: WorkflowTemplateTrigger[] = [];

      await Promise.all(
        items.map(async (source) => {
          const webhookSourceId = normalizeText(source.id);
          if (!webhookSourceId) return;
          try {
            const preview = await ui.settingsPreview({
              category: "webhook_ingest_policy",
              scopeType: "source",
              scopeId: webhookSourceId,
            });
            const policyTemplateId = resolveWorkflowTemplateIdFromPolicy(preview?.value);
            if (!policyTemplateId || policyTemplateId !== templateId) return;
            matches.push({
              webhookSourceId,
              sourceIdentifier: normalizeText(source.source_identifier),
              name: normalizeText(source.name),
              providerType: normalizeText(source.provider_type),
              enabled: normalizeBoolean(source.enabled),
              policyScopeType: normalizeText(preview?.scope_type),
              policyScopeId: normalizeText(preview?.scope_id),
            });
          } catch (_error) {
            // Ignore per-source policy preview errors; they surface in settings tools.
          }
        })
      );

      triggers = matches.sort((a, b) =>
        (a.sourceIdentifier ?? a.webhookSourceId).localeCompare(
          b.sourceIdentifier ?? b.webhookSourceId
        )
      );
    }
  } catch (error) {
    triggers = [];
    webhookTriggersError = formatUiError(error, t("errors.loadTriggers"));
  }

  try {
    const stepsChecksum = normalizeText(detail?.steps_checksum);
    if (stepsChecksum) {
      const overlapLimit = Math.max(25, Math.min(paginationSettings.maxPageSize, 200));
      const list = await listAllResources(
        ui,
        "workflow_templates",
        { steps_checksum: stepsChecksum },
        overlapLimit,
        { key: "updated_at", direction: "desc" }
      );
      const items = Array.isArray(list.items) ? list.items : [];
      overlaps = items
        .map((template): WorkflowTemplateDefinitionOverlap | null => {
          const templateIdValue = normalizeText(template.id);
          if (!templateIdValue || templateIdValue === templateId) return null;
          return {
            templateId: templateIdValue,
            templateName: normalizeText(template.name),
            status: normalizeText(template.status),
            scopeType: normalizeText(template.scope_type),
            scopeId: normalizeText(template.scope_id),
            updatedAt: normalizeText(template.updated_at),
          };
        })
        .filter((value): value is WorkflowTemplateDefinitionOverlap => Boolean(value))
        .sort((a, b) =>
          (a.templateName ?? a.templateId).localeCompare(b.templateName ?? b.templateId)
        );
    } else {
      overlaps = [];
    }
  } catch (error) {
    overlaps = [];
    overlapsError = formatUiError(error, t("errors.loadOverlaps"));
  }

  const stepsResource = findRegistryResource(registry, "workflow_template_steps");
  const stepColumns = resolveColumns(stepsResource, stepsList);
  const runsResource = findRegistryResource(registry, "workflow_runs");
  const runsColumns = resolveColumns(runsResource, runsList);
  const templateTitle = resolveTemplateTitle(detail);
  const templateStatus = resolveTemplateStatus(detail);
  const scheduleTemplateGuide = resolveWorkflowScheduleTemplateGuide(steps);
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const stepsCountLabel =
    typeof stepsTotal === "number"
      ? t("steps.countWithTotal", { count: steps.length, total: stepsTotal })
      : t("steps.count", { count: steps.length });
  const runsCountLabel =
    typeof runsTotal === "number"
      ? t("runs.countWithTotal", { count: runs.length, total: runsTotal })
      : t("runs.count", { count: runs.length });
  const scheduleTriggersTabCount =
    typeof scheduleTriggersTotal === "number" ? scheduleTriggersTotal : scheduleTriggers.length;
  const incomingRunTriggersTabCount =
    typeof incomingRunTriggersTotal === "number"
      ? incomingRunTriggersTotal
      : incomingRunTriggers.length;
  const outgoingRunTriggersTabCount =
    typeof outgoingRunTriggersTotal === "number"
      ? outgoingRunTriggersTotal
      : outgoingRunTriggers.length;
  const workflowRunTriggersTabCount =
    incomingRunTriggersTabCount + outgoingRunTriggersTabCount;
  const webhookTriggersTabCount = triggers.length;
  const triggersTabCount =
    scheduleTriggersTabCount + workflowRunTriggersTabCount + webhookTriggersTabCount;
  const triggersCountLabel = t("triggers.matches", {
    count: String(webhookTriggersTabCount),
  });
  const triggersHref = "#workflow-triggers";
  const overlapsCount = overlaps.length;
  const overlapsHref = "#workflow-overlaps";
  const pageTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-${detailNotFound ? "not-found" : detailError ? "error" : "ready"}`
    : undefined;
  const runsTabCount = typeof runsTotal === "number" ? runsTotal : runs.length;
  const stepsHref = resolveSafeHref(
    appBasePath,
    `/resources/workflow_template_steps?workflow_template_id=${encodeURIComponent(templateId)}`
  );
  const runsHref = resolveSafeHref(
    appBasePath,
    `/resources/workflow_runs?workflow_template_id=${encodeURIComponent(templateId)}`
  );
  const webhookSourcesHref = resolveSafeHref(appBasePath, "/resources/webhook_sources");
  const webhookPolicyHref = resolveSafeHref(
    appBasePath,
    "/settings/request?category=webhook_ingest_policy&scope_type=global"
  );

  return (
    <div className="space-y-6" data-testid={pageTestId}>
      <PageHeader
        title={templateTitle ?? t("title")}
        description={t("description")}
        actions={
          <WorkflowTemplateStudioActions
            templateId={templateId}
            templateStatus={templateStatus}
            capabilities={userCapabilities}
            appBasePath={appBasePath}
            testIdPrefix={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-actions` : null}
          />
        }
      />
      <HashTabs
        defaultValue="studio"
        hashToValue={{ "workflow-overlaps": "overlaps", "workflow-triggers": "triggers" }}
        valueToHash={{ overlaps: "workflow-overlaps", triggers: "workflow-triggers" }}
        className="space-y-0"
      >
        <TabsList className="w-full flex-wrap">
          <TabsTrigger value="studio">
            <span className="flex items-center gap-2">{t("tabs.studio")}</span>
          </TabsTrigger>
          <TabsTrigger value="runs">
            <span className="flex items-center gap-2">
              {t("tabs.runs")}
              <span className="rounded-full border border-ui-border bg-ui-surface px-2 py-0.5 text-[10px] text-ui-muted">
                {runsTabCount}
              </span>
            </span>
          </TabsTrigger>
          <TabsTrigger value="triggers">
            <span className="flex items-center gap-2">
              {t("tabs.triggers")}
              <span className="rounded-full border border-ui-border bg-ui-surface px-2 py-0.5 text-[10px] text-ui-muted">
                {triggersTabCount}
              </span>
            </span>
          </TabsTrigger>
          <TabsTrigger value="overlaps">
            <span className="flex items-center gap-2">
              {t("tabs.overlaps")}
              <span className="rounded-full border border-ui-border bg-ui-surface px-2 py-0.5 text-[10px] text-ui-muted">
                {overlapsCount}
              </span>
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="studio">
          <div className="space-y-6">
      <Section
        title={t("steps.title")}
        collapsible
        collapseKey="workflowStudio.template.steps"
      >
        <div className="space-y-3">
          {stepsError ? (
            <div
              data-testid={
                resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-steps-error` : undefined
              }
              className="space-y-2 text-sm text-ui-muted"
            >
              <p>{t("steps.unavailable")}</p>
              <p className="text-xs text-ui-muted/70">{stepsError}</p>
            </div>
          ) : (
            <div
              data-testid={
                resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-steps-ready` : undefined
              }
              className="space-y-3"
            >
              <div className="text-xs text-ui-muted">{stepsCountLabel}</div>
              <Tabs defaultValue="flow">
                <TabsList>
                  <TabsTrigger
                    value="flow"
                    data-testid={
                      resolvedTestIdPrefix
                        ? `${resolvedTestIdPrefix}-steps-tab-flow`
                        : undefined
                    }
                  >
                    {t("steps.views.flow")}
                  </TabsTrigger>
                  <TabsTrigger
                    value="builder"
                    data-testid={
                      resolvedTestIdPrefix
                        ? `${resolvedTestIdPrefix}-steps-tab-builder`
                        : undefined
                    }
                  >
                    {t("steps.views.builder")}
                  </TabsTrigger>
                  <TabsTrigger
                    value="table"
                    data-testid={
                      resolvedTestIdPrefix
                        ? `${resolvedTestIdPrefix}-steps-tab-table`
                        : undefined
                    }
                  >
                    {t("steps.views.table")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="flow">
                  <WorkflowTemplateStepsBuilder
                    resourceKey="workflow_template_steps"
                    workflowTemplateId={templateId}
                    steps={steps}
                    runs={runs}
                    appBasePath={appBasePath}
                    triggers={
                      triggers.map((trigger) => ({
                        webhook_source_id: trigger.webhookSourceId,
                        source_identifier: trigger.sourceIdentifier,
                        name: trigger.name,
                        provider_type: trigger.providerType,
                        enabled: trigger.enabled,
                      })) ?? null
                    }
                    workflowTemplates={workflowTemplates}
                    incomingRunTriggers={incomingRunTriggers}
                    outgoingRunTriggers={outgoingRunTriggers}
                    workflowTemplatesError={workflowTemplatesError}
                    workflowRunTriggersError={
                      incomingRunTriggersError ?? outgoingRunTriggersError ?? null
                    }
                    scheduleTriggers={scheduleTriggers}
                    scheduleTriggersTotal={scheduleTriggersTotal}
                    scheduleTriggersError={scheduleTriggersError}
                    scheduleTemplateGuide={scheduleTemplateGuide}
                    webhookTriggersDeniedReason={webhookTriggersDeniedReason}
                    webhookTriggersError={webhookTriggersError}
                    triggersHref={triggersHref}
                    overlapCount={overlapsCount}
                    overlapsHref={overlapsHref}
                    idKey="id"
                    layout="flow"
                    reorder={stepsResource?.reorder ?? null}
                    capabilities={userCapabilities}
                    capabilityWrite={stepsResource?.capability_write ?? null}
                    testIdPrefix={
                      resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-steps-flow` : null
                    }
                  />
                </TabsContent>
                <TabsContent value="builder">
                  <WorkflowTemplateStepsBuilder
                    resourceKey="workflow_template_steps"
                    workflowTemplateId={templateId}
                    steps={steps}
                    idKey="id"
                    reorder={stepsResource?.reorder ?? null}
                    capabilities={userCapabilities}
                    capabilityWrite={stepsResource?.capability_write ?? null}
                    testIdPrefix={
                      resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-steps-builder` : null
                    }
                  />
                </TabsContent>
                <TabsContent value="table">
                  <div className="space-y-3">
                    <RelatedResourceTableClient
                      resourceKey="workflow_template_steps"
                      columns={stepColumns}
                      items={steps}
                      idKey="id"
                      baseHref={stepsHref ?? ""}
                      appBasePath={appBasePath}
                      emptyMessage={t("steps.empty")}
                      reorder={null}
                      capabilities={userCapabilities}
                      capabilityWrite={stepsResource?.capability_write ?? null}
                      testIdPrefix={
                        resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-steps` : undefined
                      }
                    />
                    {stepsHref ? (
                      <a
                        className="text-sm text-ui-ink underline underline-offset-4"
                        href={stepsHref}
                      >
                        {t("steps.openFullView")}
                      </a>
                    ) : (
                      <span className="text-sm text-ui-muted">{t("steps.openFullView")}</span>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      </Section>
      <Section
        title={t("template.title")}
        collapsible
        collapseKey="workflowStudio.template.detail"
      >
        {detailError ? (
          <div
            data-testid={
              resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-details-error` : undefined
            }
            className="space-y-2 text-sm text-ui-muted"
          >
            <p>{t("template.unavailable")}</p>
            <p className="text-xs text-ui-muted/70">{detailError}</p>
          </div>
        ) : (
          <div
            data-testid={
              resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-details-ready` : undefined
            }
            className="space-y-4"
          >
            <ResourceDetail
              data={detail}
              emptyMessage={t("template.notFound")}
              testIdPrefix={resolvedTestIdPrefix || undefined}
            />
          </div>
        )}
      </Section>
          </div>
        </TabsContent>
        <TabsContent value="runs">
          <div className="space-y-6">
      <Section
        title={t("runs.title")}
        collapsible
        collapseKey="workflowStudio.template.runs"
      >
        <div className="space-y-3">
          {runsError ? (
            <div
              data-testid={
                resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-runs-error` : undefined
              }
              className="space-y-2 text-sm text-ui-muted"
            >
              <p>{t("runs.unavailable")}</p>
              <p className="text-xs text-ui-muted/70">{runsError}</p>
            </div>
          ) : (
            <div
              data-testid={
                resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-runs-ready` : undefined
              }
              className="space-y-3"
            >
              <div className="text-xs text-ui-muted">{runsCountLabel}</div>
                <RelatedResourceTableClient
                  resourceKey="workflow_runs"
                  columns={runsColumns}
                  items={runs}
                  idKey="id"
                  baseHref={runsHref ?? ""}
                  appBasePath={appBasePath}
                  emptyMessage={t("runs.empty")}
                  capabilities={userCapabilities}
                  capabilityWrite={runsResource?.capability_write ?? null}
                  testIdPrefix={
                    resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-runs` : undefined
                  }
                />
                {runsHref ? (
                  <a
                    className="text-sm text-ui-ink underline underline-offset-4"
                    href={runsHref}
                  >
                    {t("runs.openFullView")}
                  </a>
                ) : (
                  <span className="text-sm text-ui-muted">{t("runs.openFullView")}</span>
                )}
            </div>
          )}
        </div>
      </Section>
          </div>
        </TabsContent>
        <TabsContent value="triggers">
          <div className="space-y-6">
            <div id="workflow-triggers">
              <Section
                title={t("triggers.title")}
                collapsible
                collapseKey="workflowStudio.template.triggers"
              >
                <div
                  data-testid={
                    resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-triggers-ready` : undefined
                  }
                  className="space-y-6"
                >
                  {scheduleTriggersError ? (
                    <div className="space-y-2 rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-sm text-ui-muted">
                      <p>{t("triggers.schedules.unavailable")}</p>
                      <p className="text-xs text-ui-muted/70">{scheduleTriggersError}</p>
                    </div>
                  ) : (
                    <WorkflowScheduleTriggersPanel
                      workflowTemplateId={templateId}
                      triggers={scheduleTriggers}
                      triggersTotal={scheduleTriggersTotal}
                      appBasePath={appBasePath}
                      scheduleTemplateGuide={scheduleTemplateGuide}
                      capabilities={userCapabilities}
                      testIdPrefix={
                        resolvedTestIdPrefix
                          ? `${resolvedTestIdPrefix}-triggers-schedules`
                          : null
                      }
                    />
                  )}

                  <div className="border-t border-ui-border/60 pt-6">
                    {workflowTemplatesError ? (
                      <div className="space-y-2 rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-sm text-ui-muted">
                        <p>{t("triggers.unavailable")}</p>
                        <p className="text-xs text-ui-muted/70">{workflowTemplatesError}</p>
                      </div>
                    ) : null}

                    {incomingRunTriggersError || outgoingRunTriggersError ? (
                      <div className="space-y-2 rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-sm text-ui-muted">
                        <p>{t("triggers.unavailable")}</p>
                        <p className="text-xs text-ui-muted/70">
                          {incomingRunTriggersError ?? outgoingRunTriggersError}
                        </p>
                      </div>
                    ) : null}

                    <WorkflowRunTriggersPanel
                      workflowTemplateId={templateId}
                      incomingTriggers={incomingRunTriggers}
                      outgoingTriggers={outgoingRunTriggers}
                      workflowTemplates={workflowTemplates}
                      appBasePath={appBasePath}
                      capabilities={userCapabilities}
                      testIdPrefix={
                        resolvedTestIdPrefix
                          ? `${resolvedTestIdPrefix}-triggers-workflow-runs`
                          : null
                      }
                    />
                  </div>

                  <div className="border-t border-ui-border/60 pt-6">
                    <div className="space-y-1 text-sm text-ui-muted">
                      <p className="font-medium text-ui-ink">
                        {t("triggers.webhooks.title")}
                      </p>
                      <p className="text-xs text-ui-muted/70">
                        {t("triggers.policyHint")}
                      </p>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {webhookSourcesHref ? (
                        <a
                          className="text-sm text-ui-ink underline underline-offset-4"
                          href={webhookSourcesHref}
                        >
                          {t("triggers.openSources")}
                        </a>
                      ) : (
                        <span className="text-sm text-ui-muted">{t("triggers.openSources")}</span>
                      )}
                      {webhookPolicyHref ? (
                        <a
                          className="text-sm text-ui-ink underline underline-offset-4"
                          href={webhookPolicyHref}
                        >
                          {t("triggers.openPolicy")}
                        </a>
                      ) : (
                        <span className="text-sm text-ui-muted">{t("triggers.openPolicy")}</span>
                      )}
                      <a
                        className="text-sm text-ui-ink underline underline-offset-4"
                        href={overlapsHref}
                      >
                        {t("triggers.openOverlaps")}
                      </a>
                    </div>

                    {webhookTriggersDeniedReason ? (
                      <div className="mt-4 rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-xs text-ui-muted">
                        {t("triggers.webhooks.denied", {
                          capability: webhookTriggersDeniedReason,
                        })}
                      </div>
                    ) : webhookTriggersError ? (
                      <div className="mt-4 space-y-2 rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-sm text-ui-muted">
                        <p>{t("triggers.unavailable")}</p>
                        <p className="text-xs text-ui-muted/70">{webhookTriggersError}</p>
                      </div>
                    ) : (
                      <div className="mt-4 space-y-3">
                        <div className="text-xs text-ui-muted">{triggersCountLabel}</div>
                            {triggers.length === 0 ? (
                          <p className="text-sm text-ui-muted">{t("triggers.empty")}</p>
                        ) : (
                          <div className="space-y-2">
                            {triggers.map((trigger) => {
                              const title = trigger.sourceIdentifier ?? trigger.webhookSourceId;
                              const subtitle = [trigger.providerType, trigger.name]
                                .filter(Boolean)
                                .join(" \u00b7 ");
                              const provenance = trigger.policyScopeType
                                ? t("triggers.resolvedAt", { value: trigger.policyScopeType })
                                : null;
                              const webhookSourceHref = resolveSafeHref(
                                appBasePath,
                                `/resources/webhook_sources?id=${encodeURIComponent(
                                  trigger.webhookSourceId
                                )}`
                              );
                              const webhookPolicyRowHref = resolveSafeHref(
                                appBasePath,
                                `/settings/request?category=webhook_ingest_policy&scope_type=source&scope_id=${encodeURIComponent(
                                  trigger.webhookSourceId
                                )}`
                              );
                              return (
                                <div
                                  key={trigger.webhookSourceId}
                                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ui-border bg-ui-surface/70 px-3 py-2 text-sm"
                                >
                                  <div className="min-w-0 space-y-1">
                                    <div className="truncate font-medium text-ui-ink">
                                      {title}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 text-xs text-ui-muted">
                                      {subtitle ? <span>{subtitle}</span> : null}
                                      {provenance ? <span>{provenance}</span> : null}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-3">
                                    {webhookSourceHref ? (
                                      <a
                                        className="text-sm text-ui-ink underline underline-offset-4"
                                        href={webhookSourceHref}
                                      >
                                        {t("triggers.openSource")}
                                      </a>
                                    ) : (
                                      <span className="text-sm text-ui-muted">
                                        {t("triggers.openSource")}
                                      </span>
                                    )}
                                    {webhookPolicyRowHref ? (
                                      <a
                                        className="text-sm text-ui-ink underline underline-offset-4"
                                        href={webhookPolicyRowHref}
                                      >
                                        {t("triggers.editPolicy")}
                                      </a>
                                    ) : (
                                      <span className="text-sm text-ui-muted">
                                        {t("triggers.editPolicy")}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </Section>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="overlaps">
          <div className="space-y-6">
      <div id="workflow-overlaps">
        <Section
          title={t("overlaps.title")}
          collapsible
          collapseKey="workflowStudio.template.overlaps"
        >
        {overlapsError ? (
          <div className="space-y-2 text-sm text-ui-muted">
            <p>{t("overlaps.unavailable")}</p>
            <p className="text-xs text-ui-muted/70">{overlapsError}</p>
          </div>
        ) : overlaps.length === 0 ? (
          <p className="text-sm text-ui-muted">{t("overlaps.empty")}</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1 text-xs text-ui-muted">
              <div>
                {t("overlaps.badge", { count: String(overlapsCount) })}
              </div>
              {detail?.steps_checksum ? (
                <div>{t("overlaps.source", { value: String(detail.steps_checksum) })}</div>
              ) : null}
            </div>
            <div className="space-y-2">
                {overlaps.map((entry) => {
                const workflowHref = resolveSafeHref(
                  appBasePath,
                  `/workflows/templates/${encodeURIComponent(entry.templateId)}`
                );
                const status = entry.status ?? "-";
                const scope = [entry.scopeType, entry.scopeId].filter(Boolean).join(" ");
                return (
                  <div
                    key={entry.templateId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ui-border bg-ui-surface/70 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="truncate font-medium text-ui-ink">
                        {entry.templateName ?? entry.templateId}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-ui-muted">
                        <span>{t("overlaps.priorityLabel", { value: status })}</span>
                        {scope ? <span>{scope}</span> : null}
                      </div>
                    </div>
                    {workflowHref ? (
                      <a
                        className="shrink-0 text-sm text-ui-ink underline underline-offset-4"
                        href={workflowHref}
                      >
                        {t("overlaps.openWorkflow")}
                      </a>
                    ) : (
                      <span className="shrink-0 text-sm text-ui-muted">
                        {t("overlaps.openWorkflow")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        </Section>
      </div>
          </div>
        </TabsContent>
      </HashTabs>
    </div>
  );
}
