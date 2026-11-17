import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
    <ResourcePage
      appKey={appKey}
      resourceKey="token_rotation_requests"
      searchParams={searchParams}
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/security/token-rotation`}
      testIdPrefix="console-token-rotation"
    />
));
