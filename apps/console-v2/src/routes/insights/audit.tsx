import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { AuditModule } from '@/modules/insights/audit';

export const Route = createFileRoute('/insights/audit')({
  component: AuditModule,
  head: () => buildRouteHead('/insights/audit'),
});
