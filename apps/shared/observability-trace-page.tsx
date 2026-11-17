import {
  labelFromKey,
  PageHeader,
  ResourceTable,
  Section,
  resolvePaginationSettings,
} from "@masarx/ui";
import type { UiTrace } from "@masarx/api";
import type { AppContextWithConfig } from "./app-layout";

type PaginationSettings = ReturnType<typeof resolvePaginationSettings>;

type ObservabilityTranslate = AppContextWithConfig["t"];

type ObservabilityTracePageProps = {
  correlationId: string;
  trace: UiTrace | null;
  errorMessage: string | null;
  paginationSettings: PaginationSettings;
  testIdPrefix: string;
  t: ObservabilityTranslate;
};

function normalizeItems(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function resolveColumns(items: Record<string, unknown>[]) {
  const first = items[0];
  if (!first) return [];
  return Object.keys(first).map((key) => ({
    key,
    label: labelFromKey(key),
  }));
}

export function ObservabilityTracePage({
  correlationId,
  trace,
  errorMessage,
  paginationSettings,
  testIdPrefix,
  t,
}: ObservabilityTracePageProps) {
  const observabilityEvents = normalizeItems(trace?.observability_events);
  const domainEvents = normalizeItems(trace?.domain_events);
  const workflowRuns = normalizeItems(trace?.workflow_runs);

  const clientPagination = {
    pageSizes: paginationSettings.allowedSizes,
    defaultPageSize: paginationSettings.defaultPageSize,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("observability.trace.title")}
        description={t("observability.trace.description")}
      />
      <Section
        title={t("observability.trace.sections.summary")}
        collapsible
        collapseKey="observability.trace.summary"
      >
        {errorMessage ? (
          <div
            data-testid={`${testIdPrefix}-trace-error`}
            className="space-y-2 text-sm text-ui-muted"
          >
            <p>{t("observability.trace.unavailable")}</p>
            <p className="text-xs text-ui-muted/70">{errorMessage}</p>
          </div>
        ) : (
          <div data-testid={`${testIdPrefix}-trace-ready`} className="text-xs text-ui-muted">
            {t("observability.trace.correlationLabel", { id: correlationId })}
          </div>
        )}
      </Section>
      {!errorMessage ? (
        <>
          <Section
            title={t("observability.trace.sections.observability")}
            collapsible
            collapseKey="observability.trace.observability"
          >
            <ResourceTable
              columns={resolveColumns(observabilityEvents)}
              items={observabilityEvents}
              idKey="id"
              clientPagination={clientPagination}
              emptyMessage={t("observability.trace.empty.observability")}
            />
          </Section>
          <Section
            title={t("observability.trace.sections.domain")}
            collapsible
            collapseKey="observability.trace.domain"
          >
            <ResourceTable
              columns={resolveColumns(domainEvents)}
              items={domainEvents}
              idKey="id"
              clientPagination={clientPagination}
              emptyMessage={t("observability.trace.empty.domain")}
            />
          </Section>
          <Section
            title={t("observability.trace.sections.workflowRuns")}
            collapsible
            collapseKey="observability.trace.workflowRuns"
          >
            <ResourceTable
              columns={resolveColumns(workflowRuns)}
              items={workflowRuns}
              idKey="id"
              clientPagination={clientPagination}
              emptyMessage={t("observability.trace.empty.workflowRuns")}
            />
          </Section>
        </>
      ) : null}
    </div>
  );
}
