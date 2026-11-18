import { createFileRoute, redirect } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';

export const Route = createFileRoute('/insights/telemetry')({
  beforeLoad: () => {
    throw redirect({ to: '/insights/ui-events' });
  },
  head: () => buildRouteHead('/insights/telemetry'),
});
