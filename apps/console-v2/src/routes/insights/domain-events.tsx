import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { DomainEventsModule } from '@/modules/insights/domain-events';

export const Route = createFileRoute('/insights/domain-events')({
  component: DomainEventsModule,
  head: () => buildRouteHead('/insights/domain-events'),
});
