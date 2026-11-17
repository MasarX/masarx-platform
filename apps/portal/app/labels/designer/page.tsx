import { LabelDesignerPage } from "../../_components/label-designer-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <LabelDesignerPage
    appBasePath={appBasePath}
    searchParams={searchParams}
    testIdPrefix="portal-label-designer"
  />
));
