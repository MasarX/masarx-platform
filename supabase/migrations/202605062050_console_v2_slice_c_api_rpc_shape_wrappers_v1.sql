-- Slice C: Console V2 API-schema RPC shape wrappers.
--
-- Console V2 Supabase clients are pinned to the exposed `api` schema. The
-- canonical functions below already exist under `public`, but some browser
-- adapters call them through the shared jsonb envelope `{ p_args }` while the
-- existing api wrappers only expose the older positional renderer/plugin
-- signatures. Keep this append-only: add overloads, do not replace the
-- canonical public functions or existing positional api wrappers.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605062050_console_v2_slice_c_api_rpc_shape_wrappers_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE FUNCTION api.integration_plugin_generate_draft_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires p_args object'
      USING ERRCODE = '22023';
  END IF;

  RETURN public.integration_plugin_generate_draft_v1(
    NULLIF(btrim(v_args->>'plugin_name'), ''),
    NULLIF(btrim(v_args->>'plugin_kind'), ''),
    COALESCE(NULLIF(btrim(v_args->>'source_type'), ''), 'manual'),
    COALESCE(v_args->'source_payload', v_args->'payload', '{}'::jsonb),
    COALESCE(v_args->'inbound_config', '{}'::jsonb),
    COALESCE(v_args->'mapping_config', '{}'::jsonb),
    COALESCE(v_args->'workflow_binding', '{}'::jsonb),
    COALESCE(v_args->'outbound_operations', '[]'::jsonb),
    COALESCE(NULLIF(v_args->>'plugin_id', ''), NULLIF(v_args->>'integration_plugin_id', ''))::uuid,
    NULLIF(btrim(v_args->>'plugin_key'), ''),
    NULLIF(btrim(v_args->>'description'), ''),
    COALESCE(NULLIF(v_args->>'organization_id', ''), NULLIF(v_args->>'tenant_id', ''))::uuid,
    COALESCE(v_args->'metadata', '{}'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.integration_plugin_rollback_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'integration_plugin_rollback_v1 requires p_args object'
      USING ERRCODE = '22023';
  END IF;

  RETURN public.integration_plugin_rollback_v1(
    COALESCE(NULLIF(v_args->>'plugin_id', ''), NULLIF(v_args->>'integration_plugin_id', ''))::uuid,
    COALESCE(NULLIF(v_args->>'target_plugin_version_id', ''), NULLIF(v_args->>'plugin_version_id', ''))::uuid,
    NULLIF(btrim(v_args->>'reason'), '')
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.integration_plugin_rotate_credentials_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_plugin_version_id uuid := COALESCE(
    NULLIF(v_args->>'plugin_version_id', ''),
    NULLIF(v_args->>'integration_plugin_version_id', '')
  )::uuid;
  v_config_id uuid := COALESCE(
    NULLIF(v_args->>'config_id', ''),
    NULLIF(v_args->>'provider_auth_config_id', ''),
    NULLIF(v_args->>'auth_config_id', '')
  )::uuid;
  v_auth_type text := NULLIF(btrim(COALESCE(v_args->>'auth_type', v_args->>'provider_auth_type')), '');
  v_upsert_args jsonb;
  v_result jsonb;
  v_result_config_id text;
BEGIN
  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 requires p_args object'
      USING ERRCODE = '22023';
  END IF;

  IF v_plugin_version_id IS NOT NULL THEN
    RETURN public.integration_plugin_rotate_credentials_v1(
      v_plugin_version_id,
      v_auth_type,
      COALESCE(v_args->'credentials', '{}'::jsonb),
      NULLIF(v_args->>'expires_at', '')::timestamptz,
      NULLIF(btrim(v_args->>'reason'), '')
    );
  END IF;

  IF v_config_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 requires plugin_version_id or config_id'
      USING ERRCODE = '23502';
  END IF;

  IF NOT (v_args ? 'credentials') AND NULLIF(v_args->>'credentials_vault_id', '') IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 requires credentials or credentials_vault_id for config rotation'
      USING ERRCODE = '23502';
  END IF;

  v_upsert_args := jsonb_build_object('config_id', v_config_id::text);

  IF v_auth_type IS NOT NULL THEN
    v_upsert_args := v_upsert_args || jsonb_build_object('auth_type', v_auth_type);
  END IF;
  IF v_args ? 'credentials' THEN
    v_upsert_args := v_upsert_args || jsonb_build_object('credentials', v_args->'credentials');
  END IF;
  IF NULLIF(v_args->>'credentials_vault_id', '') IS NOT NULL THEN
    v_upsert_args := v_upsert_args || jsonb_build_object('credentials_vault_id', v_args->>'credentials_vault_id');
  END IF;
  IF v_args ? 'expires_at' THEN
    v_upsert_args := v_upsert_args || jsonb_build_object('expires_at', v_args->>'expires_at');
  END IF;

  v_result := public.ui_upsert_provider_auth_config_v1(v_upsert_args);
  v_result_config_id := COALESCE(v_result->>'provider_auth_config_id', v_config_id::text);

  RETURN v_result || jsonb_build_object(
    'ok', true,
    'action', 'rotated',
    'provider_auth_config_id', v_result_config_id,
    'auth_config_id', v_result_config_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.complete_label_job(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_job_id uuid := COALESCE(NULLIF(v_args->>'label_job_id', ''), NULLIF(v_args->>'job_id', ''))::uuid;
  v_input_status text := lower(NULLIF(btrim(COALESCE(v_args->>'status', 'completed')), ''));
  v_public_status text;
  v_file_url text := COALESCE(
    NULLIF(v_args->>'file_url', ''),
    NULLIF(v_args->>'artifact_url', ''),
    NULLIF(v_args->>'output_url', '')
  );
  v_file_size_bytes integer := NULLIF(v_args->>'file_size_bytes', '')::integer;
  v_renderer_metadata jsonb := CASE
    WHEN v_args ? 'renderer_metadata' THEN COALESCE(v_args->'renderer_metadata', '{}'::jsonb)
    WHEN v_args ? 'metadata' THEN COALESCE(v_args->'metadata', '{}'::jsonb)
    ELSE '{}'::jsonb
  END;
  v_error_reason text := COALESCE(NULLIF(v_args->>'error_reason', ''), NULLIF(v_args->>'reason', ''));
  v_correlation_id text;
BEGIN
  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'complete_label_job requires p_args object'
      USING ERRCODE = '22023';
  END IF;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'complete_label_job requires label_job_id'
      USING ERRCODE = '23502';
  END IF;

  v_public_status := CASE
    WHEN v_input_status IN ('completed', 'complete', 'success', 'succeeded') THEN 'succeeded'
    WHEN v_input_status IN ('error', 'errored', 'failed', 'failure') THEN 'failed'
    ELSE COALESCE(v_input_status, 'succeeded')
  END;

  PERFORM public.complete_label_job(
    v_job_id,
    v_public_status,
    v_file_url,
    v_file_size_bytes,
    v_renderer_metadata,
    v_error_reason
  );

  v_correlation_id := COALESCE(NULLIF(v_renderer_metadata #>> '{correlation_id}', ''), gen_random_uuid()::text);

  RETURN jsonb_build_object(
    'ok', true,
    'label_job_id', v_job_id,
    'status', CASE WHEN v_public_status = 'succeeded' THEN 'completed' ELSE v_public_status END,
    'correlation_id', v_correlation_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION api.integration_plugin_generate_draft_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.integration_plugin_generate_draft_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.integration_plugin_generate_draft_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.integration_plugin_rollback_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.integration_plugin_rollback_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.integration_plugin_rollback_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.integration_plugin_rotate_credentials_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.integration_plugin_rotate_credentials_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.integration_plugin_rotate_credentials_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.complete_label_job(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.complete_label_job(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.complete_label_job(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.complete_label_job(jsonb) TO service_role;

DO $grant_renderer$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.complete_label_job(jsonb) TO edge_label_renderer_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_renderer_role') THEN
    GRANT USAGE ON SCHEMA api TO label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.complete_label_job(jsonb) TO label_renderer_role;
  END IF;
END;
$grant_renderer$;

COMMENT ON FUNCTION api.integration_plugin_generate_draft_v1(jsonb)
  IS 'Console V2 api-schema jsonb wrapper for public.integration_plugin_generate_draft_v1 positional RPC.';
COMMENT ON FUNCTION api.integration_plugin_rollback_v1(jsonb)
  IS 'Console V2 api-schema jsonb wrapper for public.integration_plugin_rollback_v1 positional RPC.';
COMMENT ON FUNCTION api.integration_plugin_rotate_credentials_v1(jsonb)
  IS 'Console V2 api-schema jsonb wrapper for public.integration_plugin_rotate_credentials_v1/plugin credential rotation contracts.';
COMMENT ON FUNCTION api.complete_label_job(jsonb)
  IS 'API-schema jsonb wrapper for renderer label-job completion; service/renderer roles only.';

SELECT pg_advisory_unlock(hashtext('202605062050_console_v2_slice_c_api_rpc_shape_wrappers_v1'));

COMMIT;
