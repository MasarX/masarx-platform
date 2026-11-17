import { CustomerShipmentChangesPage } from "../../_components/customer-shipment-changes-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appBasePath, appKey }, { searchParams }) => (
  <CustomerShipmentChangesPage
    appKey={appKey}
    appBasePath={appBasePath}
    searchParams={searchParams}
    baseHref={`${appBasePath}/operations/customer-shipment-changes`}
    testIdPrefix="console-customer-shipment-changes"
  />
));
