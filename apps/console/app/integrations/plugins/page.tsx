import { withConsoleConfig } from "../../app-context";
import { ConsoleIntegrationPluginsPage } from "./plugins-page";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ConsoleIntegrationPluginsPage
    appKey="console"
    appBasePath={appBasePath}
    searchParams={searchParams}
  />
));
