import { SettingsRequestPage } from "../../_components/settings-request-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appName, appBasePath }, { searchParams }) => (
    <SettingsRequestPage
      appLabel={appName}
      testIdPrefix="console-settings-request"
      searchParams={searchParams}
      requestHref={`${appBasePath}/settings/request`}
      returnHref={`${appBasePath}/resources/settings_category_registry`}
    />
));
