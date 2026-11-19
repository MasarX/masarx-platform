// Phase D / D1 — driver-signup intake review surface (operator console).
// Pairs with `supabase/functions/driver-signup-intake/index.ts` (edge fn that
// persists rows via `marketplace_participant_request_create_v1`) and
// `marketplace_participant_request_review_apply_v1` (Phase B canonical RPC).
import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { DriverApplicationsModule } from '@/modules/operate/fleet/driver-applications';

export const Route = createFileRoute('/operate/fleet/driver-applications')({
  component: DriverApplicationsModule,
  head: () => buildRouteHead('/operate/fleet/driver-applications'),
});
