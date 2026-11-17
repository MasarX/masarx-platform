import { OnboardingReadinessPage } from "../../_components/onboarding-readiness-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
  <OnboardingReadinessPage
    appKey={appKey}
    appBasePath={appBasePath}
    searchParams={searchParams}
    baseHref={`${appBasePath}/organizations/readiness`}
    testIdPrefix="console-onboarding-readiness"
  />
));
