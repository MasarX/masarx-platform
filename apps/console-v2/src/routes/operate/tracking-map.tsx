import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { TrackingMapModule } from '@/modules/operate/tracking-map';

export const Route = createFileRoute('/operate/tracking-map')({
  component: TrackingMapModule,
  head: () => buildRouteHead('/operate/tracking-map'),
});
