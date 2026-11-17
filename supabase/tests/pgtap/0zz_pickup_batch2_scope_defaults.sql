-- Plan: B02 Pickup & first-mile handoff / Step: scoped defaults regression
-- pgTAP: pickup scoped dispatch_stop_policy defaults

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

CREATE OR REPLACE FUNCTION pg_temp.test_pickup_batch2_scope_defaults()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEXT ok(
    COALESCE((
      SELECT COUNT(*) = COUNT(*) FILTER (
        WHERE jsonb_typeof(s.cached_value #> '{stop_kind_map,pickup,outcome_map}') = 'object'
      )
      FROM public.settings s
      WHERE s.category = 'dispatch_stop_policy'
        AND s.scope_type IN ('tenant', 'client', 'sender', 'resource')
        AND jsonb_typeof(s.cached_value #> '{stop_kind_map,pickup}') = 'object'
    ), TRUE),
    'scoped dispatch_stop_policy pickup objects carry an outcome_map'
  );

  RETURN NEXT ok(
    COALESCE((
      SELECT bool_and(
        s.cached_value #>> '{stop_kind_map,pickup,outcome_map,sender_unavailable,action_category}' = 'exception'
        AND s.cached_value #>> '{stop_kind_map,pickup,outcome_map,sender_unavailable,shipment_status}' = 'pickup_failed'
        AND s.cached_value #>> '{stop_kind_map,pickup,outcome_map,sender_unavailable,followup_tasks,0,task_type_key}' = 'dispatch_reschedule_pickup'
      )
      FROM public.settings s
      WHERE s.category = 'dispatch_stop_policy'
        AND s.scope_type IN ('tenant', 'client', 'sender', 'resource')
        AND jsonb_typeof(s.cached_value #> '{stop_kind_map,pickup}') = 'object'
    ), TRUE),
    'scoped pickup sender_unavailable keeps exception semantics and reschedule follow-up'
  );

  RETURN NEXT ok(
    COALESCE((
      SELECT bool_and(
        s.cached_value #>> '{stop_kind_map,pickup,outcome_map,quantity_mismatch,action_category}' = 'exception'
        AND s.cached_value #>> '{stop_kind_map,pickup,outcome_map,quantity_mismatch,shipment_status}' = 'pickup_failed'
        AND s.cached_value #>> '{stop_kind_map,pickup,outcome_map,quantity_mismatch,followup_tasks,0,task_type_key}' = 'dispatch_pickup_escalation_review'
      )
      FROM public.settings s
      WHERE s.category = 'dispatch_stop_policy'
        AND s.scope_type IN ('tenant', 'client', 'sender', 'resource')
        AND jsonb_typeof(s.cached_value #> '{stop_kind_map,pickup}') = 'object'
    ), TRUE),
    'scoped pickup quantity_mismatch keeps escalation semantics'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_pickup_batch2_scope_defaults();

SELECT * FROM finish();
ROLLBACK;
