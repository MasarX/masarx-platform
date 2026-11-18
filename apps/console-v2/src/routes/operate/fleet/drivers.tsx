import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { DriversModule } from '@/modules/operate/fleet/drivers';

export const Route = createFileRoute('/operate/fleet/drivers')({
  component: DriversModule,
  head: () => buildRouteHead('/operate/fleet/drivers'),
});
