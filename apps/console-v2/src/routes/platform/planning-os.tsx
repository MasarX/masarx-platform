import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { PlanningOsModule } from '@/modules/platform/planning-os';

export const Route = createFileRoute('/platform/planning-os')({
  component: PlanningOsModule,
  head: () => buildRouteHead('/platform/planning-os'),
});
