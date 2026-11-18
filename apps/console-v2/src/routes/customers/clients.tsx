import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ClientsModule } from '@/modules/customers/clients';

export const Route = createFileRoute('/customers/clients')({
  component: ClientsModule,
  head: () => buildRouteHead('/customers/clients'),
});
