import { ShipmentAmendCancelPage } from "../../_components/shipment-amend-cancel-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appBasePath, appKey }, { searchParams }) => (
  <ShipmentAmendCancelPage
    appKey={appKey}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/operations/shipment-amend-cancel`}
    searchParams={searchParams}
    testIdPrefix="portal-shipment-amend-cancel"
  />
));
