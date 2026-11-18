import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { RecipientsModule } from '@/modules/customers/recipients';

export const Route = createFileRoute('/customers/recipients')({
  component: RecipientsModule,
  head: () => buildRouteHead('/customers/recipients'),
});
