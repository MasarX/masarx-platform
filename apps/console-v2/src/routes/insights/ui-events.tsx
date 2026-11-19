import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { UiEventsModule } from '@/modules/insights/ui-events';

export const Route = createFileRoute('/insights/ui-events')({
  component: UiEventsModule,
  head: () => buildRouteHead('/insights/ui-events'),
});
