-- Plan: PLAN-202601-api-schema-boundary / Step: S04
-- Migration: Create `api` contract schema (views + RPC wrappers) so PostgREST can expose only `api`.
-- Notes:
--   - Base SSOT tables/functions remain in `public` for now.
--   - `api` contains projection views + thin wrappers that delegate to existing `public` routines.
--   - Grants on wrapper functions are derived from the underlying `public` function grants, excluding PUBLIC/anon.
BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) Contract schema boundary
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2) Contract views for `.from('<table>')` callers
--    - Use security_invoker so underlying RLS policies apply to the caller role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW api.label_design_drafts
WITH (security_invoker = true)
AS
SELECT *
FROM public.label_design_drafts;

REVOKE ALL ON api.label_design_drafts FROM PUBLIC;
REVOKE ALL ON api.label_design_drafts FROM anon;
REVOKE ALL ON api.label_design_drafts FROM authenticated;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.label_design_drafts TO authenticated;
GRANT ALL ON api.label_design_drafts TO service_role;

CREATE OR REPLACE VIEW api.metrics_webhook_events
WITH (security_invoker = true)
AS
SELECT *
FROM public.metrics_webhook_events;

REVOKE ALL ON api.metrics_webhook_events FROM PUBLIC;
REVOKE ALL ON api.metrics_webhook_events FROM anon;
REVOKE ALL ON api.metrics_webhook_events FROM authenticated;
GRANT USAGE ON SCHEMA api TO service_role;
GRANT SELECT, INSERT ON api.metrics_webhook_events TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_label_renderer_role;
    GRANT SELECT, INSERT ON api.metrics_webhook_events TO edge_label_renderer_role;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) Contract wrappers for `.rpc('<fn>')` callers
--    - Preserve argument names for PostgREST JSON argument mapping.
--    - Copy EXECUTE grants from the underlying public function, excluding PUBLIC/anon/postgres.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_names text[] := ARRAY[
    'claim_pending_edge_jobs',
    'complete_label_job',
    'complete_label_jobs',
    'compose_label_payload',
    'compose_label_payloads',
    'get_job_call_spec',
    'get_label_jobs_status',
    'label_designer_get_effective_label_design',
    'label_designer_get_effective_label_print_profile',
    'label_designer_get_field_catalog',
    'label_designer_get_label_media_catalog',
    'label_designer_get_sample_payload',
    'label_designer_publish_label_design_draft',
    'label_designer_validate_label_design_draft',
    'label_designer_whoami',
    'lease_label_job',
    'lease_label_jobs',
    'lease_label_jobs_by_ids',
    'lease_label_jobs_by_ids_compact',
    'log_api_call_event',
    'log_decision',
    'mark_outbound_call_failure',
    'mark_outbound_call_in_progress',
    'mark_outbound_call_success',
    'request_label_generation_batch',
    'resolve_label_bundle_targets_for_file_urls',
    'resolve_label_files_for_bundle',
    'resolve_settings_merged'
  ];
  v_name text;
  f record;
  v_args text;
  v_identity_args text;
  v_result text;
  v_call_args text;
  v_sql text;
  v_volatility text;
  v_is_set boolean;
  v_grantee text;
  i integer;
BEGIN
  FOREACH v_name IN ARRAY v_names
  LOOP
    FOR f IN
      SELECT
        p.oid,
        p.proname,
        p.pronargs,
        p.proowner,
        p.proacl,
        p.provolatile
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = v_name
    LOOP
      v_args := pg_get_function_arguments(f.oid);
      v_identity_args := pg_get_function_identity_arguments(f.oid);
      v_result := pg_get_function_result(f.oid);
      v_volatility := CASE f.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE '' END;

      v_call_args := '';
      IF f.pronargs > 0 THEN
        FOR i IN 1..f.pronargs LOOP
          v_call_args := v_call_args || CASE WHEN i > 1 THEN ', ' ELSE '' END || '$' || i;
        END LOOP;
      END IF;

      v_is_set := (v_result ILIKE 'SETOF %') OR (v_result ILIKE 'TABLE%');
      IF v_is_set THEN
        v_sql := format('SELECT * FROM public.%I(%s);', f.proname, v_call_args);
      ELSE
        v_sql := format('SELECT public.%I(%s);', f.proname, v_call_args);
      END IF;

      EXECUTE format(
        'CREATE OR REPLACE FUNCTION api.%I(%s) RETURNS %s LANGUAGE sql%s SET search_path TO public, extensions, pg_temp AS $fn$ %s $fn$',
        f.proname,
        v_args,
        v_result,
        CASE WHEN v_volatility <> '' THEN ' ' || v_volatility ELSE '' END,
        v_sql
      );

      -- Default EXECUTE is granted to PUBLIC for new functions; enforce deny-by-default.
      EXECUTE format('REVOKE ALL ON FUNCTION api.%I(%s) FROM PUBLIC', f.proname, v_identity_args);

      -- Copy grants from the underlying public function, but never expose PUBLIC/anon.
      FOR v_grantee IN
        SELECT DISTINCT
          CASE
            WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE (SELECT rolname FROM pg_roles WHERE oid = acl.grantee)
          END AS grantee
        FROM aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) acl
        WHERE acl.privilege_type = 'EXECUTE'
      LOOP
        IF v_grantee IS NULL THEN
          CONTINUE;
        END IF;
        IF v_grantee IN ('PUBLIC', 'anon', 'postgres') THEN
          CONTINUE;
        END IF;
        IF v_grantee = 'authenticated' AND f.proname NOT LIKE 'label_designer_%' THEN
          CONTINUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = v_grantee) THEN
          CONTINUE;
        END IF;

        EXECUTE format('GRANT USAGE ON SCHEMA api TO %I', v_grantee);
        EXECUTE format('GRANT EXECUTE ON FUNCTION api.%I(%s) TO %I', f.proname, v_identity_args, v_grantee);
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;
