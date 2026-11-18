import { TrackingMapPage } from "../../../../../packages/ui/src/tracking-map-page";
import { withConsoleConfig } from "../../app-context";

type Props = { searchParams: Record<string, string | string[] | undefined> };
export default withConsoleConfig<Props>(({ locale, appBasePath }, { searchParams }) => (
  <TrackingMapPage
    locale={locale}
    searchParams={searchParams}
    baseHref={`${appBasePath}/operations/tracking-map`}
    testIdPrefix="console-tracking-map"
  />
));
