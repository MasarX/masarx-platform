import { withPortalConfig } from "../../app-context";
import { PortalExceptionInboxPage } from "./exception-inbox-page";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(
  ({ appBasePath, appKey }, { searchParams }) => (
    <PortalExceptionInboxPage
      appBasePath={appBasePath}
      appKey={appKey}
      searchParams={searchParams}
    />
  )
);
