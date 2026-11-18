import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { PartnersModule } from '@/modules/network/partners';

export const Route = createFileRoute('/network/partners')({
  component: PartnersModule,
  head: () => buildRouteHead('/network/partners'),
});
