import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { LedgerModule } from '@/modules/finance/ledger';

export const Route = createFileRoute('/finance/ledger')({
  component: LedgerModule,
  head: () => buildRouteHead('/finance/ledger'),
});
