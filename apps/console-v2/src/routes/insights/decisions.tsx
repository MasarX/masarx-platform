import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { DecisionsModule } from '@/modules/insights/decisions';

export const Route = createFileRoute('/insights/decisions')({
  component: DecisionsModule,
  head: () => buildRouteHead('/insights/decisions'),
});
