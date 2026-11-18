import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { PickupsModule } from '@/modules/operate/pickups';

export const Route = createFileRoute('/operate/pickups')({
  component: PickupsModule,
  head: () => buildRouteHead('/operate/pickups'),
});
