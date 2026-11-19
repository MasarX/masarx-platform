import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { BasketsModule } from '@/modules/operate/baskets';

export const Route = createFileRoute('/operate/baskets')({
  component: BasketsModule,
  head: () => buildRouteHead('/operate/baskets'),
});
