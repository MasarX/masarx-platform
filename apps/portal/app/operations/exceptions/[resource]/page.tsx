import { withPortalConfig } from "../../../app-context";
import { PortalExceptionResourcePage } from "./exception-resource-page";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
  params: { resource: string };
};

export default withPortalConfig<PageProps>(
  ({ appBasePath, appKey }, { searchParams, params }) => (
    <PortalExceptionResourcePage
      appBasePath={appBasePath}
      appKey={appKey}
      searchParams={searchParams}
      resource={params.resource}
    />
  )
);
