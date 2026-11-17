import { ShipmentManualCreatePage } from "@masarx/ui";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

const firstValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ShipmentManualCreatePage
    appBasePath={appBasePath}
    returnTo={firstValue(searchParams.return_to) ?? `${appBasePath}/resources/shipments`}
    testIdPrefix="console-shipment-manual-create"
  />
));
