-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Reconcile api contract views after marketplace user-facing surface expansion

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091161_api_contract_views_user_facing_reconcile_v4'));
SET search_path TO public, extensions, pg_temp;

DO $$
BEGIN
  IF to_regprocedure('public.refresh_api_contract_views_v1()') IS NOT NULL THEN
    PERFORM public.refresh_api_contract_views_v1();
  ELSE
    RAISE EXCEPTION 'public.refresh_api_contract_views_v1() is required';
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202603091161_api_contract_views_user_facing_reconcile_v4'));
COMMIT;
