import { MarketplaceContractRoomPage } from "../../../_components/marketplace-contract-room-page";
import { withConsoleConfig } from "../../../app-context";

type PageProps = {
  params: { id: string };
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { params }) => (
  <MarketplaceContractRoomPage
    appBasePath={appBasePath}
    contractId={params.id}
    contractsHref={`${appBasePath}/marketplace/contracts`}
    testIdPrefix="console-marketplace-contract-room"
  />
));
