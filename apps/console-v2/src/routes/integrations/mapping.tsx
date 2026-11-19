import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { MappingModule } from '@/modules/integrations/mapping';

export const Route = createFileRoute('/integrations/mapping')({
  component: MappingModule,
  head: () => buildRouteHead('/integrations/mapping'),
});
