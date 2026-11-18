import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { SendersModule } from '@/modules/customers/senders';

export const Route = createFileRoute('/customers/senders')({
  component: SendersModule,
  head: () => buildRouteHead('/customers/senders'),
});
