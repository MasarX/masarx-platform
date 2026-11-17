import { PickupWavesPage } from "@masarx/ui";
import { withPortalConfig } from "../../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(
  ({ appBasePath, appKey }, { searchParams }) => (
    <PickupWavesPage
      appKey={appKey}
      appBasePath={appBasePath}
      searchParams={searchParams}
      testIdPrefix="portal-pickup-waves"
    />
  ),
);
