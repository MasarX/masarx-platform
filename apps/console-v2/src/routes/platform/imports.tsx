import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ImportsModule } from '@/modules/platform/imports';

export const Route = createFileRoute('/platform/imports')({
  component: ImportsModule,
  head: () => buildRouteHead('/platform/imports'),
});
