import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { DisputesModule } from '@/modules/finance/disputes';

export const Route = createFileRoute('/finance/disputes')({
  component: DisputesModule,
  head: () => buildRouteHead('/finance/disputes'),
});
