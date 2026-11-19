import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { MobilePolicyModule } from '@/modules/platform/mobile-policy';

export const Route = createFileRoute('/platform/mobile-policy')({
  component: MobilePolicyModule,
  head: () => buildRouteHead('/platform/mobile-policy'),
});
