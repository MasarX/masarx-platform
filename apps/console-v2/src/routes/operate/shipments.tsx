import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ShipmentsModule } from '@/modules/operate/shipments';

export const Route = createFileRoute('/operate/shipments')({
  component: ShipmentsModule,
  head: () => buildRouteHead('/operate/shipments'),
});
