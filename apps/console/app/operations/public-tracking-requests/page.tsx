import { CustomerShipmentChangesPage } from "../../_components/customer-shipment-changes-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
  <CustomerShipmentChangesPage
    appKey={appKey}
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/operations/public-tracking-requests`}
    defaultOutcome="pending_review"
    description="Review customer shipment changes that still need an operator decision."
    testIdPrefix="console-public-tracking-requests"
  />
));
