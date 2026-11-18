import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { CatalogModule } from '@/modules/integrations/catalog';

export const Route = createFileRoute('/integrations/catalog')({
  component: CatalogModule,
  head: () => buildRouteHead('/integrations/catalog'),
});
