import { CustomerShipmentChangesPage } from "../../_components/customer-shipment-changes-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appBasePath, appKey }, { searchParams }) => (
  <CustomerShipmentChangesPage
    appKey={appKey}
    appBasePath={appBasePath}
    searchParams={searchParams}
    baseHref={`${appBasePath}/operations/customer-shipment-changes`}
    testIdPrefix="portal-customer-shipment-changes"
  />
));
