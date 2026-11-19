-- 202605020400_w46_canonical_lookup_tone_seeds.sql — backend mirror for the
-- W24b FE seed expansion (apps/console-v2/src/lib/seed-raw/lookups.js#W24b).
--
-- The console-v2 FE just removed all inline `*_TONE: Record<...>` and
-- `*_LABEL: Record<...>` maps in favor of strict consumption from
-- `lookup_values.metadata.tone` / `lookup_values.label`. This migration is
-- the canonical SSOT for those rows in any deployed environment so the
-- "no fallbacks" contract holds end-to-end (FE seed mirror + DB seed
-- match exactly).
--
-- AGENTS.md alignment:
--   §1 SIMPLE/SCALABLE/DYNAMIC — one migration per category cluster, all
--      idempotent (ON CONFLICT DO UPDATE). Adding a new chip-toned status
--      anywhere in console-v2 is one INSERT pair, no FE source change.
--   §2 ZERO HARDCODING — every tone/label the FE renders has a canonical
--      row here; the FE renders a danger-toned `(missing)` chip when the
--      row is absent (no silent neutral fallback).
--   §3 ROW-DRIVEN — adding/removing values is a row mutation; FE picks
--      it up automatically via `lookupRow(...)`.
--   §4 SSOT — three-way SSOT: this file ↔ FE seed-raw/lookups.js ↔
--      console-v2 modules.
--   §5 APPEND-ONLY — new file; W17 (202605020100_w43_*) untouched.
--   §10 NO WORKAROUNDS — strict canonical row ⇒ visible gap on missing.
--
-- Categories added (17): branch_type, branch_status, branch_role,
-- marketplace_offer_status, marketplace_award_status,
-- marketplace_contract_status, marketplace_request_status,
-- marketplace_participant_request_status, partner_compliance_status,
-- partner_listing_status, zone_status, zone_override_status,
-- zone_change_kind, zone_color_token, address_validation_status,
-- geocoding_attempt_status, webhook_rule_domain,
-- billing_invoice_event_type.
--
-- Metadata enrichment: support_case_status gains `lifecycle` metadata
-- (open|resolved|canceled) so the FE's lifecycle filters partition
-- statuses canonically rather than by inline FALLBACK arrays.

-- ---------------------------------------------------------------------------
-- 1. lookup_definitions — system-scope, append-only category catalog
-- ---------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (
  category, description, owner_role, approval_policy, is_mutable,
  organization_id, scope_type
)
VALUES
  ('branch_type',
   'Branch type taxonomy (hub/satellite/drop_off/counter); FE renders chip color from metadata.tone.',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('branch_status',
   'Branch lifecycle status (active/oos/inactive); chip tone via metadata.tone.',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('branch_role',
   'Branch role within the network (canonical_hub/regional/local/satellite).',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('marketplace_offer_status',
   'Marketplace offer status taxonomy.',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('marketplace_award_status',
   'Marketplace award status taxonomy.',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('marketplace_contract_status',
   'Marketplace contract status taxonomy.',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('marketplace_request_status',
   'Marketplace request status taxonomy.',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('marketplace_participant_request_status',
   'Marketplace participant request status taxonomy.',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('partner_compliance_status',
   'Partner compliance status (KYC/contract/regulatory).',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('partner_listing_status',
   'Partner listing visibility status (listed/unlisted/blacklisted).',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('zone_status',
   'Zone lifecycle status (active/paused/archived).',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('zone_override_status',
   'Zone override approval status (pending/approved/rejected/expired).',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('zone_change_kind',
   'Zone change-history event kind (created/district_added/etc.).',
   'operations', 'tier_2', TRUE, NULL, 'global'),
  ('zone_color_token',
   'Zone map-color tokens (sky/emerald/amber/rose/slate).',
   'operations', 'tier_1', TRUE, NULL, 'global'),
  ('address_validation_status',
   'Address validation result status.',
   'engineering', 'tier_2', TRUE, NULL, 'global'),
  ('geocoding_attempt_status',
   'Geocoding attempt outcome (success/failure/pending/rate_limited).',
   'engineering', 'tier_2', TRUE, NULL, 'global'),
  ('webhook_rule_domain',
   'Webhook rule domain category (shipment/route/cod/webhook/integration).',
   'engineering', 'tier_2', TRUE, NULL, 'global'),
  ('billing_invoice_event_type',
   'Billing invoice event type (created/sent/paid/overdue/refunded/cancelled/disputed).',
   'finance', 'tier_2', TRUE, NULL, 'global')
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. lookup_values — one upsert per category, ON CONFLICT (lookup_definition_id, value)
-- ---------------------------------------------------------------------------
-- Pattern mirrors W17 (202605020100_w43_*): CROSS JOIN against
-- lookup_definitions to avoid hardcoding UUIDs; use VALUES (...) to keep
-- each category's row set scannable.

-- branch_type
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('hub',       'Hub',       10, '{"tone":"info"}'),
  ('satellite', 'Satellite', 20, '{"tone":"good"}'),
  ('drop_off',  'Drop-off',  30, '{"tone":"neutral"}'),
  ('counter',   'Counter',   40, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'branch_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- branch_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active',   'Active',   10, '{"tone":"good"}'),
  ('oos',      'OOS',      20, '{"tone":"warn"}'),
  ('inactive', 'Inactive', 30, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'branch_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- branch_role
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('canonical_hub', 'Canonical hub', 10, '{"tone":"good"}'),
  ('regional',      'Regional',      20, '{"tone":"info"}'),
  ('local',         'Local',         30, '{"tone":"neutral"}'),
  ('satellite',     'Satellite',     40, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'branch_role'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- marketplace_offer_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('open',      'Open',      10, '{"tone":"info"}'),
  ('awarded',   'Awarded',   20, '{"tone":"good"}'),
  ('declined',  'Declined',  30, '{"tone":"warn"}'),
  ('expired',   'Expired',   40, '{"tone":"neutral"}'),
  ('withdrawn', 'Withdrawn', 50, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'marketplace_offer_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- marketplace_award_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('pending',  'Pending',  10, '{"tone":"info"}'),
  ('accepted', 'Accepted', 20, '{"tone":"good"}'),
  ('declined', 'Declined', 30, '{"tone":"warn"}'),
  ('revoked',  'Revoked',  40, '{"tone":"danger"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'marketplace_award_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- marketplace_contract_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('draft',    'Draft',    10, '{"tone":"neutral"}'),
  ('active',   'Active',   20, '{"tone":"good"}'),
  ('paused',   'Paused',   30, '{"tone":"warn"}'),
  ('closed',   'Closed',   40, '{"tone":"neutral"}'),
  ('breached', 'Breached', 50, '{"tone":"danger"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'marketplace_contract_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- marketplace_request_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('draft',     'Draft',     10, '{"tone":"neutral"}'),
  ('published', 'Published', 20, '{"tone":"info"}'),
  ('awarded',   'Awarded',   30, '{"tone":"good"}'),
  ('cancelled', 'Cancelled', 40, '{"tone":"neutral"}'),
  ('expired',   'Expired',   50, '{"tone":"warn"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'marketplace_request_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- marketplace_participant_request_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('pending',   'Pending',   10, '{"tone":"info"}'),
  ('approved',  'Approved',  20, '{"tone":"good"}'),
  ('rejected',  'Rejected',  30, '{"tone":"danger"}'),
  ('withdrawn', 'Withdrawn', 40, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'marketplace_participant_request_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- partner_compliance_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('compliant',     'Compliant',     10, '{"tone":"good"}'),
  ('expiring_soon', 'Expiring soon', 20, '{"tone":"warn"}'),
  ('expired',       'Expired',       30, '{"tone":"danger"}'),
  ('pending_kyc',   'Pending KYC',   40, '{"tone":"info"}'),
  ('rejected',      'Rejected',      50, '{"tone":"danger"}'),
  ('suspended',     'Suspended',     60, '{"tone":"danger"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'partner_compliance_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- partner_listing_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('listed',      'Listed',      10, '{"tone":"good"}'),
  ('unlisted',    'Unlisted',    20, '{"tone":"neutral"}'),
  ('blacklisted', 'Blacklisted', 30, '{"tone":"danger"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'partner_listing_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- zone_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active',   'Active',   10, '{"tone":"good"}'),
  ('paused',   'Paused',   20, '{"tone":"warn"}'),
  ('archived', 'Archived', 30, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'zone_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- zone_override_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('pending',  'Pending',  10, '{"tone":"info"}'),
  ('approved', 'Approved', 20, '{"tone":"good"}'),
  ('rejected', 'Rejected', 30, '{"tone":"danger"}'),
  ('expired',  'Expired',  40, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'zone_override_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- zone_change_kind
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('created',          'Created',          10, '{"tone":"good"}'),
  ('district_added',   'District added',   20, '{"tone":"info"}'),
  ('district_removed', 'District removed', 30, '{"tone":"warn"}'),
  ('archived',         'Archived',         40, '{"tone":"neutral"}'),
  ('override_applied', 'Override applied', 50, '{"tone":"info"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'zone_change_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- zone_color_token
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('sky',     'Sky',     10, '{"tone":"info"}'),
  ('emerald', 'Emerald', 20, '{"tone":"good"}'),
  ('amber',   'Amber',   30, '{"tone":"warn"}'),
  ('rose',    'Rose',    40, '{"tone":"danger"}'),
  ('slate',   'Slate',   50, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'zone_color_token'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- address_validation_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('valid',           'Valid',           10, '{"tone":"good"}'),
  ('invalid',         'Invalid',         20, '{"tone":"danger"}'),
  ('requires_review', 'Requires review', 30, '{"tone":"warn"}'),
  ('needs_review',    'Requires review', 35, '{"tone":"warn"}'),
  ('pending',         'Pending',         40, '{"tone":"info"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'address_validation_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- geocoding_attempt_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('success',      'Success',      10, '{"tone":"good"}'),
  ('failure',      'Failure',      20, '{"tone":"danger"}'),
  ('pending',      'Pending',      30, '{"tone":"info"}'),
  ('rate_limited', 'Rate limited', 40, '{"tone":"warn"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'geocoding_attempt_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- webhook_rule_domain
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('shipment',    'Shipment',    10, '{"tone":"info"}'),
  ('route',       'Route',       20, '{"tone":"info"}'),
  ('cod',         'COD',         30, '{"tone":"good"}'),
  ('webhook',     'Webhook',     40, '{"tone":"neutral"}'),
  ('integration', 'Integration', 50, '{"tone":"neutral"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'webhook_rule_domain'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- billing_invoice_event_type
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('created',   'Created',   10, '{"tone":"info"}'),
  ('sent',      'Sent',      20, '{"tone":"good"}'),
  ('paid',      'Paid',      30, '{"tone":"good"}'),
  ('overdue',   'Overdue',   40, '{"tone":"warn"}'),
  ('refunded',  'Refunded',  50, '{"tone":"neutral"}'),
  ('cancelled', 'Cancelled', 60, '{"tone":"neutral"}'),
  ('disputed',  'Disputed',  70, '{"tone":"danger"}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'billing_invoice_event_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---------------------------------------------------------------------------
-- 3. Metadata enrichment — support_case_status.lifecycle
-- ---------------------------------------------------------------------------
-- W17 seeded support_case_status values without `lifecycle`. The FE's
-- canonical lifecycle filter (Open vs Resolved queue partitioning) reads
-- `metadata.lifecycle` so the partition stays row-driven instead of
-- depending on FE-side OPEN_STATUS_FALLBACK / RESOLVED_STATUS_FALLBACK.

UPDATE public.lookup_values
SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lifecycle}', to_jsonb(v.lifecycle::text), true),
    updated_at = now()
FROM (VALUES
  ('open',        'open'),
  ('in_progress', 'open'),
  ('resolved',    'resolved'),
  ('closed',      'resolved'),
  ('canceled',    'canceled')
) AS v(value, lifecycle)
WHERE lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'support_case_status')
  AND public.lookup_values.value = v.value
  AND COALESCE(public.lookup_values.metadata->>'lifecycle', '') IS DISTINCT FROM v.lifecycle;
