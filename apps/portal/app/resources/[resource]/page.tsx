import { ResourcePage } from "../../_components/resource-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  params: { resource: string };
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appKey, appBasePath }, { params, searchParams }) => (
    <ResourcePage
      appKey={appKey}
      resourceKey={params.resource}
      searchParams={searchParams}
      appBasePath={appBasePath}
      testIdPrefix="portal-resource"
    />
));
