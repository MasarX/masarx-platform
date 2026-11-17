-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Delivery attempt/NDR metadata primitives v1 (lookups + scan_policy schema extension)
-- Date: 2026-01-31
--
-- Goals:
--   - Add SSOT lookup categories for standardized delivery attempt outcomes/reasons and NDR actions.
--   - Extend scan_policy JSON schema (v1) to allow a contract-driven delivery_attempt section (no behavior hardcoding).
--   - Keep enforcement in RPC/workflows policy-driven (out of scope here); this is structure-only.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311840_attempt_metadata_lookups_scan_policy_schema_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookups (row-driven enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('attempt_outcome', 'Delivery attempt outcomes (standardized keys for analytics + workflows)', 'dispatch', 'tier_1', TRUE)
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
  ('delivered',        'Delivered',        'Attempt succeeded; delivered', 10, TRUE,  '{}' ),
  ('not_delivered',    'Not Delivered',    'Attempt failed; not delivered', 20, FALSE, '{}' ),
  ('partial_delivery', 'Partial Delivery', 'Attempt partially completed', 30, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'attempt_outcome'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('attempt_reason', 'Delivery attempt reasons (NDR reasons; standardized keys)', 'dispatch', 'tier_1', TRUE)
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
  ('customer_not_available', 'Customer Not Available', 'Recipient not reachable / not present', 10, TRUE,  '{}' ),
  ('customer_refused',       'Customer Refused',       'Recipient refused delivery', 20, FALSE, '{}' ),
  ('address_issue',          'Address Issue',          'Address incorrect / cannot locate', 30, FALSE, '{}' ),
  ('access_restricted',      'Access Restricted',      'Gated / no access / security restriction', 40, FALSE, '{}' ),
  ('damaged',                'Damaged',                'Package damaged; cannot deliver', 50, FALSE, '{}' ),
  ('other',                  'Other',                  'Other/unspecified reason', 99, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'attempt_reason'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('ndr_action', 'NDR action outcomes (reattempt/reschedule/RTO/hold/etc.)', 'dispatch', 'tier_1', TRUE)
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
  ('reattempt',      'Reattempt',      'Try delivery again', 10, TRUE,  '{}' ),
  ('reschedule',     'Reschedule',     'Reschedule delivery window', 20, FALSE, '{}' ),
  ('hold_at_branch', 'Hold at Branch', 'Hold for pickup at branch/locker', 30, FALSE, '{}' ),
  ('return_to_sender','Return to Sender','Return to sender (RTO)', 40, FALSE, '{}' ),
  ('cancel',         'Cancel',         'Cancel delivery / close', 90, FALSE, '{"is_final":true}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'ndr_action'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Extend scan_policy schema_registry (v1) to allow delivery_attempt contract block
-------------------------------------------------------------------------------

UPDATE public.schema_registry
SET
  schema = jsonb_set(
    schema,
    '{properties,delivery_attempt}',
    jsonb_build_object(
      'type', jsonb_build_array('object','null'),
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'required_metadata_keys', jsonb_build_object('type', jsonb_build_array('array','null'), 'items', jsonb_build_object('type', 'string')),
        'allowed_outcomes', jsonb_build_object('type', jsonb_build_array('array','null'), 'items', jsonb_build_object('type', 'string')),
        'allowed_reasons', jsonb_build_object('type', jsonb_build_array('array','null'), 'items', jsonb_build_object('type', 'string')),
        'allowed_ndr_actions', jsonb_build_object('type', jsonb_build_array('array','null'), 'items', jsonb_build_object('type', 'string')),
        'require_artifact', jsonb_build_object('type', jsonb_build_array('boolean','null')),
        'require_coordinates', jsonb_build_object('type', jsonb_build_array('boolean','null'))
      )
    ),
    TRUE
  ),
  description = COALESCE(description, '') || ' (v1 extended: optional delivery_attempt contract block for NDR standardization.)',
  updated_at = now()
WHERE category = 'scan_policy' AND version = 1;

-- Best-effort: append an example if examples is an array.
UPDATE public.schema_registry
SET
  examples = CASE
    WHEN jsonb_typeof(examples) = 'array' THEN
      examples || jsonb_build_array(
        jsonb_build_object(
          'version', 1,
          'enabled', TRUE,
          'accepted_scan_types', jsonb_build_array('pickup','sort','load','unload','delivery_attempt','delivered'),
          'enqueue_domain_event', FALSE,
          'delivery_attempt', jsonb_build_object(
            'required_metadata_keys', jsonb_build_array('attempt_outcome', 'attempt_reason', 'ndr_action'),
            'allowed_outcomes', jsonb_build_array('delivered','not_delivered','partial_delivery'),
            'allowed_reasons', jsonb_build_array('customer_not_available','customer_refused','address_issue','access_restricted','damaged','other'),
            'allowed_ndr_actions', jsonb_build_array('reattempt','reschedule','hold_at_branch','return_to_sender','cancel'),
            'require_coordinates', TRUE
          )
        )
      )
    ELSE examples
  END,
  updated_at = now()
WHERE category = 'scan_policy' AND version = 1;

SELECT pg_advisory_unlock(hashtext('202601311840_attempt_metadata_lookups_scan_policy_schema_v1'));
COMMIT;

