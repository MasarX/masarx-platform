import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { AccessModule } from '@/modules/platform/access';

export const Route = createFileRoute('/platform/access')({
  component: AccessModule,
  head: () => buildRouteHead('/platform/access'),
});
