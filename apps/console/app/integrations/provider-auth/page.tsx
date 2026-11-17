import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
    <ResourcePage
      appKey={appKey}
      resourceKey="provider_auth_configs"
      searchParams={searchParams}
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/integrations/provider-auth`}
      testIdPrefix="console-provider-auth"
    />
));
