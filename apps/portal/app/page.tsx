import { DashboardPage } from "./_components/dashboard-page";
import { withPortalConfig } from "./app-context";

export default withPortalConfig(({ appName, appBasePath, appKey, locale, messages }) => (
    <DashboardPage
      appLabel={appName}
      appKey={appKey}
      appBasePath={appBasePath}
      testIdPrefix="portal-dashboard"
      locale={locale}
      messages={messages}
    />
));
