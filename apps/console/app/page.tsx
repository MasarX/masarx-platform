import { DashboardPage } from "./_components/dashboard-page";
import { OnboardingBanner } from "./_components/onboarding-banner";
import { withConsoleConfig } from "./app-context";

export default withConsoleConfig(({ appName, appBasePath, appKey, locale, messages }) => (
  <>
    <OnboardingBanner appBasePath={appBasePath} />
    <DashboardPage
      appLabel={appName}
      appKey={appKey}
      appBasePath={appBasePath}
      testIdPrefix="console-dashboard"
      locale={locale}
      messages={messages}
    />
  </>
));
