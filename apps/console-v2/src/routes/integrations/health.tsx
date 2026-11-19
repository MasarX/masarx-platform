import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { HealthModule } from '@/modules/integrations/health';

export const Route = createFileRoute('/integrations/health')({
  component: HealthModule,
  head: () => buildRouteHead('/integrations/health'),
});
