import { OnboardingReadinessPage } from "../../_components/onboarding-readiness-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
  <OnboardingReadinessPage
    appKey={appKey}
    appBasePath={appBasePath}
    searchParams={searchParams}
    baseHref={`${appBasePath}/onboarding/readiness`}
    testIdPrefix="portal-onboarding-readiness"
    visibility="client_safe"
  />
));
