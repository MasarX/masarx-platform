import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { CodModule } from '@/modules/finance/cod';

export const Route = createFileRoute('/finance/cod')({
  component: CodModule,
  head: () => buildRouteHead('/finance/cod'),
});
