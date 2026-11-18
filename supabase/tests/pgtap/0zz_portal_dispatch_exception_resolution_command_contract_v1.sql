-- pgTAP: dedicated dispatch-exception commands keep canonical top-level inputs

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(2);

SELECT is(
  (
    SELECT count(DISTINCT item->>'key')::INTEGER
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(s.cached_value->'commands', '[]'::jsonb)
      ) AS item
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND item->>'key' = ANY (ARRAY[
         'dispatch_exception_review.complete',
         'dispatch_exception_review_mine.complete',
         'sla_deadline_alerts.complete'
       ])
  ),
  3,
  'global command registry exposes all dedicated dispatch-exception resolution commands'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(s.cached_value->'commands', '[]'::jsonb)
      ) AS item
     WHERE s.category = 'ui_command_registry'
       AND item->>'key' = ANY (ARRAY[
         'dispatch_exception_review.complete',
         'dispatch_exception_review_mine.complete',
         'sla_deadline_alerts.complete'
       ])
       AND (
         item#>>'{execution,type}' IS DISTINCT FROM 'rpc'
         OR item#>>'{execution,rpc}' IS DISTINCT FROM 'ui_execute_dispatch_exception_resolution_v1'
         OR item#>'{execution}' ? 'payload_key'
         OR item#>'{execution}' ? 'params'
         OR item#>>'{execution,input_schema,fields,0,key}' IS DISTINCT FROM 'resolution_action'
         OR item#>>'{execution,input_schema,fields,0,type}' IS DISTINCT FROM 'lookup'
         OR item#>>'{execution,input_schema,fields,0,lookup_category}' IS DISTINCT FROM 'ndr_action'
         OR item#>>'{execution,input_schema,fields,1,key}' IS DISTINCT FROM 'resolution_notes'
       )
  ),
  'every dedicated dispatch-exception command uses the canonical unwrapped input contract'
);

SELECT * FROM finish();

ROLLBACK;
