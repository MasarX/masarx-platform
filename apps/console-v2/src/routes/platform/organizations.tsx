import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { OrganizationsModule } from '@/modules/platform/organizations';

export const Route = createFileRoute('/platform/organizations')({
  component: OrganizationsModule,
  head: () => buildRouteHead('/platform/organizations'),
});
