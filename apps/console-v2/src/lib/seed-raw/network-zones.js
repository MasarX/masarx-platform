// network-zones.js — Wave 1 / CLAIM-NETWORK-ZONES seed.

import { lookups } from './lookups.js';

// Inject zone-specific status / role / change-kind lookups into the canonical
// `lookups` registry. This mirrors public.lookup_values rows that ship with
// the migration; we keep the additive Object.assign style established by the
// fleet-vehicles seed so Wave 1 agents do not step on lookups.js directly.
Object.assign(lookups, {
  // E2 closure (P1 #4) — `metadata.is_active_zone_status` declares whether a
  // zone status counts toward the "active zones" KPI / bulk action target
  // set. Replaces inline `=== 'active'` literals in zones.tsx (KPI count,
  // bulk-suspend filter). Adding a new lifecycle status requires extending
  // metadata so the KPI + bulk targeting derives via canonical metadata.
  // W67-Network closure — `metadata.is_suspended_zone_status` declares whether
  // a zone status counts toward the "suspended zones" KPI. Replaces the
  // remaining literal `=== 'suspended'` filter in zones.tsx so adding a new
  // suspended-equivalent lifecycle status (e.g. 'frozen') is metadata-only.
  zone_status: [
    { value: 'active', label: 'Active', tone: 'good', rank: 10, is_default: true, metadata: { is_active_zone_status: true, is_suspended_zone_status: false } },
    { value: 'draft', label: 'Draft', tone: 'info', rank: 20, metadata: { is_active_zone_status: false, is_suspended_zone_status: false } },
    { value: 'suspended', label: 'Suspended', tone: 'warn', rank: 30, metadata: { is_active_zone_status: false, is_suspended_zone_status: true } },
    { value: 'retired', label: 'Retired', tone: 'neutral', rank: 40, metadata: { is_active_zone_status: false, is_suspended_zone_status: false } },
  ],
  zone_district_role: [
    { value: 'primary', label: 'Primary', tone: 'good', rank: 10 },
    { value: 'secondary', label: 'Secondary', tone: 'info', rank: 20 },
  ],
  // E2 closure (P1 #1) — `metadata.allowed_actions` declares which review
  // buttons may render for a zone override row in the canonical lifecycle.
  // Replaces inline `o.status === 'pending'` / `'approved'` literals at
  // zones-drawer.tsx:446,448,470,520. Backend RPC
  // `execute_zone_override_request_v1` accepts decision `'approve'|'deny'`;
  // the FE only surfaces the buttons when the canonical lifecycle row
  // authorizes it. `metadata.summary_kind` declares which timeline summary
  // line to render (replaces the ternary literal cascade in the
  // overrideEvents map).
  zone_override_status: [
    { value: 'pending', label: 'Pending', tone: 'warn', rank: 10, metadata: { allowed_actions: ['approve', 'deny'], summary_kind: 'pending', is_terminal: false } },
    { value: 'approved', label: 'Approved', tone: 'good', rank: 20, metadata: { allowed_actions: [], summary_kind: 'approved', is_terminal: true } },
    { value: 'denied', label: 'Denied', tone: 'danger', rank: 30, metadata: { allowed_actions: [], summary_kind: 'denied', is_terminal: true } },
  ],
  zone_override_kind: [
    { value: 'add_district', label: 'Add district', tone: 'info', rank: 10 },
    { value: 'remove_district', label: 'Remove district', tone: 'warn', rank: 20 },
    { value: 'reassign_role', label: 'Reassign role', tone: 'info', rank: 30 },
    { value: 'rename', label: 'Rename', tone: 'neutral', rank: 40 },
    { value: 'suspend_zone', label: 'Suspend', tone: 'warn', rank: 50 },
    { value: 'restore_zone', label: 'Restore', tone: 'good', rank: 60 },
  ],
  // The 6-token color palette mirrors backend lookup `zone_color_token`. The
  // value maps onto the shared tone vocabulary used by every visual primitive.
  zone_color_token: [
    { value: 'good', label: 'Green · ops nominal', tone: 'good', rank: 10 },
    { value: 'info', label: 'Blue · informational', tone: 'info', rank: 20 },
    { value: 'warn', label: 'Amber · attention', tone: 'warn', rank: 30 },
    { value: 'danger', label: 'Red · escalation', tone: 'danger', rank: 40 },
    { value: 'neutral', label: 'Grey · idle', tone: 'neutral', rank: 50 },
  ],
});
//
// Mirrors the contract from `supabase/migrations/202512261200_zones_baskets.sql`:
//
//   public.zones
//     (id, organization_id, name, slug, description, is_active, metadata,
//      created_at, updated_at)
//
//   public.zone_districts
//     (zone_id, district_id, role IN ('primary','secondary'), created_at)
//
//   public.zone_override_requests
//     (id, zone_id, requested_by_user_id, change_kind, payload jsonb,
//      status IN ('pending','approved','denied'),
//      decision_at, decided_by_user_id, created_at)
//
// Cross-reference: `canonical_districts` provides district display names and
// centroids. `zone_summary.geometry` derives map polygons from those linked
// centroid rows through the same projection seam used in live mode.

// ---------- Canonical districts dictionary (additive, demo-only) -----------
// Real backend SSOT lives in `public.canonical_districts` (city_id, code, name,
// centroid). We only seed the small set needed for the Wave 1 zones drawer.
//
// W20 — added canonical column shadows for the deferred RENAME items (per
// `__audit__/SCHEMA-DRIFT/NETWORK.md` §11 / §15):
//   • `name_canonical` ← canonical (FE alias `name`)
//   • `name_arabic`    ← canonical (FE alias `name_ar`)
// FE row resolvers (`districtNameOf` / `districtNameArOf`) prefer canonical.
// W34c — district centroid coordinates added as canonical metadata so the
// tracking map (operate/tracking-map.tsx) can render district labels through
// a canonical projection (`useResourceList('canonical_districts')`) instead
// of a hardcoded inline DISTRICT_LABELS array. Centroids are deterministic
// neighborhood centers; the FE filters to ones with non-null lat/lng before
// rendering. Backend mirror: `public.canonical_districts.metadata->>'centroid_lat'/'centroid_lng'`
// (or paired `lat`/`lng` columns) — projection is additive and back-compatible.
export const canonical_districts = [
  // Riyadh
  { id: 'cd_ruh_olaya', city_code: 'RUH', name_canonical: 'Olaya', name: 'Olaya', name_arabic: 'العليا', name_ar: 'العليا', centroid_lat: 24.74, centroid_lng: 46.66 },
  { id: 'cd_ruh_sulaymaniyah', city_code: 'RUH', name_canonical: 'Sulaymaniyah', name: 'Sulaymaniyah', name_arabic: 'السليمانية', name_ar: 'السليمانية', centroid_lat: 24.72, centroid_lng: 46.74 },
  { id: 'cd_ruh_malqa', city_code: 'RUH', name_canonical: 'Al-Malqa', name: 'Al-Malqa', name_arabic: 'الملقا', name_ar: 'الملقا', centroid_lat: 24.78, centroid_lng: 46.62 },
  { id: 'cd_ruh_yasmin', city_code: 'RUH', name_canonical: 'Al-Yasmin', name: 'Al-Yasmin', name_arabic: 'الياسمين', name_ar: 'الياسمين', centroid_lat: 24.76, centroid_lng: 46.69 },
  { id: 'cd_ruh_aqiq', city_code: 'RUH', name_canonical: 'Al-Aqiq', name: 'Al-Aqiq', name_arabic: 'العقيق', name_ar: 'العقيق', centroid_lat: 24.78, centroid_lng: 46.63 },
  { id: 'cd_ruh_hittin', city_code: 'RUH', name_canonical: 'Hittin', name: 'Hittin', name_arabic: 'حطين', name_ar: 'حطين', centroid_lat: 24.69, centroid_lng: 46.69 },
  { id: 'cd_ruh_nakheel', city_code: 'RUH', name_canonical: 'Al-Nakheel', name: 'Al-Nakheel', name_arabic: 'النخيل', name_ar: 'النخيل', centroid_lat: 24.75, centroid_lng: 46.64 },
  { id: 'cd_ruh_diplomatic', city_code: 'RUH', name_canonical: 'Diplomatic Quarter', name: 'Diplomatic Quarter', name_arabic: 'الحي الدبلوماسي', name_ar: 'الحي الدبلوماسي', centroid_lat: 24.68, centroid_lng: 46.62 },
  // Jeddah
  { id: 'cd_jed_corniche', city_code: 'JED', name_canonical: 'Corniche', name: 'Corniche', name_arabic: 'الكورنيش', name_ar: 'الكورنيش', centroid_lat: 21.60, centroid_lng: 39.11 },
  { id: 'cd_jed_andalus', city_code: 'JED', name_canonical: 'Al-Andalus', name: 'Al-Andalus', name_arabic: 'الأندلس', name_ar: 'الأندلس', centroid_lat: 21.56, centroid_lng: 39.15 },
  { id: 'cd_jed_zahra', city_code: 'JED', name_canonical: 'Al-Zahra', name: 'Al-Zahra', name_arabic: 'الزهراء', name_ar: 'الزهراء', centroid_lat: 21.61, centroid_lng: 39.17 },
  { id: 'cd_jed_rawdah', city_code: 'JED', name_canonical: 'Al-Rawdah', name: 'Al-Rawdah', name_arabic: 'الروضة', name_ar: 'الروضة', centroid_lat: 21.56, centroid_lng: 39.18 },
  { id: 'cd_jed_balad', city_code: 'JED', name_canonical: 'Al-Balad', name: 'Al-Balad', name_arabic: 'البلد', name_ar: 'البلد', centroid_lat: 21.49, centroid_lng: 39.19 },
  // Dammam / Khobar
  { id: 'cd_dmm_shati', city_code: 'DMM', name_canonical: 'Al-Shati', name: 'Al-Shati', name_arabic: 'الشاطئ', name_ar: 'الشاطئ', centroid_lat: 26.45, centroid_lng: 50.12 },
  { id: 'cd_dmm_faisaliyah', city_code: 'DMM', name_canonical: 'Al-Faisaliyah', name: 'Al-Faisaliyah', name_arabic: 'الفيصلية', name_ar: 'الفيصلية', centroid_lat: 26.39, centroid_lng: 50.06 },
  { id: 'cd_kho_aqrabiyah', city_code: 'KHO', name_canonical: 'Al-Aqrabiyah', name: 'Al-Aqrabiyah', name_arabic: 'العقربية', name_ar: 'العقربية', centroid_lat: 26.29, centroid_lng: 50.20 },
  // Mecca / Madinah
  { id: 'cd_mec_aziziyah', city_code: 'MEC', name_canonical: 'Al-Aziziyah', name: 'Al-Aziziyah', name_arabic: 'العزيزية', name_ar: 'العزيزية', centroid_lat: 21.41, centroid_lng: 39.88 },
  { id: 'cd_mad_haram', city_code: 'MAD', name_canonical: 'Central Haram', name: 'Central Haram', name_arabic: 'الحرم', name_ar: 'الحرم', centroid_lat: 24.47, centroid_lng: 39.61 },
].map((row) => ({ organization_id: 'org_rashed', ...row }));

// ---------- zones (mirrors public.zones) -----------
//
// W17-5 — renamed from `network_zones` to canonical `zones` to align the FE
// registry key with the backend table name (per
// `__audit__/DECISIONS/REGISTRY-ALIASES.md` §1 closure). The legacy
// hub-keyed picker shape that previously occupied the `zones` export in
// `domain-routes.js` was removed in the same wave (no live consumers).
//
// `color_token` mirrors a backend lookup: design tokens that map to the
// shared tone palette. The map view derives `tone` from `color_token` (see
// network/zones.tsx).
//
// `status` mirrors backend lookup `zone_status` ∈ {active, suspended,
// draft, retired}.
//
// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §7):
//   • `is_active`            ← canonical (FE alias `status`)
//   • `description`          ← canonical (FE alias `notes`)
//   • `metadata.lifecycle`   ← drives FE multi-state status display
//   • `metadata.color_token` ← projection of FE alias `color_token`
// Both shapes are seeded so the FE row resolvers (`zoneStatusOf` /
// `zoneNotesOf` / `zoneIsActiveOf`) hit the canonical path first while
// view-saved sorts/filters keep working. Zone polygons are derived by the
// `zone_summary` projection from linked canonical district centroids.
export const zones = [
  {
    id: 'zn_ruh_north',
    organization_id: 'org_rashed',
    name: 'Riyadh North',
    slug: 'ruh-north',
    color_token: 'good',
    is_active: true,
    status: 'active',
    description: 'Primary delivery footprint covering Olaya, Sulaymaniyah, Al-Malqa.',
    notes: 'Primary delivery footprint covering Olaya, Sulaymaniyah, Al-Malqa.',
    metadata: { lifecycle: 'active', color_token: 'good' },
    created_at: '2026-02-12T08:00:00Z',
    updated_at: '2026-04-22T11:14:00Z',
    hub_code: 'RUH-N',
  },
  {
    id: 'zn_ruh_south',
    organization_id: 'org_rashed',
    name: 'Riyadh South',
    slug: 'ruh-south',
    color_token: 'info',
    is_active: true,
    status: 'active',
    description: 'Southern Riyadh corridor — Aqiq, Hittin, Nakheel.',
    notes: 'Southern Riyadh corridor — Aqiq, Hittin, Nakheel.',
    metadata: { lifecycle: 'active', color_token: 'info' },
    created_at: '2026-02-12T08:00:00Z',
    updated_at: '2026-04-21T09:42:00Z',
    hub_code: 'RUH-S',
  },
  {
    id: 'zn_ruh_diplomatic',
    organization_id: 'org_rashed',
    name: 'Diplomatic Quarter',
    slug: 'ruh-dq',
    color_token: 'warn',
    is_active: true,
    status: 'active',
    description: 'Restricted-access embassy zone · senior driver clearance required.',
    notes: 'Restricted-access embassy zone · senior driver clearance required.',
    metadata: { lifecycle: 'active', color_token: 'warn' },
    created_at: '2026-03-04T08:00:00Z',
    updated_at: '2026-04-25T07:18:00Z',
    hub_code: 'RUH-N',
  },
  {
    id: 'zn_jed_north',
    organization_id: 'org_rashed',
    name: 'Jeddah Coastal',
    slug: 'jed-coastal',
    color_token: 'good',
    is_active: true,
    status: 'active',
    description: 'Corniche + Al-Zahra north arc.',
    notes: 'Corniche + Al-Zahra north arc.',
    metadata: { lifecycle: 'active', color_token: 'good' },
    created_at: '2026-02-18T08:00:00Z',
    updated_at: '2026-04-23T10:02:00Z',
    hub_code: 'JED-N',
  },
  {
    id: 'zn_jed_south',
    organization_id: 'org_rashed',
    name: 'Jeddah Heritage',
    slug: 'jed-heritage',
    color_token: 'neutral',
    is_active: false,
    status: 'suspended',
    description: 'Suspended pending traffic-permit renewal · Al-Balad / Al-Rawdah.',
    notes: 'Suspended pending traffic-permit renewal · Al-Balad / Al-Rawdah.',
    metadata: { lifecycle: 'suspended', color_token: 'neutral' },
    created_at: '2026-02-18T08:00:00Z',
    updated_at: '2026-04-25T11:20:00Z',
    hub_code: 'JED-N',
  },
  {
    id: 'zn_dmm_central',
    organization_id: 'org_rashed',
    name: 'Dammam Central',
    slug: 'dmm-central',
    color_token: 'info',
    is_active: true,
    status: 'active',
    description: 'Industrial + residential mix · Khobar overflow allowed.',
    notes: 'Industrial + residential mix · Khobar overflow allowed.',
    metadata: { lifecycle: 'active', color_token: 'info' },
    created_at: '2026-03-01T08:00:00Z',
    updated_at: '2026-04-24T08:48:00Z',
    hub_code: 'DMM-C',
  },
  {
    id: 'zn_mec_haram',
    organization_id: 'org_rashed',
    name: 'Mecca Haram',
    slug: 'mec-haram',
    color_token: 'danger',
    is_active: true,
    status: 'active',
    description: 'Hajj-season congestion zone · last-mile partner required.',
    notes: 'Hajj-season congestion zone · last-mile partner required.',
    metadata: { lifecycle: 'active', color_token: 'danger' },
    created_at: '2026-03-09T08:00:00Z',
    updated_at: '2026-04-25T12:00:00Z',
    hub_code: 'JED-N',
  },
  {
    id: 'zn_mad_central',
    organization_id: 'org_rashed',
    name: 'Madinah Central',
    slug: 'mad-central',
    color_token: 'warn',
    is_active: false,
    status: 'draft',
    description: 'Draft proposal awaiting district mapping sign-off.',
    notes: 'Draft proposal awaiting district mapping sign-off.',
    metadata: { lifecycle: 'draft', color_token: 'warn' },
    created_at: '2026-04-15T08:00:00Z',
    updated_at: '2026-04-22T15:14:00Z',
    hub_code: 'JED-N',
  },
];

// ---------- zone_districts (mirrors public.zone_districts) -----------
//
// W17-2 — `role` dropped from rows. Canonical `public.zone_districts` is a
// pure (zone_id, canonical_district_id) link with no primary/secondary
// distinction. The drawer's district table renders linked-at instead of a
// role chip.
//
// W20 — added canonical `canonical_district_id` shadow alongside FE alias
// `district_id` (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §8). Resolver
// helper `zoneDistrictIdOf(row)` prefers canonical when present.
export const zone_districts = [
  // Riyadh North — Olaya, Sulaymaniyah, Malqa, Yasmin.
  { zone_id: 'zn_ruh_north', canonical_district_id: 'cd_ruh_olaya', district_id: 'cd_ruh_olaya', created_at: '2026-02-12T08:00:00Z' },
  { zone_id: 'zn_ruh_north', canonical_district_id: 'cd_ruh_sulaymaniyah', district_id: 'cd_ruh_sulaymaniyah', created_at: '2026-02-12T08:00:00Z' },
  { zone_id: 'zn_ruh_north', canonical_district_id: 'cd_ruh_malqa', district_id: 'cd_ruh_malqa', created_at: '2026-02-12T08:00:00Z' },
  { zone_id: 'zn_ruh_north', canonical_district_id: 'cd_ruh_yasmin', district_id: 'cd_ruh_yasmin', created_at: '2026-03-01T08:00:00Z' },
  // Riyadh South.
  { zone_id: 'zn_ruh_south', canonical_district_id: 'cd_ruh_aqiq', district_id: 'cd_ruh_aqiq', created_at: '2026-02-12T08:00:00Z' },
  { zone_id: 'zn_ruh_south', canonical_district_id: 'cd_ruh_hittin', district_id: 'cd_ruh_hittin', created_at: '2026-02-12T08:00:00Z' },
  { zone_id: 'zn_ruh_south', canonical_district_id: 'cd_ruh_nakheel', district_id: 'cd_ruh_nakheel', created_at: '2026-02-12T08:00:00Z' },
  // Diplomatic Quarter — single linked district.
  { zone_id: 'zn_ruh_diplomatic', canonical_district_id: 'cd_ruh_diplomatic', district_id: 'cd_ruh_diplomatic', created_at: '2026-03-04T08:00:00Z' },
  // Jeddah Coastal.
  { zone_id: 'zn_jed_north', canonical_district_id: 'cd_jed_corniche', district_id: 'cd_jed_corniche', created_at: '2026-02-18T08:00:00Z' },
  { zone_id: 'zn_jed_north', canonical_district_id: 'cd_jed_andalus', district_id: 'cd_jed_andalus', created_at: '2026-02-18T08:00:00Z' },
  { zone_id: 'zn_jed_north', canonical_district_id: 'cd_jed_zahra', district_id: 'cd_jed_zahra', created_at: '2026-02-18T08:00:00Z' },
  // Jeddah Heritage.
  { zone_id: 'zn_jed_south', canonical_district_id: 'cd_jed_balad', district_id: 'cd_jed_balad', created_at: '2026-02-18T08:00:00Z' },
  { zone_id: 'zn_jed_south', canonical_district_id: 'cd_jed_rawdah', district_id: 'cd_jed_rawdah', created_at: '2026-02-18T08:00:00Z' },
  // Dammam Central.
  { zone_id: 'zn_dmm_central', canonical_district_id: 'cd_dmm_shati', district_id: 'cd_dmm_shati', created_at: '2026-03-01T08:00:00Z' },
  { zone_id: 'zn_dmm_central', canonical_district_id: 'cd_dmm_faisaliyah', district_id: 'cd_dmm_faisaliyah', created_at: '2026-03-01T08:00:00Z' },
  { zone_id: 'zn_dmm_central', canonical_district_id: 'cd_kho_aqrabiyah', district_id: 'cd_kho_aqrabiyah', created_at: '2026-03-12T08:00:00Z' },
  // Mecca Haram.
  { zone_id: 'zn_mec_haram', canonical_district_id: 'cd_mec_aziziyah', district_id: 'cd_mec_aziziyah', created_at: '2026-03-09T08:00:00Z' },
  // Madinah Central (draft — single linked district).
  { zone_id: 'zn_mad_central', canonical_district_id: 'cd_mad_haram', district_id: 'cd_mad_haram', created_at: '2026-04-15T08:00:00Z' },
];

// ---------- zone_override_requests (mirrors public.zone_override_requests) ----
//
// W17-2 — top-level `change_kind` dropped. Canonical
// `public.zone_override_requests` has no `change_kind` column; the FE-
// historical kind label now lives inside `payload` (canonical metadata
// jsonb) under the `change_kind` key, alongside the rest of the request
// detail. The drawer reads it via `changeKindOf()` so the timeline label
// behavior stays identical.
//
// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §9):
//   • `requested_zone_id` ← canonical (FE alias `zone_id`)
//   • `requested_by`      ← canonical (FE alias `requested_by_user_id`)
//   • `metadata`          ← canonical (FE alias `payload`)
//   • `reviewed_at`       ← canonical (FE alias `decision_at`)
//   • `reviewed_by`       ← canonical (FE alias `decided_by_user_id`)
// Both shapes are seeded so the FE row resolvers (`overrideZoneIdOf` /
// `overrideRequestedByOf` / `overrideMetadataOf` / `overrideReviewedAtOf` /
// `overrideReviewedByOf`) hit the canonical path first while view-saved
// sorts/filters keyed on the FE aliases keep working.
export const zone_override_requests = [
  {
    id: 'zor_2901',
    zone_id: 'zn_ruh_north',
    requested_zone_id: 'zn_ruh_north',
    requested_by_user_id: 'usr_dr_khalid',
    requested_by: 'usr_dr_khalid',
    payload: { change_kind: 'add_district', district_id: 'cd_ruh_diplomatic', proposed_role: 'secondary', justification: 'Frequent embassy spillover stops' },
    metadata: { change_kind: 'add_district', district_id: 'cd_ruh_diplomatic', proposed_role: 'secondary', justification: 'Frequent embassy spillover stops' },
    status: 'pending',
    decision_at: null,
    reviewed_at: null,
    decided_by_user_id: null,
    reviewed_by: null,
    created_at: '2026-04-25T08:30:00Z',
  },
  {
    id: 'zor_2900',
    zone_id: 'zn_jed_south',
    requested_zone_id: 'zn_jed_south',
    requested_by_user_id: 'usr_admin_rashed',
    requested_by: 'usr_admin_rashed',
    payload: { change_kind: 'suspend_zone', reason: 'Traffic permit pending renewal · Q2-2026', expires_at: '2026-05-30' },
    metadata: { change_kind: 'suspend_zone', reason: 'Traffic permit pending renewal · Q2-2026', expires_at: '2026-05-30' },
    status: 'approved',
    decision_at: '2026-04-25T11:20:00Z',
    reviewed_at: '2026-04-25T11:20:00Z',
    decided_by_user_id: 'usr_admin_rashed',
    reviewed_by: 'usr_admin_rashed',
    created_at: '2026-04-25T09:48:00Z',
  },
  {
    id: 'zor_2899',
    zone_id: 'zn_dmm_central',
    requested_zone_id: 'zn_dmm_central',
    requested_by_user_id: 'usr_dr_tariq',
    requested_by: 'usr_dr_tariq',
    payload: { change_kind: 'remove_district', district_id: 'cd_kho_aqrabiyah', justification: 'Khobar coverage now owned by partner pool' },
    metadata: { change_kind: 'remove_district', district_id: 'cd_kho_aqrabiyah', justification: 'Khobar coverage now owned by partner pool' },
    status: 'pending',
    decision_at: null,
    reviewed_at: null,
    decided_by_user_id: null,
    reviewed_by: null,
    created_at: '2026-04-24T16:14:00Z',
  },
  {
    id: 'zor_2898',
    zone_id: 'zn_mec_haram',
    requested_zone_id: 'zn_mec_haram',
    requested_by_user_id: 'usr_admin_rashed',
    requested_by: 'usr_admin_rashed',
    payload: { change_kind: 'rename', from: 'Mecca Centre', to: 'Mecca Haram' },
    metadata: { change_kind: 'rename', from: 'Mecca Centre', to: 'Mecca Haram' },
    status: 'approved',
    decision_at: '2026-04-22T10:02:00Z',
    reviewed_at: '2026-04-22T10:02:00Z',
    decided_by_user_id: 'usr_admin_rashed',
    reviewed_by: 'usr_admin_rashed',
    created_at: '2026-04-22T09:55:00Z',
  },
  {
    id: 'zor_2897',
    zone_id: 'zn_ruh_south',
    requested_zone_id: 'zn_ruh_south',
    requested_by_user_id: 'usr_dr_yousef',
    requested_by: 'usr_dr_yousef',
    payload: { change_kind: 'reassign_role', district_id: 'cd_ruh_nakheel', from: 'secondary', to: 'primary' },
    metadata: { change_kind: 'reassign_role', district_id: 'cd_ruh_nakheel', from: 'secondary', to: 'primary' },
    status: 'denied',
    decision_at: '2026-04-21T14:42:00Z',
    reviewed_at: '2026-04-21T14:42:00Z',
    decided_by_user_id: 'usr_admin_rashed',
    reviewed_by: 'usr_admin_rashed',
    created_at: '2026-04-21T13:18:00Z',
  },
  {
    id: 'zor_2896',
    zone_id: 'zn_mad_central',
    requested_zone_id: 'zn_mad_central',
    requested_by_user_id: 'usr_admin_rashed',
    requested_by: 'usr_admin_rashed',
    payload: { change_kind: 'add_district', district_id: 'cd_mad_haram', proposed_role: 'primary', justification: 'Initial draft district mapping' },
    metadata: { change_kind: 'add_district', district_id: 'cd_mad_haram', proposed_role: 'primary', justification: 'Initial draft district mapping' },
    status: 'pending',
    decision_at: null,
    reviewed_at: null,
    decided_by_user_id: null,
    reviewed_by: null,
    created_at: '2026-04-25T07:42:00Z',
  },
];

// ---------- branch_zones (cross-reference) -----------
//
// W18-1 — the canonical `branch_zones` seed export now lives in
// `network-branches.js` (closes __audit__/DECISIONS/REGISTRY-ALIASES.md §2).
// That export uses the post-migration canonical `branches.id` form
// (`hub_ruh_n`, `hub_ruh_s`, …) which references the canonical `branches`
// roster in the same module — keeping FK integrity across the seed.
// The legacy `br_*`-keyed projection that previously lived here referenced
// branch IDs that did not exist in the canonical `branches` roster; the
// /network/zones drawer now reads the unified seed (with `branch_label`
// preserved per row) so no consumer change is required.

// ---------- Performance KPIs (additive synthetic projection) ----------
//
// The backend projection will be a `mv_zone_performance_v1` materialized view
// (shipments_today, deliveries_on_time_pct, capacity_saturation_pct, plus
// 7-day spark series). Until that lands the demo computes synthetic numbers
// keyed on zone id so the Performance tab renders deterministic values per
// zone without a network call.
export const zone_performance_metrics = {
  zn_ruh_north: {
    shipments_today: 184, shipments_week: 1243, on_time_pct: 0.94,
    capacity_saturation_pct: 0.71, spark_today: [12, 18, 22, 26, 31, 28, 24, 22],
    spark_week: [142, 188, 196, 174, 218, 230, 203],
  },
  zn_ruh_south: {
    shipments_today: 142, shipments_week: 904, on_time_pct: 0.91,
    capacity_saturation_pct: 0.58, spark_today: [9, 14, 19, 22, 24, 22, 18, 14],
    spark_week: [120, 142, 158, 122, 168, 188, 142],
  },
  zn_ruh_diplomatic: {
    shipments_today: 22, shipments_week: 156, on_time_pct: 0.97,
    capacity_saturation_pct: 0.42, spark_today: [2, 3, 4, 4, 3, 2, 2, 1],
    spark_week: [18, 22, 26, 28, 18, 22, 22],
  },
  zn_jed_north: {
    shipments_today: 168, shipments_week: 1127, on_time_pct: 0.92,
    capacity_saturation_pct: 0.68, spark_today: [11, 16, 22, 25, 26, 24, 22, 22],
    spark_week: [138, 162, 188, 142, 188, 178, 168],
  },
  zn_jed_south: {
    shipments_today: 0, shipments_week: 312, on_time_pct: 0.78,
    capacity_saturation_pct: 0.0, spark_today: [0, 0, 0, 0, 0, 0, 0, 0],
    spark_week: [62, 58, 48, 56, 42, 28, 18],
  },
  zn_dmm_central: {
    shipments_today: 96, shipments_week: 642, on_time_pct: 0.89,
    capacity_saturation_pct: 0.61, spark_today: [6, 11, 14, 16, 18, 14, 11, 6],
    spark_week: [88, 96, 102, 88, 106, 102, 96],
  },
  zn_mec_haram: {
    shipments_today: 38, shipments_week: 264, on_time_pct: 0.74,
    capacity_saturation_pct: 0.88, spark_today: [3, 4, 5, 6, 6, 5, 5, 4],
    spark_week: [32, 38, 44, 38, 42, 36, 34],
  },
  zn_mad_central: {
    shipments_today: 0, shipments_week: 0, on_time_pct: null,
    capacity_saturation_pct: 0.0, spark_today: [0, 0, 0, 0, 0, 0, 0, 0],
    spark_week: [0, 0, 0, 0, 0, 0, 0],
  },
};
