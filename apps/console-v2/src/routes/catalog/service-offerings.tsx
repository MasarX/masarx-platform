import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ServiceOfferingsModule } from '@/modules/catalog/service-offerings';

export const Route = createFileRoute('/catalog/service-offerings')({
  component: ServiceOfferingsModule,
  head: () => buildRouteHead('/catalog/service-offerings'),
});
