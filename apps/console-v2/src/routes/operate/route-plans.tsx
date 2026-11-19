import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { RoutePlansModule } from '@/modules/operate/route-plans';

export const Route = createFileRoute('/operate/route-plans')({
  component: RoutePlansModule,
  head: () => buildRouteHead('/operate/route-plans'),
});
