-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Dispatch exception taxonomy semantics defaults (row-driven; non-stomping)
-- Date: 2026-01-24
--
-- Why:
--   - We have a canonical dispatch exception reason taxonomy (lookup_values).
--   - Stop finalization should be able to apply default status/action semantics for known exception reasons
--     without requiring per-tenant hardcoded branches.
--   - Defaults are stored as metadata on the taxonomy rows and can be overridden by dispatch_stop_policy (ladder).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601242300_dispatch_exception_reason_semantics_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def_id UUID;
BEGIN
  SELECT id
    INTO v_def_id
    FROM public.lookup_definitions
   WHERE category = 'dispatch_exception_reason'
   LIMIT 1;

  IF v_def_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_exception_reason lookup_definitions row missing';
  END IF;

  -- Add default semantics keys additively (do not overwrite existing keys if present).
  UPDATE public.lookup_values lv
     SET metadata = jsonb_strip_nulls(
           COALESCE(lv.metadata, '{}'::jsonb) ||
           jsonb_build_object(
             'default_shipment_status', COALESCE(
               lv.metadata->>'default_shipment_status',
               CASE lv.value
                 WHEN 'customer_refused' THEN 'return_to_origin'
                 WHEN 'package_damaged' THEN 'return_to_origin'
                 ELSE 'delivery_failed'
               END
             ),
             'default_action_type', COALESCE(lv.metadata->>'default_action_type', 'exception'),
             'default_action_category', COALESCE(lv.metadata->>'default_action_category', 'exception')
           )
         ),
         updated_at = now()
   WHERE lv.lookup_definition_id = v_def_id
     AND lv.value IN (
       'no_answer',
       'customer_refused',
       'address_not_found',
       'address_incorrect',
       'phone_unreachable',
       'payment_issue',
       'package_damaged',
       'package_lost',
       'business_closed',
       'other'
     );
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202601242300_dispatch_exception_reason_semantics_v1'));
COMMIT;

