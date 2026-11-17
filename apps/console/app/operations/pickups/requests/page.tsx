import { PickupRequestsPage } from "@masarx/ui";
import { withConsoleConfig } from "../../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(
  ({ appBasePath, appKey }, { searchParams }) => (
    <PickupRequestsPage
      appKey={appKey}
      appBasePath={appBasePath}
      searchParams={searchParams}
      testIdPrefix="console-pickup-requests"
    />
  ),
);
