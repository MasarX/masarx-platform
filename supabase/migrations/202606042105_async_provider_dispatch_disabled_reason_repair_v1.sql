-- Restore explicit disabled-state metadata for the async provider dispatch
-- outbound step. Shipment-create webhooks now use the shipment-only workflow;
-- the legacy/provider-dispatch outbound step must remain visibly disabled and
-- explain why it is unavailable before any operator or engine path can enable it.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606042105_async_provider_dispatch_disabled_reason_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'async_provider_dispatch_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'async_provider_dispatch_v1 workflow template not found';
  END IF;

  UPDATE public.workflow_template_steps
     SET metadata = jsonb_strip_nulls(
           COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object(
             'disabled_reason', 'operation_template_unavailable',
             'requires_provider_operation', TRUE
           )
         ),
         updated_at = now()
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'outbound_http'
     AND enabled IS FALSE
     AND NULLIF(metadata->>'disabled_reason', '') IS NULL;
END;
$$;

WITH recalculated AS (
  SELECT
    wts.workflow_template_id,
    md5(
      string_agg(
        concat_ws(
          '|',
          wts.sequence_order,
          COALESCE(wts.operation_name, ''),
          COALESCE(wts.operation_settings_category, ''),
          COALESCE(wts.transition_condition, ''),
          COALESCE(wts.handler_key, ''),
          COALESCE(wts.handler_version, ''),
          COALESCE(wts.enabled::text, ''),
          COALESCE(wts.metadata::text, '')
        ),
        '||' ORDER BY wts.sequence_order, wts.id
      )
    ) AS checksum
  FROM public.workflow_template_steps wts
  WHERE wts.workflow_template_id = (
    SELECT id
      FROM public.workflow_templates
     WHERE name = 'async_provider_dispatch_v1'
     LIMIT 1
  )
  GROUP BY wts.workflow_template_id
)
UPDATE public.workflow_templates wt
   SET steps_checksum = recalculated.checksum,
       updated_at = now()
  FROM recalculated
 WHERE wt.id = recalculated.workflow_template_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.workflow_template_steps wts
      JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
     WHERE wt.name = 'async_provider_dispatch_v1'
       AND wts.handler_key = 'outbound_http'
       AND wts.enabled IS FALSE
       AND wts.metadata->>'disabled_reason' = 'operation_template_unavailable'
  ) THEN
    RAISE EXCEPTION 'async_provider_dispatch_v1 outbound step missing explicit disabled reason';
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202606042105_async_provider_dispatch_disabled_reason_repair_v1'));

COMMIT;
