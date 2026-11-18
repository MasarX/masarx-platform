import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { BillingModule } from '@/modules/finance/billing';

export const Route = createFileRoute('/finance/billing')({
  component: BillingModule,
  head: () => buildRouteHead('/finance/billing'),
});
