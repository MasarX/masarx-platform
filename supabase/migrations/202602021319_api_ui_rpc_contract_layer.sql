-- Plan: PLAN-202602-frontend-workflow-prod-ready-finalize / Step: S04
-- Migration: Expose UI RPCs in `api` schema (PostgREST boundary).
-- Notes:
--   - UI uses `.rpc('ui_*')`; env.cloud restricts PostgREST to `api`.
--   - These wrappers delegate to `public.ui_*` and copy EXECUTE grants (excluding PUBLIC/anon).
BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

DO $$
DECLARE
  v_names text[] := ARRAY[
    'ui_access_policy_v1',
    'ui_apply_navigation_items_v1',
    'ui_command_registry_v1',
    'ui_create_workflow_run_trigger_v1',
    'ui_create_workflow_schedule_trigger_v1',
    'ui_create_workflow_template_step_v1',
    'ui_create_workflow_template_v1',
    'ui_dashboard_config_v1',
    'ui_delete_resource_v1',
    'ui_execute_command_v1',
    'ui_filter_operators_v1',
    'ui_filter_tree_sql_v1',
    'ui_get_resource_v1',
    'ui_get_trace_v1',
    'ui_list_resource_v1',
    'ui_log_event_v1',
    'ui_log_events_v1',
    'ui_me_v1',
    'ui_navigation_v1',
    'ui_read_registry_v1',
    'ui_related_resources_v1',
    'ui_reorder_resource_v1',
    'ui_request_access_policy_change_v1',
    'ui_resource_metrics_v1',
    'ui_run_workflow_schedule_trigger_v1',
    'ui_settings_preview_v1',
    'ui_start_workflow_run_v1',
    'ui_table_views_v1',
    'ui_tracking_registry_v1',
    'ui_update_resource_v1'
  ];
  v_name text;
  v_found boolean;
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
    v_found := false;
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
      v_found := true;
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

      EXECUTE format('REVOKE ALL ON FUNCTION api.%I(%s) FROM PUBLIC', f.proname, v_identity_args);

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
        IF NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = v_grantee) THEN
          CONTINUE;
        END IF;

        EXECUTE format('GRANT USAGE ON SCHEMA api TO %I', v_grantee);
        EXECUTE format('GRANT EXECUTE ON FUNCTION api.%I(%s) TO %I', f.proname, v_identity_args, v_grantee);
      END LOOP;
    END LOOP;

    IF NOT v_found THEN
      RAISE EXCEPTION 'api ui rpc wrapper: public.% not found', v_name;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
