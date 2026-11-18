import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { LabelsModule } from '@/modules/platform/labels';

export const Route = createFileRoute('/platform/labels')({
  component: LabelsModule,
  head: () => buildRouteHead('/platform/labels'),
});
