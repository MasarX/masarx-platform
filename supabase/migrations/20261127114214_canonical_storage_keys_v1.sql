BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('20261124165000_canonical_storage_keys_v1'));

CREATE FUNCTION public.is_organization_storage_key_v1(p_organization_id UUID, p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path TO pg_catalog
AS $function$
  SELECT COALESCE(
    p_key COLLATE "C" ~ ('^' || p_organization_id::text || '/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$')
    AND p_key !~ '(^|/)[.]{1,2}(/|$)',
    FALSE
  );
$function$;

REVOKE ALL ON FUNCTION public.is_organization_storage_key_v1(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_organization_storage_key_v1(UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_attachment_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := workflow_handlers.resolve_input_payload_v1(v_ctx);
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_attachments JSONB := CASE
    WHEN jsonb_typeof(v_ctx->'attachments') = 'array' THEN v_ctx->'attachments'
    WHEN jsonb_typeof(v_ctx->'attachment') = 'object' THEN jsonb_build_array(v_ctx->'attachment')
    WHEN jsonb_typeof(v_payload->'attachments') = 'array' THEN v_payload->'attachments'
    WHEN jsonb_typeof(v_payload->'attachment') = 'object' THEN jsonb_build_array(v_payload->'attachment')
    WHEN jsonb_typeof(v_payload#>'{shipment,attachments}') = 'array' THEN v_payload#>'{shipment,attachments}'
    WHEN jsonb_typeof(v_payload#>'{shipment,attachment}') = 'object' THEN jsonb_build_array(v_payload#>'{shipment,attachment}')
    ELSE '[]'::jsonb
  END;
  v_attachment JSONB;
  v_bucket TEXT;
  v_key TEXT;
  v_mime TEXT;
  v_size BIGINT;
  v_sha TEXT;
  v_relation_type TEXT := lower(COALESCE(NULLIF(v_policy#>>'{attachment,relation_type}', ''), 'evidence'));
  v_allowed_mime JSONB := COALESCE(v_policy#>'{attachment,allowed_mime_types}', '[]'::jsonb);
  v_max_size BIGINT := COALESCE(NULLIF(v_policy#>>'{attachment,max_size_bytes}', '')::BIGINT, 10485760);
  v_max_items INT := COALESCE(NULLIF(v_policy#>>'{attachment,max_items_per_event}', '')::INT, 10);
  v_artifact_id UUID;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
  v_attachment_count INT := 0;
  v_artifact_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;
  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  IF jsonb_typeof(v_attachments) <> 'array' OR jsonb_array_length(v_attachments) = 0 THEN
    v_result.status := 'failed';
    v_result.last_error := 'attachment_payload_invalid';
    v_result.operation_result := jsonb_build_object('error', 'attachment_payload_invalid');
    RETURN v_result;
  END IF;

  v_attachment_count := jsonb_array_length(v_attachments);
  IF v_attachment_count > v_max_items THEN
    v_result.status := 'failed';
    v_result.last_error := 'attachment_item_count_exceeded';
    v_result.operation_result := jsonb_build_object('error', 'attachment_item_count_exceeded', 'item_count', v_attachment_count, 'max_items_per_event', v_max_items);
    RETURN v_result;
  END IF;

  FOR v_attachment IN
    SELECT value
    FROM jsonb_array_elements(v_attachments)
  LOOP
    IF jsonb_typeof(v_attachment) <> 'object' THEN
      v_result.status := 'failed';
      v_result.last_error := 'attachment_payload_invalid';
      v_result.operation_result := jsonb_build_object('error', 'attachment_payload_invalid');
      RETURN v_result;
    END IF;

    v_bucket := NULLIF(v_attachment->>'storage_bucket', '');
    v_key := NULLIF(v_attachment->>'storage_key', '');
    IF v_key IS NULL AND (v_bucket IS NULL OR v_bucket = 'external_url') THEN
      v_bucket := 'external_url';
      v_key := NULLIF(v_attachment->>'content_url', '');
    END IF;
    IF NULLIF(v_attachment->>'storage_key', '') IS NOT NULL
       AND (v_bucket IS NULL OR v_bucket = 'external_url'
            OR v_bucket COLLATE "C" !~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
            OR v_ctx->>'organization_id' IS DISTINCT FROM v_target.organization_id::text
            OR NOT public.is_organization_storage_key_v1(v_target.organization_id, v_key)) THEN
      v_result.status := 'failed';
      v_result.last_error := 'attachment_storage_reference_invalid';
      v_result.operation_result := jsonb_build_object('error', 'attachment_storage_reference_invalid');
      RETURN v_result;
    END IF;
    v_mime := NULLIF(v_attachment->>'mime_type', '');
    v_sha := NULLIF(v_attachment->>'sha256', '');
    BEGIN
      v_size := NULLIF(v_attachment->>'size_bytes', '')::BIGINT;
    EXCEPTION
      WHEN others THEN
        v_size := NULL;
    END;

    IF v_bucket IS NULL OR v_key IS NULL THEN
      v_result.status := 'failed';
      v_result.last_error := 'attachment_storage_reference_missing';
      v_result.operation_result := jsonb_build_object('error', 'attachment_storage_reference_missing');
      RETURN v_result;
    END IF;

    IF v_mime IS NOT NULL
       AND jsonb_typeof(v_allowed_mime) = 'array'
       AND jsonb_array_length(v_allowed_mime) > 0
       AND NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(v_allowed_mime) AS x(value)
         WHERE lower(x.value) = lower(v_mime)
       ) THEN
      v_result.status := 'failed';
      v_result.last_error := 'attachment_mime_not_allowed';
      v_result.operation_result := jsonb_build_object('error', 'attachment_mime_not_allowed', 'mime_type', v_mime);
      RETURN v_result;
    END IF;

    IF v_size IS NOT NULL AND v_size > v_max_size THEN
      v_result.status := 'failed';
      v_result.last_error := 'attachment_size_exceeded';
      v_result.operation_result := jsonb_build_object('error', 'attachment_size_exceeded', 'size_bytes', v_size, 'max_size_bytes', v_max_size);
      RETURN v_result;
    END IF;
  END LOOP;

  FOR v_attachment IN
    SELECT value
    FROM jsonb_array_elements(v_attachments)
  LOOP
    v_bucket := NULLIF(v_attachment->>'storage_bucket', '');
    v_key := NULLIF(v_attachment->>'storage_key', '');
    IF v_key IS NULL AND (v_bucket IS NULL OR v_bucket = 'external_url') THEN
      v_bucket := 'external_url';
      v_key := NULLIF(v_attachment->>'content_url', '');
    END IF;
    v_mime := NULLIF(v_attachment->>'mime_type', '');
    v_sha := NULLIF(v_attachment->>'sha256', '');
    BEGIN
      v_size := NULLIF(v_attachment->>'size_bytes', '')::BIGINT;
    EXCEPTION
      WHEN others THEN
        v_size := NULL;
    END;

    INSERT INTO public.artifacts (
      organization_id,
      storage_bucket,
      storage_key,
      mime_type,
      size_bytes,
      sha256,
      source_system,
      metadata
    ) VALUES (
      v_target.organization_id,
      v_bucket,
      v_key,
      v_mime,
      v_size,
      v_sha,
      'shipment_update_attachment',
      COALESCE(v_attachment - 'storage_bucket' - 'storage_key' - 'content_url', '{}'::jsonb)
    )
    ON CONFLICT (organization_id, storage_bucket, storage_key) DO UPDATE
    SET mime_type = COALESCE(EXCLUDED.mime_type, public.artifacts.mime_type),
        size_bytes = COALESCE(EXCLUDED.size_bytes, public.artifacts.size_bytes),
        sha256 = COALESCE(EXCLUDED.sha256, public.artifacts.sha256),
        metadata = public.deep_merge_jsonb(COALESCE(public.artifacts.metadata, '{}'::jsonb), COALESCE(EXCLUDED.metadata, '{}'::jsonb)),
        updated_at = now()
    RETURNING id INTO v_artifact_id;

    INSERT INTO public.artifact_links (
      organization_id,
      artifact_id,
      resource_type,
      resource_id,
      relation_type,
      metadata
    ) VALUES (
      v_target.organization_id,
      v_artifact_id,
      'shipment',
      v_target.shipment_id,
      v_relation_type,
      jsonb_strip_nulls(jsonb_build_object('idempotency_key', v_event_id))
    )
    ON CONFLICT (organization_id, artifact_id, resource_type, resource_id, relation_type) DO NOTHING;

    v_artifact_ids := array_append(v_artifact_ids, v_artifact_id);
  END LOOP;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_target.shipment_id,
    'attachment_added',
    'administrative',
    jsonb_strip_nulls(jsonb_build_object(
      'idempotency_key', v_event_id,
      'artifact_ids', to_jsonb(v_artifact_ids),
      'relation_type', v_relation_type
    )),
    NULL,
    NULL,
    'workflow_handlers.execute_shipment_update_attachment_v1',
    NULL,
    NULL
  );

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'artifact_id', CASE WHEN array_length(v_artifact_ids, 1) > 0 THEN v_artifact_ids[1] ELSE NULL END,
    'artifact_ids', to_jsonb(v_artifact_ids),
    'artifact_count', COALESCE(array_length(v_artifact_ids, 1), 0),
    'shipment_action_id', v_action_id
  ));
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.register_mobile_artifact_v1(
  p_artifact JSONB
)
RETURNS TABLE (
  artifact_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_payload JSONB := COALESCE(p_artifact, '{}'::jsonb);
  v_org UUID := public.current_user_org_id();
  v_actor UUID := auth.uid();
  v_requested_org UUID := NULL;
  v_bucket TEXT := NULL;
  v_key TEXT := NULL;
  v_allowed_bucket TEXT := 'fieldops-evidence';
  v_result RECORD;
BEGIN
  IF jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_permission_v1('tasks.complete', v_org) THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 requires tasks.complete permission' USING ERRCODE = '42501';
  END IF;

  BEGIN v_requested_org := NULLIF(btrim(COALESCE(v_payload->>'organization_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_requested_org := NULL; END;
  IF v_requested_org IS NOT NULL AND v_requested_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 organization mismatch' USING ERRCODE = '42501';
  END IF;

  v_bucket := NULLIF(btrim(COALESCE(v_payload->>'storage_bucket', '')), '');
  v_key := NULLIF(v_payload->>'storage_key', '');

  IF v_bucket IS NULL OR lower(v_bucket) <> v_allowed_bucket THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 storage_bucket must be %', v_allowed_bucket USING ERRCODE = '23514';
  END IF;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 missing storage_key' USING ERRCODE = '23514';
  END IF;

  IF NOT public.is_organization_storage_key_v1(v_org, v_key) THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 storage_key must be a canonical current-organization key' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_result
    FROM public.register_artifact_v1(
      jsonb_strip_nulls(
        v_payload
        || jsonb_build_object(
          'organization_id', v_org,
          'storage_bucket', v_allowed_bucket,
          'storage_key', v_key,
          'created_by_user_id', v_actor,
          'source_system', COALESCE(NULLIF(v_payload->>'source_system', ''), 'fieldops_mobile')
        )
      )
    )
  LIMIT 1;

  RETURN QUERY SELECT v_result.artifact_id, v_result.created;
END;
$function$;

CREATE OR REPLACE FUNCTION public.register_self_kyc_artifact_v1(p_artifact JSONB)
RETURNS TABLE(artifact_id UUID) LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp AS $fn$
DECLARE v_org UUID:=public.assert_self_kyc_actor_v1(); v_meta JSONB; v_id UUID;
BEGIN
 IF jsonb_typeof(p_artifact) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'self_kyc_invalid_evidence' USING ERRCODE='22023';
 END IF;
 IF (p_artifact ? 'organization_id' AND p_artifact->>'organization_id' IS DISTINCT FROM v_org::text)
 OR (p_artifact ? 'user_id' AND p_artifact->>'user_id' IS DISTINCT FROM auth.uid()::text) THEN
  RAISE EXCEPTION 'self_kyc_forbidden' USING ERRCODE='42501';
 END IF;
 IF NOT public.is_organization_storage_key_v1(v_org,p_artifact->>'storage_key') THEN
  RAISE EXCEPTION 'self_kyc_evidence_forbidden' USING ERRCODE='42501';
 END IF;
 v_meta:=public.assert_self_kyc_object_v1(p_artifact->>'storage_bucket',p_artifact->>'storage_key');
 SELECT r.artifact_id INTO v_id FROM public.register_artifact_v1(jsonb_build_object(
  'organization_id',v_org,'storage_bucket',p_artifact->>'storage_bucket','storage_key',p_artifact->>'storage_key',
  'created_by_user_id',auth.uid(),'source_system','fieldops_self_kyc',
  'mime_type',v_meta->>'mimetype','size_bytes',v_meta->'size',
  'metadata',jsonb_build_object('subject_user_id',auth.uid(),'source','fieldops_self_kyc'))) r;
 RETURN QUERY SELECT v_id;
END;
$fn$;

-- Recreate the base after its rename and the scope resolution and profile read in 202603101530.
CREATE OR REPLACE FUNCTION public.tabular_import_prepare_base_v1(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_scope_resolution JSONB := public.ui_resolve_import_scope_context_v1(v_payload);
  v_org_id UUID := public.mapping_studio_try_uuid_v1(v_scope_resolution->>'organization_id');
  v_client_id UUID := public.mapping_studio_try_uuid_v1(v_scope_resolution->>'client_id');
  v_sender_id UUID := public.mapping_studio_try_uuid_v1(v_scope_resolution->>'sender_id');
  v_resource_key TEXT := NULLIF(btrim(COALESCE(v_payload->>'resource_key', '')), '');
  v_write_mode TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'write_mode', '')), ''), 'create'));
  v_rule_source TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'rule_source', '')), ''), 'auto'));
  v_source_format TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'source_format', '')), ''), 'csv'));
  v_source_file_name TEXT := NULLIF(btrim(COALESCE(v_payload->>'source_file_name', '')), '');
  v_source_artifact_id UUID := public.mapping_studio_try_uuid_v1(v_payload->>'source_artifact_id');
  v_sheet_name TEXT := NULLIF(btrim(COALESCE(v_payload->>'sheet_name', '')), '');
  v_header_fingerprint TEXT := NULLIF(btrim(COALESCE(v_payload->>'header_fingerprint', '')), '');
  v_headers JSONB := COALESCE(v_payload->'headers', '[]'::jsonb);
  v_rows JSONB := COALESCE(v_payload->'rows', '[]'::jsonb);
  v_rules_payload JSONB := COALESCE(v_payload->'rules', '[]'::jsonb);
  v_resource JSONB;
  v_relation TEXT;
  v_relation_schema TEXT := 'public';
  v_relation_table TEXT := NULL;
  v_id_column TEXT;
  v_scope_columns JSONB := '{}'::jsonb;
  v_capability TEXT;
  v_allow_upsert BOOLEAN := FALSE;
  v_default_write_mode TEXT := 'create';
  v_identity_columns TEXT[] := ARRAY[]::TEXT[];
  v_resource_formats TEXT[] := ARRAY[]::TEXT[];
  v_importable_columns JSONB := '[]'::jsonb;
  v_required_targets TEXT[] := ARRAY[]::TEXT[];
  v_relation_required_targets TEXT[] := ARRAY[]::TEXT[];
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_policy_formats TEXT[] := ARRAY['csv','xls','xlsx'];
  v_policy_max_rows INT := 5000;
  v_global_blocking JSONB := '[]'::jsonb;
  v_available_profiles JSONB := '[]'::jsonb;
  v_profile_match JSONB := NULL;
  v_profile_rules JSONB := '[]'::jsonb;
  v_candidate_rules JSONB := '[]'::jsonb;
  v_effective_rules JSONB := '[]'::jsonb;
  v_effective_target_keys TEXT[] := ARRAY[]::TEXT[];
  v_effective_source_headers TEXT[] := ARRAY[]::TEXT[];
  v_unmatched_headers TEXT[] := ARRAY[]::TEXT[];
  v_unresolved_targets TEXT[] := ARRAY[]::TEXT[];
  v_run_id UUID;
  v_row_item JSONB;
  v_rule JSONB;
  v_column JSONB;
  v_source_column TEXT;
  v_target_field TEXT;
  v_index INT := 0;
  v_total_rows INT := 0;
  v_will_create INT := 0;
  v_will_update INT := 0;
  v_will_skip INT := 0;
  v_blocked_count INT := 0;
  v_warning_count INT := 0;
  v_rows_preview JSONB := '[]'::jsonb;
  v_automatic_corrections JSONB := '[]'::jsonb;
  v_blocking_diagnostics JSONB := '[]'::jsonb;
  v_warning_diagnostics JSONB := '[]'::jsonb;
  v_mapped_row JSONB;
  v_diagnostics JSONB;
  v_coercions JSONB;
  v_action TEXT;
  v_execution_status TEXT;
  v_reason_codes JSONB;
  v_reason_messages JSONB;
  v_value_result JSONB;
  v_match JSONB;
  v_match_count INT;
  v_target_record_id TEXT;
  v_required_target TEXT;
  v_row_required_targets TEXT[] := ARRAY[]::TEXT[];
  v_identity_signature TEXT;
  v_seen_identity_signatures TEXT[] := ARRAY[]::TEXT[];
  v_rows_count_from_json INT := 0;
BEGIN
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires payload object';
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires organization context';
  END IF;
  IF v_resource_key IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires resource_key';
  END IF;
  IF jsonb_typeof(v_headers) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires headers array';
  END IF;
  IF jsonb_typeof(v_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires rows array';
  END IF;
  IF jsonb_typeof(v_rules_payload) IS DISTINCT FROM 'array' THEN
    v_rules_payload := '[]'::jsonb;
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_resource_key);
  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 unknown resource %', v_resource_key;
  END IF;

  IF COALESCE((v_resource#>>ARRAY['import','enabled'])::boolean, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 import disabled for resource %', v_resource_key;
  END IF;

  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), '')
  );
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, 'tenant', v_org_id);
  END IF;

  v_relation := NULLIF(btrim(COALESCE(v_resource->>'relation', '')), '');
  v_relation_schema := split_part(COALESCE(v_relation, ''), '.', 1);
  v_relation_table := split_part(COALESCE(v_relation, ''), '.', 2);
  IF NULLIF(btrim(COALESCE(v_relation_table, '')), '') IS NULL THEN
    v_relation_table := v_relation_schema;
    v_relation_schema := 'public';
  END IF;
  v_id_column := COALESCE(NULLIF(btrim(COALESCE(v_resource->>'id_column', '')), ''), 'id');
  v_scope_columns := COALESCE(v_resource->'scope_columns', '{}'::jsonb);
  v_default_write_mode := lower(COALESCE(NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','default_write_mode'], '')), ''), 'create'));
  BEGIN
    v_allow_upsert := COALESCE(NULLIF(v_resource#>>ARRAY['import','allow_upsert'], '')::boolean, FALSE);
  EXCEPTION
    WHEN OTHERS THEN
      v_allow_upsert := FALSE;
  END;

  IF v_relation IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 resource % missing relation', v_resource_key;
  END IF;

  SELECT ARRAY(
    SELECT value
    FROM jsonb_array_elements_text(COALESCE(v_resource#>'{import,identity_columns}', '[]'::jsonb)) AS value
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  ) INTO v_identity_columns;

  SELECT ARRAY(
    SELECT lower(value)
    FROM jsonb_array_elements_text(COALESCE(v_resource#>'{import,accepted_formats}', '[]'::jsonb)) AS value
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  ) INTO v_resource_formats;

  IF v_write_mode NOT IN ('create', 'upsert') THEN
    v_write_mode := v_default_write_mode;
  END IF;
  IF v_write_mode = 'upsert' AND (NOT v_allow_upsert OR array_length(v_identity_columns, 1) IS NULL) THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 upsert not allowed for resource %', v_resource_key;
  END IF;

  SELECT jsonb_agg(column_entry.value)
    INTO v_importable_columns
    FROM jsonb_array_elements(COALESCE(v_resource->'columns', '[]'::jsonb)) AS column_entry(value)
   WHERE NULLIF(btrim(COALESCE(column_entry.value->>'key', '')), '') IS NOT NULL
     AND COALESCE(
       NULLIF(column_entry.value#>>ARRAY['import','enabled'], '')::boolean,
       CASE
         WHEN lower(COALESCE(column_entry.value->>'edit_mode', '')) IN ('none', 'read') THEN FALSE
         ELSE TRUE
       END
     ) IS TRUE;

  v_importable_columns := COALESCE(v_importable_columns, '[]'::jsonb);

  SELECT ARRAY(
    SELECT value->>'key'
    FROM jsonb_array_elements(v_importable_columns) AS value
    WHERE COALESCE(NULLIF(value#>>ARRAY['import','required'], '')::boolean, FALSE) IS TRUE
      AND NULLIF(btrim(COALESCE(value->>'key', '')), '') IS NOT NULL
  ) INTO v_required_targets;

  SELECT ARRAY(
    SELECT required_key
    FROM (
      SELECT DISTINCT NULLIF(btrim(COALESCE(value->>'key', '')), '') AS required_key
      FROM jsonb_array_elements(v_importable_columns) AS value
      JOIN pg_namespace n
        ON n.nspname = v_relation_schema
      JOIN pg_class c
        ON c.relnamespace = n.oid
       AND c.relname = v_relation_table
      JOIN pg_attribute a
        ON a.attrelid = c.oid
       AND a.attname = value->>'key'
       AND a.attnum > 0
       AND a.attisdropped = FALSE
      LEFT JOIN pg_attrdef ad
        ON ad.adrelid = a.attrelid
       AND ad.adnum = a.attnum
      WHERE NULLIF(btrim(COALESCE(value->>'key', '')), '') IS NOT NULL
        AND a.attnotnull IS TRUE
        AND COALESCE(a.attidentity, '') = ''
        AND COALESCE(a.attgenerated, '') = ''
        AND ad.adbin IS NULL
        AND value->>'key' <> v_id_column
        AND NOT (
          (v_scope_columns ? 'tenant' AND v_scope_columns->>'tenant' = value->>'key' AND v_org_id IS NOT NULL)
          OR (v_scope_columns ? 'client' AND v_scope_columns->>'client' = value->>'key' AND v_client_id IS NOT NULL)
          OR (v_scope_columns ? 'sender' AND v_scope_columns->>'sender' = value->>'key' AND v_sender_id IS NOT NULL)
        )
    ) AS required_columns
    WHERE required_key IS NOT NULL
    ORDER BY required_key
  ) INTO v_relation_required_targets;

  IF v_scope_columns ? 'client' AND v_client_id IS NULL THEN
    v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'client', '')), '');
    IF v_target_field IS NOT NULL AND NOT (v_target_field = ANY(v_required_targets)) THEN
      v_required_targets := array_append(v_required_targets, v_target_field);
    END IF;
  END IF;

  IF v_scope_columns ? 'sender' AND v_sender_id IS NULL THEN
    v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'sender', '')), '');
    IF v_target_field IS NOT NULL AND NOT (v_target_field = ANY(v_required_targets)) THEN
      v_required_targets := array_append(v_required_targets, v_target_field);
    END IF;
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_tabular_import_policy_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'organization_id', v_org_id,
          'client_id', v_client_id,
          'sender_id', v_sender_id,
          'resource_key', v_resource_key
        )
      )
    )
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);
  SELECT ARRAY(
    SELECT lower(value)
    FROM jsonb_array_elements_text(COALESCE(v_policy->'accepted_formats', '[]'::jsonb)) AS value
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  ) INTO v_policy_formats;

  BEGIN
    v_policy_max_rows := COALESCE(NULLIF(v_policy->>'max_rows', '')::int, v_policy_max_rows);
  EXCEPTION
    WHEN OTHERS THEN
      v_policy_max_rows := 5000;
  END;

  IF v_source_format IS NULL OR v_source_format NOT IN ('csv', 'xls', 'xlsx') THEN
    v_global_blocking := v_global_blocking || jsonb_build_array(
      jsonb_build_object(
        'level', 'error',
        'blocking', TRUE,
        'code', 'source_format_invalid',
        'message', 'Unsupported import format.',
        'why', 'The uploaded file format is not supported by the tabular import runtime.',
        'recommended_fix', 'Upload a CSV, XLS, or XLSX file.'
      )
    );
  ELSIF NOT (v_source_format = ANY(v_policy_formats)) OR NOT (v_source_format = ANY(v_resource_formats)) THEN
    v_global_blocking := v_global_blocking || jsonb_build_array(
      jsonb_build_object(
        'level', 'error',
        'blocking', TRUE,
        'code', 'source_format_not_allowed',
        'message', 'This resource does not allow the uploaded file format.',
        'why', 'The import policy or resource contract rejected the selected source format.',
        'recommended_fix', 'Use one of the allowed formats for this resource.'
      )
    );
  END IF;

  SELECT count(*) INTO v_rows_count_from_json FROM jsonb_array_elements(v_rows);

  IF v_rows_count_from_json = 0 THEN
    v_global_blocking := v_global_blocking || jsonb_build_array(
      jsonb_build_object(
        'level', 'error',
        'blocking', TRUE,
        'code', 'rows_missing',
        'message', 'No rows were detected in the uploaded file.',
        'why', 'The source workbook did not produce any importable rows.',
        'recommended_fix', 'Upload a file with headers and at least one data row.'
      )
    );
  ELSIF v_rows_count_from_json > v_policy_max_rows THEN
    v_global_blocking := v_global_blocking || jsonb_build_array(
      jsonb_build_object(
        'level', 'error',
        'blocking', TRUE,
        'code', 'rows_limit_exceeded',
        'message', format('This import contains %s rows which exceeds the configured limit.', v_rows_count_from_json),
        'why', 'The resolved tabular import policy limits the maximum rows per import.',
        'recommended_fix', format('Reduce the file to %s rows or fewer, or update the tabular import policy.', v_policy_max_rows)
      )
    );
  END IF;

  IF v_header_fingerprint IS NULL THEN
    SELECT string_agg(normalized_header, '|' ORDER BY normalized_header)
      INTO v_header_fingerprint
      FROM (
        SELECT regexp_replace(lower(btrim(value)), '[^a-z0-9]+', '_', 'g') AS normalized_header
        FROM jsonb_array_elements_text(v_headers) AS value
        WHERE NULLIF(btrim(value), '') IS NOT NULL
      ) normalized;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', profile.id,
        'profile_name', profile.profile_name,
        'profile_slug', profile.profile_slug,
        'header_fingerprint', profile.header_fingerprint,
        'sheet_hint', profile.sheet_hint,
        'write_mode', profile.write_mode,
        'mapping_key', profile.mapping_key,
        'mapping_config', profile.mapping_config,
        'created_at', profile.created_at,
        'updated_at', profile.updated_at
      )
      ORDER BY profile.updated_at DESC, profile.created_at DESC
    ),
    '[]'::jsonb
  )
    INTO v_available_profiles
    FROM public.ui_tabular_import_profiles_v1(v_resource_key, COALESCE(v_payload->'scope_context', '{}'::jsonb)) profile;

  SELECT value
    INTO v_profile_match
    FROM jsonb_array_elements(v_available_profiles) AS value
   WHERE COALESCE(value->>'header_fingerprint', '') = COALESCE(v_header_fingerprint, '')
   ORDER BY COALESCE(value->>'updated_at', value->>'created_at', '') DESC
   LIMIT 1;

  IF v_profile_match IS NOT NULL AND jsonb_typeof(v_profile_match#>'{mapping_config,field_rules}') = 'array' THEN
    v_profile_rules := COALESCE(v_profile_match#>'{mapping_config,field_rules}', '[]'::jsonb);
  END IF;

  v_candidate_rules := COALESCE(v_rules_payload, '[]'::jsonb);
  IF jsonb_typeof(v_candidate_rules) IS DISTINCT FROM 'array' THEN
    v_candidate_rules := '[]'::jsonb;
  END IF;

  IF v_rule_source <> 'manual'
     AND jsonb_typeof(v_profile_rules) = 'array'
     AND jsonb_array_length(v_profile_rules) > 0 THEN
    v_effective_rules := v_profile_rules;
    v_rule_source := 'profile';
  ELSIF jsonb_array_length(v_candidate_rules) > 0 THEN
    v_effective_rules := v_candidate_rules;
    v_rule_source := CASE WHEN v_rule_source = 'manual' THEN 'manual' ELSE 'auto' END;
  ELSE
    v_effective_rules := '[]'::jsonb;
    v_rule_source := 'auto';
  END IF;

  IF jsonb_typeof(v_effective_rules) IS DISTINCT FROM 'array' THEN
    v_effective_rules := '[]'::jsonb;
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT NULLIF(btrim(COALESCE(value->>'target_field', '')), '')
    FROM jsonb_array_elements(v_effective_rules) AS value
    WHERE COALESCE(value->>'enabled', 'true') <> 'false'
      AND NULLIF(btrim(COALESCE(value->>'target_field', '')), '') IS NOT NULL
  ) INTO v_effective_target_keys;

  SELECT ARRAY(
    SELECT DISTINCT NULLIF(btrim(COALESCE(value->>'source_column', '')), '')
    FROM jsonb_array_elements(v_effective_rules) AS value
    WHERE COALESCE(value->>'enabled', 'true') <> 'false'
      AND NULLIF(btrim(COALESCE(value->>'source_column', '')), '') IS NOT NULL
  ) INTO v_effective_source_headers;

  SELECT ARRAY(
    SELECT header_value
    FROM jsonb_array_elements_text(v_headers) AS header_value
    WHERE NOT (header_value = ANY(COALESCE(v_effective_source_headers, ARRAY[]::TEXT[])))
  ) INTO v_unmatched_headers;

  SELECT ARRAY(
    SELECT target_key
    FROM unnest(COALESCE(v_required_targets, ARRAY[]::TEXT[])) AS target_key
    WHERE NOT (target_key = ANY(COALESCE(v_effective_target_keys, ARRAY[]::TEXT[])))
      AND NOT (
        (v_scope_columns ? 'tenant' AND v_scope_columns->>'tenant' = target_key AND v_org_id IS NOT NULL)
        OR (v_scope_columns ? 'client' AND v_scope_columns->>'client' = target_key AND v_client_id IS NOT NULL)
        OR (v_scope_columns ? 'sender' AND v_scope_columns->>'sender' = target_key AND v_sender_id IS NOT NULL)
      )
  ) INTO v_unresolved_targets;

  IF array_length(v_unresolved_targets, 1) IS NOT NULL THEN
    v_global_blocking := v_global_blocking || (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'level', 'error',
          'blocking', TRUE,
          'code', 'target_unresolved',
          'fieldPath', target_key,
          'message', format('Required target %s is not mapped.', target_key),
          'why', 'The dry-run could not find a source value for a required target field.',
          'recommended_fix', 'Map a source column to this field or provide the missing scope context before approval.'
        )
      ), '[]'::jsonb)
      FROM unnest(v_unresolved_targets) AS target_key
    );
  END IF;

  IF v_source_artifact_id IS NOT NULL THEN
    PERFORM 1
      FROM public.artifacts a
     WHERE a.id = v_source_artifact_id
       AND a.organization_id = v_org_id
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tabular_import_prepare_v1 source artifact is unavailable for this organization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.tabular_import_runs (
    organization_id,
    client_id,
    sender_id,
    resource_key,
    relation_name,
    write_mode,
    status,
    profile_name,
    header_fingerprint,
    sheet_name,
    source_format,
    source_file_name,
    source_artifact_id,
    summary,
    created_by,
    updated_by
  )
  VALUES (
    v_org_id,
    v_client_id,
    v_sender_id,
    v_resource_key,
    v_relation,
    v_write_mode,
    'prepared',
    NULLIF(btrim(COALESCE(v_profile_match->>'profile_name', '')), ''),
    v_header_fingerprint,
    v_sheet_name,
    v_source_format,
    v_source_file_name,
    v_source_artifact_id,
    jsonb_strip_nulls(jsonb_build_object('rule_source', v_rule_source, 'headers', v_headers)),
    v_user_id,
    v_user_id
  )
  RETURNING id INTO v_run_id;

  IF v_source_artifact_id IS NOT NULL THEN
    INSERT INTO public.artifact_links (
      organization_id,
      artifact_id,
      resource_type,
      resource_id,
      relation_type,
      metadata
    )
    VALUES (
      v_org_id,
      v_source_artifact_id,
      'tabular_import_runs',
      v_run_id,
      'source',
      jsonb_build_object('file_name', v_source_file_name, 'sheet_name', v_sheet_name)
    )
    ON CONFLICT (organization_id, artifact_id, resource_type, resource_id, relation_type) DO NOTHING;
  END IF;

  FOR v_row_item IN
    SELECT value
    FROM jsonb_array_elements(v_rows) AS value
  LOOP
    v_index := v_index + 1;
    IF jsonb_typeof(v_row_item) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_total_rows := v_total_rows + 1;
    v_mapped_row := '{}'::jsonb;
    v_diagnostics := COALESCE(v_global_blocking, '[]'::jsonb);
    v_coercions := '[]'::jsonb;

    FOR v_rule IN
      SELECT value
      FROM jsonb_array_elements(v_effective_rules) AS value
    LOOP
      v_source_column := v_rule->>'source_column';
      v_target_field := v_rule->>'target_field';
      v_column := public.tabular_import_resolve_column_v1(v_importable_columns, v_target_field);
      IF v_column IS NULL THEN
        CONTINUE;
      END IF;

      v_value_result := public.tabular_import_coerce_value_v1(v_row_item -> v_source_column, v_column, v_source_column);
      IF v_value_result ? 'diagnostics' THEN
        v_diagnostics := v_diagnostics || COALESCE(v_value_result->'diagnostics', '[]'::jsonb);
      END IF;
      IF v_value_result ? 'coercion' THEN
        v_coercions := v_coercions || jsonb_build_array(v_value_result->'coercion');
      END IF;
      IF v_value_result ? 'value' THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], COALESCE(v_value_result->'value', 'null'::jsonb), TRUE);
      END IF;
    END LOOP;

    IF v_scope_columns ? 'tenant' AND v_org_id IS NOT NULL THEN
      v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'tenant', '')), '');
      IF v_target_field IS NOT NULL AND NOT (v_mapped_row ? v_target_field) THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], to_jsonb(v_org_id), TRUE);
      END IF;
    END IF;
    IF v_scope_columns ? 'client' AND v_client_id IS NOT NULL THEN
      v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'client', '')), '');
      IF v_target_field IS NOT NULL AND NOT (v_mapped_row ? v_target_field) THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], to_jsonb(v_client_id), TRUE);
      END IF;
    END IF;
    IF v_scope_columns ? 'sender' AND v_sender_id IS NOT NULL THEN
      v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'sender', '')), '');
      IF v_target_field IS NOT NULL AND NOT (v_mapped_row ? v_target_field) THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], to_jsonb(v_sender_id), TRUE);
      END IF;
    END IF;

    v_target_record_id := NULL;
    v_match_count := 0;
    IF array_length(v_identity_columns, 1) IS NOT NULL THEN
      v_identity_signature := NULL;
      IF NOT EXISTS (
        SELECT 1
        FROM unnest(v_identity_columns) AS identity_key
        WHERE NOT (v_mapped_row ? identity_key)
           OR v_mapped_row->identity_key IS NULL
           OR v_mapped_row->identity_key = 'null'::jsonb
      ) THEN
        SELECT string_agg(COALESCE(v_mapped_row->>identity_key, ''), '||' ORDER BY identity_key)
          INTO v_identity_signature
          FROM unnest(v_identity_columns) AS identity_key;
      END IF;

      IF v_identity_signature IS NOT NULL THEN
        IF v_identity_signature = ANY(v_seen_identity_signatures) THEN
          v_diagnostics := v_diagnostics || jsonb_build_array(
            jsonb_build_object(
              'level', 'error',
              'blocking', TRUE,
              'code', 'duplicate_identity_in_file',
              'message', format('Row %s duplicates an earlier identity in the same file.', v_index),
              'why', 'The import file contains multiple rows with the same configured identity columns.',
              'recommended_fix', 'Remove the duplicate row or consolidate the source data before import.'
            )
          );
        ELSE
          v_seen_identity_signatures := array_append(v_seen_identity_signatures, v_identity_signature);
        END IF;
      END IF;

      IF v_diagnostics = '[]'::jsonb OR NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
      ) THEN
        v_match := public.tabular_import_match_target_v1(v_relation, v_id_column, v_mapped_row, v_identity_columns);
        BEGIN
          v_match_count := COALESCE(NULLIF(v_match->>'match_count', '')::int, 0);
        EXCEPTION
          WHEN OTHERS THEN
            v_match_count := 0;
        END;
        v_target_record_id := NULLIF(btrim(COALESCE(v_match->>'target_record_id', '')), '');

        IF v_write_mode = 'upsert' THEN
          IF v_match_count > 1 THEN
            v_diagnostics := v_diagnostics || jsonb_build_array(
              jsonb_build_object(
                'level', 'error',
                'blocking', TRUE,
                'code', 'identity_match_ambiguous',
                'message', format('Row %s matched more than one existing record.', v_index),
                'why', 'Configured upsert identity columns resolved to multiple target rows.',
                'recommended_fix', 'Tighten the identity columns or clean the target data before import.'
              )
            );
          END IF;
        ELSIF v_write_mode = 'create' AND v_match_count > 0 THEN
          v_diagnostics := v_diagnostics || jsonb_build_array(
            jsonb_build_object(
              'level', 'warning',
              'blocking', FALSE,
              'code', 'existing_identity_conflict',
              'message', format('Row %s matches an existing record and will be skipped in create mode.', v_index),
              'why', 'Create mode does not overwrite or update rows that already exist.',
              'recommended_fix', 'Switch to upsert for this resource or remove existing duplicates before import.'
            )
          );
        END IF;
      END IF;
    END IF;

    v_row_required_targets := COALESCE(v_required_targets, ARRAY[]::TEXT[]);
    IF v_match_count = 0 THEN
      SELECT ARRAY(
        SELECT target_key
        FROM (
          SELECT DISTINCT NULLIF(btrim(COALESCE(target_key, '')), '') AS target_key
          FROM unnest(COALESCE(v_row_required_targets, ARRAY[]::TEXT[]) || COALESCE(v_relation_required_targets, ARRAY[]::TEXT[])) AS target_key
        ) AS required_targets
        WHERE target_key IS NOT NULL
        ORDER BY target_key
      ) INTO v_row_required_targets;
    END IF;

    FOREACH v_required_target IN ARRAY COALESCE(v_row_required_targets, ARRAY[]::TEXT[])
    LOOP
      IF NOT (v_mapped_row ? v_required_target)
         OR v_mapped_row->v_required_target IS NULL
         OR v_mapped_row->v_required_target = 'null'::jsonb
         OR (jsonb_typeof(v_mapped_row->v_required_target) = 'string' AND NULLIF(btrim(v_mapped_row->>v_required_target), '') IS NULL) THEN
        v_diagnostics := v_diagnostics || jsonb_build_array(
          jsonb_build_object(
            'level', 'error',
            'blocking', TRUE,
            'code', 'required_field_missing',
            'fieldPath', v_required_target,
            'message', format('Required field %s is missing on row %s.', v_required_target, v_index),
            'why', 'The mapped row does not contain a value for a required target column.',
            'recommended_fix', 'Provide a source value for this field or fix the mapping before approval.'
          )
        );
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_diagnostics) AS diag
      WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
    ) THEN
      v_action := 'block';
      v_execution_status := 'blocked';
      v_blocked_count := v_blocked_count + 1;
    ELSIF v_write_mode = 'create' AND v_match_count > 0 THEN
      v_action := 'skip';
      v_execution_status := 'skipped';
      v_will_skip := v_will_skip + 1;
    ELSIF v_write_mode = 'upsert' AND v_match_count = 1 THEN
      v_action := 'update';
      v_execution_status := 'queued';
      v_will_update := v_will_update + 1;
    ELSE
      v_action := 'create';
      v_execution_status := 'queued';
      v_will_create := v_will_create + 1;
    END IF;

    SELECT COALESCE(jsonb_agg(diag->>'code'), '[]'::jsonb),
           COALESCE(jsonb_agg(diag->>'message'), '[]'::jsonb)
      INTO v_reason_codes, v_reason_messages
      FROM jsonb_array_elements(v_diagnostics) AS diag;

    INSERT INTO public.tabular_import_run_rows (
      run_id,
      organization_id,
      row_number,
      action,
      execution_status,
      original_row,
      mapped_row,
      diagnostics,
      coercions,
      target_record_id,
      reason_codes,
      reason_messages,
      metadata
    )
    VALUES (
      v_run_id,
      v_org_id,
      v_index,
      v_action,
      v_execution_status,
      v_row_item,
      v_mapped_row,
      v_diagnostics,
      v_coercions,
      v_target_record_id,
      COALESCE(v_reason_codes, '[]'::jsonb),
      COALESCE(v_reason_messages, '[]'::jsonb),
      jsonb_build_object('match_count', v_match_count)
    );

    IF v_index <= 25 THEN
      v_rows_preview := v_rows_preview || jsonb_build_array(
        jsonb_build_object(
          'row_number', v_index,
          'execution_status', v_execution_status,
          'action', v_action,
          'diagnostics', v_diagnostics,
          'coercions', v_coercions,
          'mapped_row', v_mapped_row,
          'target_record_id', v_target_record_id,
          'reason_codes', COALESCE(v_reason_codes, '[]'::jsonb),
          'reason_messages', COALESCE(v_reason_messages, '[]'::jsonb)
        )
      );
    END IF;

    IF jsonb_array_length(v_coercions) > 0 THEN
      v_automatic_corrections := v_automatic_corrections || v_coercions;
    END IF;

    IF jsonb_array_length(v_diagnostics) > 0 THEN
      v_warning_count := v_warning_count + COALESCE((
        SELECT count(*)
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE lower(COALESCE(diag->>'level', '')) = 'warning'
      ), 0);
      v_blocking_diagnostics := v_blocking_diagnostics || COALESCE((
        SELECT jsonb_agg(diag)
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
      ), '[]'::jsonb);
      v_warning_diagnostics := v_warning_diagnostics || COALESCE((
        SELECT jsonb_agg(diag)
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE lower(COALESCE(diag->>'level', '')) = 'warning'
      ), '[]'::jsonb);
    END IF;
  END LOOP;

  UPDATE public.tabular_import_runs
     SET total_rows = v_total_rows,
         will_create = v_will_create,
         will_update = v_will_update,
         will_skip = v_will_skip,
         blocked_count = v_blocked_count,
         warning_count = v_warning_count,
         summary = jsonb_strip_nulls(
           COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
             'headers', v_headers,
             'resolved_rules', v_effective_rules,
             'profile_match', v_profile_match,
             'available_profiles', v_available_profiles,
             'unmatched_headers', to_jsonb(COALESCE(v_unmatched_headers, ARRAY[]::TEXT[])),
             'unresolved_targets', to_jsonb(COALESCE(v_unresolved_targets, ARRAY[]::TEXT[])),
             'write_mode', v_write_mode,
             'sheet_name', v_sheet_name,
             'source_file_name', v_source_file_name,
             'source_format', v_source_format
           )
         ),
         updated_at = now(),
         updated_by = v_user_id
   WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'resource', v_resource_key,
    'write_mode', v_write_mode,
    'source_format', v_source_format,
    'source_file_name', v_source_file_name,
    'header_fingerprint', v_header_fingerprint,
    'sheet_name', v_sheet_name,
    'unmatched_headers', to_jsonb(COALESCE(v_unmatched_headers, ARRAY[]::TEXT[])),
    'unresolved_targets', to_jsonb(COALESCE(v_unresolved_targets, ARRAY[]::TEXT[])),
    'total_rows', v_total_rows,
    'will_create', v_will_create,
    'will_update', v_will_update,
    'will_skip', v_will_skip,
    'blocked_count', v_blocked_count,
    'warning_count', v_warning_count,
    'automatic_corrections', COALESCE(v_automatic_corrections, '[]'::jsonb),
    'blocking_diagnostics', COALESCE(v_blocking_diagnostics, '[]'::jsonb),
    'warning_diagnostics', COALESCE(v_warning_diagnostics, '[]'::jsonb),
    'rows', COALESCE(v_rows_preview, '[]'::jsonb),
    'profile', v_profile_match,
    'available_profiles', COALESCE(v_available_profiles, '[]'::jsonb),
    'resolved_rules', COALESCE(v_effective_rules, '[]'::jsonb)
  );
END;
$function$;

-- Preserve failed-output admission and renderer HTTP result handling on the scoped status response.
CREATE OR REPLACE FUNCTION public.ui_get_workflow_run_output_status_v1(
  p_workflow_run_id UUID,
  p_output_url_paths TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();
  v_run RECORD;
  v_context JSONB := '{}'::jsonb;
  v_metadata JSONB := '{}'::jsonb;
  v_step_result JSONB := '{}'::jsonb;
  v_detail JSONB := '{}'::jsonb;
  v_path TEXT;
  v_segments TEXT[];
  v_value TEXT;
  v_output_url TEXT := NULL;
  v_output_file_path TEXT := NULL;
  v_output_bucket TEXT := 'labels';
  v_output_needs_signing BOOLEAN := FALSE;
  v_output_source TEXT := NULL;
  v_default_paths TEXT[] := ARRAY[
      'context.generated_labels[0].download_url',
      'context.generated_labels[0].url',
      'context.outputs[0].download_url',
      'context.outputs[0].url',
      'context.output.url',
      'context.label_print.execute_response.bundle.signed_url',
      'context.label_print.execute_response.bundle.file_url',
      'context.label_print.bundle_response.signed_url',
      'context.label_print.bundle_response.file_url',
      'metadata.generated_labels[0].download_url',
      'metadata.generated_labels[0].url',
      'metadata.outputs[0].download_url',
      'metadata.outputs[0].url',
      'metadata.output.url',
      'metadata.label_print.execute_response.bundle.signed_url',
      'metadata.label_print.execute_response.bundle.file_url',
      'metadata.label_print.bundle_response.signed_url',
      'metadata.label_print.bundle_response.file_url',
      'execute_result.bundle.signed_url',
      'execute_result.bundle.output_url',
      'execute_result.bundle.file_url',
      'step_result.signed_url',
      'step_result.output_url',
      'step_result.file_url',
      'step_result.execute.bundle.signed_url',
      'step_result.execute.bundle.output_url',
      'step_result.execute.bundle.file_url',
      'step_result.bundle.signed_url',
      'step_result.bundle.output_url',
      'step_result.bundle.file_url',
      'step_result.bundle.output_file_url',
      'execute_async_body.bundle.signed_url',
      'execute_async_body.bundle.output_url',
      'execute_async_body.bundle.file_url',
      'execute_async_body.bundle.output_file_url',
      'execute_async_response.body.bundle.signed_url',
      'execute_async_response.body.bundle.output_url',
      'execute_async_response.body.bundle.file_url',
      'execute_async_response.body.bundle.output_file_url',
      'async_body.bundle.signed_url',
      'async_body.bundle.output_url',
      'async_body.bundle.file_url',
      'async_body.bundle.output_file_url',
      'async_body.signed_url',
      'async_body.output_url',
      'async_response.body.bundle.signed_url',
      'async_response.body.bundle.output_url',
      'async_response.body.bundle.file_url',
      'async_response.body.bundle.output_file_url',
      'async_response.body.signed_url',
      'async_response.body.output_url'
    ]::TEXT[];
  v_fresh_paths TEXT[] := ARRAY[
      'context.label_print.execute_response.bundle.signed_url',
      'context.label_print.execute_response.bundle.file_url',
      'context.label_print.bundle_response.signed_url',
      'context.label_print.bundle_response.file_url',
      'metadata.label_print.execute_response.bundle.signed_url',
      'metadata.label_print.execute_response.bundle.file_url',
      'metadata.label_print.bundle_response.signed_url',
      'metadata.label_print.bundle_response.file_url',
      'execute_result.bundle.signed_url',
      'execute_result.bundle.output_url',
      'execute_result.bundle.file_url',
      'step_result.signed_url',
      'step_result.output_url',
      'step_result.file_url',
      'step_result.execute.bundle.signed_url',
      'step_result.execute.bundle.output_url',
      'step_result.execute.bundle.file_url',
      'step_result.bundle.signed_url',
      'step_result.bundle.output_url',
      'step_result.bundle.file_url',
      'step_result.bundle.output_file_url',
      'execute_async_body.bundle.signed_url',
      'execute_async_body.bundle.output_url',
      'execute_async_body.bundle.file_url',
      'execute_async_body.bundle.output_file_url',
      'execute_async_response.body.bundle.signed_url',
      'execute_async_response.body.bundle.output_url',
      'execute_async_response.body.bundle.file_url',
      'execute_async_response.body.bundle.output_file_url',
      'async_body.bundle.signed_url',
      'async_body.bundle.output_url',
      'async_body.bundle.file_url',
      'async_body.bundle.output_file_url',
      'async_body.signed_url',
      'async_body.output_url',
      'async_response.body.bundle.signed_url',
      'async_response.body.bundle.output_url',
      'async_response.body.bundle.file_url',
      'async_response.body.bundle.output_file_url',
      'async_response.body.signed_url',
      'async_response.body.output_url'
    ]::TEXT[];
  v_file_path_paths TEXT[] := ARRAY[
      'context.label_print.execute_response.bundle.file_path',
      'context.label_print.bundle_response.file_path',
      'metadata.label_print.execute_response.bundle.file_path',
      'metadata.label_print.bundle_response.file_path',
      'execute_result.bundle.file_path',
      'step_result.execute.bundle.file_path',
      'step_result.file_path',
      'step_result.bundle.file_path',
      'execute_async_body.bundle.file_path',
      'execute_async_response.body.bundle.file_path',
      'async_body.bundle.file_path',
      'async_response.body.bundle.file_path'
    ]::TEXT[];
  v_paths TEXT[] := NULL;
  v_pending_text TEXT := '';
  v_ready_text TEXT := '';
  v_pending_count INT := NULL;
  v_ready_count INT := NULL;
  v_phase TEXT := 'checking';
  v_terminal BOOLEAN := FALSE;
  v_failure_reason TEXT := NULL;
  v_run_org_raw TEXT := '';
  v_run_org_id UUID := NULL;
  v_status_checked_at TIMESTAMPTZ := clock_timestamp();
  v_function_total_raw TEXT := '';
  v_function_total_ms NUMERIC := NULL;
  v_execute_result JSONB := '{}'::jsonb;
  v_execute_request_raw TEXT := '';
  v_execute_request_id BIGINT := NULL;
  v_execute_async_response JSONB := '{}'::jsonb;
  v_execute_async_body JSONB := '{}'::jsonb;
  v_execute_async_completed BOOLEAN := FALSE;
  v_execute_step_id UUID := NULL;
  v_execute_step_raw TEXT := '';
  v_execute_step_status TEXT := NULL;
  v_execute_progress_result JSONB := NULL;
  v_execute_progress_attempted BOOLEAN := FALSE;
  v_execute_progress_status TEXT := NULL;
  v_execute_progress_error TEXT := NULL;
  v_async_request_raw TEXT := '';
  v_async_request_id BIGINT := NULL;
  v_async_response JSONB := '{}'::jsonb;
  v_async_body JSONB := '{}'::jsonb;
  v_async_completed BOOLEAN := FALSE;
  v_fresh_generation_required BOOLEAN := FALSE;
  v_fresh_resolve_mode TEXT := '';
  v_fresh_scope_key_raw TEXT := '';
  v_fresh_scope_step_id UUID := NULL;
  v_fresh_state JSONB := '{}'::jsonb;
  v_fresh_expected_count INT := 0;
  v_fresh_ready_count INT := 0;
  v_fresh_failed_count INT := 0;
  v_fresh_only_resolved BOOLEAN := FALSE;
  v_stage_prepare_ms NUMERIC := NULL;
  v_stage_execute_ms NUMERIC := NULL;
  v_stage_enqueue_ms NUMERIC := NULL;
  v_stage_render_ms NUMERIC := NULL;
  v_stage_bundle_ms NUMERIC := NULL;
  v_stage_complete_ms NUMERIC := NULL;
  v_stage_render_wait_ms NUMERIC := NULL;
  v_stage_bundle_wait_ms NUMERIC := NULL;
  v_stage_finalize_ms NUMERIC := NULL;
  v_artifact_persisted BOOLEAN := FALSE;
  v_job_completion_pending BOOLEAN := FALSE;
  v_timing_source TEXT := NULL;
  v_ready_source TEXT := NULL;
  v_prepare_duration_raw TEXT := '';
  v_execute_duration_raw TEXT := '';
  v_bundle_duration_raw TEXT := '';
  v_finalize_duration_raw TEXT := '';
  v_bundle_requested_raw TEXT := '';
  v_bundle_requested_count INT := NULL;
  v_bundle_bundled_raw TEXT := '';
  v_bundle_bundled_count INT := NULL;
  v_bundle_request_label_count INT := NULL;
  v_bundle_response JSONB := '{}'::jsonb;
  v_bundle_step_id UUID := NULL;
  v_bundle_step_raw TEXT := '';
  v_bundle_step_status TEXT := NULL;
  v_bundle_progress_budget_ms INT := 1200;
  v_bundle_progress_max_steps INT := 10;
  v_bundle_progress_result JSONB := NULL;
  v_bundle_progress_attempted BOOLEAN := FALSE;
  v_bundle_progress_status TEXT := NULL;
  v_bundle_progress_error TEXT := NULL;
  v_bundle_payload JSONB := '{}'::jsonb;
  v_poll_progress_enabled BOOLEAN := FALSE;
  v_poll_progress_budget_ms INT := 350;
  v_poll_progress_max_steps INT := 8;
  v_poll_progress_result JSONB := NULL;
  v_poll_progress_attempted BOOLEAN := FALSE;
  v_poll_progress_status TEXT := NULL;
  v_poll_progress_error TEXT := NULL;
  v_poll_progress_managed BOOLEAN := FALSE;
  v_print_mode TEXT := NULL;
  v_artifact_kind TEXT := NULL;
  v_reload_attempt INT := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 requires authenticated user';
  END IF;
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 requires workflow_run_id';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.read', v_scope_type, v_scope_id);

  <<reload_run>>
  FOR v_reload_attempt IN 1..4 LOOP
    SELECT
      wr.id,
      wr.workflow_status,
      wr.context,
      wr.metadata,
      wr.failure_reason,
      wr.last_error,
      wts.operation_name AS current_operation
    INTO v_run
    FROM public.workflow_runs wr
    LEFT JOIN public.workflow_template_steps wts ON wts.id = wr.current_step_id
    WHERE wr.id = p_workflow_run_id
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 workflow_run not found %', p_workflow_run_id;
    END IF;

    v_context := COALESCE(v_run.context, '{}'::jsonb);
    v_metadata := COALESCE(v_run.metadata, '{}'::jsonb);

    v_run_org_raw := COALESCE(v_context->>'organization_id', '');
    IF v_run_org_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      v_run_org_id := v_run_org_raw::UUID;
    ELSE
      v_run_org_id := NULL;
    END IF;

    IF NOT public.is_platform_user() THEN
      IF v_org_id IS NULL OR v_run_org_id IS NULL OR v_run_org_id IS DISTINCT FROM v_org_id THEN
        RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 access denied for workflow_run %', p_workflow_run_id;
      END IF;
    END IF;

    IF lower(COALESCE(NULLIF(v_context #>> '{ui_command,params,poll_progress_enabled}', ''), '')) IN ('1', 't', 'true', 'y', 'yes', 'on') THEN
      v_poll_progress_enabled := TRUE;
    ELSE
      v_poll_progress_enabled := FALSE;
    END IF;
    v_poll_progress_managed := v_poll_progress_enabled;

    IF COALESCE(v_context #>> '{ui_command,params,poll_progress_budget_ms}', '') ~ '^\d+$' THEN
      v_poll_progress_budget_ms := LEAST(
        GREATEST((v_context #>> '{ui_command,params,poll_progress_budget_ms}')::INT, 25),
        5000
      );
    END IF;
    IF COALESCE(v_context #>> '{ui_command,params,poll_progress_max_steps}', '') ~ '^\d+$' THEN
      v_poll_progress_max_steps := LEAST(
        GREATEST((v_context #>> '{ui_command,params,poll_progress_max_steps}')::INT, 1),
        50
      );
    END IF;

    IF v_reload_attempt = 1
       AND v_poll_progress_enabled
       AND COALESCE(v_run.workflow_status, '') NOT IN ('completed', 'failed', 'cancelled')
       AND NOT v_poll_progress_attempted THEN
      BEGIN
        v_poll_progress_result := public.progress_workflow_run_until_wait_v1(
          p_workflow_run_id,
          '{}'::jsonb,
          v_poll_progress_budget_ms,
          v_poll_progress_max_steps
        );
        v_poll_progress_attempted := TRUE;
        v_poll_progress_status := NULLIF(v_poll_progress_result->>'status', '');
      EXCEPTION
        WHEN OTHERS THEN
          v_poll_progress_attempted := TRUE;
          v_poll_progress_error := SQLERRM;
      END;
      CONTINUE reload_run;
    END IF;

    SELECT COALESCE(wrs.operation_result, '{}'::jsonb)
    INTO v_step_result
    FROM public.workflow_run_steps wrs
    WHERE wrs.workflow_run_id = p_workflow_run_id
      AND wrs.handler_key IN ('label_print_finalize', 'label_print_execute', 'label_bundle')
    ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
    LIMIT 1;

    v_execute_result := COALESCE(v_context #> '{label_print,execute_response}', '{}'::jsonb);
    IF COALESCE(jsonb_typeof(v_execute_result), '') IS DISTINCT FROM 'object' OR v_execute_result = '{}'::jsonb THEN
      SELECT COALESCE(
               CASE
                 WHEN jsonb_typeof(wrs.operation_result->'execute') = 'object' THEN wrs.operation_result->'execute'
                 ELSE wrs.operation_result
               END,
               '{}'::jsonb
             )
      INTO v_execute_result
      FROM public.workflow_run_steps wrs
      WHERE wrs.workflow_run_id = p_workflow_run_id
        AND wrs.handler_key = 'label_print_execute'
      ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
      LIMIT 1;
    END IF;

    v_execute_request_raw := COALESCE(
      NULLIF(v_context #>> '{label_print,execute_async,request_id}', ''),
      NULLIF(v_metadata #>> '{label_print,execute_async,request_id}', '')
    );
    v_execute_request_id := NULL;
    v_execute_async_response := '{}'::jsonb;
    v_execute_async_body := '{}'::jsonb;
    v_execute_async_completed := FALSE;

    IF v_execute_request_raw ~ '^[0-9]+$' THEN
      v_execute_request_id := v_execute_request_raw::BIGINT;
      BEGIN
        v_execute_async_response := COALESCE(public.check_async_response(v_execute_request_id), '{}'::jsonb);
        v_execute_async_completed := COALESCE((v_execute_async_response->>'completed')::BOOLEAN, FALSE);
        IF v_execute_async_completed
           AND COALESCE((v_execute_async_response->>'status')::int, 0) NOT BETWEEN 200 AND 299 THEN
          v_execute_async_body := jsonb_build_object(
            'status', 'failed', 'error', 'label_print_execute_http_error',
            'http_status', COALESCE((v_execute_async_response->>'status')::int, 0));
          v_execute_async_response := jsonb_set(v_execute_async_response, '{body}', v_execute_async_body);
        ELSIF jsonb_typeof(v_execute_async_response->'body') = 'object' THEN
          v_execute_async_body := v_execute_async_response->'body';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_execute_async_response := '{}'::jsonb;
        v_execute_async_body := '{}'::jsonb;
        v_execute_async_completed := FALSE;
      END;
    END IF;

    v_async_request_raw := COALESCE(
      NULLIF(v_context #>> '{label_print,bundle_async,request_id}', ''),
      NULLIF(v_metadata #>> '{label_print,bundle_async,request_id}', '')
    );
    v_async_request_id := NULL;
    v_async_response := '{}'::jsonb;
    v_async_body := '{}'::jsonb;
    v_async_completed := FALSE;

    IF v_async_request_raw ~ '^[0-9]+$' THEN
      v_async_request_id := v_async_request_raw::BIGINT;
      BEGIN
        v_async_response := COALESCE(public.check_async_response(v_async_request_id), '{}'::jsonb);
        v_async_completed := COALESCE((v_async_response->>'completed')::BOOLEAN, FALSE);
        IF v_async_completed
           AND COALESCE((v_async_response->>'status')::int, 0) NOT BETWEEN 200 AND 299 THEN
          v_async_body := jsonb_build_object(
            'status', 'failed', 'error', 'label_print_execute_http_error',
            'http_status', COALESCE((v_async_response->>'status')::int, 0));
          v_async_response := jsonb_set(v_async_response, '{body}', v_async_body);
        ELSIF jsonb_typeof(v_async_response->'body') = 'object' THEN
          v_async_body := v_async_response->'body';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_async_response := '{}'::jsonb;
        v_async_body := '{}'::jsonb;
        v_async_completed := FALSE;
      END;
    END IF;

    v_bundle_response := COALESCE(v_context #> '{label_print,bundle_response}', '{}'::jsonb);
    IF COALESCE(jsonb_typeof(v_bundle_response), '') IS DISTINCT FROM 'object' OR v_bundle_response = '{}'::jsonb THEN
      v_bundle_response := COALESCE(
        CASE WHEN jsonb_typeof(v_execute_result->'bundle') = 'object' THEN v_execute_result->'bundle' ELSE NULL END,
        CASE WHEN jsonb_typeof(v_step_result->'bundle') = 'object' THEN v_step_result->'bundle' ELSE NULL END,
        '{}'::jsonb
      );
    END IF;

    IF v_reload_attempt <= 3
       AND v_execute_request_id IS NOT NULL
       AND v_execute_async_completed
       AND NOT v_execute_progress_attempted
       AND (
         COALESCE(jsonb_typeof(v_execute_result), '') IS DISTINCT FROM 'object'
         OR v_execute_result = '{}'::jsonb
         OR lower(COALESCE(NULLIF(v_execute_result->>'status', ''), 'pending')) IN ('pending', 'waiting', 'in_progress')
         OR COALESCE(
           NULLIF(v_execute_result #>> '{bundle,signed_url}', ''),
           NULLIF(v_execute_result #>> '{bundle,output_url}', ''),
           NULLIF(v_execute_result #>> '{bundle,file_url}', ''),
           NULLIF(v_execute_result #>> '{bundle,output_file_url}', ''),
           NULLIF(v_execute_result #>> '{bundle,file_path}', '')
         ) IS NULL
       ) THEN
      v_execute_step_raw := COALESCE(
        NULLIF(v_context #>> '{label_print,execute_async,request_payload,print,workflow_run_step_id}', ''),
        NULLIF(v_metadata #>> '{label_print,execute_async,request_payload,print,workflow_run_step_id}', ''),
        NULLIF(v_context #>> '{label_print,fresh_request_scope_key}', ''),
        NULLIF(v_metadata #>> '{label_print,fresh_request_scope_key}', '')
      );
      IF v_execute_step_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        v_execute_step_id := v_execute_step_raw::UUID;
      ELSE
        SELECT wrs.id
        INTO v_execute_step_id
        FROM public.workflow_run_steps wrs
        WHERE wrs.workflow_run_id = p_workflow_run_id
          AND wrs.handler_key = 'label_print_execute'
        ORDER BY wrs.sequence_order DESC
        LIMIT 1;
      END IF;

      IF v_execute_step_id IS NOT NULL THEN
        SELECT wrs.step_status
        INTO v_execute_step_status
        FROM public.workflow_run_steps wrs
        WHERE wrs.id = v_execute_step_id
          AND wrs.workflow_run_id = p_workflow_run_id
        LIMIT 1;

        IF v_execute_step_status = 'pending' THEN
          v_execute_progress_attempted := TRUE;
          BEGIN
            v_execute_progress_result := public.progress_workflow_run_step_result_v1(
              p_workflow_run_id,
              v_execute_step_id,
              jsonb_strip_nulls(jsonb_build_object(
                'status', CASE
                  WHEN lower(COALESCE(v_execute_async_body->>'status', '')) IN ('failed', 'error')
                       OR NULLIF(v_execute_async_body->>'error', '') IS NOT NULL
                  THEN 'failed'
                  ELSE 'completed'
                END,
                'source', 'ui_status_execute_async_reconcile',
                'print_mode', COALESCE(NULLIF(v_execute_async_body->>'mode', ''), 'print_sync'),
                'artifact_kind', COALESCE(NULLIF(v_execute_async_body->>'artifact_kind', ''), NULLIF(v_execute_async_body #>> '{bundle,artifact_kind}', '')),
                'execute', v_execute_async_body,
                'bundle', CASE
                  WHEN jsonb_typeof(v_execute_async_body->'bundle') = 'object' THEN v_execute_async_body->'bundle'
                  ELSE NULL
                END
              )),
              v_poll_progress_budget_ms,
              v_poll_progress_max_steps
            );
            v_execute_progress_status := NULLIF(v_execute_progress_result->>'status', '');
          EXCEPTION
            WHEN OTHERS THEN
              v_execute_progress_error := SQLERRM;
          END;
          CONTINUE reload_run;
        END IF;
      END IF;
    END IF;

    IF v_reload_attempt <= 3
       AND v_async_request_id IS NOT NULL
       AND v_async_completed
       AND NOT v_bundle_progress_attempted
       AND COALESCE(jsonb_typeof(v_bundle_response), '') = 'object'
       AND v_bundle_response = '{}'::jsonb THEN
      v_bundle_step_raw := COALESCE(
        NULLIF(v_context #>> '{label_print,bundle_async,request_payload,bundle,workflow_run_step_id}', ''),
        NULLIF(v_metadata #>> '{label_print,bundle_async,request_payload,bundle,workflow_run_step_id}', '')
      );
      IF v_bundle_step_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        v_bundle_step_id := v_bundle_step_raw::UUID;
      ELSE
        SELECT wrs.id
        INTO v_bundle_step_id
        FROM public.workflow_run_steps wrs
        WHERE wrs.workflow_run_id = p_workflow_run_id
          AND wrs.handler_key = 'label_bundle'
        ORDER BY wrs.sequence_order DESC
        LIMIT 1;
      END IF;

      IF COALESCE(v_context #>> '{label_print,bundle_async,request_payload,bundle,workflow_progress_budget_ms}', '') ~ '^\d+$' THEN
        v_bundle_progress_budget_ms := LEAST(
          GREATEST((v_context #>> '{label_print,bundle_async,request_payload,bundle,workflow_progress_budget_ms}')::INT, 25),
          5000
        );
      END IF;
      IF COALESCE(v_context #>> '{label_print,bundle_async,request_payload,bundle,workflow_progress_max_steps}', '') ~ '^\d+$' THEN
        v_bundle_progress_max_steps := LEAST(
          GREATEST((v_context #>> '{label_print,bundle_async,request_payload,bundle,workflow_progress_max_steps}')::INT, 1),
          50
        );
      END IF;

      IF v_bundle_step_id IS NOT NULL THEN
        SELECT wrs.step_status
        INTO v_bundle_step_status
        FROM public.workflow_run_steps wrs
        WHERE wrs.id = v_bundle_step_id
          AND wrs.workflow_run_id = p_workflow_run_id
        LIMIT 1;

        IF v_bundle_step_status = 'pending' THEN
          v_bundle_payload := COALESCE(v_async_body->'bundle', v_async_body, '{}'::jsonb);
          v_bundle_progress_attempted := TRUE;
          BEGIN
            v_bundle_progress_result := public.progress_workflow_run_step_result_v1(
              p_workflow_run_id,
              v_bundle_step_id,
              jsonb_strip_nulls(jsonb_build_object(
                'status', CASE
                  WHEN lower(COALESCE(v_bundle_payload->>'status', v_async_body->>'status', '')) IN ('failed', 'error')
                       OR NULLIF(v_async_body->>'error', '') IS NOT NULL
                  THEN 'failed'
                  ELSE 'completed'
                END,
                'source', 'ui_status_bundle_async_reconcile',
                'bundle', v_bundle_payload
              )),
              v_bundle_progress_budget_ms,
              v_bundle_progress_max_steps
            );
            v_bundle_progress_status := NULLIF(v_bundle_progress_result->>'status', '');
          EXCEPTION
            WHEN OTHERS THEN
              v_bundle_progress_error := SQLERRM;
          END;
          CONTINUE reload_run;
        END IF;
      END IF;
    END IF;

    EXIT reload_run;
  END LOOP;

  v_fresh_generation_required := COALESCE((v_context #>> '{label_print,fresh_generation_required}')::BOOLEAN, FALSE);
  v_fresh_resolve_mode := lower(COALESCE(NULLIF(v_context #>> '{label_print,fresh_resolve_mode}', ''), ''));
  v_fresh_scope_key_raw := COALESCE(
    NULLIF(v_context #>> '{label_print,fresh_request_scope_key}', ''),
    NULLIF(v_metadata #>> '{label_print,fresh_request_scope_key}', '')
  );
  IF v_fresh_scope_key_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_fresh_scope_step_id := v_fresh_scope_key_raw::uuid;
  END IF;

  IF v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only' AND v_fresh_scope_step_id IS NOT NULL THEN
    v_fresh_state := public.resolve_label_print_fresh_scope_v1(
      v_fresh_scope_step_id,
      COALESCE(v_context->'label_print'->'targets', v_metadata->'label_print'->'targets', '[]'::jsonb)
    );
    v_fresh_expected_count := COALESCE(NULLIF(v_fresh_state->>'expected_count', '')::INT, 0);
    v_fresh_ready_count := COALESCE(NULLIF(v_fresh_state->>'ready_count', '')::INT, 0);
    v_fresh_failed_count := COALESCE(NULLIF(v_fresh_state->>'failed_count', '')::INT, 0);
    v_pending_count := COALESCE(NULLIF(v_fresh_state->>'pending_count', '')::INT, 0);
    v_ready_count := v_fresh_ready_count;
    v_fresh_only_resolved := TRUE;
  ELSE
    v_pending_text := COALESCE(v_context #>> '{label_print,counts,pending}', '');
    IF v_pending_text ~ '^\d+$' THEN
      v_pending_count := v_pending_text::INT;
    END IF;

    v_ready_text := COALESCE(v_context #>> '{label_print,counts,ready}', '');
    IF v_ready_text ~ '^\d+$' THEN
      v_ready_count := v_ready_text::INT;
    END IF;
  END IF;

  v_detail := jsonb_build_object(
    'context', v_context,
    'metadata', v_metadata,
    'execute_result', COALESCE(v_execute_result, '{}'::jsonb),
    'step_result', COALESCE(v_step_result, '{}'::jsonb),
    'execute_async_response', COALESCE(v_execute_async_response, '{}'::jsonb),
    'execute_async_body', COALESCE(v_execute_async_body, '{}'::jsonb),
    'async_response', COALESCE(v_async_response, '{}'::jsonb),
    'async_body', COALESCE(v_async_body, '{}'::jsonb)
  );

  v_paths := CASE
    WHEN v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only' THEN v_fresh_paths
    WHEN p_output_url_paths IS NULL OR array_length(p_output_url_paths, 1) IS NULL THEN v_default_paths
    ELSE p_output_url_paths || v_default_paths
  END;

  FOREACH v_path IN ARRAY v_paths LOOP
    v_path := btrim(COALESCE(v_path, ''));
    IF v_path = '' THEN
      CONTINUE;
    END IF;

    v_segments := string_to_array(regexp_replace(v_path, '\\[(\\d+)\\]', '.\\1', 'g'), '.');
    IF v_segments IS NULL OR array_length(v_segments, 1) IS NULL THEN
      CONTINUE;
    END IF;

    v_value := NULLIF(btrim(v_detail #>> v_segments), '');
    IF v_value ~* '^https?://' THEN
      v_output_url := v_value;
      IF v_path LIKE 'context.%' THEN
        v_output_source := 'context';
      ELSIF v_path LIKE 'metadata.%' THEN
        v_output_source := 'metadata';
      ELSIF v_path LIKE 'execute_result.%' THEN
        v_output_source := 'execute_result';
      ELSIF v_path LIKE 'step_result.%' THEN
        v_output_source := 'step_result';
      ELSIF v_path LIKE 'execute_async_body.%' OR v_path LIKE 'execute_async_response.%' THEN
        v_output_source := 'execute_async_response';
      ELSIF v_path LIKE 'async_body.%' OR v_path LIKE 'async_response.%' THEN
        v_output_source := 'async_response';
      ELSE
        v_output_source := 'unknown';
      END IF;
      EXIT;
    END IF;
  END LOOP;

  v_bundle_requested_raw := COALESCE(
    NULLIF(v_context #>> '{label_print,execute_response,bundle,counts,requested}', ''),
    NULLIF(v_context #>> '{label_print,bundle_response,counts,requested}', ''),
    NULLIF(v_metadata #>> '{label_print,execute_response,bundle,counts,requested}', ''),
    NULLIF(v_metadata #>> '{label_print,bundle_response,counts,requested}', ''),
    NULLIF(v_execute_result #>> '{bundle,counts,requested}', ''),
    NULLIF(v_step_result #>> '{counts,requested}', ''),
    NULLIF(v_step_result #>> '{execute,bundle,counts,requested}', ''),
    NULLIF(v_step_result #>> '{bundle,counts,requested}', ''),
    NULLIF(v_execute_async_body #>> '{counts,requested}', ''),
    NULLIF(v_execute_async_body #>> '{bundle,counts,requested}', ''),
    NULLIF(v_execute_async_response #>> '{body,counts,requested}', ''),
    NULLIF(v_execute_async_response #>> '{body,bundle,counts,requested}', ''),
    NULLIF(v_async_body #>> '{counts,requested}', ''),
    NULLIF(v_async_body #>> '{bundle,counts,requested}', ''),
    NULLIF(v_async_response #>> '{body,counts,requested}', ''),
    NULLIF(v_async_response #>> '{body,bundle,counts,requested}', '')
  );
  IF v_bundle_requested_raw ~ '^\d+$' THEN
    v_bundle_requested_count := v_bundle_requested_raw::INT;
  END IF;

  v_bundle_bundled_raw := COALESCE(
    NULLIF(v_context #>> '{label_print,execute_response,bundle,counts,bundled}', ''),
    NULLIF(v_context #>> '{label_print,bundle_response,counts,bundled}', ''),
    NULLIF(v_metadata #>> '{label_print,execute_response,bundle,counts,bundled}', ''),
    NULLIF(v_metadata #>> '{label_print,bundle_response,counts,bundled}', ''),
    NULLIF(v_execute_result #>> '{bundle,counts,bundled}', ''),
    NULLIF(v_step_result #>> '{counts,bundled}', ''),
    NULLIF(v_step_result #>> '{execute,bundle,counts,bundled}', ''),
    NULLIF(v_step_result #>> '{bundle,counts,bundled}', ''),
    NULLIF(v_execute_async_body #>> '{counts,bundled}', ''),
    NULLIF(v_execute_async_body #>> '{bundle,counts,bundled}', ''),
    NULLIF(v_execute_async_response #>> '{body,counts,bundled}', ''),
    NULLIF(v_execute_async_response #>> '{body,bundle,counts,bundled}', ''),
    NULLIF(v_async_body #>> '{counts,bundled}', ''),
    NULLIF(v_async_body #>> '{bundle,counts,bundled}', ''),
    NULLIF(v_async_response #>> '{body,counts,bundled}', ''),
    NULLIF(v_async_response #>> '{body,bundle,counts,bundled}', '')
  );
  IF v_bundle_bundled_raw ~ '^\d+$' THEN
    v_bundle_bundled_count := v_bundle_bundled_raw::INT;
  END IF;

  IF jsonb_typeof(v_context #> '{label_print,bundle_async,request_payload,bundle,label_ids}') = 'array' THEN
    v_bundle_request_label_count := jsonb_array_length(v_context #> '{label_print,bundle_async,request_payload,bundle,label_ids}');
  ELSIF jsonb_typeof(v_metadata #> '{label_print,bundle_async,request_payload,bundle,label_ids}') = 'array' THEN
    v_bundle_request_label_count := jsonb_array_length(v_metadata #> '{label_print,bundle_async,request_payload,bundle,label_ids}');
  END IF;

  IF v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only' THEN
    IF v_pending_count > 0 OR v_fresh_ready_count < v_fresh_expected_count THEN
      v_output_url := NULL;
      v_output_source := NULL;
    ELSIF v_fresh_expected_count > 0 AND (
      (v_bundle_requested_count IS NOT NULL AND v_bundle_requested_count < v_fresh_expected_count)
      OR (v_bundle_bundled_count IS NOT NULL AND v_bundle_bundled_count < v_fresh_expected_count)
      OR (v_bundle_request_label_count IS NOT NULL AND v_bundle_request_label_count < v_fresh_expected_count)
    ) THEN
      v_output_url := NULL;
      v_output_source := NULL;
    END IF;
  END IF;

  SELECT COALESCE(
           NULLIF(wrs.operation_result #>> '{execute,timings,total_ms}', ''),
           NULLIF(wrs.operation_result #>> '{timings,total_ms}', ''),
           CASE
             WHEN wrs.duration_ms IS NOT NULL THEN wrs.duration_ms::text
             ELSE NULL
           END
         )
  INTO v_execute_duration_raw
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_workflow_run_id
    AND wrs.handler_key = 'label_print_execute'
  ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
  LIMIT 1;
  IF COALESCE(v_execute_duration_raw, '') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_stage_execute_ms := v_execute_duration_raw::numeric;
  END IF;

  SELECT COALESCE(
           NULLIF(wrs.operation_result #>> '{duration_ms}', ''),
           CASE
             WHEN wrs.duration_ms IS NOT NULL THEN wrs.duration_ms::text
             ELSE NULL
           END
         )
  INTO v_prepare_duration_raw
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_workflow_run_id
    AND wrs.handler_key = 'label_print_prepare'
  ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
  LIMIT 1;
  IF COALESCE(v_prepare_duration_raw, '') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_stage_prepare_ms := v_prepare_duration_raw::numeric;
  END IF;

  SELECT COALESCE(
           NULLIF(wrs.operation_result #>> '{bundle,timings,total_ms}', ''),
           NULLIF(wrs.operation_result #>> '{timings,total_ms}', ''),
           CASE
             WHEN wrs.duration_ms IS NOT NULL THEN wrs.duration_ms::text
             ELSE NULL
           END
         )
  INTO v_bundle_duration_raw
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_workflow_run_id
    AND wrs.handler_key = 'label_bundle'
  ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
  LIMIT 1;
  IF COALESCE(v_bundle_duration_raw, '') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_stage_bundle_wait_ms := v_bundle_duration_raw::numeric;
  END IF;

  SELECT COALESCE(
           NULLIF(wrs.operation_result #>> '{duration_ms}', ''),
           CASE
             WHEN wrs.duration_ms IS NOT NULL THEN wrs.duration_ms::text
             ELSE NULL
           END
         )
  INTO v_finalize_duration_raw
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_workflow_run_id
    AND wrs.handler_key = 'label_print_finalize'
  ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
  LIMIT 1;
  IF COALESCE(v_finalize_duration_raw, '') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_stage_finalize_ms := v_finalize_duration_raw::numeric;
  END IF;

  BEGIN
    v_stage_enqueue_ms := NULLIF(
      COALESCE(
        NULLIF(v_context #>> '{label_print,execute_response,timings,enqueue_ms}', ''),
        NULLIF(v_execute_result #>> '{timings,enqueue_ms}', ''),
        NULLIF(v_context #>> '{label_print,execute_response,steps,0,duration_ms}', ''),
        NULLIF(v_execute_result #>> '{steps,0,duration_ms}', ''),
        NULLIF(v_step_result #>> '{execute,timings,enqueue_ms}', ''),
        NULLIF(v_step_result #>> '{execute,steps,0,duration_ms}', ''),
        NULLIF(v_execute_async_body #>> '{timings,enqueue_ms}', ''),
        NULLIF(v_execute_async_body #>> '{steps,0,duration_ms}', ''),
        NULLIF(v_execute_async_response #>> '{body,timings,enqueue_ms}', '')
      ),
      ''
    )::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_stage_enqueue_ms := NULL;
  END;
  IF v_stage_enqueue_ms IS NULL THEN
    BEGIN
      SELECT NULLIF(step_elem->>'duration_ms', '')::numeric
      INTO v_stage_enqueue_ms
      FROM jsonb_array_elements(
        COALESCE(
          v_execute_result->'steps',
          v_step_result->'execute'->'steps',
          v_execute_async_body->'steps',
          v_execute_async_response #> '{body,steps}',
          '[]'::jsonb
        )
      ) AS step_elem
      WHERE step_elem->>'step' = 'enqueue_label_jobs'
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_stage_enqueue_ms := NULL;
    END;
  END IF;
  BEGIN
    v_stage_render_ms := NULLIF(
      COALESCE(
        NULLIF(v_context #>> '{label_print,execute_response,timings,render_ms}', ''),
        NULLIF(v_context #>> '{label_print,execute_response,bundle,timings,render_ms}', ''),
        NULLIF(v_execute_result #>> '{timings,render_ms}', ''),
        NULLIF(v_execute_result #>> '{bundle,timings,render_ms}', ''),
        NULLIF(v_step_result #>> '{execute,timings,render_ms}', ''),
        NULLIF(v_step_result #>> '{execute,bundle,timings,render_ms}', ''),
        NULLIF(v_execute_async_body #>> '{timings,render_ms}', ''),
        NULLIF(v_execute_async_body #>> '{bundle,timings,render_ms}', ''),
        NULLIF(v_execute_async_response #>> '{body,timings,render_ms}', '')
      ),
      ''
    )::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_stage_render_ms := NULL;
  END;
  IF v_stage_render_ms IS NULL THEN
    BEGIN
      SELECT COALESCE(
        NULLIF(step_elem->>'duration_ms', '')::numeric,
        NULLIF(step_elem #>> '{calls,0,render_ms}', '')::numeric
      )
      INTO v_stage_render_ms
      FROM jsonb_array_elements(
        COALESCE(
          v_execute_result->'steps',
          v_step_result->'execute'->'steps',
          v_execute_async_body->'steps',
          v_execute_async_response #> '{body,steps}',
          '[]'::jsonb
        )
      ) AS step_elem
      WHERE step_elem->>'step' = 'render_label_jobs'
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_stage_render_ms := NULL;
    END;
  END IF;
  BEGIN
    v_stage_bundle_ms := NULLIF(
      COALESCE(
        NULLIF(v_context #>> '{label_print,execute_response,timings,bundle_ms}', ''),
        NULLIF(v_context #>> '{label_print,execute_response,bundle,timings,total_ms}', ''),
        NULLIF(v_execute_result #>> '{timings,bundle_ms}', ''),
        NULLIF(v_execute_result #>> '{bundle,timings,total_ms}', ''),
        NULLIF(v_step_result #>> '{execute,timings,bundle_ms}', ''),
        NULLIF(v_step_result #>> '{execute,bundle,timings,total_ms}', ''),
        NULLIF(v_execute_async_body #>> '{timings,bundle_ms}', ''),
        NULLIF(v_execute_async_body #>> '{bundle,timings,total_ms}', ''),
        NULLIF(v_execute_async_response #>> '{body,timings,bundle_ms}', ''),
        NULLIF(v_execute_async_response #>> '{body,bundle,timings,total_ms}', '')
      ),
      ''
    )::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_stage_bundle_ms := NULL;
  END;
  BEGIN
    v_stage_complete_ms := NULLIF(
      COALESCE(
        NULLIF(v_context #>> '{label_print,execute_response,timings,complete_ms}', ''),
        NULLIF(v_execute_result #>> '{timings,complete_ms}', ''),
        NULLIF(v_step_result #>> '{execute,timings,complete_ms}', ''),
        NULLIF(v_execute_async_body #>> '{timings,complete_ms}', ''),
        NULLIF(v_execute_async_response #>> '{body,timings,complete_ms}', '')
      ),
      ''
    )::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_stage_complete_ms := NULL;
  END;

  v_print_mode := COALESCE(
    NULLIF(v_context #>> '{label_print,print_mode}', ''),
    NULLIF(v_execute_result->>'mode', ''),
    NULLIF(v_step_result->>'print_mode', ''),
    NULLIF(v_step_result #>> '{execute,mode}', ''),
    NULLIF(v_execute_async_body->>'mode', ''),
    'print_sync'
  );
  v_artifact_kind := COALESCE(
    NULLIF(v_context #>> '{label_print,artifact_kind}', ''),
    NULLIF(v_execute_result->>'artifact_kind', ''),
    NULLIF(v_execute_result #>> '{bundle,artifact_kind}', ''),
    NULLIF(v_step_result->>'artifact_kind', ''),
    NULLIF(v_step_result #>> '{execute,artifact_kind}', ''),
    NULLIF(v_step_result #>> '{execute,bundle,artifact_kind}', ''),
    NULLIF(v_execute_async_body->>'artifact_kind', ''),
    NULLIF(v_execute_async_body #>> '{bundle,artifact_kind}', ''),
    NULLIF(v_bundle_response->>'artifact_kind', '')
  );

  IF COALESCE(v_fresh_state->>'render_wait_ms', '') ~ '^\d+$' THEN
    v_stage_render_wait_ms := (v_fresh_state->>'render_wait_ms')::numeric;
  END IF;
  IF v_stage_render_wait_ms IS NULL THEN
    v_stage_render_wait_ms := v_stage_render_ms;
  END IF;
  IF v_stage_bundle_wait_ms IS NULL THEN
    v_stage_bundle_wait_ms := COALESCE(v_stage_bundle_ms, v_stage_execute_ms);
  END IF;
  IF v_stage_complete_ms IS NULL THEN
    v_stage_complete_ms := v_stage_finalize_ms;
  END IF;

  v_terminal := COALESCE(v_run.workflow_status, '') IN ('completed', 'failed', 'cancelled');
  IF v_output_url IS NULL
     AND v_output_file_path IS NULL
     AND v_terminal
     AND (
       (v_execute_request_id IS NOT NULL AND NOT v_execute_async_completed)
       OR (v_async_request_id IS NOT NULL AND NOT v_async_completed)
     ) THEN
    v_terminal := FALSE;
  END IF;

  IF COALESCE(v_run.workflow_status, '') IN ('failed', 'cancelled') THEN
    v_phase := 'failed';
  ELSIF v_output_url IS NOT NULL THEN
    v_phase := 'downloading';
  ELSIF v_output_file_path IS NOT NULL THEN
    v_phase := 'downloading';
  ELSIF v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only' AND v_pending_count > 0 THEN
    v_phase := 'generating';
  ELSIF v_execute_request_id IS NOT NULL AND NOT v_execute_async_completed THEN
    v_phase := 'generating';
  ELSIF v_async_request_id IS NOT NULL AND NOT v_async_completed THEN
    v_phase := 'bundling';
  ELSIF COALESCE(v_run.current_operation, '') IN ('label_print_prepare', 'execute_label_print') THEN
    v_phase := 'generating';
  ELSIF COALESCE(v_run.current_operation, '') IN ('label_bundle', 'label_print_finalize') THEN
    v_phase := 'bundling';
  ELSE
    v_phase := 'checking';
  END IF;

  IF COALESCE(v_run.workflow_status, '') IN ('failed', 'cancelled') THEN
    v_failure_reason := COALESCE(
      NULLIF(v_run.failure_reason, ''),
      NULLIF(v_run.last_error::TEXT, ''),
      format('workflow_status=%s', v_run.workflow_status)
    );
  ELSIF v_fresh_generation_required AND v_fresh_failed_count > 0 THEN
    v_failure_reason := 'label_jobs_failed';
  ELSIF v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only'
        AND v_fresh_expected_count > 0
        AND (
          (v_bundle_requested_count IS NOT NULL AND v_bundle_requested_count < v_fresh_expected_count)
          OR (v_bundle_bundled_count IS NOT NULL AND v_bundle_bundled_count < v_fresh_expected_count)
          OR (v_bundle_request_label_count IS NOT NULL AND v_bundle_request_label_count < v_fresh_expected_count)
        ) THEN
    v_failure_reason := 'incomplete_fresh_bundle_response';
  END IF;

  IF v_output_url IS NULL THEN
    FOREACH v_path IN ARRAY v_file_path_paths LOOP
      v_path := btrim(COALESCE(v_path, ''));
      IF v_path = '' THEN
        CONTINUE;
      END IF;

      v_segments := string_to_array(regexp_replace(v_path, '\\[(\\d+)\\]', '.\\1', 'g'), '.');
      IF v_segments IS NULL OR array_length(v_segments, 1) IS NULL THEN
        CONTINUE;
      END IF;

      v_value := NULLIF(btrim(v_detail #>> v_segments), '');
      IF v_value IS NOT NULL AND v_value !~* '^https?://' THEN
        v_output_file_path := v_value;
        IF v_path LIKE 'context.%' THEN
          v_output_source := 'context';
        ELSIF v_path LIKE 'metadata.%' THEN
          v_output_source := 'metadata';
        ELSIF v_path LIKE 'execute_result.%' THEN
          v_output_source := 'execute_result';
        ELSIF v_path LIKE 'step_result.%' THEN
          v_output_source := 'step_result';
        ELSIF v_path LIKE 'execute_async_body.%' OR v_path LIKE 'execute_async_response.%' THEN
          v_output_source := 'execute_async_response';
        ELSIF v_path LIKE 'async_body.%' OR v_path LIKE 'async_response.%' THEN
          v_output_source := 'async_response';
        ELSE
          v_output_source := 'file_path';
        END IF;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_output_url IS NULL
     AND v_output_file_path IS NULL
     AND v_fresh_generation_required
     AND v_fresh_resolve_mode = 'workflow_scope_only'
     AND v_fresh_expected_count = 1
     AND v_fresh_ready_count = 1 THEN
    v_output_file_path := NULLIF(v_fresh_state #>> '{ready,0,file_url}', '');
    IF v_output_file_path ~* '^https?://' THEN
      v_output_url := v_output_file_path;
      v_output_file_path := NULL;
      v_output_source := 'fresh_ready_url';
    ELSIF v_output_file_path IS NOT NULL THEN
      v_output_source := 'fresh_ready_file';
      v_output_needs_signing := TRUE;
    END IF;
  END IF;

  IF v_output_file_path IS NOT NULL THEN
    v_output_needs_signing := TRUE;
    IF v_phase <> 'failed' THEN
      v_phase := 'downloading';
    END IF;
  END IF;

  IF COALESCE(v_run.workflow_status, '') = 'completed' AND v_output_url IS NULL AND v_output_file_path IS NULL THEN
    IF (v_execute_request_id IS NOT NULL AND NOT v_execute_async_completed)
       OR (v_async_request_id IS NOT NULL AND NOT v_async_completed) THEN
      v_failure_reason := NULL;
    ELSIF NULLIF(v_execute_async_body->>'error', '') IS NOT NULL THEN
      v_failure_reason := format('print_async_error: %s', v_execute_async_body->>'error');
    ELSIF NULLIF(v_async_body->>'error', '') IS NOT NULL THEN
      v_failure_reason := format('bundle_async_error: %s', v_async_body->>'error');
    ELSE
      v_failure_reason := 'workflow completed without output URL';
    END IF;
  END IF;

  v_function_total_raw := COALESCE(
    NULLIF(v_context #>> '{label_print,execute_response,timings,total_ms}', ''),
    NULLIF(v_execute_result #>> '{timings,total_ms}', ''),
    NULLIF(v_step_result #>> '{execute,timings,total_ms}', ''),
    NULLIF(v_step_result #>> '{timings,total_ms}', ''),
    NULLIF(v_step_result #>> '{bundle,timings,total_ms}', ''),
    NULLIF(v_execute_async_body #>> '{timings,total_ms}', ''),
    NULLIF(v_execute_async_body #>> '{bundle,timings,total_ms}', ''),
    NULLIF(v_context #>> '{label_print,bundle_response,timings,total_ms}', ''),
    NULLIF(v_metadata #>> '{label_print,bundle_response,timings,total_ms}', ''),
    NULLIF(v_async_body #>> '{timings,total_ms}', ''),
    NULLIF(v_async_body #>> '{bundle,timings,total_ms}', '')
  );
  BEGIN
    IF NULLIF(v_function_total_raw, '') IS NOT NULL THEN
      v_function_total_ms := v_function_total_raw::NUMERIC;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_function_total_ms := NULL;
  END;
  IF v_function_total_ms IS NULL THEN
    v_function_total_ms := COALESCE(v_stage_execute_ms, v_stage_bundle_ms, v_stage_bundle_wait_ms);
  END IF;

  v_artifact_persisted := (
    v_output_url IS NOT NULL
    OR v_output_file_path IS NOT NULL
    OR COALESCE(
      NULLIF(v_bundle_response->>'file_path', ''),
      NULLIF(v_bundle_response->>'file_url', ''),
      NULLIF(v_bundle_response->>'signed_url', ''),
      NULLIF(v_execute_result #>> '{bundle,file_path}', ''),
      NULLIF(v_execute_result #>> '{bundle,file_url}', ''),
      NULLIF(v_execute_result #>> '{bundle,signed_url}', ''),
      NULLIF(v_execute_async_body #>> '{bundle,file_path}', ''),
      NULLIF(v_execute_async_body #>> '{bundle,file_url}', ''),
      NULLIF(v_execute_async_body #>> '{bundle,signed_url}', '')
    ) IS NOT NULL
  );
  v_job_completion_pending := (
    v_artifact_persisted
    AND v_fresh_generation_required
    AND COALESCE(v_pending_count, 0) > 0
  );

  IF v_stage_execute_ms IS NOT NULL THEN
    v_timing_source := 'stage_execute_ms';
  ELSIF NULLIF(v_function_total_raw, '') IS NOT NULL THEN
    v_timing_source := 'function_total_ms';
  ELSIF v_stage_bundle_wait_ms IS NOT NULL THEN
    v_timing_source := 'stage_bundle_wait_ms';
  ELSIF v_stage_bundle_ms IS NOT NULL THEN
    v_timing_source := 'stage_bundle_ms';
  ELSE
    v_timing_source := 'missing';
  END IF;

  -- Definitive failure overrides residual downloadable bytes, not factual persistence.
  IF COALESCE(v_run.workflow_status, '') IN ('failed', 'cancelled') THEN
    v_terminal := TRUE;
    v_phase := 'failed';
    v_output_url := NULL;
    v_output_file_path := NULL;
    v_output_source := NULL;
    v_output_needs_signing := FALSE;
  END IF;

  v_ready_source := v_output_source;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'workflow_run_id', v_run.id,
      'organization_id', v_run_org_id,
      'workflow_status', v_run.workflow_status,
      'current_operation', v_run.current_operation,
      'phase', v_phase,
      'output_url', v_output_url,
      'output_file_path', v_output_file_path,
      'output_bucket', v_output_bucket,
      'output_needs_signing', v_output_needs_signing,
      'output_source', v_output_source,
      'ready_source', v_ready_source,
      'artifact_persisted', v_artifact_persisted,
      'job_completion_pending', v_job_completion_pending,
      'timing_source', v_timing_source,
      'output_ready', v_output_url IS NOT NULL OR v_output_file_path IS NOT NULL,
      'terminal', v_terminal,
      'failure_reason', v_failure_reason,
      'pending_count', v_pending_count,
      'ready_count', v_ready_count,
      'fresh_expected_count', v_fresh_expected_count,
      'fresh_ready_count', v_fresh_ready_count,
      'fresh_failed_count', v_fresh_failed_count,
      'fresh_bundle_requested_count', v_bundle_requested_count,
      'fresh_bundle_bundled_count', v_bundle_bundled_count,
      'fresh_bundle_request_label_count', v_bundle_request_label_count
    ) || jsonb_build_object(
      'fresh_request_scope_key', CASE WHEN v_fresh_scope_step_id IS NOT NULL THEN v_fresh_scope_step_id::text ELSE NULL END,
      'fresh_only_resolved', v_fresh_only_resolved,
      'print_async_request_id', v_execute_request_id,
      'print_async_completed', v_execute_async_completed,
      'print_mode', v_print_mode,
      'artifact_kind', v_artifact_kind,
      'bundle_async_request_id', v_async_request_id,
      'bundle_async_completed', v_async_completed,
      'function_total_ms', v_function_total_ms,
      'stage_prepare_ms', v_stage_prepare_ms,
      'stage_execute_ms', v_stage_execute_ms,
      'stage_enqueue_ms', v_stage_enqueue_ms,
      'stage_render_ms', v_stage_render_ms,
      'stage_bundle_ms', v_stage_bundle_ms,
      'stage_complete_ms', v_stage_complete_ms,
      'stage_render_wait_ms', v_stage_render_wait_ms,
      'stage_bundle_wait_ms', v_stage_bundle_wait_ms,
      'stage_finalize_ms', v_stage_finalize_ms,
      'status_checked_at', v_status_checked_at,
      'poll_progress_managed', CASE WHEN v_poll_progress_managed THEN TRUE ELSE NULL END,
      'poll_progress_attempted', CASE WHEN v_poll_progress_attempted THEN TRUE ELSE NULL END,
      'poll_progress_status', v_poll_progress_status,
      'poll_progress_error', v_poll_progress_error
    ) || jsonb_build_object(
      'print_async_progress_attempted', CASE WHEN v_execute_progress_attempted THEN TRUE ELSE NULL END,
      'print_async_progress_status', v_execute_progress_status,
      'print_async_progress_error', v_execute_progress_error,
      'async_progress_attempted', CASE WHEN v_bundle_progress_attempted THEN TRUE ELSE NULL END,
      'async_progress_status', v_bundle_progress_status,
      'async_progress_error', v_bundle_progress_error
    )
  );
END;
$$;

COMMIT;
