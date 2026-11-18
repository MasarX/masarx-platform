import { TrackingPage } from "../_components/tracking-page";
import { withPortalConfig } from "../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appKey, appBasePath, locale }, { searchParams }) => (
    <TrackingPage
      searchParams={searchParams}
      appKey={appKey}
      appBasePath={appBasePath}
      testIdPrefix="portal-tracking"
      locale={locale}
    />
), { authMode: "optional" });
