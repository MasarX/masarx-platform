import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";
import { Button } from "@masarx/ui";
import { createUiTranslator } from "@masarx/ui";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
  (() => {
    const uiT = createUiTranslator("ui.workflowStudio");
    return (
      <ResourcePage
        appKey={appKey}
        resourceKey="workflow_templates"
        searchParams={searchParams}
        appBasePath={appBasePath}
        baseHref={`${appBasePath}/workflows/templates`}
        testIdPrefix="console-workflow-templates"
        headerActions={
          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              <a href={`${appBasePath}/onboarding/readiness`}>
                Onboarding readiness
              </a>
            </Button>
            <Button asChild size="sm" variant="ghost">
              <a href={`${appBasePath}/workflows/bindings`}>
                Workflow bindings
              </a>
            </Button>
            <Button asChild size="sm" variant="ghost">
              <a href={`${appBasePath}/workflows/overlaps`}>
                {uiT("actions.overlapExplorer")}
              </a>
            </Button>
            <Button asChild size="sm">
              <a href={`${appBasePath}/workflows/templates/new`}>
                {uiT("actions.newTemplate")}
              </a>
            </Button>
          </div>
        }
        renderDetailFooter={({ detailId, detailError }) => {
          if (!detailId || detailError) return null;
          return (
            <div className="pt-3">
              <a
                className="text-sm text-ui-ink underline underline-offset-4"
                href={`${appBasePath}/workflows/templates/${encodeURIComponent(detailId)}`}
                data-testid="console-workflow-templates-open-studio"
              >
                {uiT("actions.openStudio")}
              </a>
            </div>
          );
        }}
      />
    );
  })()
));
