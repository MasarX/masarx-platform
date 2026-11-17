-- Keep every shipment-applicable webhook policy binding deterministic on both
-- existing rows and future writes through the shared settings upsert seam.

BEGIN;

SELECT pg_advisory_lock(hashtext('202608161890_webhook_policy_binding_normalization_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.normalize_webhook_ingest_policy_workflow_bindings_v1(
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_value JSONB := COALESCE(p_value, '{}'::jsonb);
  v_workflow JSONB;
  v_templates JSONB;
  v_original_templates JSONB;
  v_binding RECORD;
  v_canonical_id UUID;
  v_selected_id UUID;
  v_selected_name TEXT;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(v_value) IS DISTINCT FROM 'object' THEN
    RETURN p_value;
  END IF;

  v_workflow := CASE
    WHEN jsonb_typeof(v_value->'workflow') = 'object' THEN v_value->'workflow'
    ELSE '{}'::jsonb
  END;
  v_templates := CASE
    WHEN jsonb_typeof(v_workflow->'templates_by_intent') = 'object'
      THEN v_workflow->'templates_by_intent'
    ELSE '{}'::jsonb
  END;
  v_original_templates := v_templates;

  FOR v_binding IN
    SELECT binding.intent, binding.template_name
      FROM (VALUES
        ('shipment.create'::TEXT, 'webhook_shipment_create_v1'::TEXT),
        ('shipment.delete'::TEXT, 'shipment_delete_v1'::TEXT),
        ('shipment.reschedule'::TEXT, 'shipment_reschedule_v1'::TEXT)
      ) AS binding(intent, template_name)
  LOOP
    -- Always evaluate applicability against the original policy. Adding one
    -- explicit binding must not opt a non-shipment policy into sibling intents.
    IF NOT public.webhook_policy_applies_to_shipment_intent_v1(v_value, v_binding.intent) THEN
      CONTINUE;
    END IF;

    SELECT wt.id
      INTO v_canonical_id
      FROM public.workflow_templates wt
     WHERE wt.name = v_binding.template_name
       AND wt.status = 'active'
     ORDER BY wt.version DESC, wt.updated_at DESC
     LIMIT 1;

    IF v_canonical_id IS NULL
       OR NOT public.workflow_template_supports_shipment_intent_v1(
         v_canonical_id,
         v_binding.intent
       ) THEN
      RAISE EXCEPTION 'canonical active % template is missing or incompatible', v_binding.template_name;
    END IF;

    v_selected_id := v_canonical_id;
    v_selected_name := v_binding.template_name;

    -- shipment.create may retain a proven active compatible custom materializer.
    -- Mutation intents intentionally stay on their canonical workflow defaults.
    IF v_binding.intent = 'shipment.create' THEN
      v_selected_id := public.resolve_webhook_followup_template_id_v1(
        v_value,
        v_binding.intent
      );

      IF v_selected_id IS NULL
         OR NOT public.workflow_template_supports_shipment_intent_v1(
           v_selected_id,
           v_binding.intent
         ) THEN
        v_selected_id := v_canonical_id;
        v_selected_name := v_binding.template_name;
      ELSE
        SELECT wt.name
          INTO v_selected_name
          FROM public.workflow_templates wt
         WHERE wt.id = v_selected_id
           AND wt.status = 'active';

        IF v_selected_name IS NULL THEN
          v_selected_id := v_canonical_id;
          v_selected_name := v_binding.template_name;
        END IF;
      END IF;
    END IF;

    v_templates := jsonb_set(
      v_templates,
      ARRAY[v_binding.intent],
      jsonb_build_object(
        'template_id', v_selected_id,
        'template_name', v_selected_name
      ),
      TRUE
    );
  END LOOP;

  IF v_templates IS NOT DISTINCT FROM v_original_templates THEN
    RETURN p_value;
  END IF;

  v_workflow := v_workflow || jsonb_build_object('templates_by_intent', v_templates);
  RETURN jsonb_set(v_value, '{workflow}', v_workflow, TRUE);
END;
$function$;

REVOKE ALL ON FUNCTION public.normalize_webhook_ingest_policy_workflow_bindings_v1(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_webhook_ingest_policy_workflow_bindings_v1(JSONB)
  TO service_role;

COMMENT ON FUNCTION public.normalize_webhook_ingest_policy_workflow_bindings_v1(JSONB) IS
  'Service-only deterministic webhook workflow-binding normalization: preserve compatible custom shipment.create materializers, enforce canonical delete/reschedule defaults, and preserve explicit non-shipment intent scope.';

CREATE OR REPLACE FUNCTION public.normalize_settings_value_v1(
  p_category TEXT,
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF lower(COALESCE(btrim(p_category), '')) = 'ui_read_registry' THEN
    RETURN public.normalize_ui_read_registry_import_v1(p_value);
  END IF;

  IF lower(COALESCE(btrim(p_category), '')) = 'label_print_policy' THEN
    RETURN public.normalize_label_print_policy_v1(p_value);
  END IF;

  IF lower(COALESCE(btrim(p_category), '')) = 'webhook_ingest_policy' THEN
    RETURN public.normalize_webhook_ingest_policy_workflow_bindings_v1(p_value);
  END IF;

  RETURN p_value;
END;
$function$;

COMMENT ON FUNCTION public.normalize_settings_value_v1(TEXT, JSONB) IS
  'Apply category-specific settings normalization before persistence, including canonical webhook workflow intent bindings.';

DO $reconcile$
DECLARE
  v_setting RECORD;
  v_normalized JSONB;
  v_schema_version INT;
  v_seen INT := 0;
BEGIN
  SELECT sr.version
    INTO v_schema_version
    FROM public.schema_registry sr
   WHERE sr.category = 'webhook_ingest_policy'
     AND sr.is_active IS TRUE
   ORDER BY sr.version DESC
   LIMIT 1;

  IF v_schema_version IS NULL THEN
    RAISE EXCEPTION 'schema_registry missing active schema for webhook_ingest_policy';
  END IF;

  FOR v_setting IN
    SELECT s.scope_type,
           s.scope_id,
           COALESCE(s.cached_value, sv.value, '{}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'webhook_ingest_policy'
     FOR UPDATE OF s, sv
  LOOP
    v_seen := v_seen + 1;
    v_normalized := public.normalize_settings_value_v1(
      'webhook_ingest_policy',
      v_setting.value
    );

    IF v_normalized IS DISTINCT FROM v_setting.value THEN
      PERFORM 1
        FROM public.upsert_settings_value_v1(
          'webhook_ingest_policy',
          v_setting.scope_type,
          v_setting.scope_id,
          v_normalized,
          v_schema_version,
          'Normalize canonical webhook shipment workflow bindings'
        );
    END IF;
  END LOOP;

  IF v_seen = 0 THEN
    RAISE EXCEPTION 'webhook_ingest_policy settings missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'webhook_ingest_policy'
       AND public.normalize_settings_value_v1(
         'webhook_ingest_policy',
         COALESCE(s.cached_value, sv.value, '{}'::jsonb)
       ) IS DISTINCT FROM COALESCE(s.cached_value, sv.value, '{}'::jsonb)
  ) THEN
    RAISE EXCEPTION 'webhook_ingest_policy workflow binding reconciliation is incomplete';
  END IF;
END;
$reconcile$;

SELECT pg_advisory_unlock(hashtext('202608161890_webhook_policy_binding_normalization_v1'));

COMMIT;
