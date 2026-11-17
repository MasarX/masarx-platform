import { MarketplaceContractRoomPage } from "../../../_components/marketplace-contract-room-page";
import { withPortalConfig } from "../../../app-context";

type PageProps = {
  params: { id: string };
};

export default withPortalConfig<PageProps>(({ appBasePath }, { params }) => (
  <MarketplaceContractRoomPage
    appBasePath={appBasePath}
    contractId={params.id}
    contractsHref={`${appBasePath}/marketplace/contracts`}
    testIdPrefix="portal-marketplace-contract-room"
  />
));
