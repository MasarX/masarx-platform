import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { BankReconModule } from '@/modules/finance/bank-recon';

export const Route = createFileRoute('/finance/bank-recon')({
  component: BankReconModule,
  head: () => buildRouteHead('/finance/bank-recon'),
});
