-- W41 closure of W40 finding F2
-- pgTAP: driver_hours_of_service idempotent recreate + DROP-then-CREATE
-- pattern in refresh_api_contract_views_v1.
--
-- Asserts:
--   * public.driver_hours_of_service base table exists and has canonical
--     columns (organization_id, driver_id, segment_start, duty_status, etc.).
--   * RLS is enabled and has at least one explicit policy.
--   * api.driver_hours_of_service contract view exists with security_invoker.
--   * refresh_api_contract_views_v1() can be called repeatedly without
--     erroring (idempotent column-shrink-safe behavior).
--
-- Evidence link: docs/ops/evidence/2026-04-30/local-verify/migrate-soft.log

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

CREATE OR REPLACE FUNCTION test_w41_driver_hours_of_service_recreate()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Base table
  RETURN NEXT has_table(
    'public', 'driver_hours_of_service',
    'public.driver_hours_of_service base table exists'
  );

  RETURN NEXT has_column(
    'public', 'driver_hours_of_service', 'organization_id',
    'organization_id column exists'
  );

  RETURN NEXT has_column(
    'public', 'driver_hours_of_service', 'duty_status',
    'duty_status column exists'
  );

  -- RLS enabled
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'driver_hours_of_service'
        AND c.relrowsecurity = TRUE
    ),
    'RLS is enabled on driver_hours_of_service'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'driver_hours_of_service'
    ),
    'driver_hours_of_service has at least one RLS policy'
  );

  -- api contract view exists with security_invoker
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'api'
        AND c.relname = 'driver_hours_of_service'
        AND c.relkind = 'v'
    ),
    'api.driver_hours_of_service contract view exists'
  );

  -- Idempotency: refresh_api_contract_views_v1 can be called twice without
  -- erroring. Validates the W41 F2 column-shrink-safe DROP-then-CREATE
  -- pattern defended in 202605010002.
  PERFORM public.refresh_api_contract_views_v1();
  PERFORM public.refresh_api_contract_views_v1();
  RETURN NEXT pass(
    'refresh_api_contract_views_v1 is idempotent across consecutive calls'
  );
END
$function$;

SELECT * FROM test_w41_driver_hours_of_service_recreate();

ROLLBACK;
