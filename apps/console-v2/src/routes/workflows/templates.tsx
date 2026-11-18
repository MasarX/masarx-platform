import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { TemplatesModule } from '@/modules/workflows/templates';

export const Route = createFileRoute('/workflows/templates')({
  component: TemplatesModule,
  head: () => buildRouteHead('/workflows/templates'),
});
