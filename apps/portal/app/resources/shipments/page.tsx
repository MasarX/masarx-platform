import { ShipmentResourcePage } from "@masarx/ui";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
  <ShipmentResourcePage
    appKey={appKey}
    appBasePath={appBasePath}
    searchParams={searchParams}
    testIdPrefix="portal-resource"
  />
));
