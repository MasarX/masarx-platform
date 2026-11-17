-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Dispatch exception taxonomy + standard task types (row-driven)
-- Date: 2026-01-24
--
-- Why:
--   - Enterprise last-mile ops needs a canonical exception taxonomy (reason codes) so mobile + ops + BI speak the same language.
--   - Dispatch stop policies already support outcome_reason -> follow-up tasks; standardize reason codes + provide standard task types.
--   - Keep it row-driven: reasons live in lookup_values, tasks live in task_type_catalog settings (ladder-resolved).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601242000_dispatch_exception_taxonomy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Canonical exception taxonomy (reason codes) via lookup tables (SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'dispatch_exception_reason',
  'Canonical dispatch exception reason codes for last-mile stop outcomes and exception handling workflows.',
  'dispatch',
  'tier_1',
  TRUE
)
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
  ('no_answer', 'No Answer', 'Recipient did not answer / not available at delivery time', 10, TRUE, '{"recommended_followup_task_type_key":"dispatch_exception_review","class":"customer"}'),
  ('customer_refused', 'Customer Refused', 'Recipient refused the shipment', 20, FALSE, '{"recommended_followup_task_type_key":"dispatch_rto_pickup","class":"customer"}'),
  ('address_not_found', 'Address Not Found', 'Driver could not locate the address', 30, FALSE, '{"recommended_followup_task_type_key":"dispatch_reschedule_delivery","class":"address"}'),
  ('address_incorrect', 'Incorrect Address', 'Address is incorrect / incomplete', 40, FALSE, '{"recommended_followup_task_type_key":"dispatch_reschedule_delivery","class":"address"}'),
  ('phone_unreachable', 'Phone Unreachable', 'Recipient phone off / unreachable', 50, FALSE, '{"recommended_followup_task_type_key":"dispatch_exception_review","class":"customer"}'),
  ('payment_issue', 'Payment Issue', 'COD payment issue (insufficient cash / card issues)', 60, FALSE, '{"recommended_followup_task_type_key":"dispatch_exception_review","class":"payment"}'),
  ('package_damaged', 'Package Damaged', 'Package damaged / leaking / unsafe to deliver', 70, FALSE, '{"recommended_followup_task_type_key":"dispatch_exception_review","class":"package"}'),
  ('package_lost', 'Package Lost', 'Package lost / missing during route execution', 80, FALSE, '{"recommended_followup_task_type_key":"dispatch_exception_review","class":"package"}'),
  ('business_closed', 'Business Closed', 'Recipient business location was closed', 90, FALSE, '{"recommended_followup_task_type_key":"dispatch_reschedule_delivery","class":"customer"}'),
  ('other', 'Other', 'Other / unspecified exception reason', 999, FALSE, '{"recommended_followup_task_type_key":"dispatch_exception_review","class":"other"}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'dispatch_exception_reason'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) route_stop_kind lookup alignment (avoid hidden stop_kind values)
-------------------------------------------------------------------------------

-- Some policies historically referenced stop_kind=return_to_origin. Keep it as an explicit alias entry
-- so UI/config can see it (without forcing any workflow changes).
INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  'return_to_origin',
  'Return To Origin',
  'Alias for rto (return-to-origin stop)',
  45,
  FALSE,
  jsonb_build_object('alias_of', 'rto')
FROM public.lookup_definitions ld
WHERE ld.category = 'route_stop_kind'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 3) Standard task types for dispatch exceptions (additive global defaults)
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing JSONB := NULL;
  v_policy JSONB := '{}'::jsonb;
  v_task_types JSONB := '[]'::jsonb;
  v_prev_task_types JSONB := '[]'::jsonb;

  v_desired JSONB := jsonb_build_array(
    jsonb_build_object('key', 'dispatch_reschedule_delivery', 'name', 'Dispatch Reschedule Delivery', 'default_priority', 50, 'default_queue_key', 'dispatch', 'enabled', TRUE),
    jsonb_build_object('key', 'dispatch_reattempt_delivery', 'name', 'Dispatch Reattempt Delivery', 'default_priority', 50, 'default_queue_key', 'dispatch', 'enabled', TRUE),
    jsonb_build_object('key', 'dispatch_rto_pickup', 'name', 'Dispatch RTO Pickup', 'default_priority', 50, 'default_queue_key', 'dispatch', 'enabled', TRUE),
    jsonb_build_object('key', 'dispatch_return_pickup', 'name', 'Dispatch Return Pickup', 'default_priority', 50, 'default_queue_key', 'dispatch', 'enabled', TRUE),
    jsonb_build_object('key', 'dispatch_swap_completion', 'name', 'Dispatch Swap Completion', 'default_priority', 50, 'default_queue_key', 'dispatch', 'enabled', TRUE)
  );

  v_item JSONB;
  v_key TEXT;
  v_sv_id UUID := gen_random_uuid();
  v_next_version INT := 1;
BEGIN
  SELECT s.cached_value
    INTO v_existing
    FROM public.settings s
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_existing IS NULL OR jsonb_typeof(v_existing) <> 'object' THEN
    v_existing := '{}'::jsonb;
  END IF;

  v_task_types := COALESCE(v_existing->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) <> 'array' THEN
    v_task_types := '[]'::jsonb;
  END IF;
  v_prev_task_types := v_task_types;

  FOR v_item IN
    SELECT * FROM jsonb_array_elements(v_desired)
  LOOP
    v_key := lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), ''));
    IF v_key IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_task_types) e
      WHERE lower(NULLIF(btrim(COALESCE(e->>'key', '')), '')) = v_key
    ) THEN
      v_task_types := v_task_types || jsonb_build_array(v_item);
    END IF;
  END LOOP;

  IF v_task_types IS NOT DISTINCT FROM v_prev_task_types THEN
    RETURN;
  END IF;

  v_policy := v_existing;
  v_policy := jsonb_set(v_policy, '{task_types}', v_task_types, TRUE);

  -- Close out any existing approved "current" row so the partial unique index remains valid.
  UPDATE public.settings_versions
     SET effective_until = workflow_now()
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash;

  INSERT INTO public.settings_versions (
    id, category, scope_type, scope_id, scope_hash, version,
    value, schema_version, change_reason, approved_at, effective_from
  ) VALUES (
    v_sv_id,
    'task_type_catalog',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_policy,
    1,
    'Add standard dispatch exception task types to task_type_catalog',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category, scope_type, scope_id, scope_hash,
    settings_version_id, cached_value, last_updated
  )
  VALUES (
    'task_type_catalog',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_sv_id,
    v_policy,
    workflow_now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202601242000_dispatch_exception_taxonomy_v1'));
COMMIT;

