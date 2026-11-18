import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { SettlementsModule } from '@/modules/finance/settlements';

export const Route = createFileRoute('/finance/settlements')({
  component: SettlementsModule,
  head: () => buildRouteHead('/finance/settlements'),
});
