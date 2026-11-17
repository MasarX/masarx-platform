import { PickupFailuresPage } from "@masarx/ui";
import { withPortalConfig } from "../../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(
  ({ appBasePath }, { searchParams }) => (
    <PickupFailuresPage
      appBasePath={appBasePath}
      searchParams={searchParams}
      testIdPrefix="portal-pickup-failures"
    />
  ),
);
