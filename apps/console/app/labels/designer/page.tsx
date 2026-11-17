import { LabelDesignerPage } from "../../_components/label-designer-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <LabelDesignerPage
    appBasePath={appBasePath}
    searchParams={searchParams}
    testIdPrefix="console-label-designer"
  />
));
