import { DashboardPage } from "./_components/dashboard-page";
import { withConsoleConfig } from "./app-context";

export default withConsoleConfig(({ appName, appBasePath, appKey, locale, messages }) => (
    <DashboardPage
      appLabel={appName}
      appKey={appKey}
      appBasePath={appBasePath}
      testIdPrefix="console-dashboard"
      locale={locale}
      messages={messages}
    />
));
