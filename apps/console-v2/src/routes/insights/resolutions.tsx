import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ResolutionsModule } from '@/modules/insights/resolutions';

export const Route = createFileRoute('/insights/resolutions')({
  component: ResolutionsModule,
  head: () => buildRouteHead('/insights/resolutions'),
});
