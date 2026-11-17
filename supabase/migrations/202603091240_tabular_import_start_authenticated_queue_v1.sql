-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Queue approved tabular imports under authenticated context

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091240_tabular_import_start_authenticated_queue_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_start_tabular_import_run_v1(
  p_run_id UUID,
  p_save_profile JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_resource JSONB;
  v_capability TEXT;
  v_save_profile JSONB := COALESCE(p_save_profile, '{}'::jsonb);
  v_profile_mode TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_save_profile->>'mode', '')), ''), 'none'));
  v_profile_name TEXT := NULLIF(btrim(COALESCE(v_save_profile->>'profile_name', '')), '');
  v_profile_id UUID := public.mapping_studio_try_uuid_v1(v_save_profile->>'profile_id');
  v_profile_slug TEXT;
  v_mapping_key TEXT;
  v_mapping_result JSONB;
  v_summary JSONB := '{}'::jsonb;
  v_resolved_rules JSONB := '[]'::jsonb;
  v_unresolved_targets JSONB := '[]'::jsonb;
  v_task RECORD;
  v_previous_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id
   FOR UPDATE;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 run % not found', p_run_id;
  END IF;

  IF NOT public.is_platform_user()
     AND v_run.organization_id IS DISTINCT FROM public.current_user_org_id() THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 cannot start another organization';
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_run.resource_key);
  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), ''),
    'system.write'
  );
  PERFORM public.assert_capability_v1(v_capability, 'tenant', v_run.organization_id);

  IF v_run.status IN ('queued', 'processing') THEN
    RETURN public.ui_get_tabular_import_run_v1(v_run.id);
  END IF;
  IF v_run.status IN ('completed', 'completed_with_errors', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 run % is already terminal (%).', v_run.id, v_run.status;
  END IF;
  IF v_run.total_rows <= 0 THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 run % has no staged rows', v_run.id;
  END IF;
  IF v_run.blocked_count > 0 THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 run % still has blocked rows', v_run.id;
  END IF;

  v_summary := COALESCE(v_run.summary, '{}'::jsonb);
  v_resolved_rules := COALESCE(v_summary->'resolved_rules', '[]'::jsonb);
  v_unresolved_targets := COALESCE(v_summary->'unresolved_targets', '[]'::jsonb);

  IF jsonb_typeof(v_unresolved_targets) = 'array' AND jsonb_array_length(v_unresolved_targets) > 0 THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 run % still has unresolved targets', v_run.id;
  END IF;

  IF v_profile_mode IN ('new', 'update') THEN
    v_profile_name := COALESCE(v_profile_name, v_run.profile_name, format('%s import', v_run.resource_key));
    v_profile_slug := public.tabular_import_slug_v1(v_profile_name);
    v_mapping_key := format(
      'tabular_import::%s::%s::%s',
      public.mapping_studio_normalize_key_v1(v_run.resource_key),
      v_profile_slug,
      v_run.organization_id
    );

    v_mapping_result := public.ui_upsert_mapping_artifact_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'artifact', 'tabular_import',
          'organization_id', v_run.organization_id,
          'mapping_config_id', CASE WHEN v_profile_mode = 'update' THEN v_profile_id ELSE NULL END,
          'mapping_key', v_mapping_key,
          'target_resource_key', v_run.resource_key,
          'notes', format('Tabular import profile saved from run %s', v_run.id),
          'mapping_config', jsonb_build_object(
            'resource_key', v_run.resource_key,
            'profile_name', v_profile_name,
            'profile_slug', v_profile_slug,
            'header_fingerprint', v_run.header_fingerprint,
            'sheet_hint', v_run.sheet_name,
            'write_mode', v_run.write_mode,
            'field_rules', COALESCE(v_resolved_rules, '[]'::jsonb)
          )
        )
      )
    );

    UPDATE public.tabular_import_runs
       SET profile_name = v_profile_name,
           updated_at = now()
     WHERE id = v_run.id;
  END IF;

  PERFORM set_config('app.actor_system', 'resource_import_studio', true);
  BEGIN
    SELECT *
      INTO v_task
      FROM public.create_task_v1(
        'tabular_import.process',
        jsonb_build_object(
          'organization_id', v_run.organization_id,
          'client_id', v_run.client_id,
          'sender_id', v_run.sender_id,
          'resource_key', v_run.resource_key,
          'run_id', v_run.id
        ),
        'tabular_import_run',
        v_run.id,
        'imports',
        60,
        NULL,
        format('tabular_import_process:%s', v_run.id),
        jsonb_build_object(
          'operation_kind', 'tabular_import_execution',
          'profile_name', COALESCE(v_profile_name, v_run.profile_name),
          'resource_key', v_run.resource_key
        )
      );
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('app.actor_system', v_previous_actor_system, true);
      RAISE;
  END;
  PERFORM set_config('app.actor_system', v_previous_actor_system, true);

  UPDATE public.tabular_import_runs
     SET status = 'queued',
         task_id = v_task.task_id,
         updated_at = now(),
         updated_by = COALESCE(auth.uid(), updated_by)
   WHERE id = v_run.id;

  RETURN public.ui_get_tabular_import_run_v1(v_run.id);
END;
$function$;

COMMENT ON FUNCTION public.ui_start_tabular_import_run_v1(UUID, JSONB) IS
  'Approve and enqueue a prepared tabular import run, optionally persisting or updating a reusable profile first.';

REVOKE ALL ON FUNCTION public.ui_start_tabular_import_run_v1(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_start_tabular_import_run_v1(UUID, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603091240_tabular_import_start_authenticated_queue_v1'));
COMMIT;
