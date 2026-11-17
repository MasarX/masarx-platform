-- Plan: B05 Branch transfer & network movement
-- Migration: Warehouse transfer api contract views v1
-- Date: 2026-04-02
--
-- Purpose:
--   - Expose warehouse transfer foundation tables through the canonical `api`
--     schema boundary for hosted Console/Portal consumers.
--   - Keep grants aligned with the underlying public-table contract instead of
--     introducing separate application-side DB fallbacks.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604021205_warehouse_transfer_api_contract_views_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

DO $$
DECLARE
  r RECORD;
  v_public_ref TEXT;
  v_auth_select BOOLEAN;
  v_auth_insert BOOLEAN;
  v_auth_update BOOLEAN;
  v_auth_delete BOOLEAN;
  v_anon_select BOOLEAN;
  v_anon_insert BOOLEAN;
  v_anon_update BOOLEAN;
  v_anon_delete BOOLEAN;
  v_any_anon BOOLEAN := FALSE;
BEGIN
  FOR r IN
    SELECT tablename
    FROM (
      VALUES
        ('handling_units'::text),
        ('warehouse_transfers'::text),
        ('warehouse_transfer_items'::text)
    ) AS v(tablename)
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE VIEW api.%I WITH (security_invoker = true) AS SELECT * FROM public.%I',
      r.tablename,
      r.tablename
    );

    EXECUTE format('REVOKE ALL ON api.%I FROM PUBLIC', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM anon', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM authenticated', r.tablename);

    v_public_ref := format('public.%I', r.tablename);

    v_auth_select := has_table_privilege('authenticated', v_public_ref, 'select');
    v_auth_insert := has_table_privilege('authenticated', v_public_ref, 'insert');
    v_auth_update := has_table_privilege('authenticated', v_public_ref, 'update');
    v_auth_delete := has_table_privilege('authenticated', v_public_ref, 'delete');

    v_anon_select := has_table_privilege('anon', v_public_ref, 'select');
    v_anon_insert := has_table_privilege('anon', v_public_ref, 'insert');
    v_anon_update := has_table_privilege('anon', v_public_ref, 'update');
    v_anon_delete := has_table_privilege('anon', v_public_ref, 'delete');

    IF v_auth_select THEN EXECUTE format('GRANT SELECT ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_insert THEN EXECUTE format('GRANT INSERT ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_update THEN EXECUTE format('GRANT UPDATE ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_delete THEN EXECUTE format('GRANT DELETE ON api.%I TO authenticated', r.tablename); END IF;

    IF v_anon_select THEN EXECUTE format('GRANT SELECT ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;
    IF v_anon_insert THEN EXECUTE format('GRANT INSERT ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;
    IF v_anon_update THEN EXECUTE format('GRANT UPDATE ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;
    IF v_anon_delete THEN EXECUTE format('GRANT DELETE ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON api.%I TO service_role', r.tablename);
  END LOOP;

  IF v_any_anon THEN
    GRANT USAGE ON SCHEMA api TO anon;
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202604021205_warehouse_transfer_api_contract_views_v1'));
COMMIT;
