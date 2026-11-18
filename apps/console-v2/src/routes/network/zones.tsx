// /network/zones — CLAIM-NETWORK-ZONES (Wave 1, Phase A).
// Map-first operator surface for the canonical public.zones table.
import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ZonesModule } from '@/modules/network/zones';

export const Route = createFileRoute('/network/zones')({
  component: ZonesModule,
  head: () => buildRouteHead('/network/zones'),
});
