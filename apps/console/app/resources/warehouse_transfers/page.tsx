import { WarehouseTransferResourcePage } from "@masarx/ui";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
  <WarehouseTransferResourcePage
    appKey={appKey}
    appBasePath={appBasePath}
    searchParams={searchParams}
    testIdPrefix="console-resource"
  />
));
