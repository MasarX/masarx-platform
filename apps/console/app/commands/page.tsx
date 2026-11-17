import { CommandCatalogPage } from "../_components/command-catalog-page";
import { withConsoleConfig } from "../app-context";

type PageProps = {
  searchParams?: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appName, appKey, appBasePath }, { searchParams }) => (
    <CommandCatalogPage
      appKey={appKey}
      appLabel={appName}
      testIdPrefix="console-commands"
      appBasePath={appBasePath}
      searchParams={searchParams}
    />
));
