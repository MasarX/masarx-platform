import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { BranchesModule } from '@/modules/network/branches';

export const Route = createFileRoute('/network/branches')({
  component: BranchesModule,
  head: () => buildRouteHead('/network/branches'),
});
