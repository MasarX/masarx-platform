import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { RunsModule } from '@/modules/workflows/runs';

export const Route = createFileRoute('/workflows/runs')({
  component: RunsModule,
  head: () => buildRouteHead('/workflows/runs'),
});
