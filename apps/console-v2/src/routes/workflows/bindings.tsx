import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { BindingsModule } from '@/modules/workflows/bindings';

export const Route = createFileRoute('/workflows/bindings')({
  component: BindingsModule,
  head: () => buildRouteHead('/workflows/bindings'),
});
