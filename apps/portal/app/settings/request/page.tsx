import { SettingsRequestPage } from "../../_components/settings-request-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appName, appBasePath }, { searchParams }) => (
    <SettingsRequestPage
      appLabel={appName}
      testIdPrefix="portal-settings-request"
      searchParams={searchParams}
      requestHref={`${appBasePath}/settings/request`}
      returnHref={`${appBasePath}/resources/settings_category_registry`}
    />
));
