import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { SupportCasesModule } from '@/modules/support/cases';

export const Route = createFileRoute('/support/cases')({
  component: SupportCasesModule,
  head: () => buildRouteHead('/support/cases'),
});
