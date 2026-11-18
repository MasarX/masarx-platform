import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { IntakeModule } from '@/modules/integrations/intake';

export const Route = createFileRoute('/integrations/intake')({
  component: IntakeModule,
  head: () => buildRouteHead('/integrations/intake'),
});
