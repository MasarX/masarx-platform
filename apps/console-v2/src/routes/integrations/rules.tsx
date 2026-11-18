import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { RulesModule } from '@/modules/integrations/rules';

export const Route = createFileRoute('/integrations/rules')({
  component: RulesModule,
  head: () => buildRouteHead('/integrations/rules'),
});
