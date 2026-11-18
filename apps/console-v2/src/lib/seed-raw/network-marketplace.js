// network-marketplace.js — Wave 2 / CLAIM-NETWORK-MARKETPLACE seed.
//
// Mirrors the contracts from the canonical marketplace migrations
// (`supabase/migrations/202603071100_marketplace_network_foundation_v1.sql`
// family — bid/award/contract/request lifecycle backing the operator
// marketplace surface):
//
//   public.marketplace_offers
//     (id, request_id, supplier_participant_profile_id, status, terms jsonb,
//      pricing jsonb, submitted_at, expires_at)
//      -- W18-3: top-level lane/price/currency dropped (live in terms/pricing
//      -- jsonb). FE resolves via laneOf/priceOf/currencyOf helpers.
//
//   public.marketplace_awards
//     (id, offer_id, awarded_at, awarded_by_user_id, terms_summary, status,
//      cancelled_at, cancellation_reason)
//
//   public.marketplace_contracts
//     (id, award_id, participant_id, started_at, ends_at, status, terms)
//
//   public.marketplace_requests
//     (id, organization_id, request_kind, opened_by_user_id, opened_at,
//      payload jsonb, status)
//
//   public.marketplace_request_items
//     (id, request_id, item_key, payload jsonb)
//      -- W18-3: top-level qty dropped (lives inside payload.qty). FE
//      -- resolves via qtyOf helper.
//
//   public.marketplace_request_kinds
//     (id, key, label)               -- lookup
//
//   public.marketplace_availability_windows
//     (participant_id, weekday, hour, capacity)
//
//   public.marketplace_reputation_snapshots
//     (id, participant_id, snapshot_at, score, score_breakdown jsonb)
//
//   public.marketplace_events
//     (id, participant_id, event_type, occurred_at, payload jsonb)
//
// Cross-reference: `marketplace_participants` (seeded in marketplace.js) is the
// canonical roster — offers/awards/contracts deep-link to /network/partners
// via the `participant_id` foreign key.

import { lookups } from './lookups.js';

// Inject marketplace lifecycle lookups into the canonical lookups registry so
// DataTable lookup chips resolve to consistent tones across the surface. Same
// additive pattern Wave 1 established (network-zones / fleet-vehicles).
//
// W27 Cycle E closure additions:
//   • `marketplace_offer_status`, `marketplace_request_status`,
//     `marketplace_contract_status` now carry `metadata.is_*` flags so KPI
//     filters resolve through canonical row metadata instead of inline
//     status-array literals (P2 #6).
//   • `marketplace_verification_status` added — tone palette for the
//     verification record table chip on marketplace.tsx (P1 #2). Mirrors the
//     migration CHECK constraint
//     (202603071100_marketplace_network_foundation_v1.sql:672:
//     `status IN ('pending','approved','rejected','expired')`).
//   • `marketplace_event_type` added — tone palette for the marketplace
//     events ledger chip on marketplace.tsx (P1 #3). Replaces the inline
//     substring-based heuristic with a row-driven lookup.
Object.assign(lookups, {
  marketplace_offer_status: [
    { value: 'pending', label: 'Pending', tone: 'warn', rank: 10, is_default: true, metadata: { is_pending_award: true } },
    { value: 'shortlisted', label: 'Shortlisted', tone: 'info', rank: 20, metadata: { is_pending_award: true } },
    { value: 'awarded', label: 'Awarded', tone: 'good', rank: 30, metadata: { is_pending_award: false } },
    { value: 'rejected', label: 'Rejected', tone: 'danger', rank: 40, metadata: { is_pending_award: false } },
    { value: 'expired', label: 'Expired', tone: 'neutral', rank: 50, metadata: { is_pending_award: false } },
    { value: 'withdrawn', label: 'Withdrawn', tone: 'neutral', rank: 60, metadata: { is_pending_award: false } },
  ],
  // E2 closure (P1 #1) — `metadata.allowed_actions` declares which mutation
  // buttons may render for an award row in the canonical lifecycle. Replaces
  // inline `a.status === 'active'` literal at marketplace.tsx:1718. Adding a
  // new lifecycle status requires extending the row metadata so FE button
  // gating stays SSOT-bound. Backend RPC `marketplace_award_respond_v1`
  // accepts `response: 'cancel'`; the FE only surfaces the button when the
  // canonical lifecycle row authorizes it.
  marketplace_award_status: [
    { value: 'active', label: 'Active', tone: 'good', rank: 10, is_default: true, metadata: { allowed_actions: ['cancel'] } },
    { value: 'cancelled', label: 'Cancelled', tone: 'danger', rank: 20, metadata: { allowed_actions: [] } },
    { value: 'completed', label: 'Completed', tone: 'neutral', rank: 30, metadata: { allowed_actions: [] } },
  ],
  // E2 closure (P1 #1) — `metadata.allowed_actions` declares which mutation
  // buttons may render for a contract row in the canonical lifecycle. Replaces
  // inline `c.status === 'draft'` literal at marketplace.tsx:1821. The FE
  // surfaces Activate / Renegotiate / Terminate per row metadata. The
  // Activate button is gated on `'activate'` membership; Renegotiate +
  // Terminate are surfaced for non-terminal contract rows because both flows
  // mutate via the same canonical respond_v1 RPC seam.
  marketplace_contract_status: [
    { value: 'draft', label: 'Draft', tone: 'info', rank: 10, metadata: { is_active_lifecycle: false, allowed_actions: ['activate', 'renegotiate', 'terminate'] } },
    { value: 'active', label: 'Active', tone: 'good', rank: 20, is_default: true, metadata: { is_active_lifecycle: true, allowed_actions: ['renegotiate', 'terminate'] } },
    { value: 'expiring_soon', label: 'Expiring soon', tone: 'warn', rank: 30, metadata: { is_active_lifecycle: true, allowed_actions: ['renegotiate', 'terminate'] } },
    { value: 'expired', label: 'Expired', tone: 'neutral', rank: 40, metadata: { is_active_lifecycle: false, allowed_actions: [] } },
    { value: 'terminated', label: 'Terminated', tone: 'danger', rank: 50, metadata: { is_active_lifecycle: false, allowed_actions: [] } },
  ],
  marketplace_request_status: [
    { value: 'open', label: 'Open', tone: 'info', rank: 10, is_default: true, metadata: { is_open: true } },
    { value: 'in_review', label: 'In review', tone: 'warn', rank: 20, metadata: { is_open: true } },
    { value: 'awarded', label: 'Awarded', tone: 'good', rank: 30, metadata: { is_open: false } },
    { value: 'closed', label: 'Closed', tone: 'neutral', rank: 40, metadata: { is_open: false } },
    { value: 'cancelled', label: 'Cancelled', tone: 'danger', rank: 50, metadata: { is_open: false } },
  ],
  marketplace_request_kind: [
    { value: 'same_day_capacity', label: 'Same-day capacity', tone: 'info', rank: 10 },
    { value: 'refrigerated', label: 'Refrigerated', tone: 'info', rank: 20 },
    { value: 'hazmat', label: 'Hazmat', tone: 'warn', rank: 30 },
    { value: 'bulk_freight', label: 'Bulk freight', tone: 'neutral', rank: 40 },
    { value: 'return_pickup', label: 'Return pickup', tone: 'good', rank: 50 },
  ],
  // W27 Cycle E (P1 #2) — `marketplace_verification_status` mirrors the
  // canonical migration CHECK constraint
  // (202603071100_marketplace_network_foundation_v1.sql:672:
  // `status IN ('pending','approved','rejected','expired')`). Tones picked
  // to match the lifecycle posture: pending=warn, approved=good,
  // rejected=danger, expired=neutral.
  //
  // E2 closure (P1 #4) — `metadata.is_approved_verification` flags the row
  // that counts toward "approved verification" KPIs (replaces literal
  // `=== 'approved'` filter at marketplace.tsx:2083). `metadata.is_pending_verification`
  // mirrors the pending-side filter (literal `=== 'pending'` at marketplace.tsx:2083).
  marketplace_verification_status: [
    { value: 'pending', label: 'Pending', tone: 'warn', rank: 10, is_default: true, metadata: { is_approved_verification: false, is_pending_verification: true } },
    { value: 'approved', label: 'Approved', tone: 'good', rank: 20, metadata: { is_approved_verification: true, is_pending_verification: false } },
    { value: 'rejected', label: 'Rejected', tone: 'danger', rank: 30, metadata: { is_approved_verification: false, is_pending_verification: false } },
    { value: 'expired', label: 'Expired', tone: 'neutral', rank: 40, metadata: { is_approved_verification: false, is_pending_verification: false } },
  ],
  // E2 closure (P1 #4) — `marketplace_participant_compliance_state`
  // canonical category for the compliance_state column on
  // `marketplace_participant_profiles` (CHECK constraint
  // pending|approved|rejected|expired|suspended). The legacy
  // `partner_compliance_status` category uses a different vocabulary
  // (compliant/expiring_soon/expired/...) that does not match the canonical
  // table values; this category mirrors the actual canonical CHECK values
  // and carries `metadata.is_compliant` so partners.tsx KPI counters resolve
  // through canonical lookup metadata rather than a hardcoded literal.
  marketplace_participant_compliance_state: [
    { value: 'pending',   label: 'Pending',   tone: 'warn',    rank: 10, is_default: true, metadata: { is_compliant: false } },
    { value: 'approved',  label: 'Approved',  tone: 'good',    rank: 20, metadata: { is_compliant: true } },
    { value: 'rejected',  label: 'Rejected',  tone: 'danger',  rank: 30, metadata: { is_compliant: false } },
    { value: 'expired',   label: 'Expired',   tone: 'neutral', rank: 40, metadata: { is_compliant: false } },
    { value: 'suspended', label: 'Suspended', tone: 'danger',  rank: 50, metadata: { is_compliant: false } },
  ],
  // E2 closure (P1 #4) — `marketplace_participant_membership_status` +
  // `marketplace_participant_capability_status` carry `metadata.is_active`
  // so marketplace.tsx (lines 2014, 2016) reputation drawer counters resolve
  // through canonical lookup metadata rather than literal `=== 'active'`.
  marketplace_participant_membership_status: [
    { value: 'active',   label: 'Active',   tone: 'good',    rank: 10, is_default: true, metadata: { is_active: true } },
    { value: 'inactive', label: 'Inactive', tone: 'neutral', rank: 20, metadata: { is_active: false } },
    { value: 'pending',  label: 'Pending',  tone: 'warn',    rank: 30, metadata: { is_active: false } },
  ],
  marketplace_participant_capability_status: [
    { value: 'active',   label: 'Active',   tone: 'good',    rank: 10, is_default: true, metadata: { is_active: true } },
    { value: 'inactive', label: 'Inactive', tone: 'neutral', rank: 20, metadata: { is_active: false } },
    { value: 'expired',  label: 'Expired',  tone: 'neutral', rank: 30, metadata: { is_active: false } },
  ],
  // W27 Cycle E (P1 #3) — `marketplace_event_type` row-driven tone palette
  // for the marketplace events ledger chip (replaces inline
  // substring-based tone heuristic at marketplace.tsx:2888-2893). Mirrors
  // the canonical event taxonomy emitted by `marketplace_events` /
  // `marketplace_reputation_events` seed rows. Adding a new event type
  // requires registering a row here so chip rendering stays row-driven.
  marketplace_event_type: [
    { value: 'offer_submitted', label: 'Offer submitted', tone: 'info', rank: 10 },
    { value: 'offer_withdrawn', label: 'Offer withdrawn', tone: 'neutral', rank: 11 },
    { value: 'offer_rejected', label: 'Offer rejected', tone: 'danger', rank: 12 },
    { value: 'offer_expired', label: 'Offer expired', tone: 'neutral', rank: 13 },
    { value: 'award_received', label: 'Award received', tone: 'good', rank: 20 },
    { value: 'award_accepted', label: 'Award accepted', tone: 'good', rank: 21 },
    { value: 'award_rejected', label: 'Award rejected', tone: 'danger', rank: 22 },
    { value: 'award_cancelled', label: 'Award cancelled', tone: 'danger', rank: 23 },
    { value: 'contract_activated', label: 'Contract activated', tone: 'good', rank: 30 },
    { value: 'contract_terminated', label: 'Contract terminated', tone: 'danger', rank: 31 },
    { value: 'reputation_recomputed', label: 'Reputation recomputed', tone: 'info', rank: 40 },
    { value: 'dispute_opened', label: 'Dispute opened', tone: 'warn', rank: 50 },
    { value: 'dispute_resolved', label: 'Dispute resolved', tone: 'good', rank: 51 },
  ],
});

// ----------------- request_kinds (lookup-style projection) -----------------
// Mirrors `public.marketplace_request_kinds`. Drives the kind chip + the
// "New request" modal kind picker.
//
// W19-1 — added canonical `kind_key` PK shadow alongside FE aliases (`id`,
// `key`). Canonical `public.marketplace_request_kinds` PK is `kind_key`,
// not `id`. The FE row resolver `kindKeyOf(row)` prefers the canonical
// shadow and falls back to the FE aliases.
export const marketplace_request_kinds = [
  { id: 'mrk_same_day', key: 'same_day_capacity', kind_key: 'same_day_capacity', label: 'Same-day capacity' },
  { id: 'mrk_refrig', key: 'refrigerated', kind_key: 'refrigerated', label: 'Refrigerated' },
  { id: 'mrk_hazmat', key: 'hazmat', kind_key: 'hazmat', label: 'Hazmat' },
  { id: 'mrk_bulk', key: 'bulk_freight', kind_key: 'bulk_freight', label: 'Bulk freight' },
  { id: 'mrk_return', key: 'return_pickup', kind_key: 'return_pickup', label: 'Return pickup' },
];

// ----------------- requests -----------------
// Mirrors `public.marketplace_requests`. payload (canonical request_details
// jsonb) is JSON; we surface lane info so offers can render a meaningful
// lane column without an extra join.
//
// W13-1 — dropped FE-fictional `response_count` (canonical
// `public.marketplace_requests` has no count column). FE derives the bid
// count from `marketplace_offers` per request_id at render time.
//
// W17-2 — dropped FE-fictional top-level `opener` + `opened_by_user_id`.
// Canonical `public.marketplace_requests` has no opener columns; the
// historical FE values now live inside `payload` (canonical
// `request_details` jsonb) under the `opener` / `opened_by_user_id` keys.
// The FE resolves them via `openerOf()` so the existing render keys stay
// stable.
//
// W19-1 — added canonical column shadows alongside FE aliases:
//   • `requester_organization_id` ← canonical (FE alias `organization_id`)
//   • `request_kind_key`          ← canonical (FE alias `request_kind`)
//   • `published_at`              ← canonical (FE alias `opened_at`)
//   • `request_details`           ← canonical (FE alias `payload`)
// Both shapes are seeded so the FE row resolvers (`requestKindKeyOf` /
// `openedAtOf` / `payloadOf`) hit the canonical path first while
// downstream consumers (cross-module deep-links, legacy view sorts,
// disputes test fixtures) that still read the FE alias keys keep working.
export const marketplace_requests = [
  {
    id: 'mreq_2401',
    organization_id: 'org_rashed',
    requester_organization_id: 'org_rashed',
    request_kind: 'same_day_capacity',
    request_kind_key: 'same_day_capacity',
    opened_at: '2026-04-22T08:30:00Z',
    published_at: '2026-04-22T08:30:00Z',
    payload: { lane: 'RUH ↔ JED', service: 'same_day', cutoff: '2026-04-26T18:00:00Z', opener: 'Rashed Al-Otaibi', opened_by_user_id: 'usr_admin_rashed' },
    request_details: { lane: 'RUH ↔ JED', service: 'same_day', cutoff: '2026-04-26T18:00:00Z', opener: 'Rashed Al-Otaibi', opened_by_user_id: 'usr_admin_rashed' },
    status: 'in_review',
  },
  {
    id: 'mreq_2402',
    organization_id: 'org_rashed',
    requester_organization_id: 'org_rashed',
    request_kind: 'refrigerated',
    request_kind_key: 'refrigerated',
    opened_at: '2026-04-23T09:10:00Z',
    published_at: '2026-04-23T09:10:00Z',
    payload: { lane: 'JED → MED', temperature_band: '2-8C', volume_pallets: 12, opener: 'Mariam Al-Sayed', opened_by_user_id: 'usr_ops_mariam' },
    request_details: { lane: 'JED → MED', temperature_band: '2-8C', volume_pallets: 12, opener: 'Mariam Al-Sayed', opened_by_user_id: 'usr_ops_mariam' },
    status: 'open',
  },
  {
    id: 'mreq_2403',
    organization_id: 'org_rashed',
    requester_organization_id: 'org_rashed',
    request_kind: 'bulk_freight',
    request_kind_key: 'bulk_freight',
    opened_at: '2026-04-21T14:45:00Z',
    published_at: '2026-04-21T14:45:00Z',
    payload: { lane: 'RUH → DMM', mode: 'truckload', weight_kg: 18000, opener: 'Rashed Al-Otaibi', opened_by_user_id: 'usr_admin_rashed' },
    request_details: { lane: 'RUH → DMM', mode: 'truckload', weight_kg: 18000, opener: 'Rashed Al-Otaibi', opened_by_user_id: 'usr_admin_rashed' },
    status: 'awarded',
  },
  {
    id: 'mreq_2404',
    organization_id: 'org_rashed',
    requester_organization_id: 'org_rashed',
    request_kind: 'hazmat',
    request_kind_key: 'hazmat',
    opened_at: '2026-04-24T11:00:00Z',
    published_at: '2026-04-24T11:00:00Z',
    payload: { lane: 'DMM ↔ JUB', class: 'UN3082', certification_required: true, opener: 'Khalid Al-Otaibi', opened_by_user_id: 'usr_dispatch_khalid' },
    request_details: { lane: 'DMM ↔ JUB', class: 'UN3082', certification_required: true, opener: 'Khalid Al-Otaibi', opened_by_user_id: 'usr_dispatch_khalid' },
    status: 'open',
  },
  {
    id: 'mreq_2405',
    organization_id: 'org_rashed',
    requester_organization_id: 'org_rashed',
    request_kind: 'return_pickup',
    request_kind_key: 'return_pickup',
    opened_at: '2026-04-25T07:15:00Z',
    published_at: '2026-04-25T07:15:00Z',
    payload: { lane: 'RUH all-zones', sla_hours: 48, opener: 'Mariam Al-Sayed', opened_by_user_id: 'usr_ops_mariam' },
    request_details: { lane: 'RUH all-zones', sla_hours: 48, opener: 'Mariam Al-Sayed', opened_by_user_id: 'usr_ops_mariam' },
    status: 'open',
  },
  {
    id: 'mreq_2406',
    organization_id: 'org_rashed',
    requester_organization_id: 'org_rashed',
    request_kind: 'same_day_capacity',
    request_kind_key: 'same_day_capacity',
    opened_at: '2026-04-19T17:00:00Z',
    published_at: '2026-04-19T17:00:00Z',
    payload: { lane: 'MED → RUH', service: 'overnight', opener: 'Rashed Al-Otaibi', opened_by_user_id: 'usr_admin_rashed' },
    request_details: { lane: 'MED → RUH', service: 'overnight', opener: 'Rashed Al-Otaibi', opened_by_user_id: 'usr_admin_rashed' },
    status: 'closed',
  },
];

// ----------------- request_items -----------------
// Mirrors `public.marketplace_request_items`. Multiple SKUs/lines per request.
//
// W18-3 — dropped FE-fictional top-level `qty`. Canonical
// `public.marketplace_request_items` has no `qty` column; the value now
// lives inside `payload` jsonb under `qty`. The FE resolves via
// `qtyOf(item)` so existing render keys stay stable.
export const marketplace_request_items = [
  // mreq_2401 (same-day RUH-JED)
  { id: 'mri_1', request_id: 'mreq_2401', item_kind: 'parcel_standard', payload: { qty: 240 } },
  { id: 'mri_2', request_id: 'mreq_2401', item_kind: 'parcel_oversize', payload: { qty: 18 } },
  { id: 'mri_3', request_id: 'mreq_2401', item_kind: 'cod_envelope', payload: { qty: 60 } },
  // mreq_2402 (refrigerated JED→MED)
  { id: 'mri_4', request_id: 'mreq_2402', item_kind: 'pallet_chilled', payload: { qty: 12 } },
  { id: 'mri_5', request_id: 'mreq_2402', item_kind: 'temp_logger', payload: { qty: 12 } },
  // mreq_2403 (bulk RUH→DMM)
  { id: 'mri_6', request_id: 'mreq_2403', item_kind: 'truckload_dry', payload: { qty: 1 } },
  { id: 'mri_7', request_id: 'mreq_2403', item_kind: 'pallet_dry', payload: { qty: 28 } },
  // mreq_2404 (hazmat DMM↔JUB)
  { id: 'mri_8', request_id: 'mreq_2404', item_kind: 'drum_un3082', payload: { qty: 14 } },
  { id: 'mri_9', request_id: 'mreq_2404', item_kind: 'spill_kit', payload: { qty: 2 } },
  // mreq_2405 (return pickup RUH)
  { id: 'mri_10', request_id: 'mreq_2405', item_kind: 'pickup_window', payload: { qty: 320 } },
  { id: 'mri_11', request_id: 'mreq_2405', item_kind: 'cage_returnable', payload: { qty: 14 } },
  // mreq_2406 (same-day MED-RUH, closed)
  { id: 'mri_12', request_id: 'mreq_2406', item_kind: 'parcel_standard', payload: { qty: 410 } },
  { id: 'mri_13', request_id: 'mreq_2406', item_kind: 'parcel_oversize', payload: { qty: 22 } },
  { id: 'mri_14', request_id: 'mreq_2406', item_kind: 'pallet_dry', payload: { qty: 4 } },
  { id: 'mri_15', request_id: 'mreq_2406', item_kind: 'cod_envelope', payload: { qty: 120 } },
  // mreq_2402 — extra
  { id: 'mri_16', request_id: 'mreq_2402', item_kind: 'reefer_seal', payload: { qty: 12 } },
];

// ----------------- offers -----------------
// Mirrors `public.marketplace_offers`. participant_id matches `marketplace_participants`
// in marketplace.js so partner deep-links resolve. Mix of statuses + a couple
// soon-to-expire entries to exercise the aging chip in the offers tab.
//
// W18-3 — dropped FE-fictional top-level `lane` / `price` / `currency`.
// Canonical `public.marketplace_offers` has no `lane`/`price`/`currency`
// columns; the values now live inside canonical jsonb (`terms.lane`,
// `pricing.price`, `pricing.currency`). The FE resolves via
// `laneOf(offer)` / `priceOf(offer)` / `currencyOf(offer)` so existing
// render keys stay stable.
//
// W19-1 — added canonical column shadows alongside FE aliases:
//   • `supplier_participant_profile_id` ← canonical (FE alias `participant_id`)
//   • `expires_at`                      ← canonical (FE alias `valid_until`)
// Both shapes are seeded so the FE row resolvers (`offerParticipantIdOf`
// / `validUntilOf`) hit the canonical path first while legacy view-saved
// sorts/filters that key on the FE alias names keep working.
function _offer(id, request_id, participant_id, lane, price, valid_until, status, submitted_at) {
  return {
    id,
    request_id,
    // FE alias kept for back-compat; new code resolves via offerParticipantIdOf
    participant_id,
    // Canonical shadow (W19-1)
    supplier_participant_profile_id: participant_id,
    terms: { lane },
    pricing: { price, currency: 'SAR' },
    // FE alias kept for back-compat; new code resolves via validUntilOf
    valid_until,
    // Canonical shadow (W19-1)
    expires_at: valid_until,
    status,
    submitted_at,
  };
}

export const marketplace_offers = [
  // mreq_2401 — three offers (RUH↔JED same-day)
  _offer('mof_1001', 'mreq_2401', 'mpp_exampledepot', 'RUH ↔ JED', 9.6, '2026-04-26T18:00:00Z', 'shortlisted', '2026-04-22T11:00:00Z'),
  _offer('mof_1002', 'mreq_2401', 'mpp_examplecourier', 'RUH ↔ JED', 10.4, '2026-04-26T20:00:00Z', 'pending', '2026-04-22T13:15:00Z'),
  _offer('mof_1003', 'mreq_2401', 'mpp_examplefleet', 'RUH ↔ JED', 11.2, '2026-04-25T22:00:00Z', 'rejected', '2026-04-22T15:00:00Z'),
  // mreq_2402 (refrigerated)
  _offer('mof_1004', 'mreq_2402', 'mpp_exampledepot', 'JED → MED', 1840, '2026-04-27T08:00:00Z', 'pending', '2026-04-23T12:00:00Z'),
  _offer('mof_1005', 'mreq_2402', 'mpp_fleet_co', 'JED → MED', 1740, '2026-04-26T12:00:00Z', 'pending', '2026-04-23T14:30:00Z'),
  // mreq_2403 — already awarded, plus a withdrawn rival
  _offer('mof_1006', 'mreq_2403', 'mpp_examplecourier', 'RUH → DMM', 4200, '2026-04-30T18:00:00Z', 'awarded', '2026-04-21T16:20:00Z'),
  _offer('mof_1007', 'mreq_2403', 'mpp_examplefleet', 'RUH → DMM', 4480, '2026-04-29T18:00:00Z', 'withdrawn', '2026-04-21T17:00:00Z'),
  // mreq_2404 (hazmat) — only one bidder
  _offer('mof_1008', 'mreq_2404', 'mpp_exampledepot', 'DMM ↔ JUB', 6800, '2026-04-28T18:00:00Z', 'pending', '2026-04-24T13:30:00Z'),
  // mreq_2405 (return pickup) — two open offers
  _offer('mof_1009', 'mreq_2405', 'mpp_examplecourier', 'RUH all-zones', 14.5, '2026-04-30T22:00:00Z', 'pending', '2026-04-25T10:00:00Z'),
  _offer('mof_1010', 'mreq_2405', 'mpp_fleet_co', 'RUH all-zones', 16.2, '2026-04-30T22:00:00Z', 'pending', '2026-04-25T11:30:00Z'),
  // mreq_2406 (closed) — historical entries
  _offer('mof_1011', 'mreq_2406', 'mpp_examplefleet', 'MED → RUH', 8.4, '2026-04-22T18:00:00Z', 'awarded', '2026-04-19T18:00:00Z'),
  _offer('mof_1012', 'mreq_2406', 'mpp_exampledepot', 'MED → RUH', 8.8, '2026-04-22T18:00:00Z', 'expired', '2026-04-19T19:00:00Z'),
];

// ----------------- awards -----------------
// Mirrors `public.marketplace_awards`. One row per accepted offer.
//
// W17-2 — dropped FE-fictional top-level `terms_summary`. Canonical
// `public.marketplace_awards` has no `terms_summary` column; the value now
// lives inside `award_terms` jsonb under `terms_summary`. The FE resolves
// via `termsSummaryOf(award)` so existing kvRows / column keys stay stable.
//
// W19-1 — added canonical column shadows alongside FE aliases:
//   • `supplier_participant_profile_id` ← canonical (FE alias `participant_id`)
//   • `created_at`                      ← canonical (FE alias `awarded_at`)
//   • `rejected_at`                     ← canonical (FE alias `cancelled_at`)
//   • `award_reason`                    ← canonical (FE alias `cancellation_reason`)
// Both shapes are seeded so the FE row resolvers
// (`awardParticipantIdOf` / `awardedAtOf` / `awardCancelledAtOf` /
// `awardCancellationReasonOf`) hit the canonical path first.
export const marketplace_awards = [
  {
    id: 'mawd_801',
    offer_id: 'mof_1006',
    participant_id: 'mpp_examplecourier',
    supplier_participant_profile_id: 'mpp_examplecourier',
    awarded_at: '2026-04-22T09:00:00Z',
    created_at: '2026-04-22T09:00:00Z',
    awarded_by: 'Rashed Al-Otaibi',
    awarded_by_user_id: 'usr_admin_rashed',
    award_terms: { terms_summary: 'Truckload · 2 lanes/day · 30-day pricing lock' },
    status: 'active',
  },
  {
    id: 'mawd_802',
    offer_id: 'mof_1011',
    participant_id: 'mpp_examplefleet',
    supplier_participant_profile_id: 'mpp_examplefleet',
    awarded_at: '2026-04-20T09:30:00Z',
    created_at: '2026-04-20T09:30:00Z',
    awarded_by: 'Rashed Al-Otaibi',
    awarded_by_user_id: 'usr_admin_rashed',
    award_terms: { terms_summary: 'Same-day MED-RUH · 14-day window' },
    status: 'completed',
  },
  {
    id: 'mawd_803',
    offer_id: 'mof_1001',
    participant_id: 'mpp_exampledepot',
    supplier_participant_profile_id: 'mpp_exampledepot',
    awarded_at: '2026-04-23T08:00:00Z',
    created_at: '2026-04-23T08:00:00Z',
    awarded_by: 'Mariam Al-Sayed',
    awarded_by_user_id: 'usr_ops_mariam',
    award_terms: { terms_summary: 'Same-day RUH-JED · pilot 7 days · 10% volume bonus' },
    status: 'active',
  },
  {
    id: 'mawd_804',
    offer_id: 'mof_1004',
    participant_id: 'mpp_exampledepot',
    supplier_participant_profile_id: 'mpp_exampledepot',
    awarded_at: '2026-04-24T10:00:00Z',
    created_at: '2026-04-24T10:00:00Z',
    awarded_by: 'Mariam Al-Sayed',
    awarded_by_user_id: 'usr_ops_mariam',
    award_terms: { terms_summary: 'Refrigerated JED-MED · 12 pallets · single haul' },
    status: 'cancelled',
    cancelled_at: '2026-04-25T08:00:00Z',
    rejected_at: '2026-04-25T08:00:00Z',
    cancellation_reason: 'Customer postponed cold-chain rollout to Q3',
    award_reason: 'Customer postponed cold-chain rollout to Q3',
  },
  {
    id: 'mawd_805',
    offer_id: 'mof_1008',
    participant_id: 'mpp_exampledepot',
    supplier_participant_profile_id: 'mpp_exampledepot',
    awarded_at: '2026-04-25T07:00:00Z',
    created_at: '2026-04-25T07:00:00Z',
    awarded_by: 'Khalid Al-Otaibi',
    awarded_by_user_id: 'usr_dispatch_khalid',
    award_terms: { terms_summary: 'Hazmat DMM-JUB · 14 drums · ADR-trained driver' },
    status: 'active',
  },
];

// ----------------- contracts -----------------
// Mirrors `public.marketplace_contracts`. ends_at is the field the aging chip
// reads to compute warning vs danger tone (≤ 14 days = warn, ≤ 0 = expired).
//
// W18-2 — alias unification: previously exported under the disjoint key
// `marketplace_contracts_v2` so the legacy `marketplace_contracts` from
// marketplace.js (consumed by /network/partners per claim-H) could keep
// its partial-roster shape. With `partners.tsx` migrated to the canonical
// lifecycle shape (started_at / ends_at / terms / award_id /
// metadata.contract_no), the alias is no longer needed; the export is now
// the canonical `marketplace_contracts` and is consumed by both
// /network/partners and /network/marketplace through the same registry
// key. See `__audit__/DECISIONS/REGISTRY-ALIASES.md` §3 closure.
//
// W17-2 — dropped FE-fictional top-level `contract_no`. Canonical
// `public.marketplace_contracts` has no `contract_no` column; the value now
// lives inside `metadata` jsonb under `contract_no`. The FE resolves via
// `contractNoOf(contract)` so existing kvRows / column keys stay stable.
//
// W19-1 — added canonical column shadows alongside FE aliases:
//   • `supplier_participant_profile_id` ← canonical (FE alias `participant_id`)
//   • `activated_at`                    ← canonical (FE alias `started_at`)
//   • `completed_at`                    ← canonical (FE alias `ends_at`,
//     for non-terminated contracts)
//   • `cancelled_at`                    ← canonical (FE alias `ends_at`,
//     for terminated contracts)
// Both shapes are seeded so the FE row resolvers
// (`contractParticipantIdOf` / `startedAtOf` / `endsAtOf`) hit the
// canonical path first while partners.tsx and disputes deep-links keep
// reading the FE alias keys.
export const marketplace_contracts = [
  {
    id: 'mctr_701',
    award_id: 'mawd_801',
    participant_id: 'mpp_examplecourier',
    supplier_participant_profile_id: 'mpp_examplecourier',
    started_at: '2026-04-22T00:00:00Z',
    activated_at: '2026-04-22T00:00:00Z',
    ends_at: '2026-07-22T00:00:00Z',
    completed_at: '2026-07-22T00:00:00Z',
    status: 'active',
    terms: 'Truckload service · auto-renew clause · SLA 95% on-time',
    metadata: { contract_no: 'CTR-2026-Q2-AMX-001' },
  },
  {
    id: 'mctr_702',
    award_id: 'mawd_803',
    participant_id: 'mpp_exampledepot',
    supplier_participant_profile_id: 'mpp_exampledepot',
    started_at: '2026-04-23T00:00:00Z',
    activated_at: '2026-04-23T00:00:00Z',
    ends_at: '2026-04-30T00:00:00Z',
    completed_at: '2026-04-30T00:00:00Z',
    status: 'expiring_soon',
    terms: 'Pilot · 7-day evaluation · single lane',
    metadata: { contract_no: 'CTR-2026-Q2-NQL-014' },
  },
  {
    id: 'mctr_703',
    award_id: 'mawd_805',
    participant_id: 'mpp_exampledepot',
    supplier_participant_profile_id: 'mpp_exampledepot',
    started_at: '2026-04-25T00:00:00Z',
    activated_at: '2026-04-25T00:00:00Z',
    ends_at: '2026-05-09T00:00:00Z',
    completed_at: '2026-05-09T00:00:00Z',
    status: 'expiring_soon',
    terms: 'Hazmat · ADR-only · per-haul billing',
    metadata: { contract_no: 'CTR-2026-Q2-NQL-015' },
  },
  {
    id: 'mctr_704',
    award_id: 'mawd_802',
    participant_id: 'mpp_examplefleet',
    supplier_participant_profile_id: 'mpp_examplefleet',
    started_at: '2026-04-20T00:00:00Z',
    activated_at: '2026-04-20T00:00:00Z',
    ends_at: '2026-04-23T00:00:00Z',
    completed_at: '2026-04-23T00:00:00Z',
    status: 'expired',
    terms: 'Same-day MED-RUH · 3-day execution window',
    metadata: { contract_no: 'CTR-2026-Q2-SMS-007' },
  },
  {
    id: 'mctr_705',
    award_id: 'mawd_804',
    participant_id: 'mpp_exampledepot',
    supplier_participant_profile_id: 'mpp_exampledepot',
    started_at: '2026-04-24T00:00:00Z',
    activated_at: '2026-04-24T00:00:00Z',
    ends_at: '2026-05-24T00:00:00Z',
    cancelled_at: '2026-05-24T00:00:00Z',
    status: 'terminated',
    terms: 'Cold-chain pilot · terminated by client postponement',
    metadata: { contract_no: 'CTR-2026-Q2-NQL-016' },
  },
];

// ----------------- availability_windows -----------------
// Mirrors `public.marketplace_availability_windows`. (participant, weekday,
// hour) → capacity. Used by the partner drawer/availability section.
export const marketplace_availability_windows = [
  { participant_id: 'mpp_exampledepot', weekday: 1, hour: 8, capacity: 320 },
  { participant_id: 'mpp_exampledepot', weekday: 1, hour: 14, capacity: 280 },
  { participant_id: 'mpp_exampledepot', weekday: 2, hour: 8, capacity: 320 },
  { participant_id: 'mpp_exampledepot', weekday: 3, hour: 8, capacity: 300 },
  { participant_id: 'mpp_examplecourier', weekday: 1, hour: 9, capacity: 220 },
  { participant_id: 'mpp_examplecourier', weekday: 2, hour: 9, capacity: 240 },
  { participant_id: 'mpp_examplecourier', weekday: 3, hour: 9, capacity: 240 },
  { participant_id: 'mpp_examplecourier', weekday: 4, hour: 9, capacity: 200 },
  { participant_id: 'mpp_examplefleet', weekday: 1, hour: 7, capacity: 140 },
  { participant_id: 'mpp_examplefleet', weekday: 2, hour: 7, capacity: 140 },
  { participant_id: 'mpp_examplefleet', weekday: 4, hour: 7, capacity: 120 },
  { participant_id: 'mpp_fleet_co', weekday: 1, hour: 6, capacity: 80 },
  { participant_id: 'mpp_fleet_co', weekday: 3, hour: 6, capacity: 80 },
  { participant_id: 'mpp_fleet_co', weekday: 5, hour: 6, capacity: 60 },
];

// ----------------- reputation_snapshots -----------------
// Mirrors `public.marketplace_reputation_snapshots`. We seed ~7 weekly snapshots
// per participant so the per-row sparkline can plot a meaningful trajectory
// (range 0..100). Score breakdown is JSON: 4 sub-axes summing to ≈ score.
//
// Cadence: 2026-03-08, 03-15, 03-22, 03-29, 04-05, 04-12, 04-19, 04-26 — eight
// weekly Saturdays so the most recent point lands on the demo date.
const REP_DATES = [
  '2026-03-08T00:00:00Z',
  '2026-03-15T00:00:00Z',
  '2026-03-22T00:00:00Z',
  '2026-03-29T00:00:00Z',
  '2026-04-05T00:00:00Z',
  '2026-04-12T00:00:00Z',
  '2026-04-19T00:00:00Z',
  '2026-04-26T00:00:00Z',
];

// W13-1 — canonical `public.marketplace_reputation_snapshots` has no
// top-level `score_breakdown` column; the breakdown lives in `metadata`
// jsonb. Seed mirrors the canonical shape now and the FE resolves the
// breakdown via `breakdownOf(snap)` reading metadata.score_breakdown.
//
// W19-1 — added canonical column shadows alongside FE aliases:
//   • `participant_profile_id` ← canonical PK (FE alias `participant_id`)
//   • `updated_at`             ← canonical (FE alias `snapshot_at`)
// The FE resolves via `snapshotParticipantIdOf` and `snapshotAtOf` so the
// canonical path takes priority while view-saved sorts on the FE alias
// keys keep working.
function _snap(seq, participantId, scores) {
  return scores.map((score, i) => ({
    id: `mrs_${participantId.replace('mpp_', '')}_${seq}_${i + 1}`,
    participant_id: participantId,
    // Canonical PK shadow (W19-1)
    participant_profile_id: participantId,
    snapshot_at: REP_DATES[i],
    // Canonical updated_at shadow (W19-1)
    updated_at: REP_DATES[i],
    score,
    metadata: {
      score_breakdown: {
        on_time: Math.round(score * 0.42),
        pod_quality: Math.round(score * 0.22),
        cod_accuracy: Math.round(score * 0.20),
        dispute_rate: Math.round(score * 0.16),
      },
    },
  }));
}

export const marketplace_reputation_snapshots = [
  ..._snap(1, 'mpp_exampledepot', [86, 88, 87, 89, 91, 90, 92, 93]),
  ..._snap(2, 'mpp_examplecourier', [78, 80, 79, 82, 81, 83, 85, 86]),
  ..._snap(3, 'mpp_examplefleet', [72, 70, 74, 71, 73, 75, 74, 76]),
  ..._snap(4, 'mpp_fleet_co', [55, 58, 60, 59, 62, 64, 63, 67]),
  // Synthetic 5th participant (carrier in onboarding) — only present here so
  // the reputation tab proves it can render rows for participants that have
  // not yet generated offers/awards.
  ..._snap(5, 'mpp_examplehub', [62, 65, 64, 66, 68, 67, 70, 71]),
];

// ----------------- events -----------------
// Mirrors `public.marketplace_events`. Bid history / dispute opens / award
// posts. Surfaces under the request drawer "Bid history" tab.
export const marketplace_events = [
  { id: 'mev_5101', participant_id: 'mpp_exampledepot', event_type: 'offer_submitted', occurred_at: '2026-04-22T11:00:00Z', payload: { offer_id: 'mof_1001', request_id: 'mreq_2401' } },
  { id: 'mev_5102', participant_id: 'mpp_examplecourier', event_type: 'offer_submitted', occurred_at: '2026-04-22T13:15:00Z', payload: { offer_id: 'mof_1002', request_id: 'mreq_2401' } },
  { id: 'mev_5103', participant_id: 'mpp_examplefleet', event_type: 'offer_submitted', occurred_at: '2026-04-22T15:00:00Z', payload: { offer_id: 'mof_1003', request_id: 'mreq_2401' } },
  { id: 'mev_5104', participant_id: 'mpp_examplecourier', event_type: 'award_received', occurred_at: '2026-04-22T09:00:00Z', payload: { award_id: 'mawd_801' } },
  { id: 'mev_5105', participant_id: 'mpp_exampledepot', event_type: 'award_received', occurred_at: '2026-04-23T08:00:00Z', payload: { award_id: 'mawd_803' } },
  { id: 'mev_5106', participant_id: 'mpp_exampledepot', event_type: 'award_cancelled', occurred_at: '2026-04-25T08:00:00Z', payload: { award_id: 'mawd_804' } },
  { id: 'mev_5107', participant_id: 'mpp_examplefleet', event_type: 'reputation_recomputed', occurred_at: '2026-04-26T00:00:00Z', payload: { score: 76 } },
  { id: 'mev_5108', participant_id: 'mpp_exampledepot', event_type: 'reputation_recomputed', occurred_at: '2026-04-26T00:00:00Z', payload: { score: 93 } },
];

// ----------------- participants supplement -----------------
// Synthetic 5th participant for reputation tab parity — additive to the
// canonical roster from marketplace.js. Surfaces in the reputation tab only.
// Console renders the union when a row exists in either source.
// W27 Cycle E closure (P0 #1) — `listing_status` reconciled to canonical
// migration values (`private/curated_network/public`). Legacy `'pending'`
// was rejected by the CHECK constraint
// (202603071100_marketplace_network_foundation_v1.sql:579); the supplement
// participant Examplehub is mid-onboarding so `'curated_network'` is the
// canonical match (visible to operators but not the public listing page).
export const marketplace_participants_supplement = [
  { id: 'mpp_examplehub', name: 'Examplehub', kind: 'partner_carrier', country: 'SA', listing_status: 'curated_network', compliance: 'pending_docs' },
];

// ============================================================================
// W13-4 — Canonical participant multi-table graph
// ============================================================================
// MarketplaceParticipantRow earlier audits flagged the FE flat shape; canonical
// graph is split across 4 tables in
// supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:
//
//   public.marketplace_participant_profiles    (557+)
//   public.marketplace_participant_memberships (584+)
//   public.marketplace_participant_capabilities (643+)
//   public.marketplace_verification_records    (657+)
//
// Surfaces consume aggregated counts (active memberships, active capabilities,
// pending/expired verification records) so the participant drawer can reflect
// the canonical onboarding posture instead of a single flat shape. The seed
// keys participant_profile_id back to the existing `mpp_*` ids so cross-
// references stay stable across modules (partners.tsx / marketplace.tsx).

// Mirrors `public.marketplace_participant_profiles` for the existing roster
// (`mpp_exampledepot`, `mpp_examplecourier`, `mpp_examplefleet`, `mpp_fleet_co`, `mpp_examplehub`). Adds
// the canonical projection columns (display_name, participant_type_key,
// status, listing_status, compliance_state, rating_overall, rating_count) so
// modules can consume `useResourceList<ParticipantProfileRow>('marketplace_participant_profiles')`
// when the wider canonical graph is needed.
export const marketplace_participant_profiles = [
  {
    id: 'mpp_exampledepot',
    organization_id: 'org_exampledepot',
    participant_type_key: 'partner_carrier',
    status: 'approved',
    listing_status: 'public',
    compliance_state: 'approved',
    display_name: 'Exampledepot',
    legal_name: 'Exampledepot Express Logistics',
    contact_email: 'partnerships@exampledepot.example',
    rating_overall: 92.5,
    rating_count: 318,
    last_verified_at: '2026-03-15T00:00:00Z',
  },
  {
    id: 'mpp_examplecourier',
    organization_id: 'org_examplecourier',
    participant_type_key: 'partner_carrier',
    status: 'approved',
    listing_status: 'public',
    compliance_state: 'approved',
    display_name: 'Examplecourier',
    legal_name: 'Examplecourier Saudi Arabia',
    contact_email: 'partners@examplecourier.example',
    rating_overall: 86.0,
    rating_count: 412,
    last_verified_at: '2026-02-28T00:00:00Z',
  },
  {
    id: 'mpp_examplefleet',
    organization_id: 'org_examplefleet',
    participant_type_key: 'partner_carrier',
    status: 'approved',
    listing_status: 'public',
    compliance_state: 'approved',
    display_name: 'EXAMPLEFLEET Express',
    legal_name: 'EXAMPLEFLEET Express Saudi',
    contact_email: 'desk@examplefleet.example',
    rating_overall: 76.0,
    rating_count: 198,
    last_verified_at: '2026-03-01T00:00:00Z',
  },
  {
    id: 'mpp_fleet_co',
    organization_id: 'org_fleet_co',
    participant_type_key: 'partner_fleet',
    status: 'pending',
    listing_status: 'private',
    compliance_state: 'pending',
    display_name: 'FleetCo Riyadh',
    legal_name: 'FleetCo Riyadh Logistics',
    contact_email: 'fixture-contact-03@example.com',
    rating_overall: 67.0,
    rating_count: 42,
    last_verified_at: null,
  },
  {
    id: 'mpp_examplehub',
    organization_id: 'org_examplehub',
    participant_type_key: 'partner_carrier',
    status: 'pending',
    listing_status: 'private',
    compliance_state: 'pending',
    display_name: 'Examplehub',
    legal_name: 'Examplehub Cargo & Express',
    contact_email: 'onboarding@examplehub.example',
    rating_overall: 71.0,
    rating_count: 12,
    last_verified_at: null,
  },
];

// Mirrors `public.marketplace_participant_memberships`. Each row links a
// participant_profile to a user with a membership_role + status. The seed
// surfaces 1-3 memberships per active participant so the participant drawer
// can render `Members (n)` with primary/non-primary counts.
export const marketplace_participant_memberships = [
  { id: 'mpm_naq_1', participant_profile_id: 'mpp_exampledepot', user_id: 'usr_naq_owner', membership_role: 'owner', status: 'active', is_primary: true },
  { id: 'mpm_naq_2', participant_profile_id: 'mpp_exampledepot', user_id: 'usr_naq_dispatch', membership_role: 'dispatcher', status: 'active', is_primary: false },
  { id: 'mpm_examplecourier_1', participant_profile_id: 'mpp_examplecourier', user_id: 'usr_examplecourier_owner', membership_role: 'owner', status: 'active', is_primary: true },
  { id: 'mpm_examplecourier_2', participant_profile_id: 'mpp_examplecourier', user_id: 'usr_examplecourier_finance', membership_role: 'finance', status: 'active', is_primary: false },
  { id: 'mpm_examplecourier_3', participant_profile_id: 'mpp_examplecourier', user_id: 'usr_examplecourier_inactive', membership_role: 'dispatcher', status: 'inactive', is_primary: false },
  { id: 'mpm_examplefleet_1', participant_profile_id: 'mpp_examplefleet', user_id: 'usr_examplefleet_owner', membership_role: 'owner', status: 'active', is_primary: true },
  { id: 'mpm_fleet_1', participant_profile_id: 'mpp_fleet_co', user_id: 'usr_fleet_owner', membership_role: 'owner', status: 'active', is_primary: true },
  { id: 'mpm_examplehub_1', participant_profile_id: 'mpp_examplehub', user_id: 'usr_examplehub_owner', membership_role: 'owner', status: 'active', is_primary: true },
];

// Mirrors `public.marketplace_participant_capabilities`. Each row is a
// participant_profile_id × capability_key with a status (active/inactive/expired).
// Surfaces in the participant drawer as `Capabilities (n active / m total)`.
export const marketplace_participant_capabilities = [
  { id: 'mpc_naq_express', participant_profile_id: 'mpp_exampledepot', capability_key: 'last_mile.express', status: 'active' },
  { id: 'mpc_naq_cold', participant_profile_id: 'mpp_exampledepot', capability_key: 'last_mile.cold_chain', status: 'active' },
  { id: 'mpc_naq_returns', participant_profile_id: 'mpp_exampledepot', capability_key: 'reverse_logistics.returns', status: 'active' },
  { id: 'mpc_examplecourier_express', participant_profile_id: 'mpp_examplecourier', capability_key: 'last_mile.express', status: 'active' },
  { id: 'mpc_examplecourier_intl', participant_profile_id: 'mpp_examplecourier', capability_key: 'cross_border.import', status: 'active' },
  { id: 'mpc_examplecourier_legacy', participant_profile_id: 'mpp_examplecourier', capability_key: 'last_mile.same_day', status: 'expired' },
  { id: 'mpc_examplefleet_express', participant_profile_id: 'mpp_examplefleet', capability_key: 'last_mile.express', status: 'active' },
  { id: 'mpc_fleet_long', participant_profile_id: 'mpp_fleet_co', capability_key: 'long_haul.intercity', status: 'inactive' },
  { id: 'mpc_examplehub_express', participant_profile_id: 'mpp_examplehub', capability_key: 'last_mile.express', status: 'active' },
];

// Mirrors `public.marketplace_verification_records`. Each row is a
// participant_profile_id × document_type_key with a status
// (pending/approved/rejected/expired). Used in the participant drawer to
// render a verification posture chip strip.
export const marketplace_verification_records = [
  { id: 'mvr_naq_cr', participant_profile_id: 'mpp_exampledepot', document_type_key: 'commercial_registration', status: 'approved', issued_at: '2025-11-01T00:00:00Z', expires_at: '2027-11-01T00:00:00Z', reviewed_at: '2026-01-12T00:00:00Z' },
  { id: 'mvr_naq_vat', participant_profile_id: 'mpp_exampledepot', document_type_key: 'vat_certificate', status: 'approved', issued_at: '2025-12-15T00:00:00Z', expires_at: '2026-12-15T00:00:00Z', reviewed_at: '2026-01-15T00:00:00Z' },
  { id: 'mvr_examplecourier_cr', participant_profile_id: 'mpp_examplecourier', document_type_key: 'commercial_registration', status: 'approved', issued_at: '2025-08-15T00:00:00Z', expires_at: '2027-08-15T00:00:00Z', reviewed_at: '2025-09-12T00:00:00Z' },
  { id: 'mvr_examplecourier_vat', participant_profile_id: 'mpp_examplecourier', document_type_key: 'vat_certificate', status: 'approved', issued_at: '2025-09-10T00:00:00Z', expires_at: '2026-09-10T00:00:00Z', reviewed_at: '2025-09-20T00:00:00Z' },
  { id: 'mvr_examplefleet_cr', participant_profile_id: 'mpp_examplefleet', document_type_key: 'commercial_registration', status: 'approved', issued_at: '2026-01-01T00:00:00Z', expires_at: '2028-01-01T00:00:00Z', reviewed_at: '2026-01-12T00:00:00Z' },
  { id: 'mvr_fleet_cr', participant_profile_id: 'mpp_fleet_co', document_type_key: 'commercial_registration', status: 'pending', issued_at: '2026-04-10T00:00:00Z', expires_at: null, reviewed_at: null },
  { id: 'mvr_fleet_vat', participant_profile_id: 'mpp_fleet_co', document_type_key: 'vat_certificate', status: 'pending', issued_at: '2026-04-12T00:00:00Z', expires_at: null, reviewed_at: null },
  { id: 'mvr_examplehub_cr', participant_profile_id: 'mpp_examplehub', document_type_key: 'commercial_registration', status: 'pending', issued_at: '2026-04-22T00:00:00Z', expires_at: null, reviewed_at: null },
];

// ============================================================================
// W13-4 — marketplace_reputation_events (canonical event ledger)
// ============================================================================
// Mirrors `public.marketplace_reputation_events`
// (supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:837).
// Per-event scoring deltas drive the snapshot rollups; surfaces in the
// reputation drawer as a paginated event ledger so operators can see WHY a
// participant's score moved (e.g. on_time delivery, sla_breach, dispute).
export const marketplace_reputation_events = [
  { id: 'mre_5001', participant_profile_id: 'mpp_exampledepot', organization_id: 'org_exampledepot', event_type: 'on_time_delivery', metric_key: 'on_time_rate', weight: 1.0, score_delta: 0.4, occurred_at: '2026-04-25T18:00:00Z', payload: { shipments: 12 } },
  { id: 'mre_5002', participant_profile_id: 'mpp_exampledepot', organization_id: 'org_exampledepot', event_type: 'pod_complete', metric_key: 'pod_quality', weight: 0.8, score_delta: 0.2, occurred_at: '2026-04-25T16:30:00Z', payload: { pods: 18 } },
  { id: 'mre_5003', participant_profile_id: 'mpp_examplecourier', organization_id: 'org_examplecourier', event_type: 'sla_breach', metric_key: 'on_time_rate', weight: 1.5, score_delta: -0.6, occurred_at: '2026-04-24T21:15:00Z', payload: { shipment_id: 'shp_9381200', delay_min: 78 } },
  { id: 'mre_5004', participant_profile_id: 'mpp_examplecourier', organization_id: 'org_examplecourier', event_type: 'on_time_delivery', metric_key: 'on_time_rate', weight: 1.0, score_delta: 0.3, occurred_at: '2026-04-24T19:00:00Z', payload: { shipments: 22 } },
  { id: 'mre_5005', participant_profile_id: 'mpp_examplefleet', organization_id: 'org_examplefleet', event_type: 'dispute_opened', metric_key: 'dispute_rate', weight: 1.2, score_delta: -0.8, occurred_at: '2026-04-23T10:00:00Z', payload: { dispute_id: 'dsp_881' } },
  { id: 'mre_5006', participant_profile_id: 'mpp_examplefleet', organization_id: 'org_examplefleet', event_type: 'on_time_delivery', metric_key: 'on_time_rate', weight: 1.0, score_delta: 0.2, occurred_at: '2026-04-22T16:00:00Z', payload: { shipments: 8 } },
  { id: 'mre_5007', participant_profile_id: 'mpp_fleet_co', organization_id: 'org_fleet_co', event_type: 'document_expired', metric_key: 'document_freshness', weight: 0.9, score_delta: -0.5, occurred_at: '2026-04-20T08:00:00Z', payload: { document_type_key: 'vat_certificate' } },
  { id: 'mre_5008', participant_profile_id: 'mpp_exampledepot', organization_id: 'org_exampledepot', event_type: 'cod_accuracy', metric_key: 'cod_accuracy', weight: 1.0, score_delta: 0.4, occurred_at: '2026-04-21T15:00:00Z', payload: { batches: 4 } },
];
