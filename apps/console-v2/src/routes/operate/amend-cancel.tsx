import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { AmendCancelModule } from '@/modules/operate/amend-cancel';

export const Route = createFileRoute('/operate/amend-cancel')({
  component: AmendCancelModule,
  head: () => buildRouteHead('/operate/amend-cancel'),
});
