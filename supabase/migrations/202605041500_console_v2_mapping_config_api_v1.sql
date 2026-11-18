-- Console V2 Mapping Studio direct mapping_config CRUD bridge.
--
-- Browser clients are bound to the api schema. The historical
-- ui_upsert_mapping_artifact_v1 artifact contract only handled generated
-- tabular/webhook/api artifacts, while Console V2's Mapping Studio edits the
-- mapping_configs SSOT table directly. This adds an explicit direct
-- mapping_config write path and keeps the existing artifact wrapper intact for
-- non-direct artifact saves.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605041500_console_v2_mapping_config_api_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_upsert_mapping_config_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_current_org_id uuid;
  v_requested_org_id uuid;
  v_org_id uuid;
  v_mapping_id uuid;
  v_mapping_type text;
  v_mapping_key text;
  v_mapping_config jsonb;
  v_notes text;
  v_row public.mapping_configs%ROWTYPE;
  v_existing public.mapping_configs%ROWTYPE;
  v_action text := 'created';
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 requires argument object'
      USING ERRCODE = '23502';
  END IF;

  v_current_org_id := public.current_user_org_id();
  v_requested_org_id := public.mapping_studio_try_uuid_v1(p_args->>'organization_id');
  IF public.is_platform_user() THEN
    v_org_id := COALESCE(v_requested_org_id, v_current_org_id);
  ELSE
    v_org_id := v_current_org_id;
    IF v_requested_org_id IS NOT NULL AND v_requested_org_id IS DISTINCT FROM v_current_org_id THEN
      RAISE EXCEPTION 'ui_upsert_mapping_config_v1 cannot write a different organization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  v_mapping_id := public.mapping_studio_try_uuid_v1(p_args->>'mapping_config_id');
  v_mapping_type := NULLIF(btrim(COALESCE(p_args->>'mapping_type', '')), '');
  v_mapping_key := NULLIF(btrim(COALESCE(p_args->>'mapping_key', '')), '');
  v_mapping_config := COALESCE(p_args->'mapping_config', '{}'::jsonb);
  v_notes := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 requires organization context'
      USING ERRCODE = '23502';
  END IF;

  IF v_mapping_type IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 requires mapping_type'
      USING ERRCODE = '23502';
  END IF;

  IF v_mapping_key IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 requires mapping_key'
      USING ERRCODE = '23502';
  END IF;

  IF jsonb_typeof(v_mapping_config) <> 'object' THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 requires mapping_config object'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'mapping_type'
      AND v.value = v_mapping_type
      AND v.status = 'active'
  ) THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping_type % is not active', v_mapping_type
      USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('mappings.write', 'tenant', v_org_id);
  PERFORM pg_advisory_xact_lock(hashtext('mapping_config:' || v_mapping_type || ':' || v_mapping_key));

  IF v_mapping_id IS NOT NULL THEN
    SELECT *
      INTO v_existing
      FROM public.mapping_configs
     WHERE id = v_mapping_id
     FOR UPDATE;

    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping_config % not found', v_mapping_id
        USING ERRCODE = '23503';
    END IF;

    IF v_existing.organization_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping_config % is global/shared and service-managed', v_mapping_id
        USING ERRCODE = '42501';
    END IF;

    IF v_existing.organization_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping_config % belongs to another organization', v_mapping_id
        USING ERRCODE = '42501';
    END IF;

    UPDATE public.mapping_configs
       SET mapping_type = v_mapping_type,
           mapping_key = v_mapping_key,
           mapping_config = v_mapping_config,
           mapping_version = mapping_version + 1,
           notes = COALESCE(v_notes, notes),
           updated_at = now()
     WHERE id = v_mapping_id
       AND organization_id = v_org_id
     RETURNING * INTO v_row;
    v_action := 'updated';
  ELSE
    SELECT *
      INTO v_existing
      FROM public.mapping_configs
     WHERE mapping_type = v_mapping_type
       AND mapping_key = v_mapping_key
     FOR UPDATE;

    IF v_existing.id IS NOT NULL THEN
      IF v_existing.organization_id IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping key %/% is global/shared and service-managed', v_mapping_type, v_mapping_key
          USING ERRCODE = '42501';
      END IF;

      IF v_existing.organization_id IS DISTINCT FROM v_org_id THEN
        RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping key %/% belongs to another organization', v_mapping_type, v_mapping_key
          USING ERRCODE = '42501';
      END IF;

      UPDATE public.mapping_configs
         SET mapping_config = v_mapping_config,
             mapping_version = mapping_version + 1,
             notes = COALESCE(v_notes, notes),
             updated_at = now()
       WHERE id = v_existing.id
         AND organization_id = v_org_id
       RETURNING * INTO v_row;
      v_action := 'updated';
    ELSE
      v_action := 'created';
      INSERT INTO public.mapping_configs (
        organization_id,
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes
      )
      VALUES (
        v_org_id,
        v_mapping_type,
        v_mapping_key,
        v_mapping_config,
        1,
        COALESCE(v_notes, 'Console V2 mapping_config artifact')
      )
      RETURNING * INTO v_row;
    END IF;
  END IF;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 failed to persist mapping_config'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'primary_resource_type', 'mapping_configs',
    'primary_resource_id', v_row.id,
    'mapping_config_id', v_row.id,
    'resource_ids', jsonb_build_array(
      jsonb_build_object('resource_type', 'mapping_configs', 'resource_id', v_row.id)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.mapping_config_promote_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_correlation_id uuid := gen_random_uuid();
  v_decision_id uuid := gen_random_uuid();
  v_resource_id uuid := public.mapping_studio_try_uuid_v1(p_args->>'mapping_config_id');
  v_new_payload jsonb := p_args->'mapping_config';
  v_promote_notes text := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');
  v_before public.mapping_configs%ROWTYPE;
  v_before_jsonb jsonb;
  v_after_jsonb jsonb;
  v_next_revision int;
  v_promoted_to_version int;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'mapping_config_promote_v1 requires argument object'
      USING ERRCODE = '23502';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'mapping_config_promote_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'mapping_config_promote_v1 requires mapping_config_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT *
    INTO v_before
    FROM public.mapping_configs
   WHERE id = v_resource_id
   FOR UPDATE;

  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'mapping_config_promote_v1 mapping_config % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  IF v_before.organization_id IS NULL THEN
    RAISE EXCEPTION 'mapping_config_promote_v1 mapping_config % is global/shared and service-managed', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  IF v_org_id IS NULL OR v_org_id IS DISTINCT FROM v_before.organization_id THEN
    RAISE EXCEPTION 'mapping_config_promote_v1 mapping_config % belongs to another organization', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('mappings.write', 'tenant', v_before.organization_id);

  v_before_jsonb := to_jsonb(v_before);
  v_promoted_to_version := v_before.mapping_version + 1;

  UPDATE public.mapping_configs
     SET mapping_config = COALESCE(v_new_payload, mapping_config),
         mapping_version = v_promoted_to_version,
         notes = COALESCE(v_promote_notes, notes),
         updated_at = now()
   WHERE id = v_resource_id
     AND organization_id = v_before.organization_id
   RETURNING to_jsonb(mapping_configs.*) INTO v_after_jsonb;

  SELECT COALESCE(MAX(revision), 0) + 1
    INTO v_next_revision
    FROM public.mapping_config_revisions
   WHERE mapping_config_id = v_resource_id;

  INSERT INTO public.mapping_config_revisions (
    mapping_config_id, revision, promoted_from_version, promoted_to_version,
    before_value, after_value, changed_by, correlation_id, decision_log_id
  ) VALUES (
    v_resource_id, v_next_revision, v_before.mapping_version, v_promoted_to_version,
    v_before_jsonb, v_after_jsonb, v_user_id, v_correlation_id::text, v_decision_id
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id,
    'mappings.promote', 'mapping_config', v_resource_id,
    'mapping_config_promote_v1', 'promoted',
    jsonb_strip_nulls(jsonb_build_object(
      'previous_version', v_before.mapping_version,
      'promoted_to_version', v_promoted_to_version,
      'replaced_payload', v_new_payload IS NOT NULL,
      'notes', v_promote_notes
    )),
    'mapping_config_promote_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_before.organization_id, 'mapping_config.promoted', 'mapping_config', v_resource_id,
    jsonb_build_object(
      'mapping_type', v_before.mapping_type,
      'mapping_key', v_before.mapping_key,
      'promoted_to_version', v_promoted_to_version
    ),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'mapping_config_id', v_resource_id,
    'promoted_to_version', v_promoted_to_version,
    'revision', v_next_revision,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mapping_config_promote_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mapping_config_promote_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.mapping_config_promote_v1(jsonb)
  IS 'Canonical write RPC: bump org-scoped mapping_configs.mapping_version + append revision. Global/shared mapping configs remain service-managed. Capability: mappings.write.';

REVOKE ALL ON FUNCTION public.ui_upsert_mapping_config_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_upsert_mapping_config_v1(jsonb) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_upsert_mapping_config_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_upsert_mapping_config_v1(p_args);
$function$;

CREATE OR REPLACE FUNCTION api.ui_upsert_mapping_artifact_v1(p_artifact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF lower(COALESCE(NULLIF(btrim(p_artifact->>'artifact'), ''), '')) = 'mapping_config' THEN
    RETURN public.ui_upsert_mapping_config_v1(p_artifact);
  END IF;

  RETURN public.ui_upsert_mapping_artifact_v1(p_artifact);
END;
$function$;

CREATE OR REPLACE FUNCTION api.mapping_config_promote_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.mapping_config_promote_v1(p_args);
$function$;

REVOKE ALL ON FUNCTION api.ui_upsert_mapping_config_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_upsert_mapping_artifact_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.mapping_config_promote_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_upsert_mapping_config_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_upsert_mapping_artifact_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.mapping_config_promote_v1(jsonb) TO authenticated, service_role;

UPDATE public.lookup_values v
SET metadata = COALESCE(v.metadata, '{}'::jsonb)
  || jsonb_build_object(
    'tone',
    CASE v.value
      WHEN 'pending' THEN 'neutral'
      WHEN 'in_progress' THEN 'info'
      WHEN 'running' THEN 'info'
      WHEN 'completed' THEN 'good'
      WHEN 'succeeded' THEN 'good'
      WHEN 'failed' THEN 'danger'
      WHEN 'skipped' THEN 'neutral'
      WHEN 'cancelled' THEN 'neutral'
      WHEN 'timed_out' THEN 'warn'
      ELSE COALESCE(v.metadata->>'tone', 'neutral')
    END,
    'allows_retry',
    v.value IN ('failed', 'timed_out')
  )
FROM public.lookup_definitions d
WHERE v.lookup_definition_id = d.id
  AND d.category = 'workflow_step_status'
  AND v.value IN ('pending', 'in_progress', 'running', 'completed', 'succeeded', 'failed', 'skipped', 'cancelled', 'timed_out');

UPDATE public.lookup_values v
SET metadata = COALESCE(v.metadata, '{}'::jsonb)
  || jsonb_build_object(
    'tone',
    CASE v.value
      WHEN 'pending' THEN 'neutral'
      WHEN 'in_progress' THEN 'info'
      WHEN 'running' THEN 'info'
      WHEN 'completed' THEN 'good'
      WHEN 'succeeded' THEN 'good'
      WHEN 'failed' THEN 'danger'
      WHEN 'timeout' THEN 'danger'
      WHEN 'timed_out' THEN 'warn'
      WHEN 'skipped' THEN 'neutral'
      WHEN 'cancelled' THEN 'neutral'
      ELSE COALESCE(v.metadata->>'tone', 'neutral')
    END,
    'allows_retry',
    v.value IN ('failed', 'timeout', 'timed_out')
  )
FROM public.lookup_definitions d
WHERE v.lookup_definition_id = d.id
  AND d.category = 'workflow_run_status'
  AND v.value IN ('pending', 'in_progress', 'running', 'completed', 'succeeded', 'failed', 'timeout', 'timed_out', 'skipped', 'cancelled');

SELECT pg_advisory_unlock(hashtext('202605041500_console_v2_mapping_config_api_v1'));
COMMIT;
