-- Console V2 shipment-amend operation contract + workflow trigger SSOT sync.
BEGIN;
SELECT pg_advisory_lock(hashtext('202605041910_console_v2_amend_trigger_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'shipment_amend_op',
  'Console shipment change request taxonomy with backend shipment_amend_cancel_v1 operation mapping.',
  'operations',
  'tier_1',
  false
)
ON CONFLICT (category) DO UPDATE
  SET description = EXCLUDED.description,
      owner_role = EXCLUDED.owner_role,
      approval_policy = EXCLUDED.approval_policy,
      is_mutable = EXCLUDED.is_mutable;

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.sort_order,
  false,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('amend_address', 'Amend address', 10, '{"is_valid_op": true, "backend_operation": "address"}'),
  ('amend_cod',     'Amend COD',     20, '{"is_valid_op": true, "backend_operation": "modify"}'),
  ('cancel',        'Cancel',        30, '{"is_valid_op": true, "backend_operation": "cancel"}'),
  ('reschedule',    'Reschedule',    40, '{"is_valid_op": true, "backend_operation": "reschedule"}'),
  ('_default',      'Unknown',       99, '{"is_valid_op": false}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'shipment_amend_op'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET label = EXCLUDED.label,
      sort_order = EXCLUDED.sort_order,
      status = EXCLUDED.status,
      metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata;

CREATE OR REPLACE FUNCTION public.workflow_template_step_trigger_metadata_sync_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_step_metadata jsonb := COALESCE(NEW.metadata, '{}'::jsonb);
BEGIN
  IF NOT (v_step_metadata ? 'trigger_event') THEN
    RETURN NEW;
  END IF;

  UPDATE public.workflow_templates AS wt
     SET metadata = jsonb_strip_nulls(
           COALESCE(wt.metadata, '{}'::jsonb)
           || jsonb_build_object(
             'trigger_event',
             NULLIF(btrim(COALESCE(v_step_metadata->>'trigger_event', '')), ''),
             'trigger_conditions',
             CASE
               WHEN v_step_metadata ? 'trigger_conditions' THEN v_step_metadata->'trigger_conditions'
               ELSE NULL
             END,
             'trigger_condition_jsonlogic',
             NEW.condition_jsonlogic
           )
         ),
         updated_at = now()
   WHERE wt.id = NEW.workflow_template_id;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS workflow_template_step_trigger_metadata_sync_tg
  ON public.workflow_template_steps;

CREATE TRIGGER workflow_template_step_trigger_metadata_sync_tg
AFTER INSERT OR UPDATE OF metadata, condition_jsonlogic
ON public.workflow_template_steps
FOR EACH ROW
EXECUTE FUNCTION public.workflow_template_step_trigger_metadata_sync_v1();

WITH trigger_steps AS (
  SELECT DISTINCT ON (workflow_template_id)
    workflow_template_id,
    metadata,
    condition_jsonlogic
  FROM public.workflow_template_steps
  WHERE COALESCE(metadata, '{}'::jsonb) ? 'trigger_event'
  ORDER BY workflow_template_id, sequence_order ASC, id ASC
)
UPDATE public.workflow_templates AS wt
   SET metadata = jsonb_strip_nulls(
         COALESCE(wt.metadata, '{}'::jsonb)
         || jsonb_build_object(
           'trigger_event',
           NULLIF(btrim(COALESCE(trigger_steps.metadata->>'trigger_event', '')), ''),
           'trigger_conditions',
           CASE
             WHEN trigger_steps.metadata ? 'trigger_conditions' THEN trigger_steps.metadata->'trigger_conditions'
             ELSE NULL
           END,
           'trigger_condition_jsonlogic',
           trigger_steps.condition_jsonlogic
         )
       ),
       updated_at = now()
  FROM trigger_steps
 WHERE wt.id = trigger_steps.workflow_template_id;

COMMENT ON FUNCTION public.workflow_template_step_trigger_metadata_sync_v1()
  IS 'Keeps workflow_templates.metadata trigger_event aligned when Console V2 trigger composer updates a trigger step.';
COMMENT ON TRIGGER workflow_template_step_trigger_metadata_sync_tg
  ON public.workflow_template_steps
  IS 'Propagates trigger step metadata into workflow_templates.metadata, the Console V2 workflow template trigger SSOT.';

SELECT pg_advisory_unlock(hashtext('202605041910_console_v2_amend_trigger_contract_v1'));
COMMIT;
