import { CommandCatalogPage } from "../_components/command-catalog-page";
import { withPortalConfig } from "../app-context";

type PageProps = {
  searchParams?: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appName, appKey, appBasePath }, { searchParams }) => (
    <CommandCatalogPage
      appKey={appKey}
      appLabel={appName}
      testIdPrefix="portal-commands"
      appBasePath={appBasePath}
      searchParams={searchParams}
    />
));
