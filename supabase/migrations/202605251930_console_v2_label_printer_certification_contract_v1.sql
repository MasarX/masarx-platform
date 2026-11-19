-- Console V2 label printer certification contract.
-- Adds a schema-valid certification evidence object to label_print_profile and
-- exposes a browser-safe RPC that records evidence through the settings SSOT.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605251930_console_v2_label_printer_certification_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
LOCK TABLE public.schema_registry IN SHARE ROW EXCLUSIVE MODE;

WITH profile_schema AS (
  SELECT $$
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "label_print_profile.schema.json",
    "title": "label_print_profile",
    "type": "object",
    "required": ["version", "profile_key", "dpi"],
    "additionalProperties": false,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "profile_key": { "type": "string", "minLength": 1, "maxLength": 64 },
      "dpi": { "type": "integer", "minimum": 72, "maximum": 600 },
      "media": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "kind": { "type": "string", "enum": ["thermal", "laser", "inkjet", "unknown"] },
          "darkness": { "type": "integer", "minimum": 0, "maximum": 30 },
          "width_inch": { "type": "number", "minimum": 1, "maximum": 10 },
          "height_inch": { "type": "number", "minimum": 1, "maximum": 15 }
        }
      },
      "barcode": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "quiet_zone_modules": { "type": "integer", "minimum": 0, "maximum": 40 },
          "min_quiet_zone_modules": { "type": "integer", "minimum": 0, "maximum": 40 },
          "target_module_width_dots": { "type": "integer", "minimum": 1, "maximum": 10 },
          "hard_min_module_width_dots": { "type": "integer", "minimum": 1, "maximum": 10 }
        }
      },
      "printer_certification": {
        "type": "object",
        "required": ["certification_id", "certified_at", "evidence_reference", "printer_model", "printer_dpi", "media", "result"],
        "additionalProperties": false,
        "properties": {
          "certification_id": { "type": "string", "minLength": 1, "maxLength": 128 },
          "certified_at": { "type": "string", "minLength": 10, "maxLength": 64 },
          "evidence_reference": { "type": "string", "minLength": 1, "maxLength": 256 },
          "printer_model": { "type": "string", "minLength": 1, "maxLength": 128 },
          "printer_serial": { "type": "string", "maxLength": 128 },
          "profile_key": { "type": "string", "minLength": 1, "maxLength": 64 },
          "printer_dpi": { "type": "integer", "minimum": 72, "maximum": 600 },
          "media": {
            "type": "object",
            "additionalProperties": true
          },
          "test_artifact_ref": { "type": "string", "maxLength": 512 },
          "result": { "type": "string", "enum": ["passed", "failed", "conditional"] },
          "recorded_by_user_id": { "type": "string", "maxLength": 128 },
          "source": { "type": "string", "maxLength": 128 }
        }
      }
    }
  }
  $$::jsonb AS schema_doc,
  $$[
    {
      "version": 1,
      "profile_key": "default_203dpi",
      "dpi": 203,
      "media": { "kind": "thermal", "darkness": 18, "width_inch": 4, "height_inch": 6 },
      "barcode": { "quiet_zone_modules": 10, "min_quiet_zone_modules": 4, "target_module_width_dots": 2, "hard_min_module_width_dots": 1 },
      "printer_certification": {
        "certification_id": "cert-20260525-default-203dpi",
        "certified_at": "2026-05-25T00:00:00Z",
        "evidence_reference": "printer-lab/default-203dpi/scan-pack",
        "printer_model": "Zebra ZD421",
        "printer_dpi": 203,
        "media": { "kind": "thermal", "width_inch": 4, "height_inch": 6 },
        "result": "passed",
        "source": "console_v2_platform_labels"
      }
    }
  ]$$::jsonb AS examples
),
registered AS (
  INSERT INTO public.schema_registry (id, category, version, schema, description, examples, is_active, created_at)
  SELECT
    'cccc0000-0000-0000-0000-000000001112'::uuid,
    'label_print_profile',
    2,
    profile_schema.schema_doc,
    'Printer capability profile with optional schema-valid printer certification evidence.',
    profile_schema.examples,
    TRUE,
    workflow_now()
  FROM profile_schema
  WHERE EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'label_print_profile' AND version = 1 AND is_active
      AND schema = (profile_schema.schema_doc #- '{properties,printer_certification}')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'label_print_profile' AND version <> 1 AND is_active
  )
  ON CONFLICT (category, version) DO NOTHING
  RETURNING version
)
UPDATE public.schema_registry
   SET is_active = FALSE
 WHERE category = 'label_print_profile' AND version = 1
   AND EXISTS (SELECT 1 FROM registered);

CREATE OR REPLACE FUNCTION public.ui_record_label_printer_certification_v1(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_certification JSONB,
  p_change_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_check JSONB;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
  v_user_id UUID := auth.uid();
  v_profile JSONB;
  v_media JSONB;
  v_certification JSONB;
  v_updated_profile JSONB;
  v_schema_version INT;
  v_result RECORD;
  v_reason TEXT := COALESCE(NULLIF(BTRIM(p_change_reason), ''), 'Recorded label printer certification evidence');
BEGIN
  v_scope_check := public.label_designer_assert_scope(p_scope_type, p_scope_id);
  IF COALESCE((v_scope_check->>'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  IF NOT v_service_role
     AND NOT (
       public.user_has_capability_v1('label_design.write', p_scope_type, p_scope_id)
       OR public.user_has_capability_v1('settings.write', p_scope_type, p_scope_id)
       OR public.user_has_capability_v1('system.write', p_scope_type, p_scope_id)
       OR public.user_can_write()
     ) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object(
        'code', 'access_denied',
        'message', 'label_design.write or settings.write capability is required'
      )
    );
  END IF;

  IF p_certification IS NULL OR jsonb_typeof(p_certification) <> 'object' THEN
    RAISE EXCEPTION 'ui_record_label_printer_certification_v1 requires certification evidence object'
      USING ERRCODE = '22023';
  END IF;

  IF p_certification - ARRAY[
    'certification_id', 'certified_at', 'evidence_reference', 'printer_model',
    'printer_serial', 'printer_dpi', 'media', 'test_artifact_ref', 'result'
  ] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'ui_record_label_printer_certification_v1 received unknown evidence fields'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_certification->'evidence_reference') IS DISTINCT FROM 'string'
     OR NULLIF(BTRIM(p_certification->>'evidence_reference'), '') IS NULL THEN
    RAISE EXCEPTION 'ui_record_label_printer_certification_v1 requires evidence_reference'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_certification->'printer_model') IS DISTINCT FROM 'string'
     OR NULLIF(BTRIM(p_certification->>'printer_model'), '') IS NULL THEN
    RAISE EXCEPTION 'ui_record_label_printer_certification_v1 requires printer_model'
      USING ERRCODE = '22023';
  END IF;

  v_profile := COALESCE(public.resolve_settings_merged('label_print_profile', p_scope_type, p_scope_id), '{}'::jsonb);
  IF v_profile = '{}'::jsonb THEN
    RAISE EXCEPTION 'ui_record_label_printer_certification_v1 requires an effective label_print_profile'
      USING ERRCODE = '23514';
  END IF;

  v_media := COALESCE(p_certification->'media', v_profile->'media', '{}'::jsonb);

  v_certification := jsonb_strip_nulls(jsonb_build_object(
    'certification_id', COALESCE(NULLIF(BTRIM(p_certification->>'certification_id'), ''), gen_random_uuid()::TEXT),
    'certified_at', COALESCE(NULLIF(BTRIM(p_certification->>'certified_at'), ''), to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'evidence_reference', NULLIF(BTRIM(p_certification->>'evidence_reference'), ''),
    'printer_model', NULLIF(BTRIM(p_certification->>'printer_model'), ''),
    'printer_serial', NULLIF(BTRIM(p_certification->>'printer_serial'), ''),
    'profile_key', NULLIF(BTRIM(v_profile->>'profile_key'), ''),
    'printer_dpi', COALESCE(NULLIF(BTRIM(p_certification->>'printer_dpi'), '')::INT, NULLIF(BTRIM(v_profile->>'dpi'), '')::INT),
    'media', v_media,
    'test_artifact_ref', NULLIF(BTRIM(p_certification->>'test_artifact_ref'), ''),
    'result', COALESCE(NULLIF(BTRIM(p_certification->>'result'), ''), 'passed'),
    'recorded_by_user_id', v_user_id,
    'source', 'console_v2_platform_labels'
  ));

  IF v_certification->>'result' NOT IN ('passed', 'failed', 'conditional') THEN
    RAISE EXCEPTION 'ui_record_label_printer_certification_v1 result must be passed, failed, or conditional'
      USING ERRCODE = '22023';
  END IF;

  IF NOT (v_certification ?& ARRAY[
       'certification_id', 'certified_at', 'evidence_reference', 'printer_model',
       'printer_dpi', 'media', 'result'
     ])
     OR char_length(v_certification->>'certification_id') > 128
     OR char_length(v_certification->>'certified_at') NOT BETWEEN 10 AND 64
     OR char_length(v_certification->>'evidence_reference') > 256
     OR char_length(v_certification->>'printer_model') > 128
     OR char_length(v_certification->>'printer_serial') > 128
     OR char_length(v_certification->>'profile_key') > 64
     OR char_length(v_certification->>'test_artifact_ref') > 512
     OR (v_certification->>'printer_dpi')::INT NOT BETWEEN 72 AND 600
     OR jsonb_typeof(v_certification->'media') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'ui_record_label_printer_certification_v1 evidence does not match the printer certification contract'
      USING ERRCODE = '22023';
  END IF;

  v_updated_profile := v_profile || jsonb_build_object('printer_certification', v_certification);

  SELECT sr.version
    INTO v_schema_version
    FROM public.schema_registry sr
   WHERE sr.category = 'label_print_profile'
     AND sr.is_active = TRUE
   ORDER BY sr.version DESC
   LIMIT 1;

  IF v_schema_version IS NULL OR v_schema_version < 2 THEN
    RAISE EXCEPTION 'label_print_profile schema v2 is required for printer certification'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_result
    FROM public.upsert_settings_value_v1(
      'label_print_profile',
      p_scope_type,
      p_scope_id,
      v_updated_profile,
      v_schema_version,
      v_reason
    );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'scope_type', p_scope_type,
    'scope_id', p_scope_id,
    'settings_id', v_result.settings_id,
    'settings_version_id', v_result.settings_version_id,
    'settings_version_number', v_result.settings_version_number,
    'certification', v_certification,
    'readiness', public.ui_label_renderer_readiness_v1(p_scope_type, p_scope_id)
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_record_label_printer_certification_v1(TEXT, UUID, JSONB, TEXT)
  IS 'Records schema-valid printer certification evidence into the effective label_print_profile and returns refreshed Console V2 renderer readiness.';

REVOKE ALL ON FUNCTION public.ui_record_label_printer_certification_v1(TEXT, UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_record_label_printer_certification_v1(TEXT, UUID, JSONB, TEXT) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_record_label_printer_certification_v1(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_certification JSONB,
  p_change_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_record_label_printer_certification_v1($1, $2, $3, $4);
$function$;

REVOKE ALL ON FUNCTION api.ui_record_label_printer_certification_v1(TEXT, UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_record_label_printer_certification_v1(TEXT, UUID, JSONB, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605251930_console_v2_label_printer_certification_contract_v1'));

COMMIT;
