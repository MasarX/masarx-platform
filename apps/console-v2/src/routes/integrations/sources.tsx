import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { SourcesModule } from '@/modules/integrations/sources';

export const Route = createFileRoute('/integrations/sources')({
  component: SourcesModule,
  head: () => buildRouteHead('/integrations/sources'),
});
