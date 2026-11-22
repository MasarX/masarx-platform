import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { CustomerMigrationModule } from '@/modules/integrations/customer-migration';

export const Route = createFileRoute('/integrations/customer-migration')({
  component: CustomerMigrationModule,
  head: () => buildRouteHead('/integrations/customer-migration'),
});
