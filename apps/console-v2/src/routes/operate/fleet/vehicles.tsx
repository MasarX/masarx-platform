import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { VehiclesModule } from '@/modules/operate/fleet/vehicles';

export const Route = createFileRoute('/operate/fleet/vehicles')({
  component: VehiclesModule,
  head: () => buildRouteHead('/operate/fleet/vehicles'),
});
