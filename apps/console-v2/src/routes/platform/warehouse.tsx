import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { WarehouseModule } from '@/modules/platform/warehouse';

export const Route = createFileRoute('/platform/warehouse')({
  component: WarehouseModule,
  head: () => buildRouteHead('/platform/warehouse'),
});
