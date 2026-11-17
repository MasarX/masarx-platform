-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Reconcile marketplace global settings rows to product-complete defaults

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091000_marketplace_policy_defaults_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_category TEXT;
BEGIN
  FOREACH v_category IN ARRAY ARRAY[
    'marketplace_policy',
    'marketplace_request_policy',
    'marketplace_visibility_policy',
    'marketplace_execution_policy',
    'marketplace_settlement_policy',
    'marketplace_reputation_policy',
    'marketplace_tracking_display_policy',
    'marketplace_compliance_policy'
  ]
  LOOP
    PERFORM public.upsert_settings_value_v1(
      p_category := v_category,
      p_scope_type := 'global',
      p_scope_id := NULL,
      p_value := public.marketplace_policy_default_v1(v_category),
      p_schema_version := 1,
      p_change_reason := 'Reconcile marketplace global defaults to product-complete policy pack'
    );
  END LOOP;
END
$$;

SELECT pg_advisory_unlock(hashtext('202603091000_marketplace_policy_defaults_reconcile_v1'));
COMMIT;
