import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ReportingModule } from '@/modules/insights/reporting';

export const Route = createFileRoute('/insights/reporting')({
  component: ReportingModule,
  head: () => buildRouteHead('/insights/reporting'),
});
