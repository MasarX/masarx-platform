import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { DispatchModule } from '@/modules/operate/dispatch';

export const Route = createFileRoute('/operate/dispatch')({
  component: DispatchModule,
  head: () => buildRouteHead('/operate/dispatch'),
});
