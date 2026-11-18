import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { LookupsModule } from '@/modules/catalog/lookups';

export const Route = createFileRoute('/catalog/lookups')({
  component: LookupsModule,
  head: () => buildRouteHead('/catalog/lookups'),
});
