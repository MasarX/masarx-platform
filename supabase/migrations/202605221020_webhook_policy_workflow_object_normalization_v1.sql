-- Console V2 External Intake: webhook policies must keep workflow as an
-- object. Earlier policy patching could merge workflow defaults into an
-- existing array, which made live mutation intake fail when the receiver wrote
-- workflow.intent.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605221020_webhook_policy_workflow_object_normalization_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.normalize_webhook_policy_workflow_v1(
  p_policy JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_workflow JSONB := v_policy->'workflow';
  v_merged_workflow JSONB := '{}'::jsonb;
  v_item JSONB;
BEGIN
  IF jsonb_typeof(v_policy) <> 'object' THEN
    RETURN '{}'::jsonb;
  END IF;

  IF v_workflow IS NULL THEN
    RETURN v_policy;
  END IF;

  IF jsonb_typeof(v_workflow) = 'object' THEN
    RETURN v_policy;
  END IF;

  IF jsonb_typeof(v_workflow) = 'array' THEN
    FOR v_item IN
      SELECT value FROM jsonb_array_elements(v_workflow)
    LOOP
      IF jsonb_typeof(v_item) = 'object' THEN
        v_merged_workflow := public.deep_merge_jsonb(v_merged_workflow, v_item);
      END IF;
    END LOOP;

    RETURN jsonb_set(v_policy, '{workflow}', v_merged_workflow, TRUE);
  END IF;

  RETURN jsonb_set(v_policy, '{workflow}', '{}'::jsonb, TRUE);
END;
$function$;

COMMENT ON FUNCTION public.normalize_webhook_policy_workflow_v1(JSONB)
  IS 'Normalizes webhook_ingest_policy.workflow to an object, merging legacy array object entries so receiver intent/template resolution remains row-driven.';

UPDATE public.settings
   SET cached_value = public.normalize_webhook_policy_workflow_v1(cached_value),
       last_updated = now()
 WHERE category = 'webhook_ingest_policy'
   AND cached_value IS NOT NULL
   AND (cached_value ? 'workflow')
   AND jsonb_typeof(cached_value->'workflow') IS DISTINCT FROM 'object';

UPDATE public.settings_versions
   SET value = public.normalize_webhook_policy_workflow_v1(value),
       change_reason = COALESCE(NULLIF(change_reason, ''), 'Normalize webhook policy workflow shape for Console V2 receiver intake.'),
       approved_at = COALESCE(approved_at, now()),
       effective_from = COALESCE(effective_from, now())
 WHERE category = 'webhook_ingest_policy'
   AND value IS NOT NULL
   AND (value ? 'workflow')
   AND jsonb_typeof(value->'workflow') IS DISTINCT FROM 'object';

UPDATE public.lookup_values lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || jsonb_build_object(
         'canonical_intent', 'shipment.create',
         'workflow_template_name', 'webhook_shipment_create_v1'
       ),
       updated_at = now()
  FROM public.lookup_definitions ld
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'mapping_target'
   AND lv.value = 'shipments.create'
   AND COALESCE(lv.status, 'active') = 'active';

CREATE OR REPLACE FUNCTION public.resolve_webhook_followup_template_id_v1(
  p_policy JSONB,
  p_canonical_intent TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := public.normalize_webhook_policy_workflow_v1(COALESCE(p_policy, '{}'::jsonb));
  v_workflow JSONB := COALESCE(v_policy->'workflow', '{}'::jsonb);
  v_templates_by_intent JSONB := COALESCE(
    CASE WHEN jsonb_typeof(v_workflow->'templates_by_intent') = 'object' THEN v_workflow->'templates_by_intent' ELSE '{}'::jsonb END,
    '{}'::jsonb
  );
  v_intent TEXT := lower(NULLIF(btrim(COALESCE(p_canonical_intent, '')), ''));
  v_override JSONB := NULL;
  v_template_ref TEXT := NULL;
BEGIN
  IF v_intent IS NOT NULL THEN
    v_override := v_templates_by_intent->v_intent;
  END IF;

  IF v_override IS NOT NULL AND v_override <> 'null'::jsonb THEN
    IF jsonb_typeof(v_override) = 'string' THEN
      v_template_ref := NULLIF(btrim(v_override #>> '{}'), '');
    ELSIF jsonb_typeof(v_override) = 'object' THEN
      v_template_ref := COALESCE(
        NULLIF(btrim(v_override->>'template_id'), ''),
        NULLIF(btrim(v_override->>'template_name'), '')
      );
    END IF;

    IF v_template_ref IS NOT NULL THEN
      RETURN public.resolve_active_workflow_template_ref_v1(v_template_ref);
    END IF;
  END IF;

  v_template_ref := COALESCE(
    NULLIF(btrim(v_workflow->>'template_id'), ''),
    NULLIF(btrim(v_workflow->>'template_name'), '')
  );
  RETURN public.resolve_active_workflow_template_ref_v1(v_template_ref);
END;
$function$;

COMMENT ON FUNCTION public.resolve_webhook_followup_template_id_v1(JSONB, TEXT)
  IS 'Resolves webhook follow-up workflow templates from webhook_ingest_policy.workflow after normalizing legacy array workflow shapes to an object.';

CREATE OR REPLACE FUNCTION public.upsert_webhook_ingest_policy(p_scope_type text, p_scope_id uuid, p_policy jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_root TEXT := public.get_root_scope_type_key_v1();
  v_scope_type TEXT;
  v_scope_id UUID := p_scope_id;
  v_entity_table REGCLASS;
  v_schema_version INT;
  v_base JSONB;
  v_policy_patch JSONB;
  v_policy JSONB;
  v_validation JSONB;
  v_idempotency JSONB;
  v_hmac JSONB;
  v_result RECORD;
BEGIN
  IF NULLIF(TRIM(p_scope_type), '') IS NULL THEN
    RAISE EXCEPTION 'upsert_webhook_ingest_policy requires scope_type';
  END IF;

  v_scope_type := public.normalize_scope_type_v1(p_scope_type, FALSE);
  SELECT r.entity_table
    INTO v_entity_table
    FROM public.scope_type_registry r
   WHERE r.scope_type = v_scope_type
     AND r.is_enabled = TRUE
   LIMIT 1;

  IF v_scope_type = v_root OR v_entity_table IS NULL THEN
    IF v_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'upsert_webhook_ingest_policy scope_type=% requires NULL scope_id', v_scope_type;
    END IF;
  ELSE
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'upsert_webhook_ingest_policy scope_type=% requires non-NULL scope_id', v_scope_type;
    END IF;
  END IF;

  SELECT version
    INTO v_schema_version
    FROM public.schema_registry
   WHERE category = 'webhook_ingest_policy'
     AND is_active = TRUE
   ORDER BY version DESC
   LIMIT 1;

  IF v_schema_version IS NULL THEN
    RAISE EXCEPTION 'schema_registry missing active schema for webhook_ingest_policy';
  END IF;

  v_base := public.normalize_webhook_policy_workflow_v1(
    COALESCE(public.resolve_settings_merged('webhook_ingest_policy', v_scope_type, v_scope_id), '{}'::jsonb)
  );

  v_policy_patch := public.normalize_webhook_policy_workflow_v1(
    jsonb_strip_nulls(COALESCE(p_policy, '{}'::jsonb) - 'response')
  );

  IF v_policy_patch ? 'validation' THEN
    v_validation := v_policy_patch->'validation';
    v_idempotency := v_validation->'idempotency';
    v_hmac := v_validation->'hmac';

    v_validation := jsonb_strip_nulls(jsonb_build_object(
      'idempotency', CASE
        WHEN jsonb_typeof(v_idempotency) <> 'object' THEN NULL
        ELSE jsonb_strip_nulls(jsonb_build_object(
          'header', v_idempotency->'header',
          'body_path', v_idempotency->'body_path',
          'dedupe_window_seconds', v_idempotency->'dedupe_window_seconds'
        ))
      END,
      'hmac', CASE
        WHEN jsonb_typeof(v_hmac) <> 'object' THEN NULL
        ELSE jsonb_strip_nulls(jsonb_build_object(
          'enabled', v_hmac->'enabled',
          'algorithm', v_hmac->'algorithm',
          'header', v_hmac->'header',
          'auth_config_id', v_hmac->'auth_config_id',
          'timestamp_header', v_hmac->'timestamp_header',
          'tolerance_seconds', v_hmac->'tolerance_seconds',
          'signature_encoding', v_hmac->'signature_encoding'
        ))
      END,
      'json_schema_id', v_validation->'json_schema_id'
    ));

    IF v_validation IS NULL OR v_validation = '{}'::jsonb THEN
      v_policy_patch := v_policy_patch - 'validation';
    ELSE
      v_policy_patch := jsonb_set(v_policy_patch, '{validation}', v_validation, TRUE);
    END IF;
  END IF;

  v_policy := public.normalize_webhook_policy_workflow_v1(
    public.deep_merge_jsonb(v_base, v_policy_patch)
  );

  IF NOT (v_policy ? 'version') THEN
    RAISE EXCEPTION 'webhook_ingest_policy missing required key: version (seed defaults or include it in patch)';
  END IF;
  IF NOT (v_policy ? 'ack') OR jsonb_typeof(v_policy->'ack') <> 'object' OR NOT ((v_policy->'ack') ? 'mode') THEN
    RAISE EXCEPTION 'webhook_ingest_policy missing required ack.mode (seed defaults or include it in patch)';
  END IF;

  SELECT *
    INTO v_result
    FROM public.upsert_settings_value_v1(
      p_category := 'webhook_ingest_policy',
      p_scope_type := v_scope_type,
      p_scope_id := v_scope_id,
      p_value := v_policy,
      p_schema_version := v_schema_version,
      p_change_reason := format('upsert webhook_ingest_policy (%s)', v_scope_type)
    );

  RETURN v_result.settings_id;
END;
$function$;

COMMENT ON FUNCTION public.upsert_webhook_ingest_policy(TEXT, UUID, JSONB)
  IS 'Upserts webhook_ingest_policy with schema validation, validation-key normalization, and workflow-object normalization for Console V2 receiver intake.';

DO $do$
DECLARE
  v_def TEXT;
  v_old TEXT := E'  v_raw_intent := NULLIF(v_policy_body#>>''{workflow,intent}'', '''');\n';
  v_new TEXT := E'  v_policy_body := public.normalize_webhook_policy_workflow_v1(v_policy_body);\n  v_raw_intent := NULLIF(v_policy_body#>>''{workflow,intent}'', '''');\n';
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb) not found';
  END IF;

  IF position('public.normalize_webhook_policy_workflow_v1(v_policy_body)' IN v_def) > 0 THEN
    RETURN;
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 policy normalization marker not found';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END;
$do$;

COMMENT ON FUNCTION public.workflow_intake_webhook_core_v1(TEXT, JSONB, TEXT, JSONB)
  IS 'Workflow intake entrypoint: resolves policy, normalizes webhook policy workflow shape, records ACK via decision_log, applies source mapping_config_id to transformed_payload, enqueues workflow runs, and only plans shipment id/tracking when workflow.intent = shipment_create.';

CREATE OR REPLACE FUNCTION public.repair_integration_plugin_webhook_policy_v1(
  p_webhook_source_id UUID,
  p_plugin_version_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_source public.webhook_sources%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_target TEXT;
  v_intent TEXT;
  v_target_metadata JSONB := '{}'::jsonb;
  v_entry_template_ref TEXT;
  v_followup_template_ref TEXT;
  v_entry_template_id UUID;
  v_followup_template_id UUID;
  v_policy JSONB;
  v_existing_policy JSONB := '{}'::jsonb;
  v_existing_hmac JSONB := NULL;
BEGIN
  IF p_webhook_source_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'missing_webhook_source_id');
  END IF;

  SELECT * INTO v_source
    FROM public.webhook_sources
   WHERE id = p_webhook_source_id
   LIMIT 1;

  IF v_source.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'webhook_source_not_found');
  END IF;

  BEGIN
    SELECT public.normalize_webhook_policy_workflow_v1(COALESCE(policy, '{}'::jsonb))
      INTO v_existing_policy
      FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := p_webhook_source_id)
     LIMIT 1;
  EXCEPTION
    WHEN others THEN
      v_existing_policy := '{}'::jsonb;
  END;

  IF jsonb_typeof(v_existing_policy#>'{validation,hmac}') = 'object' THEN
    v_existing_hmac := v_existing_policy#>'{validation,hmac}';
  END IF;

  IF p_plugin_version_id IS NOT NULL THEN
    SELECT * INTO v_version
      FROM public.integration_plugin_versions
     WHERE id = p_plugin_version_id
     LIMIT 1;
  END IF;

  IF v_version.id IS NULL THEN
    SELECT v.* INTO v_version
      FROM public.integration_plugin_bindings b
      JOIN public.integration_plugin_versions v ON v.id = b.plugin_version_id
     WHERE b.runtime_resource_type = 'webhook_sources'
       AND b.runtime_resource_id = p_webhook_source_id
     ORDER BY b.enabled DESC, b.created_at DESC
     LIMIT 1;
  END IF;

  IF v_version.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'plugin_version_not_found');
  END IF;

  SELECT * INTO v_plugin
    FROM public.integration_plugins
   WHERE id = v_version.plugin_id
   LIMIT 1;

  -- The default onboarding source keeps the general intake policy until an explicit shipment binding exists.
  IF v_plugin.plugin_key = 'default-shipment-webhook-intake'
     AND v_version.workflow_binding = '{"template_name":"webhook_intake_v1"}'::jsonb THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'general_onboarding_intake');
  END IF;

  v_target := lower(COALESCE(
    NULLIF(v_version.workflow_binding->>'intent', ''),
    NULLIF(v_version.mapping_config->>'target', ''),
    NULLIF(v_version.mapping_config#>>'{metadata,target}', '')
  ));
  v_intent := public.normalize_shipment_intent_v1(v_target, NULL);

  SELECT COALESCE(lv.metadata, '{}'::jsonb)
    INTO v_target_metadata
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'mapping_target'
     AND COALESCE(lv.status, 'active') = 'active'
     AND (
       lower(lv.value) = v_target
       OR lower(COALESCE(lv.metadata->>'canonical_intent', '')) = v_intent
     )
     AND COALESCE(lv.metadata->'allowed_mapping_types', '[]'::jsonb) ? 'webhook_inbound'
   ORDER BY CASE WHEN lower(lv.value) = v_target THEN 0 ELSE 1 END,
            lv.sort_order NULLS LAST
   LIMIT 1;

  IF v_intent NOT IN ('shipment.create', 'shipment.delete', 'shipment.reschedule')
     OR COALESCE(v_target_metadata, '{}'::jsonb) = '{}'::jsonb THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'skipped', TRUE,
      'reason', 'non_supported_webhook_mapping_target',
      'plugin_key', v_plugin.plugin_key,
      'target', v_target
    );
  END IF;

  v_followup_template_ref := NULLIF(v_target_metadata->>'workflow_template_name', '');
  IF v_followup_template_ref IS NULL THEN
    RAISE EXCEPTION 'repair_integration_plugin_webhook_policy_v1 missing mapping_target workflow_template_name for %', v_target;
  END IF;

  v_entry_template_ref := CASE
    WHEN v_intent = 'shipment.create' THEN v_followup_template_ref
    ELSE COALESCE(
      NULLIF(v_existing_policy#>>'{workflow,template_id}', ''),
      NULLIF(v_existing_policy#>>'{workflow,template_name}', ''),
      NULLIF(v_version.workflow_binding->>'template_id', ''),
      NULLIF(v_version.workflow_binding->>'template_name', ''),
      'async_provider_dispatch_v1'
    )
  END;

  v_entry_template_id := public.resolve_active_workflow_template_ref_v1(v_entry_template_ref);
  IF v_entry_template_id IS NULL THEN
    RAISE EXCEPTION 'repair_integration_plugin_webhook_policy_v1 could not resolve entry workflow template %', v_entry_template_ref;
  END IF;

  v_followup_template_id := public.resolve_active_workflow_template_ref_v1(v_followup_template_ref);
  IF v_followup_template_id IS NULL THEN
    RAISE EXCEPTION 'repair_integration_plugin_webhook_policy_v1 could not resolve follow-up workflow template %', v_followup_template_ref;
  END IF;

  v_policy := jsonb_build_object(
    'version', 1,
    'ack', jsonb_build_object(
      'mode', 'accepted_async',
      'status_code', 202,
      'default_headers', jsonb_build_object('content-type', 'application/json')
    ),
    'workflow', jsonb_build_object(
      'template_id', v_entry_template_id,
      'template_name', v_entry_template_ref,
      'intent', v_intent,
      'templates_by_intent', jsonb_build_object(
        v_intent,
        jsonb_build_object(
          'template_id', v_followup_template_id::TEXT,
          'template_name', v_followup_template_ref
        )
      ),
      'notes', format(
        'plugin_id=%s plugin_version_id=%s target=%s intent=%s',
        v_plugin.id,
        v_version.id,
        v_target,
        v_intent
      )
    ),
    'validation', jsonb_strip_nulls(jsonb_build_object(
      'idempotency', jsonb_build_object(
        'header', 'Idempotency-Key',
        'body_path', 'event.id'
      ),
      'hmac', v_existing_hmac
    ))
  );

  PERFORM public.upsert_webhook_ingest_policy('source', p_webhook_source_id, v_policy);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'webhook_source_id', p_webhook_source_id,
    'plugin_version_id', v_version.id,
    'canonical_intent', v_intent,
    'entry_workflow_template_id', v_entry_template_id,
    'followup_workflow_template_id', v_followup_template_id,
    'hmac_preserved', v_existing_hmac IS NOT NULL
  );
END;
$function$;

COMMENT ON FUNCTION public.repair_integration_plugin_webhook_policy_v1(UUID, UUID)
  IS 'Repairs source-level webhook_ingest_policy from plugin binding or mapping target metadata while preserving explicit source HMAC validation settings.';

CREATE OR REPLACE FUNCTION public.ensure_webhook_source_plugin_binding_v1(
  p_webhook_source_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_source public.webhook_sources%ROWTYPE;
  v_mapping public.mapping_configs%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_candidate_version_id UUID;
  v_mapping_key_version TEXT;
  v_binding_id UUID;
  v_repair JSONB := '{}'::jsonb;
  v_target TEXT;
  v_canonical_intent TEXT;
  v_target_metadata JSONB := '{}'::jsonb;
  v_entry_template_ref TEXT;
  v_followup_template_ref TEXT;
  v_entry_template_id UUID;
  v_followup_template_id UUID;
  v_existing_policy JSONB := '{}'::jsonb;
  v_validation JSONB;
  v_policy JSONB;
BEGIN
  IF p_webhook_source_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'missing_webhook_source_id');
  END IF;

  SELECT * INTO v_source
    FROM public.webhook_sources
   WHERE id = p_webhook_source_id
   LIMIT 1;

  IF v_source.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'webhook_source_not_found');
  END IF;

  IF COALESCE(v_source.enabled, FALSE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'webhook_source_disabled');
  END IF;

  IF v_source.mapping_config_id IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'missing_mapping_config_id');
  END IF;

  SELECT * INTO v_mapping
    FROM public.mapping_configs
   WHERE id = v_source.mapping_config_id
   LIMIT 1;

  IF v_mapping.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'mapping_config_not_found');
  END IF;

  v_target := lower(NULLIF(btrim(COALESCE(v_mapping.mapping_config->>'target', '')), ''));
  v_canonical_intent := public.normalize_shipment_intent_v1(v_target, NULL);

  SELECT COALESCE(lv.metadata, '{}'::jsonb)
    INTO v_target_metadata
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'mapping_target'
     AND COALESCE(lv.status, 'active') = 'active'
     AND (
       lower(lv.value) = v_target
       OR lower(COALESCE(lv.metadata->>'canonical_intent', '')) = v_canonical_intent
     )
     AND COALESCE(lv.metadata->'allowed_mapping_types', '[]'::jsonb) ? 'webhook_inbound'
   ORDER BY CASE WHEN lower(lv.value) = v_target THEN 0 ELSE 1 END,
            lv.sort_order NULLS LAST
   LIMIT 1;

  IF v_canonical_intent NOT IN ('shipment.create', 'shipment.delete', 'shipment.reschedule')
     OR COALESCE(v_target_metadata, '{}'::jsonb) = '{}'::jsonb THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'skipped', TRUE,
      'reason', 'non_supported_webhook_mapping_target',
      'mapping_config_id', v_mapping.id,
      'target', v_target
    );
  END IF;

  IF COALESCE(v_source.managed_metadata->>'plugin_version_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_candidate_version_id := (v_source.managed_metadata->>'plugin_version_id')::UUID;
  ELSIF COALESCE(v_mapping.managed_metadata->>'plugin_version_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_candidate_version_id := (v_mapping.managed_metadata->>'plugin_version_id')::UUID;
  ELSE
    v_mapping_key_version := split_part(COALESCE(v_mapping.mapping_key, ''), ':', 2);
    IF v_mapping.mapping_key LIKE 'integration_plugin:%'
       AND v_mapping_key_version ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_candidate_version_id := v_mapping_key_version::UUID;
    END IF;
  END IF;

  IF v_candidate_version_id IS NOT NULL THEN
    SELECT * INTO v_version
      FROM public.integration_plugin_versions
     WHERE id = v_candidate_version_id
       AND organization_id = v_source.organization_id
     LIMIT 1;
  END IF;

  IF v_version.id IS NULL THEN
    SELECT ipv.*
      INTO v_version
      FROM public.integration_plugin_versions ipv
      JOIN public.integration_plugins ip ON ip.id = ipv.plugin_id
     WHERE ipv.organization_id = v_source.organization_id
       AND ipv.status IN ('active', 'approved')
       AND lower(COALESCE(ip.plugin_kind, '')) = 'webhook'
       AND public.normalize_shipment_intent_v1(COALESCE(
             NULLIF(ipv.workflow_binding->>'intent', ''),
             NULLIF(ipv.mapping_config->>'target', ''),
             NULLIF(ipv.mapping_config#>>'{metadata,target}', '')
           ), NULL) = v_canonical_intent
       AND ipv.mapping_config = v_mapping.mapping_config
     ORDER BY (ipv.status = 'active') DESC,
              ipv.activated_at DESC NULLS LAST,
              ipv.updated_at DESC,
              ipv.version_no DESC
     LIMIT 1;
  END IF;

  IF v_version.id IS NULL THEN
    IF v_mapping.mapping_type = 'webhook_inbound'
       AND COALESCE((v_mapping.mapping_config->>'enabled')::boolean, TRUE) IS TRUE THEN
      v_followup_template_ref := NULLIF(v_target_metadata->>'workflow_template_name', '');
      IF v_followup_template_ref IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'mapping_target_workflow_template_missing', 'target', v_target);
      END IF;

      SELECT public.normalize_webhook_policy_workflow_v1(COALESCE(p.policy, '{}'::jsonb))
        INTO v_existing_policy
        FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_source.id) AS p
       LIMIT 1;

      v_entry_template_ref := CASE
        WHEN v_canonical_intent = 'shipment.create' THEN v_followup_template_ref
        ELSE COALESCE(
          NULLIF(v_existing_policy#>>'{workflow,template_id}', ''),
          NULLIF(v_existing_policy#>>'{workflow,template_name}', ''),
          'async_provider_dispatch_v1'
        )
      END;

      v_entry_template_id := public.resolve_active_workflow_template_ref_v1(v_entry_template_ref);
      IF v_entry_template_id IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_workflow_template_not_found', 'template_ref', v_entry_template_ref);
      END IF;

      v_followup_template_id := public.resolve_active_workflow_template_ref_v1(v_followup_template_ref);
      IF v_followup_template_id IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'followup_workflow_template_not_found', 'template_ref', v_followup_template_ref);
      END IF;

      v_validation := jsonb_build_object(
        'idempotency', jsonb_build_object(
          'header', 'Idempotency-Key',
          'body_path', 'event.id'
        )
      );

      IF jsonb_typeof(v_existing_policy#>'{validation,hmac}') = 'object' THEN
        v_validation := v_validation || jsonb_build_object('hmac', v_existing_policy#>'{validation,hmac}');
      END IF;

      v_policy := jsonb_build_object(
        'version', 1,
        'ack', jsonb_build_object(
          'mode', 'accepted_async',
          'status_code', 202,
          'default_headers', jsonb_build_object('content-type', 'application/json')
        ),
        'workflow', jsonb_build_object(
          'template_id', v_entry_template_id,
          'template_name', v_entry_template_ref,
          'intent', v_canonical_intent,
          'templates_by_intent', jsonb_build_object(
            v_canonical_intent,
            jsonb_build_object(
              'template_id', v_followup_template_id::TEXT,
              'template_name', v_followup_template_ref
            )
          ),
          'notes', format(
            'mapping_config_id=%s mapping_key=%s target=%s intent=%s',
            v_mapping.id,
            v_mapping.mapping_key,
            v_target,
            v_canonical_intent
          )
        ),
        'validation', v_validation
      );

      PERFORM public.upsert_webhook_ingest_policy('source', v_source.id, v_policy);

      UPDATE public.integration_plugin_bindings
         SET enabled = FALSE,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'disabled_by', 'console_webhook_source_operator_mapping_policy',
               'operator_mapping_config_id', v_mapping.id
             ),
             updated_at = now()
       WHERE runtime_resource_type = 'webhook_sources'
         AND runtime_resource_id = v_source.id
         AND enabled IS TRUE;

      RETURN jsonb_build_object(
        'ok', TRUE,
        'webhook_source_id', v_source.id,
        'mapping_config_id', v_mapping.id,
        'policy_repair', jsonb_build_object(
          'ok', TRUE,
          'mode', 'operator_webhook_inbound_mapping',
          'canonical_intent', v_canonical_intent,
          'entry_workflow_template_id', v_entry_template_id,
          'followup_workflow_template_id', v_followup_template_id
        )
      );
    END IF;

    RETURN jsonb_build_object('ok', FALSE, 'reason', 'plugin_version_not_found');
  END IF;

  SELECT * INTO v_plugin
    FROM public.integration_plugins
   WHERE id = v_version.plugin_id
     AND organization_id = v_source.organization_id
   LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'plugin_not_found');
  END IF;

  INSERT INTO public.integration_plugin_bindings (
    plugin_version_id,
    organization_id,
    scope_type,
    scope_id,
    binding_type,
    runtime_resource_type,
    runtime_resource_id,
    enabled,
    activation_payload,
    metadata,
    created_by
  )
  VALUES (
    v_version.id,
    v_source.organization_id,
    'tenant',
    v_source.organization_id,
    'webhook_source',
    'webhook_sources',
    v_source.id,
    v_source.enabled,
    jsonb_strip_nulls(jsonb_build_object(
      'source_identifier', v_source.source_identifier,
      'mapping_config_id', v_source.mapping_config_id,
      'sender_id', v_source.sender_id
    )),
    jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'managed_by', 'console_webhook_source_upsert'
    ),
    auth.uid()
  )
  ON CONFLICT ON CONSTRAINT integration_plugin_bindings_unique_scope_resource
  DO UPDATE SET
    enabled = EXCLUDED.enabled,
    activation_payload = EXCLUDED.activation_payload,
    metadata = COALESCE(public.integration_plugin_bindings.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now()
  RETURNING id INTO v_binding_id;

  v_repair := public.repair_integration_plugin_webhook_policy_v1(v_source.id, v_version.id);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'webhook_source_id', v_source.id,
    'mapping_config_id', v_mapping.id,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'binding_id', v_binding_id,
    'policy_repair', v_repair
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) TO service_role;

COMMENT ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID)
  IS 'Ensures UI-created webhook sources have source-level webhook_ingest_policy from row-driven mapping target metadata. Plugin-backed mappings also get runtime bindings; enabled operator webhook_inbound mappings repair the source policy directly.';

SELECT pg_advisory_unlock(hashtext('202605221020_webhook_policy_workflow_object_normalization_v1'));

COMMIT;
