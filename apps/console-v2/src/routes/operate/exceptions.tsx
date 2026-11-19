import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ExceptionsModule } from '@/modules/operate/exceptions';

export const Route = createFileRoute('/operate/exceptions')({
  component: ExceptionsModule,
  head: () => buildRouteHead('/operate/exceptions'),
});
