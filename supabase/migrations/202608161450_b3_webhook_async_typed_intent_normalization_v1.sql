-- Complete the canonical async webhook mutation-intent contract without
-- changing the transport or creating a synchronous shipment-write path.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607151320_webhook_async_typed_intent_normalization_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Keep every compatibility alias at one explicit normalization seam. Generic
-- shipment.updated deliberately remains generic so payload classification must
-- resolve exactly one typed mutation intent or fail closed.
CREATE OR REPLACE FUNCTION public.normalize_shipment_intent_v1(
  p_intent TEXT,
  p_event_type TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_intent TEXT := lower(NULLIF(btrim(COALESCE(p_intent, '')), ''));
  v_event_type TEXT := lower(NULLIF(btrim(COALESCE(p_event_type, '')), ''));
BEGIN
  IF v_intent IN (
    'shipment.create',
    'shipment.updated',
    'shipment.swap',
    'shipment.return',
    'shipment.modify',
    'shipment.delete',
    'shipment.cancel',
    'shipment.canceled',
    'shipment.cancelled',
    'shipment.reschedule',
    'shipments.cancel',
    'shipments.canceled',
    'shipments.cancelled',
    'shipments.delete',
    'shipments.reschedule',
    'update.status',
    'update.geocode',
    'update.address',
    'update.driver',
    'update.action',
    'update.attachment'
  ) THEN
    RETURN CASE
      WHEN v_intent IN (
        'shipment.cancel',
        'shipment.canceled',
        'shipment.cancelled',
        'shipments.cancel',
        'shipments.canceled',
        'shipments.cancelled',
        'shipments.delete'
      ) THEN 'shipment.delete'
      WHEN v_intent = 'shipments.reschedule' THEN 'shipment.reschedule'
      ELSE v_intent
    END;
  END IF;

  CASE COALESCE(v_intent, v_event_type)
    WHEN 'shipment_create' THEN RETURN 'shipment.create';
    WHEN 'shipment_update' THEN RETURN 'shipment.updated';
    WHEN 'shipment_swap' THEN RETURN 'shipment.swap';
    WHEN 'shipment_return' THEN RETURN 'shipment.return';
    WHEN 'shipment_modify' THEN RETURN 'shipment.modify';
    WHEN 'shipment_delete' THEN RETURN 'shipment.delete';
    WHEN 'shipment_cancel' THEN RETURN 'shipment.delete';
    WHEN 'shipment_cancelled' THEN RETURN 'shipment.delete';
    WHEN 'shipment_canceled' THEN RETURN 'shipment.delete';
    WHEN 'shipments_delete' THEN RETURN 'shipment.delete';
    WHEN 'shipments_cancel' THEN RETURN 'shipment.delete';
    WHEN 'shipments_cancelled' THEN RETURN 'shipment.delete';
    WHEN 'shipments_canceled' THEN RETURN 'shipment.delete';
    WHEN 'shipment_reschedule' THEN RETURN 'shipment.reschedule';
    WHEN 'shipment_rescheduled' THEN RETURN 'shipment.reschedule';
    WHEN 'shipments_reschedule' THEN RETURN 'shipment.reschedule';
    WHEN 'status_update' THEN RETURN 'update.status';
    WHEN 'shipment_status_update' THEN RETURN 'update.status';
    WHEN 'shipment_update_status' THEN RETURN 'update.status';
    WHEN 'shipment_update_geocode' THEN RETURN 'update.geocode';
    WHEN 'shipment_update_address' THEN RETURN 'update.address';
    WHEN 'shipment_update_driver' THEN RETURN 'update.driver';
    WHEN 'shipment_update_action' THEN RETURN 'update.action';
    WHEN 'shipment_update_attachment' THEN RETURN 'update.attachment';
    WHEN 'shipment.created' THEN RETURN 'shipment.create';
    WHEN 'shipment.updated' THEN RETURN 'shipment.updated';
    WHEN 'shipment.cancel' THEN RETURN 'shipment.delete';
    WHEN 'shipment.canceled' THEN RETURN 'shipment.delete';
    WHEN 'shipment.cancelled' THEN RETURN 'shipment.delete';
    WHEN 'shipment.rescheduled' THEN RETURN 'shipment.reschedule';
    WHEN 'shipments.cancel' THEN RETURN 'shipment.delete';
    WHEN 'shipments.delete' THEN RETURN 'shipment.delete';
    WHEN 'shipments.canceled' THEN RETURN 'shipment.delete';
    WHEN 'shipments.cancelled' THEN RETURN 'shipment.delete';
    WHEN 'shipments.rescheduled' THEN RETURN 'shipment.reschedule';
    WHEN 'shipments.reschedule' THEN RETURN 'shipment.reschedule';
    ELSE
      RETURN COALESCE(v_intent, v_event_type);
  END CASE;
END;
$function$;

COMMENT ON FUNCTION public.normalize_shipment_intent_v1(TEXT, TEXT) IS
  'Canonical compatibility seam for provider webhook shipment events and mapping targets. Generic shipment.updated remains unresolved until payload classification selects exactly one typed mutation intent.';

-- Append a new settings version for every configured scope. Do not mutate
-- settings_versions in place: policy lineage remains the settings SSOT.
DO $policy_defaults$
DECLARE
  v_scope RECORD;
  v_seen INTEGER := 0;
  v_value JSONB;
  v_workflow JSONB;
  v_templates JSONB;
  v_original_templates JSONB;
  v_target RECORD;
  v_binding JSONB;
  v_existing_ref TEXT;
  v_resolved_template_id UUID;
  v_should_default BOOLEAN;
  v_top_intent TEXT;
BEGIN
  FOR v_scope IN
    SELECT s.scope_type,
           s.scope_id,
           COALESCE(sv.schema_version, 1) AS schema_version,
           COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'webhook_ingest_policy'
  LOOP
    v_seen := v_seen + 1;
    v_value := COALESCE(v_scope.value, '{}'::jsonb);
    v_workflow := CASE
      WHEN jsonb_typeof(v_value->'workflow') = 'object' THEN v_value->'workflow'
      ELSE '{}'::jsonb
    END;
    v_templates := CASE
      WHEN jsonb_typeof(v_workflow->'templates_by_intent') = 'object' THEN v_workflow->'templates_by_intent'
      ELSE '{}'::jsonb
    END;
    v_original_templates := v_templates;
    v_top_intent := public.normalize_shipment_intent_v1(v_workflow->>'intent', NULL);

    FOR v_target IN
      SELECT target.intent, target.canonical_name
        FROM (VALUES
          ('shipment.delete'::TEXT, 'shipment_delete_v1'::TEXT),
          ('shipment.reschedule'::TEXT, 'shipment_reschedule_v1'::TEXT)
        ) AS target(intent, canonical_name)
    LOOP
      IF NOT public.webhook_policy_applies_to_shipment_intent_v1(v_value, v_target.intent) THEN
        CONTINUE;
      END IF;

      v_binding := v_templates->v_target.intent;
      v_existing_ref := NULL;
      v_resolved_template_id := NULL;
      v_should_default := FALSE;

      IF v_binding IS NULL OR v_binding = 'null'::jsonb THEN
        IF v_top_intent = v_target.intent THEN
          v_existing_ref := COALESCE(
            NULLIF(btrim(v_workflow->>'template_id'), ''),
            NULLIF(btrim(v_workflow->>'template_name'), '')
          );
        END IF;
        v_should_default := v_existing_ref IS NULL;
      ELSIF jsonb_typeof(v_binding) = 'string' THEN
        v_existing_ref := NULLIF(btrim(v_binding #>> '{}'), '');
        IF v_existing_ref IS NULL AND v_top_intent = v_target.intent THEN
          v_existing_ref := COALESCE(
            NULLIF(btrim(v_workflow->>'template_id'), ''),
            NULLIF(btrim(v_workflow->>'template_name'), '')
          );
        END IF;
        v_should_default := v_existing_ref IS NULL;
      ELSIF jsonb_typeof(v_binding) = 'object' THEN
        v_existing_ref := COALESCE(
          NULLIF(btrim(v_binding->>'template_id'), ''),
          NULLIF(btrim(v_binding->>'template_name'), '')
        );
        IF v_existing_ref IS NULL AND v_top_intent = v_target.intent THEN
          v_existing_ref := COALESCE(
            NULLIF(btrim(v_workflow->>'template_id'), ''),
            NULLIF(btrim(v_workflow->>'template_name'), '')
          );
        END IF;
        v_should_default := v_existing_ref IS NULL;
      ELSE
        RAISE EXCEPTION
          'webhook % binding has unsupported shape for scope %/%',
          v_target.intent,
          v_scope.scope_type,
          COALESCE(v_scope.scope_id::text, '<global>');
      END IF;

      IF NOT v_should_default THEN
        IF v_existing_ref IN (
          '99990000-0000-0000-0000-000000300002',
          'async_provider_dispatch_v1'
        ) THEN
          v_should_default := TRUE;
        ELSE
          v_resolved_template_id := public.resolve_active_workflow_template_ref_v1(v_existing_ref);
          IF v_resolved_template_id IS NULL THEN
            RAISE EXCEPTION
              'webhook % custom follow-up is missing or inactive for scope %/%',
              v_target.intent,
              v_scope.scope_type,
              COALESCE(v_scope.scope_id::text, '<global>');
          END IF;
          IF NOT public.workflow_template_supports_shipment_intent_v1(
            v_resolved_template_id,
            v_target.intent
          ) THEN
            RAISE EXCEPTION
              'webhook % custom follow-up is incompatible for scope %/%',
              v_target.intent,
              v_scope.scope_type,
              COALESCE(v_scope.scope_id::text, '<global>');
          END IF;
        END IF;
      END IF;

      IF v_should_default THEN
        v_templates := v_templates || jsonb_build_object(
          v_target.intent,
          jsonb_build_object('template_name', v_target.canonical_name)
        );
      END IF;
    END LOOP;

    IF v_templates IS NOT DISTINCT FROM v_original_templates THEN
      CONTINUE;
    END IF;

    v_value := v_value || jsonb_build_object(
      'workflow',
      v_workflow || jsonb_build_object('templates_by_intent', v_templates)
    );

    PERFORM 1
      FROM public.upsert_settings_value_v1(
        'webhook_ingest_policy',
        v_scope.scope_type,
        v_scope.scope_id,
        v_value,
        v_scope.schema_version,
        'Add canonical async webhook cancel and reschedule intent defaults'
      );
  END LOOP;

  IF v_seen = 0 THEN
    RAISE EXCEPTION 'webhook_ingest_policy settings missing';
  END IF;
END;
$policy_defaults$;

-- Mapping Studio choices remain webhook-only. They normalize into the same
-- async workflow engine and are never exposed as synchronous /api write routes.
INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'mapping_target',
  'Canonical Mapping Studio target taxonomy for workflow-backed ingress.',
  'engineering',
  'tier_2',
  TRUE
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = clock_timestamp();

WITH definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'mapping_target'
),
seed(value, label, description, sort_order, metadata) AS (
  VALUES
    (
      'shipments.cancel',
      'Shipment cancel',
      'Normalize a provider cancellation event into the workflow-backed shipment delete intent.',
      35,
      '{"tone":"danger","target_resource":"shipments","target_action":"cancel","canonical_intent":"shipment.delete","backend_operation":"cancel","workflow_template_name":"shipment_delete_v1","ingress_mode":"async_third_party_event","allowed_mapping_types":["webhook_inbound"]}'::jsonb
    ),
    (
      'shipments.reschedule',
      'Shipment reschedule',
      'Normalize a provider reschedule event into the workflow-backed shipment reschedule intent.',
      36,
      '{"tone":"warn","target_resource":"shipments","target_action":"reschedule","canonical_intent":"shipment.reschedule","backend_operation":"reschedule","workflow_template_name":"shipment_reschedule_v1","ingress_mode":"async_third_party_event","allowed_mapping_types":["webhook_inbound"]}'::jsonb
    )
)
INSERT INTO public.lookup_values (
  id,
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata,
  effective_from,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  definition.id,
  seed.value,
  seed.label,
  seed.description,
  seed.sort_order,
  FALSE,
  'active',
  seed.metadata,
  clock_timestamp(),
  clock_timestamp(),
  clock_timestamp()
FROM definition
CROSS JOIN seed
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = FALSE,
    status = 'active',
    metadata = EXCLUDED.metadata,
    effective_from = COALESCE(public.lookup_values.effective_from, EXCLUDED.effective_from),
    updated_at = clock_timestamp();

DO $assert$
BEGIN
  IF public.normalize_shipment_intent_v1('shipments.cancel', 'shipment.updated') <> 'shipment.delete'
     OR public.normalize_shipment_intent_v1('shipments.reschedule', 'shipment.updated') <> 'shipment.reschedule'
     OR public.normalize_shipment_intent_v1(NULL, 'shipment.updated') <> 'shipment.updated' THEN
    RAISE EXCEPTION 'webhook shipment intent normalization contract is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN (VALUES
        ('shipment.delete'::TEXT),
        ('shipment.reschedule'::TEXT)
      ) AS target(intent)
     WHERE s.category = 'webhook_ingest_policy'
       AND public.webhook_policy_applies_to_shipment_intent_v1(
         COALESCE(s.cached_value, sv.value, '{}'::jsonb),
         target.intent
       )
       AND NOT public.workflow_template_supports_shipment_intent_v1(
         public.resolve_webhook_followup_template_id_v1(
           COALESCE(s.cached_value, sv.value, '{}'::jsonb),
           target.intent
         ),
         target.intent
       )
  ) THEN
    RAISE EXCEPTION 'webhook mutation workflow bindings are missing, inactive, or incompatible in one or more applicable policy scopes';
  END IF;

  IF (
    SELECT COUNT(DISTINCT wt.name)
      FROM public.workflow_templates wt
     WHERE wt.name IN ('shipment_delete_v1', 'shipment_reschedule_v1')
       AND wt.status = 'active'
  ) <> 2 THEN
    RAISE EXCEPTION 'active delete/reschedule workflow templates are required';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value IN ('shipments.cancel', 'shipments.reschedule')
       AND (
         lv.status <> 'active'
         OR lv.metadata->'allowed_mapping_types' IS DISTINCT FROM '["webhook_inbound"]'::jsonb
         OR lv.metadata->>'ingress_mode' IS DISTINCT FROM 'async_third_party_event'
       )
  ) OR (
    SELECT COUNT(*)
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value IN ('shipments.cancel', 'shipments.reschedule')
  ) <> 2 THEN
    RAISE EXCEPTION 'webhook-only cancel/reschedule mapping targets are incomplete';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202607151320_webhook_async_typed_intent_normalization_v1'));

COMMIT;
