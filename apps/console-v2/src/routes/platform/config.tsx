import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ConfigModule } from '@/modules/platform/config';

export const Route = createFileRoute('/platform/config')({
  component: ConfigModule,
  head: () => buildRouteHead('/platform/config'),
});
