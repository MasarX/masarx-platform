import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
    <ResourcePage
      appKey={appKey}
      resourceKey="requests"
      searchParams={searchParams}
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/workflows/requests`}
      testIdPrefix="console-requests"
    />
));
