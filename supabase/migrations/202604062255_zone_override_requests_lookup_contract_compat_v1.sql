-- Plan: B04 UC062 zone override approval / Step: E01
-- Migration: zone_override_requests lookup contract compat
-- Date: 2026-04-06
--
-- Purpose:
--   - Replace literal-list enum CHECK enforcement on zone_override_requests.status.
--   - Bind status/resolution_outcome through lookup_definitions + lookup_values +
--     lookup_column_contracts so the contract stays row-driven.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604062255_zone_override_requests_lookup_contract_compat_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('zone_override_request_status', 'Zone override request lifecycle status', 'operations', 'tier_1', TRUE),
  ('zone_override_request_resolution_outcome', 'Zone override request review outcome', 'operations', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('pending',   'Pending',   'Awaiting review/decision',                     10, TRUE,  '{"is_open": true}' ),
  ('approved',  'Approved',  'Approved and ready for application',           20, FALSE, '{"is_open": true}' ),
  ('rejected',  'Rejected',  'Rejected during review',                       30, FALSE, '{"is_final": true}' ),
  ('applied',   'Applied',   'Approved override applied to shipment/ledger', 40, FALSE, '{"is_final": true}' ),
  ('failed',    'Failed',    'Workflow/application failed',                  50, FALSE, '{"is_final": true}' ),
  ('cancelled', 'Cancelled', 'Request cancelled before completion',          60, FALSE, '{"is_final": true}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'zone_override_request_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('approved', 'Approved', 'Manual review approved the override request', 10, FALSE, '{}' ),
  ('rejected', 'Rejected', 'Manual review rejected the override request', 20, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'zone_override_request_resolution_outcome'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

ALTER TABLE public.zone_override_requests
  DROP CONSTRAINT IF EXISTS zone_override_requests_status_check;

COMMENT ON COLUMN public.zone_override_requests.status IS
  'Lookup category: zone_override_request_status.';

COMMENT ON COLUMN public.zone_override_requests.resolution_outcome IS
  'Lookup category: zone_override_request_resolution_outcome.';

INSERT INTO public.lookup_column_contracts (
  table_schema,
  table_name,
  column_name,
  lookup_category
)
VALUES
  ('public', 'zone_override_requests', 'status', 'zone_override_request_status'),
  ('public', 'zone_override_requests', 'resolution_outcome', 'zone_override_request_resolution_outcome')
ON CONFLICT (table_schema, table_name, column_name) DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

SELECT pg_advisory_unlock(hashtext('202604062255_zone_override_requests_lookup_contract_compat_v1'));
COMMIT;
