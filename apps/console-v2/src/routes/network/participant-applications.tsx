// Phase D5 — non-driver marketplace participant pre-approval review queue.
// Mirrors public.marketplace_participant_requests (canonical SSOT) per
// supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:598.
// Approve / Reject route through the canonical Phase B4 RPC
// `marketplace_participant_request_review_apply_v1` (already wired via
// api.ts + queries.ts hook `useReviewMarketplaceParticipantRequest`).
//
// Driver applications (requested_participant_type_key='freelancer_driver')
// are reviewed in the Fleet domain (`/operate/fleet/driver-applications`,
// CLAIM-FLEET-DRIVER-APPS). This surface covers every non-driver type.
import { createFileRoute } from '@tanstack/react-router';
import { buildRouteHead } from '@/lib/route-meta';
import { ParticipantApplicationsModule } from '@/modules/network/participant-applications';

export const Route = createFileRoute('/network/participant-applications')({
  component: ParticipantApplicationsModule,
  head: () => buildRouteHead('/network/participant-applications'),
});
