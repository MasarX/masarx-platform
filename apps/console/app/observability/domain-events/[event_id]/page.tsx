import { Section } from "@masarx/ui";
import { ResourcePage } from "../../../_components/resource-page";
import { withConsoleConfig } from "../../../app-context";

type PageProps = {
  params: { event_id: string };
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath, t }, { params, searchParams }) => {
  const detailParams = { ...searchParams, id: params.event_id };
  return (
    <ResourcePage
      appKey={appKey}
      resourceKey="domain_events"
      searchParams={detailParams}
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/observability/domain-events`}
      description={t("observability.domainEvent.description")}
      testIdPrefix="console-domain-event"
      renderDetailFooter={({ detail }) => {
        const correlationId =
          detail && typeof detail.correlation_id === "string"
            ? detail.correlation_id
            : null;
        const workflowRunId =
          detail && typeof detail.workflow_run_id === "string"
            ? detail.workflow_run_id
            : null;
        if (!correlationId && !workflowRunId) return null;
        return (
          <Section
            title={t("observability.domainEvent.relatedTitle")}
            collapsible
            collapseKey="observability.domainEvent.related"
          >
            <div className="flex flex-wrap gap-4">
              {correlationId ? (
                <a
                  className="text-sm text-ui-ink underline underline-offset-4"
                  href={`${appBasePath}/observability/trace/${encodeURIComponent(
                    correlationId
                  )}`}
                >
                  {t("observability.domainEvent.viewTrace")}
                </a>
              ) : null}
              {workflowRunId ? (
                <a
                  className="text-sm text-ui-ink underline underline-offset-4"
                  href={`${appBasePath}/observability/workflow-runs/${encodeURIComponent(
                    workflowRunId
                  )}`}
                >
                  {t("observability.domainEvent.viewWorkflowRun")}
                </a>
              ) : null}
            </div>
          </Section>
        );
      }}
    />
  );
});
