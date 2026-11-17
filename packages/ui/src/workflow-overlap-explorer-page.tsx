import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { createUiTranslator } from "./i18n";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { Button } from "./button";
import { Badge } from "./badge";
import { Input } from "./input";
import { formatUiError } from "./utils";
import { resolvePaginationSettings } from "./pagination-utils";
import { listAllResources } from "./resource-list-utils";
import { resolveSafeHref } from "./url-guard";

type WorkflowOverlapExplorerPageProps = {
  appBasePath: string;
  searchParams?: Record<string, string | string[] | undefined>;
  testIdPrefix?: string | null;
};

type WorkflowTemplateSummary = {
  templateId: string;
  templateName: string | null;
  stepsChecksum: string;
  status: string | null;
  scopeType: string | null;
  scopeId: string | null;
  updatedAt: string | null;
};

type WorkflowOverlapGroup = {
  stepsChecksum: string;
  templates: WorkflowTemplateSummary[];
};

function normalizeText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function resolveSearchParam(
  value: string | string[] | undefined
): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return resolveSearchParam(value[0]);
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeIsoDate(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function WorkflowOverlapExplorerPage({
  appBasePath,
  searchParams,
  testIdPrefix,
}: WorkflowOverlapExplorerPageProps) {
  const t = createUiTranslator("ui.workflowStudio");
  const ui = createUiServerClient();
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";

  let paginationSettings = resolvePaginationSettings(null);
  try {
    const preview = await ui.settingsPreview({ category: "ui_pagination" });
    paginationSettings = resolvePaginationSettings(preview?.value);
  } catch (_error) {
    paginationSettings = resolvePaginationSettings(null);
  }

  const checksumFilter = resolveSearchParam(searchParams?.steps_checksum);
  const nameFilter = resolveSearchParam(searchParams?.name);

  let groups: WorkflowOverlapGroup[] = [];
  let groupsError: string | null = null;

  try {
    const limit = Math.max(25, Math.min(paginationSettings.maxPageSize, 200));
    const list = await listAllResources(
      ui,
      "workflow_templates",
      nameFilter ? { name: nameFilter } : {},
      limit,
      { key: "created_at", direction: "desc" }
    );
    const templates = Array.isArray(list.items) ? list.items : [];

    const byChecksum = new Map<string, WorkflowTemplateSummary[]>();
    templates.forEach((template) => {
      const checksum = normalizeText(template.steps_checksum);
      if (!checksum) return;
      if (checksumFilter && !checksum.startsWith(checksumFilter)) return;
      const id = normalizeText(template.id);
      if (!id) return;
      const next = byChecksum.get(checksum) ?? [];
      next.push({
        templateId: id,
        templateName: normalizeText(template.name),
        stepsChecksum: checksum,
        status: normalizeText(template.status),
        scopeType: normalizeText(template.scope_type),
        scopeId: normalizeText(template.scope_id),
        updatedAt: normalizeIsoDate(template.updated_at),
      });
      byChecksum.set(checksum, next);
    });

    groups = Array.from(byChecksum.entries())
      .filter(([, templates]) => templates.length > 1)
      .map(([stepsChecksum, templates]) => ({
        stepsChecksum,
        templates: templates.sort((a, b) =>
          (a.templateName ?? a.templateId).localeCompare(b.templateName ?? b.templateId)
        ),
      }))
      .sort((a, b) => b.templates.length - a.templates.length);
  } catch (error) {
    groupsError = formatUiError(error, t("overlapExplorer.errors.load"));
    groups = [];
  }

  const pageTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-${groupsError ? "error" : "ready"}`
    : undefined;

  const openTemplatesHref = resolveSafeHref(appBasePath, "/workflows/templates");
  const clearHref = resolveSafeHref(appBasePath, "/workflows/overlaps");

  return (
    <div className="space-y-6" data-testid={pageTestId}>
      <PageHeader
        title={t("overlapExplorer.title")}
        description={t("overlapExplorer.description")}
        actions={
          <div className="flex items-center gap-2">
            {openTemplatesHref ? (
              <Button asChild size="sm" variant="ghost">
                <a href={openTemplatesHref}>{t("overlapExplorer.actions.openTemplates")}</a>
              </Button>
            ) : (
              <span className="text-xs text-ui-muted">{t("overlapExplorer.actions.openTemplates")}</span>
            )}
          </div>
        }
      />
      <Section title={t("overlapExplorer.filters.title")} collapsible>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-ui-muted">
              {t("overlapExplorer.filters.sourceLabel")}
            </label>
            <Input
              name="steps_checksum"
              defaultValue={checksumFilter ?? ""}
              placeholder={t("overlapExplorer.filters.sourcePlaceholder")}
              className="min-w-[220px]"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-ui-muted">
              {t("overlapExplorer.filters.eventLabel")}
            </label>
            <Input
              name="name"
              defaultValue={nameFilter ?? ""}
              placeholder={t("overlapExplorer.filters.eventPlaceholder")}
              className="min-w-[220px]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm">
              {t("overlapExplorer.filters.apply")}
            </Button>
            {checksumFilter || nameFilter ? (
              <Button asChild type="button" size="sm" variant="ghost">
                {clearHref ? (
                  <a href={clearHref}>{t("overlapExplorer.filters.clear")}</a>
                ) : (
                  <span>{t("overlapExplorer.filters.clear")}</span>
                )}
              </Button>
            ) : null}
          </div>
        </form>
      </Section>
      <Section title={t("overlapExplorer.results.title")} collapsible>
        {groupsError ? (
          <div className="space-y-2 text-sm text-ui-muted">
            <p>{t("overlapExplorer.errors.unavailable")}</p>
            <p className="text-xs text-ui-muted/70">{groupsError}</p>
          </div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-ui-muted">{t("overlapExplorer.results.empty")}</p>
        ) : (
          <div className="space-y-4">
            <div className="text-xs text-ui-muted">
              {t("overlapExplorer.results.count", { count: String(groups.length) })}
            </div>
            {groups.map((group) => {
              const uniqueTemplates = new Set(group.templates.map((entry) => entry.templateId)).size;
              return (
                <div
                  key={group.stepsChecksum}
                  className="space-y-2 rounded-2xl border border-ui-border bg-ui-surface/70 p-4 shadow-soft"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-semibold text-ui-ink">
                          {group.stepsChecksum.slice(0, 12)}
                        </div>
                        <Badge tone="warning" className="px-2 py-0.5 text-[10px]">
                          {t("overlapExplorer.results.templates", {
                            count: String(uniqueTemplates),
                          })}
                        </Badge>
                      </div>
                      <div className="text-xs text-ui-muted">
                        {t("overlapExplorer.results.source", { value: group.stepsChecksum })}
                      </div>
                    </div>
                  </div>
                  <div className="divide-y divide-ui-border overflow-hidden rounded-xl border border-ui-border bg-ui-paper/60">
                    {group.templates.map((template) => {
                      const workflowHref = resolveSafeHref(
                        appBasePath,
                        `/workflows/templates/${encodeURIComponent(template.templateId)}`
                      );
                      const status = template.status ?? "-";
                      const scope = [template.scopeType, template.scopeId].filter(Boolean).join(" ");
                      const workflowButton = workflowHref ? (
                        <Button asChild size="sm" variant="ghost">
                          <a href={workflowHref}>{t("overlapExplorer.results.openWorkflow")}</a>
                        </Button>
                      ) : (
                        <span className="text-xs text-ui-muted">
                          {t("overlapExplorer.results.openWorkflow")}
                        </span>
                      );
                      return (
                        <div
                          key={`${group.stepsChecksum}-${template.templateId}`}
                          className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="truncate font-medium text-ui-ink">
                              {template.templateName ?? template.templateId}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-ui-muted">
                              <span>
                                {t("overlapExplorer.results.priorityLabel", { value: status })}
                              </span>
                              {scope ? <span>{scope}</span> : null}
                            </div>
                          </div>
                          {workflowButton}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
