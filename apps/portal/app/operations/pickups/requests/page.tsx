import { PickupRequestsPage } from "@masarx/ui";
import { withPortalConfig } from "../../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(
  ({ appBasePath, appKey }, { searchParams }) => (
    <PickupRequestsPage
      appKey={appKey}
      appBasePath={appBasePath}
      searchParams={searchParams}
      testIdPrefix="portal-pickup-requests"
    />
  ),
);
