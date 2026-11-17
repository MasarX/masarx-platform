-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Restore task-type catalog auto-provisioning for authenticated tabular import start

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091250_tabular_import_authenticated_task_type_provision_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ensure_task_type_from_catalog_internal_v1(
  p_organization_id UUID,
  p_task_type_key TEXT,
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := p_organization_id;
  v_key TEXT := lower(NULLIF(btrim(COALESCE(p_task_type_key, '')), ''));
  v_ctx JSONB := COALESCE(p_context, '{}'::jsonb);
  v_existing_id UUID := NULL;
  v_row RECORD;
  v_catalog JSONB := '{}'::jsonb;
  v_items JSONB := '[]'::jsonb;
  v_item JSONB;
  v_item_key TEXT := NULL;
  v_name TEXT := NULL;
  v_description TEXT := NULL;
  v_default_priority INT := NULL;
  v_default_queue_key TEXT := NULL;
  v_enabled BOOLEAN := TRUE;
  v_metadata JSONB := '{}'::jsonb;
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ensure_task_type_from_catalog_internal_v1 requires organization_id' USING ERRCODE = '23514';
  END IF;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'ensure_task_type_from_catalog_internal_v1 requires task_type_key' USING ERRCODE = '23514';
  END IF;

  SELECT tt.id
    INTO v_existing_id
    FROM public.task_types tt
   WHERE tt.organization_id = v_org_id
     AND tt.key = v_key
   LIMIT 1;
  IF FOUND THEN
    RETURN v_existing_id;
  END IF;

  IF jsonb_typeof(v_ctx) <> 'object' THEN
    v_ctx := '{}'::jsonb;
  END IF;

  v_ctx := jsonb_strip_nulls(v_ctx || jsonb_build_object('organization_id', v_org_id));

  SELECT *
    INTO v_row
    FROM public.resolve_settings_row_from_policy_context_v1('task_type_catalog', v_ctx)
   LIMIT 1;

  v_catalog := COALESCE(v_row.value, '{}'::jsonb);
  IF jsonb_typeof(v_catalog) <> 'object' THEN
    v_catalog := '{}'::jsonb;
  END IF;

  v_items := COALESCE(v_catalog->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_items) <> 'array' THEN
    v_items := '[]'::jsonb;
  END IF;

  FOR v_item IN
    SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    v_item_key := lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), ''));
    IF v_item_key = v_key THEN
      v_name := NULLIF(btrim(COALESCE(v_item->>'name', '')), '');
      v_description := NULLIF(btrim(COALESCE(v_item->>'description', '')), '');
      BEGIN v_default_priority := NULLIF(v_item->>'default_priority', '')::int; EXCEPTION WHEN others THEN v_default_priority := NULL; END;
      v_default_queue_key := NULLIF(btrim(COALESCE(v_item->>'default_queue_key', '')), '');
      BEGIN v_enabled := COALESCE(NULLIF(v_item->>'enabled', '')::boolean, TRUE); EXCEPTION WHEN others THEN v_enabled := TRUE; END;
      v_metadata := COALESCE(v_item->'metadata', '{}'::jsonb);
      EXIT;
    END IF;
  END LOOP;

  IF v_name IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_default_priority IS NULL THEN
    v_default_priority := 50;
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  INSERT INTO public.task_types (
    organization_id,
    key,
    name,
    description,
    default_priority,
    default_queue_key,
    enabled,
    metadata
  ) VALUES (
    v_org_id,
    v_key,
    v_name,
    v_description,
    v_default_priority,
    v_default_queue_key,
    v_enabled,
    v_metadata
  )
  ON CONFLICT (organization_id, key) DO NOTHING
  RETURNING id INTO v_existing_id;

  IF v_existing_id IS NULL THEN
    SELECT tt.id
      INTO v_existing_id
      FROM public.task_types tt
     WHERE tt.organization_id = v_org_id
       AND tt.key = v_key
     LIMIT 1;
  END IF;

  RETURN v_existing_id;
END;
$function$;

COMMENT ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB)
  IS 'Internal row-driven helper that materializes task_types from task_type_catalog without requiring a service-role caller.';

REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.ensure_task_type_from_catalog_v1(
  p_organization_id UUID,
  p_task_type_key TEXT,
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'ensure_task_type_from_catalog_v1 requires service_role context';
  END IF;

  RETURN public.ensure_task_type_from_catalog_internal_v1(
    p_organization_id,
    p_task_type_key,
    p_context
  );
END;
$function$;

COMMENT ON FUNCTION public.ensure_task_type_from_catalog_v1(UUID, TEXT, JSONB)
  IS 'Service-only wrapper for task_type_catalog provisioning; delegates to the internal insert-only helper.';

REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_v1(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_v1(UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_v1(UUID, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_task_type_from_catalog_v1(UUID, TEXT, JSONB) TO service_role;

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
  v_task_context JSONB := '{}'::jsonb;
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

  v_task_context := jsonb_build_object(
    'organization_id', v_run.organization_id,
    'client_id', v_run.client_id,
    'sender_id', v_run.sender_id,
    'resource_key', v_run.resource_key,
    'run_id', v_run.id
  );

  PERFORM public.ensure_task_type_from_catalog_internal_v1(
    v_run.organization_id,
    'tabular_import.process',
    v_task_context
  );

  PERFORM set_config('app.actor_system', 'resource_import_studio', true);
  BEGIN
    SELECT *
      INTO v_task
      FROM public.create_task_v1(
        'tabular_import.process',
        v_task_context,
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

SELECT pg_advisory_unlock(hashtext('202603091250_tabular_import_authenticated_task_type_provision_v1'));
COMMIT;
