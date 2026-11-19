-- pgTAP: webhook_ingest_policy.workflow must stay object-shaped so receiver
-- intake can write canonical workflow.intent and resolve row-driven templates.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SET search_path TO public, pgtap, extensions, pg_temp;

SELECT has_function(
  'public',
  'normalize_webhook_policy_workflow_v1',
  ARRAY['jsonb'],
  'normalize_webhook_policy_workflow_v1(jsonb) exists'
);

CREATE TEMP TABLE _normalized_policy AS
SELECT public.normalize_webhook_policy_workflow_v1(
  jsonb_build_object(
    'version', 1,
    'ack', jsonb_build_object('mode', 'accepted_async'),
    'workflow', jsonb_build_array(
      NULL,
      jsonb_build_object(
        'templates_by_intent',
        jsonb_build_object(
          'shipment.delete', jsonb_build_object('template_name', 'shipment_delete_v1')
        )
      ),
      jsonb_build_object(
        'templates_by_intent',
        jsonb_build_object(
          'shipment.reschedule', jsonb_build_object('template_name', 'shipment_reschedule_v1')
        ),
        'context_patch',
        jsonb_build_object('source', 'pgtap')
      )
    )
  )
) AS policy;

SELECT is(
  (SELECT jsonb_typeof(policy->'workflow') FROM _normalized_policy),
  'object',
  'legacy workflow arrays normalize to object'
);

SELECT is(
  (SELECT policy#>>'{workflow,templates_by_intent,shipment.delete,template_name}' FROM _normalized_policy),
  'shipment_delete_v1',
  'normalization preserves cancel template mapping'
);

SELECT is(
  (SELECT policy#>>'{workflow,templates_by_intent,shipment.reschedule,template_name}' FROM _normalized_policy),
  'shipment_reschedule_v1',
  'normalization preserves reschedule template mapping'
);

SELECT is(
  (SELECT policy#>>'{workflow,context_patch,source}' FROM _normalized_policy),
  'pgtap',
  'normalization preserves workflow context patch'
);

SELECT ok(
  public.resolve_webhook_followup_template_id_v1(
    (SELECT policy FROM _normalized_policy),
    'shipment.delete'
  ) IS NOT NULL,
  'follow-up template resolver accepts normalized legacy workflow array policy'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'webhook_ingest_policy'
       AND cached_value IS NOT NULL
       AND cached_value ? 'workflow'
       AND jsonb_typeof(cached_value->'workflow') IS DISTINCT FROM 'object'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM public.settings_versions
     WHERE category = 'webhook_ingest_policy'
       AND value IS NOT NULL
       AND value ? 'workflow'
       AND jsonb_typeof(value->'workflow') IS DISTINCT FROM 'object'
  ),
  'persisted webhook_ingest_policy rows have object-shaped workflow values'
);

SELECT * FROM finish();

ROLLBACK;
