// catalog-offerings.js — CLAIM-CATALOG-OFFERINGS (Wave 2, Phase B) seed snapshot.
//
// Mirrors the canonical service catalog from
// supabase/migrations/202601212700_branch_capacity_catalog.sql:
//
//   public.service_levels
//     (id, organization_id, key, name, description, is_active, metadata jsonb,
//      created_at, updated_at)
//     UNIQUE (organization_id, key)
//
//   public.service_offerings
//     (id, service_level_id, branch_id, zone_id, effective_from, effective_to,
//      priority, is_active, metadata jsonb, created_at, updated_at)
//     INDEX on (branch_id, is_active), (service_level_id, is_active),
//           (zone_id, is_active) WHERE zone_id IS NOT NULL
//
// Write capability: `agreements.write` per
// supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql
// (RBAC gate `service_levels_write_policy` + `service_offerings_write_policy`).
// The orchestrator brief asked for `service_offerings.read` /
// `service_offerings.write` capability keys; both are added in registry.js as
// surface aliases gating the operator UI, but the canonical SSOT remains
// `agreements.write` (cited in writer flows below). Demo grants both so the
// surface still flows end-to-end.
//
// Operator-visible facets (price, sla, coverage, included_features, weight
// limits, currency) are stored in the **canonical `metadata` jsonb column** —
// the migration explicitly leaves `metadata` open for row-driven extension.
// Nothing fictional is added to the schema; the surface reads from `metadata.*`
// keys consistently so the same payload shape lands when the backend supplies
// real rows. This keeps the surface row-driven (zero hardcoded pricing tiers).
//
// Cross-references:
//   • Branch IDs (`hub_ruh_n`, `hub_jed_n`, `hub_dmm_c`, `hub_ruh_s`,
//     `branch_ruh_e`, `branch_jed_n`, `branch_med_c`, `dropoff_ruh_kfh`)
//     come from seed-raw/network-branches.js so service_offerings rows
//     resolve cleanly when the drawer renders branch coverage.
//   • Zone IDs (`zone_ruh_north`, `zone_jed_corniche` …) come from
//     seed-raw/network-zones.js for the optional zone-restricted offerings.

import { lookups } from './lookups.js';

// service_offering_status mirrors `public.service_offerings.is_active`
// (boolean) plus archived/draft chip tones used in the cards. The lookup
// catalog stays additive — fleet-vehicles.js / network-branches.js use the
// same Object.assign pattern so concurrent Wave 2 agents land additively.
//
// W61-Catalog+Customers closure: each row carries a canonical
// `metadata.lifecycle` token (`active`/`draft`/`terminal`) so the FE
// (`apps/console-v2/src/modules/catalog/service-offerings.tsx`) consumes
// lifecycle gating row-driven via `lookupRow('service_offering_status',
// value)?.metadata?.lifecycle` instead of inline string-literal compares
// against `'active'`/`'archived'`. AGENTS.md §2 (ZERO HARDCODING) + §6
// (row-driven by configuration).
Object.assign(lookups, {
  service_offering_status: [
    { value: 'active', label: 'Active', tone: 'good', rank: 10, is_default: true, metadata: { lifecycle: 'active' } },
    { value: 'draft', label: 'Draft', tone: 'info', rank: 20, metadata: { lifecycle: 'draft' } },
    { value: 'archived', label: 'Archived', tone: 'neutral', rank: 30, metadata: { lifecycle: 'terminal' } },
  ],
  // W71-Operate (Cycle F-R-11) closure — canonical
  // `service_offering_display_status` taxonomy. Mirrors the
  // `metadata.display.status` per-offering display token used to gate which
  // offerings appear in the create-shipment service select. Each row carries
  // `metadata.is_active_listing: true` for rows operators may pick during
  // create. The `_default` row (`is_default: true`) is `active` so callers
  // can resolve a default through `.find((r) => r.is_default)?.value`. When
  // an offering carries an unknown display status, the helper returns
  // null/false rather than synthesizing a literal default. AGENTS.md §2
  // (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven by configuration).
  service_offering_display_status: [
    { value: 'active',   label: 'Active',   tone: 'good',    rank: 10, is_default: true,  metadata: { is_active_listing: true } },
    { value: 'inactive', label: 'Inactive', tone: 'neutral', rank: 20, is_default: false, metadata: { is_active_listing: false } },
    { value: 'archived', label: 'Archived', tone: 'neutral', rank: 30, is_default: false, metadata: { is_active_listing: false } },
    { value: 'draft',    label: 'Draft',    tone: 'info',    rank: 40, is_default: false, metadata: { is_active_listing: false } },
  ],
  // W61-Catalog+Customers closure: canonical service_level_status SSOT lives
  // here (was previously in lookups.js). Each row carries a `metadata.lifecycle`
  // token so the FE Manage-levels chip + boolean→key mapping resolve via
  // `lookupRow('service_level_status', value)?.metadata?.lifecycle` rather than
  // inline `is_active ? 'active' : 'archived'` literals.
  service_level_status: [
    { value: 'active', label: 'active', tone: 'good', rank: 10, is_default: true, metadata: { lifecycle: 'active' } },
    { value: 'archived', label: 'archived', tone: 'neutral', rank: 20, metadata: { lifecycle: 'terminal' } },
  ],
  service_level_tier: [
    { value: 'economy', label: 'Economy', tone: 'neutral', rank: 10 },
    { value: 'standard', label: 'Standard', tone: 'info', rank: 20 },
    { value: 'express', label: 'Express', tone: 'good', rank: 30 },
    { value: 'same_day', label: 'Same day', tone: 'warn', rank: 40 },
    { value: 'white_glove', label: 'White glove', tone: 'danger', rank: 50 },
  ],
});

// ---------- service_levels (5 rows) ----------
// `key` is the lowercased stable per-org key the migration enforces. We
// expose it as the `slug` alias on the surface so existing call-sites that
// look up by slug keep working (NOT a new column — same canonical key field).
// `priority_rank` is reflected in `metadata.priority_rank` (display-only;
// canonical schema does not have a priority column on service_levels).
// `sla_minutes` is canonical metadata for promise/dispatch resolution.
// W50 closure — every service_level row carries an explicit `metadata.tone`
// token (canonical SSOT for the catalog tier badge). Replaces the inline
// `tierTone(rank)` magic-number ladder (>= 50/40/30/20) in
// `apps/console-v2/src/modules/catalog/service-offerings.tsx`. Backed by
// additive backend migration
// `202605020900_w51_service_levels_metadata_tone.sql` (UPSERT
// `service_levels.metadata->>'tone'` for canonical levels).
export const service_levels = [
  {
    id: 'svl_economy',
    organization_id: 'org_rashed',
    key: 'economy',
    name: 'Economy',
    description: 'Lowest-cost ground delivery within 3-5 working days. Suitable for non-urgent B2C parcels.',
    is_active: true,
    metadata: {
      tier: 'economy',
      priority_rank: 10,
      sla_minutes: 5760, // 4 days
      sla_label: '3-5 working days',
      color_token: 'neutral',
      tone: 'neutral',
    },
    created_at: '2025-09-01T08:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'svl_standard',
    organization_id: 'org_rashed',
    key: 'standard',
    name: 'Standard',
    description: 'Standard ground delivery, next-business-day across the metropolitan footprint.',
    is_active: true,
    metadata: {
      tier: 'standard',
      priority_rank: 20,
      sla_minutes: 1440, // 24h
      sla_label: 'Next business day',
      color_token: 'info',
      tone: 'info',
    },
    created_at: '2025-09-01T08:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'svl_express',
    organization_id: 'org_rashed',
    key: 'express',
    name: 'Express',
    description: 'Express delivery within 6 hours. Air-bridge between Riyadh, Jeddah, and Dammam.',
    is_active: true,
    metadata: {
      tier: 'express',
      priority_rank: 30,
      sla_minutes: 360, // 6h
      sla_label: '6h promise',
      color_token: 'good',
      tone: 'good',
    },
    created_at: '2025-09-01T08:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'svl_same_day',
    organization_id: 'org_rashed',
    key: 'same_day',
    name: 'Same day',
    description: 'Within-city same-day delivery. Pickup before 11:00, delivery before 19:00.',
    is_active: true,
    metadata: {
      tier: 'same_day',
      priority_rank: 40,
      sla_minutes: 480, // 8h
      sla_label: 'Same day before 19:00',
      color_token: 'warn',
      tone: 'warn',
    },
    created_at: '2025-09-01T08:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'svl_white_glove',
    organization_id: 'org_rashed',
    key: 'white_glove',
    name: 'White glove',
    description: 'Concierge handling for high-value items. 2-person crew, in-room placement, scheduled window.',
    is_active: true,
    metadata: {
      tier: 'white_glove',
      priority_rank: 50,
      sla_minutes: 240, // 4h scheduled window
      sla_label: '4h scheduled window',
      color_token: 'danger',
      tone: 'danger',
    },
    created_at: '2025-09-01T08:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
];

// ---------- service_offerings (10 rows) ----------
// All `display.*` fields live in `metadata` jsonb (not new columns). The
// surface layer reads them via `row.metadata.display.*`. Pricing breakpoints
// are stored under `metadata.pricing_breakpoints` per the orchestrator brief
// — also row-driven, not hardcoded.
export const service_offerings = [
  {
    id: 'sof_eco_kingdom',
    service_level_id: 'svl_economy',
    branch_id: 'hub_ruh_n',
    zone_id: null,
    effective_from: '2025-10-01T00:00:00Z',
    effective_to: null,
    priority: 10,
    is_active: true,
    metadata: {
      display: {
        name: 'Kingdom Economy',
        slug: 'kingdom-economy',
        status: 'active',
      },
      base_price: 14.0,
      currency: 'SAR',
      max_weight_kg: 10,
      included_features: [
        'Real-time tracking',
        'SMS notification',
        'Pickup from any major city',
      ],
      pricing_breakpoints: [
        { up_to_kg: 1, price: 14.0 },
        { up_to_kg: 5, price: 22.0 },
        { up_to_kg: 10, price: 36.0 },
      ],
      coverage_summary: 'Kingdom-wide ground network',
      active_subscriptions_count: 412,
    },
    created_at: '2025-10-01T00:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'sof_eco_central',
    service_level_id: 'svl_economy',
    branch_id: 'hub_ruh_s',
    zone_id: 'zn_ruh_central',
    effective_from: '2025-10-01T00:00:00Z',
    effective_to: null,
    priority: 20,
    is_active: true,
    metadata: {
      display: {
        name: 'Central Economy',
        slug: 'central-economy',
        status: 'active',
      },
      base_price: 11.0,
      currency: 'SAR',
      max_weight_kg: 5,
      included_features: ['Real-time tracking', 'SMS notification'],
      pricing_breakpoints: [
        { up_to_kg: 1, price: 11.0 },
        { up_to_kg: 5, price: 18.0 },
      ],
      coverage_summary: 'Riyadh central districts only',
      active_subscriptions_count: 87,
    },
    created_at: '2025-10-01T00:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'sof_std_metro',
    service_level_id: 'svl_standard',
    branch_id: 'hub_ruh_n',
    zone_id: null,
    effective_from: '2025-10-01T00:00:00Z',
    effective_to: null,
    priority: 10,
    is_active: true,
    metadata: {
      display: {
        name: 'Metro Standard',
        slug: 'metro-standard',
        status: 'active',
      },
      base_price: 22.0,
      currency: 'SAR',
      max_weight_kg: 15,
      included_features: [
        'Real-time tracking',
        'SMS + WhatsApp notification',
        'Driver photo at delivery',
        'Insurance up to 500 SAR',
      ],
      pricing_breakpoints: [
        { up_to_kg: 1, price: 22.0 },
        { up_to_kg: 5, price: 28.0 },
        { up_to_kg: 10, price: 42.0 },
        { up_to_kg: 15, price: 58.0 },
      ],
      coverage_summary: 'Metro Riyadh + Jeddah + Dammam',
      active_subscriptions_count: 1284,
    },
    created_at: '2025-10-01T00:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'sof_std_west',
    service_level_id: 'svl_standard',
    branch_id: 'hub_jed_n',
    zone_id: null,
    effective_from: '2025-10-01T00:00:00Z',
    effective_to: null,
    priority: 20,
    is_active: true,
    metadata: {
      display: {
        name: 'Western Standard',
        slug: 'western-standard',
        status: 'active',
      },
      base_price: 24.0,
      currency: 'SAR',
      max_weight_kg: 15,
      included_features: [
        'Real-time tracking',
        'SMS + WhatsApp notification',
        'Cash on delivery',
      ],
      pricing_breakpoints: [
        { up_to_kg: 1, price: 24.0 },
        { up_to_kg: 5, price: 32.0 },
        { up_to_kg: 15, price: 64.0 },
      ],
      coverage_summary: 'Western Region (Jeddah, Mecca, Madinah)',
      active_subscriptions_count: 562,
    },
    created_at: '2025-10-01T00:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'sof_exp_airbridge',
    service_level_id: 'svl_express',
    branch_id: 'hub_ruh_n',
    zone_id: null,
    effective_from: '2025-11-01T00:00:00Z',
    effective_to: null,
    priority: 10,
    is_active: true,
    metadata: {
      display: {
        name: 'Air-Bridge Express',
        slug: 'air-bridge-express',
        status: 'active',
      },
      base_price: 75.0,
      currency: 'SAR',
      max_weight_kg: 20,
      included_features: [
        '6-hour delivery promise',
        'Real-time GPS tracking',
        'Insurance up to 5000 SAR',
        'Priority lane at hub',
        'WhatsApp + voice notifications',
      ],
      pricing_breakpoints: [
        { up_to_kg: 1, price: 75.0 },
        { up_to_kg: 5, price: 110.0 },
        { up_to_kg: 10, price: 165.0 },
        { up_to_kg: 20, price: 250.0 },
      ],
      coverage_summary: 'Riyadh ↔ Jeddah ↔ Dammam air corridors',
      active_subscriptions_count: 198,
    },
    created_at: '2025-11-01T00:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'sof_exp_metro_jed',
    service_level_id: 'svl_express',
    branch_id: 'hub_jed_n',
    zone_id: 'zn_jed_corniche',
    effective_from: '2025-11-01T00:00:00Z',
    effective_to: null,
    priority: 20,
    is_active: true,
    metadata: {
      display: {
        name: 'Jeddah Metro Express',
        slug: 'jeddah-metro-express',
        status: 'active',
      },
      base_price: 55.0,
      currency: 'SAR',
      max_weight_kg: 12,
      included_features: [
        '6-hour delivery promise',
        'Real-time GPS tracking',
        'Insurance up to 2500 SAR',
      ],
      pricing_breakpoints: [
        { up_to_kg: 1, price: 55.0 },
        { up_to_kg: 5, price: 80.0 },
        { up_to_kg: 12, price: 130.0 },
      ],
      coverage_summary: 'Jeddah Corniche + Andalus districts',
      active_subscriptions_count: 76,
    },
    created_at: '2025-11-01T00:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'sof_sd_ruh',
    service_level_id: 'svl_same_day',
    branch_id: 'hub_ruh_n',
    zone_id: null,
    effective_from: '2025-12-01T00:00:00Z',
    effective_to: null,
    priority: 10,
    is_active: true,
    metadata: {
      display: {
        name: 'Riyadh Same-Day',
        slug: 'riyadh-same-day',
        status: 'active',
      },
      base_price: 45.0,
      currency: 'SAR',
      max_weight_kg: 8,
      included_features: [
        'Pickup before 11:00, delivery before 19:00',
        'WhatsApp tracking link',
        'Photo proof of delivery',
      ],
      pricing_breakpoints: [
        { up_to_kg: 1, price: 45.0 },
        { up_to_kg: 4, price: 60.0 },
        { up_to_kg: 8, price: 95.0 },
      ],
      coverage_summary: 'Riyadh metropolitan area',
      active_subscriptions_count: 244,
    },
    created_at: '2025-12-01T00:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'sof_sd_jed',
    service_level_id: 'svl_same_day',
    branch_id: 'hub_jed_n',
    zone_id: null,
    effective_from: '2025-12-15T00:00:00Z',
    effective_to: null,
    priority: 20,
    is_active: true,
    metadata: {
      display: {
        name: 'Jeddah Same-Day',
        slug: 'jeddah-same-day',
        status: 'active',
      },
      base_price: 48.0,
      currency: 'SAR',
      max_weight_kg: 8,
      included_features: [
        'Pickup before 11:00, delivery before 19:00',
        'WhatsApp tracking link',
      ],
      pricing_breakpoints: [
        { up_to_kg: 1, price: 48.0 },
        { up_to_kg: 4, price: 65.0 },
        { up_to_kg: 8, price: 100.0 },
      ],
      coverage_summary: 'Jeddah metropolitan area',
      active_subscriptions_count: 132,
    },
    created_at: '2025-12-15T00:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'sof_wg_ruh',
    service_level_id: 'svl_white_glove',
    branch_id: 'hub_ruh_n',
    zone_id: null,
    effective_from: '2026-02-01T00:00:00Z',
    effective_to: null,
    priority: 10,
    is_active: true,
    metadata: {
      display: {
        name: 'White Glove · Riyadh',
        slug: 'white-glove-riyadh',
        status: 'active',
      },
      base_price: 250.0,
      currency: 'SAR',
      max_weight_kg: 80,
      included_features: [
        '2-person crew',
        'Scheduled 4-hour window',
        'In-room placement',
        'Packaging removal',
        'Insurance up to 50,000 SAR',
        'Concierge support hotline',
      ],
      pricing_breakpoints: [
        { up_to_kg: 25, price: 250.0 },
        { up_to_kg: 50, price: 380.0 },
        { up_to_kg: 80, price: 520.0 },
      ],
      coverage_summary: 'Riyadh metropolitan area',
      active_subscriptions_count: 28,
    },
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-03-21T11:14:00Z',
  },
  {
    id: 'sof_legacy_zone_pilot',
    service_level_id: 'svl_economy',
    branch_id: 'hub_dmm_c',
    zone_id: null,
    effective_from: '2024-08-01T00:00:00Z',
    effective_to: '2026-01-31T23:59:59Z',
    priority: 30,
    is_active: false,
    metadata: {
      display: {
        name: 'Eastern Pilot · Economy',
        slug: 'eastern-pilot-economy',
        status: 'archived',
      },
      base_price: 12.0,
      currency: 'SAR',
      max_weight_kg: 5,
      included_features: ['Real-time tracking'],
      pricing_breakpoints: [{ up_to_kg: 5, price: 12.0 }],
      coverage_summary: 'Dammam pilot — superseded by Kingdom Economy',
      active_subscriptions_count: 0,
      retired_reason: 'Folded into sof_eco_kingdom on 2026-02-01',
    },
    created_at: '2024-08-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
  },
];
