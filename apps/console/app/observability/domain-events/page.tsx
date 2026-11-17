import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
    <ResourcePage
      appKey={appKey}
      resourceKey="domain_events"
      searchParams={searchParams}
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/observability/domain-events`}
      testIdPrefix="console-domain-events"
    />
));
