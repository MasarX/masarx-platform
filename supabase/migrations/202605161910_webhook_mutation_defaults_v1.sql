-- Console V2 External Intake webhook mutation defaults.
--
-- Keep non-create webhook mutations row-driven: provider-facing events resolve
-- to canonical intents, default policies point those intents at workflow
-- templates, and Mapping Studio exposes selectable cancel/reschedule targets.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605161910_webhook_mutation_defaults_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.normalize_shipment_intent_v1(
  p_intent TEXT,
  p_event_type TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
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
    'shipment.reschedule',
    'shipments.reschedule',
    'update.status',
    'update.geocode',
    'update.address',
    'update.driver',
    'update.action',
    'update.attachment'
  ) THEN
    RETURN CASE
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
    WHEN 'shipment.canceled' THEN RETURN 'shipment.delete';
    WHEN 'shipment.cancelled' THEN RETURN 'shipment.delete';
    WHEN 'shipment.rescheduled' THEN RETURN 'shipment.reschedule';
    WHEN 'shipments.rescheduled' THEN RETURN 'shipment.reschedule';
    ELSE
      RETURN COALESCE(v_intent, v_event_type);
  END CASE;
END;
$function$;

COMMENT ON FUNCTION public.normalize_shipment_intent_v1(TEXT, TEXT)
  IS 'Normalizes provider webhook shipment event names into canonical workflow intents, including canceled/cancelled compatibility and shipment.rescheduled.';

UPDATE public.settings
   SET cached_value =
       COALESCE(cached_value, '{}'::jsonb)
       || jsonb_build_object(
         'workflow',
         COALESCE(cached_value->'workflow', '{}'::jsonb)
         || jsonb_build_object(
           'templates_by_intent',
           COALESCE(cached_value#>'{workflow,templates_by_intent}', '{}'::jsonb)
           || jsonb_build_object(
             'shipment.delete', jsonb_build_object('template_name', 'shipment_delete_v1'),
             'shipment.reschedule', jsonb_build_object('template_name', 'shipment_reschedule_v1')
           )
         )
       ),
       last_updated = now()
 WHERE category = 'webhook_ingest_policy';

UPDATE public.settings_versions
   SET value =
       COALESCE(value, '{}'::jsonb)
       || jsonb_build_object(
         'workflow',
         COALESCE(value->'workflow', '{}'::jsonb)
         || jsonb_build_object(
           'templates_by_intent',
           COALESCE(value#>'{workflow,templates_by_intent}', '{}'::jsonb)
           || jsonb_build_object(
             'shipment.delete', jsonb_build_object('template_name', 'shipment_delete_v1'),
             'shipment.reschedule', jsonb_build_object('template_name', 'shipment_reschedule_v1')
           )
         )
       ),
       change_reason = COALESCE(NULLIF(change_reason, ''), 'Webhook mutation defaults include cancel/reschedule workflow targets.'),
       approved_at = COALESCE(approved_at, now()),
       effective_from = COALESCE(effective_from, now())
 WHERE category = 'webhook_ingest_policy';

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
      'Normalize provider cancellation payloads into the workflow-backed shipment cancel path.',
      35,
      '{"tone":"danger","target_resource":"shipments","target_action":"cancel","canonical_intent":"shipment.delete","backend_operation":"cancel","workflow_template_name":"shipment_delete_v1","allowed_mapping_types":["webhook_inbound"]}'::jsonb
    ),
    (
      'shipments.reschedule',
      'Shipment reschedule',
      'Normalize provider reschedule payloads into the workflow-backed shipment reschedule path.',
      36,
      '{"tone":"warn","target_resource":"shipments","target_action":"reschedule","canonical_intent":"shipment.reschedule","backend_operation":"reschedule","workflow_template_name":"shipment_reschedule_v1","allowed_mapping_types":["webhook_inbound"]}'::jsonb
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
  now(),
  now(),
  now()
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
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605161910_webhook_mutation_defaults_v1'));

COMMIT;
