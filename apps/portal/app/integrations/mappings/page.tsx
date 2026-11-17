import { withPortalConfig } from "../../app-context";
import { PortalMappingsPage } from "./mappings-page";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <PortalMappingsPage appBasePath={appBasePath} searchParams={searchParams} />
));
