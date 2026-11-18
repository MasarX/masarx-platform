import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { CredentialsModule } from '@/modules/integrations/credentials';

export const Route = createFileRoute('/integrations/credentials')({
  component: CredentialsModule,
  head: () => buildRouteHead('/integrations/credentials'),
});
