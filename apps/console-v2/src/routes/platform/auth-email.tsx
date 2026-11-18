import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { AuthEmailModule } from '@/modules/platform/auth-email';

export const Route = createFileRoute('/platform/auth-email')({
  component: AuthEmailModule,
  head: () => buildRouteHead('/platform/auth-email'),
});
