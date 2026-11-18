import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { TracesModule } from '@/modules/insights/traces';

export const Route = createFileRoute('/insights/traces')({
  component: TracesModule,
  head: () => buildRouteHead('/insights/traces'),
});
