import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ReturnedToBranchModule } from '@/modules/operate/returned-to-branch';

export const Route = createFileRoute('/operate/returned-to-branch')({
  component: ReturnedToBranchModule,
  head: () => buildRouteHead('/operate/returned-to-branch'),
});
