import { PickupFailuresPage } from "@masarx/ui";
import { withConsoleConfig } from "../../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(
  ({ appBasePath }, { searchParams }) => (
    <PickupFailuresPage
      appBasePath={appBasePath}
      searchParams={searchParams}
      testIdPrefix="console-pickup-failures"
    />
  ),
);
