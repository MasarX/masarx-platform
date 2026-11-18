import { CodReconciliationPage } from "../../_components/cod-reconciliation-page";
import { withConsoleConfig } from "../../app-context";

type Props = { searchParams: Record<string, string | string[] | undefined> };

export default withConsoleConfig<Props>(({ appBasePath }, { searchParams }) => (
  <CodReconciliationPage appBasePath={appBasePath} searchParams={searchParams} />
));
