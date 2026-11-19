import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { MarketplaceModule } from '@/modules/network/marketplace';

export const Route = createFileRoute('/network/marketplace')({
  component: MarketplaceModule,
  head: () => buildRouteHead('/network/marketplace'),
});
