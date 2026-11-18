import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ReleaseProofModule } from '@/modules/platform/release-proof';

export const Route = createFileRoute('/platform/release-proof')({
  component: ReleaseProofModule,
  head: () => buildRouteHead('/platform/release-proof'),
});
