import { ShipmentResourcePage } from "@masarx/ui";
import { withConsoleConfig } from "../../app-context";

type PageProps = { searchParams: Record<string, string | string[] | undefined> };

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
  <ShipmentResourcePage appKey={appKey} appBasePath={appBasePath} searchParams={searchParams}
    operatorHandoffDestination testIdPrefix="console-operator-handoff" />
));
