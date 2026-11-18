import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { DashboardModule } from '@/modules/dashboard';

export const Route = createFileRoute('/')({
  component: DashboardModule,
  head: () => buildRouteHead('/'),
});
