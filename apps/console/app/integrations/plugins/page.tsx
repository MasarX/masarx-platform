import { Button } from "@masarx/ui";
import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export function ConsoleIntegrationPluginsPage({
  appKey,
  appBasePath,
  searchParams,
}: {
  appKey: "console";
  appBasePath: string;
  searchParams: PageProps["searchParams"];
}) {
  return (
    <ResourcePage
      appKey={appKey}
      resourceKey="integration_plugins"
      searchParams={searchParams}
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/integrations/plugins`}
      testIdPrefix="console-integration-plugins"
      headerActions={
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="ghost">
            <a href={`${appBasePath}/organizations/readiness`}>Onboarding readiness</a>
          </Button>
          <Button asChild size="sm">
            <a href={`${appBasePath}/integrations/plugins/new`}>New Plugin</a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href={`${appBasePath}/resources/provider_health_latest`}>Provider Health</a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href={`${appBasePath}/resources/circuit_breaker_dashboard`}>Circuit Breakers</a>
          </Button>
        </div>
      }
      renderDetailFooter={({ detailId, detailError }) => {
        if (!detailId || detailError) return null;
        return (
          <div className="pt-3">
            <a
              className="text-sm text-ui-ink underline underline-offset-4"
              href={`${appBasePath}/integrations/plugins/${encodeURIComponent(detailId)}`}
              data-testid="console-integration-plugins-open-detail"
            >
              Open Plugin Workspace
            </a>
          </div>
        );
      }}
    />
  );
}

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ConsoleIntegrationPluginsPage
    appKey="console"
    appBasePath={appBasePath}
    searchParams={searchParams}
  />
));
