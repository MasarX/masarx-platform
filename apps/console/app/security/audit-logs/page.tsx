import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
    <ResourcePage
      appKey={appKey}
      resourceKey="audit_table_changes"
      searchParams={searchParams}
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/security/audit-logs`}
      testIdPrefix="console-audit-logs"
    />
));
