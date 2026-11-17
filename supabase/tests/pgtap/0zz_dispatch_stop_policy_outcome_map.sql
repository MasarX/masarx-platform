-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: dispatch_stop_policy delivery outcome_map completeness (canonical reasons)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(32);

CREATE OR REPLACE FUNCTION pg_temp.test_dispatch_stop_policy_outcome_map_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_policy JSONB := NULL;
  v_map JSONB := NULL;
  v_key TEXT;
  v_expected TEXT[] := ARRAY[
    'no_answer',
    'customer_refused',
    'address_not_found',
    'address_incorrect',
    'phone_unreachable',
    'payment_issue',
    'package_damaged',
    'package_lost',
    'business_closed',
    'other'
  ];
  v_business_followup TEXT := NULL;
  v_status TEXT := NULL;
  v_followup0 TEXT := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT s.cached_value
    INTO v_policy
    FROM public.settings s
   WHERE s.category = 'dispatch_stop_policy'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  RETURN NEXT ok(v_policy IS NOT NULL, 'global dispatch_stop_policy exists');
  RETURN NEXT is(jsonb_typeof(v_policy), 'object', 'dispatch_stop_policy is a JSON object');

  v_map := v_policy #> '{stop_kind_map,delivery,outcome_map}';
  RETURN NEXT is(jsonb_typeof(v_map), 'object', 'dispatch_stop_policy.stop_kind_map.delivery.outcome_map is a JSON object');

  FOREACH v_key IN ARRAY v_expected LOOP
    RETURN NEXT ok((v_map ? v_key), format('outcome_map includes canonical reason: %s', v_key));
  END LOOP;

  v_status := lower(NULLIF(btrim(COALESCE(v_map #>> '{no_answer,shipment_status}', '')), ''));
  RETURN NEXT is(v_status, 'delivery_failed', 'no_answer shipment_status=delivery_failed');
  v_followup0 := lower(NULLIF(btrim(COALESCE(v_map #>> '{no_answer,followup_tasks,0,task_type_key}', '')), ''));
  RETURN NEXT is(v_followup0, 'dispatch_exception_review', 'no_answer follow-up task defaults to dispatch_exception_review');

  v_status := lower(NULLIF(btrim(COALESCE(v_map #>> '{customer_refused,shipment_status}', '')), ''));
  RETURN NEXT is(v_status, 'return_to_origin', 'customer_refused shipment_status=return_to_origin');
  v_followup0 := lower(NULLIF(btrim(COALESCE(v_map #>> '{customer_refused,followup_tasks,0,task_type_key}', '')), ''));
  RETURN NEXT is(v_followup0, 'dispatch_rto_pickup', 'customer_refused follow-up task defaults to dispatch_rto_pickup');

  v_status := lower(NULLIF(btrim(COALESCE(v_map #>> '{address_not_found,shipment_status}', '')), ''));
  RETURN NEXT is(v_status, 'delivery_failed', 'address_not_found shipment_status=delivery_failed');
  v_followup0 := lower(NULLIF(btrim(COALESCE(v_map #>> '{address_not_found,followup_tasks,0,task_type_key}', '')), ''));
  RETURN NEXT is(v_followup0, 'dispatch_reschedule_delivery', 'address_not_found follow-up task defaults to dispatch_reschedule_delivery');

  v_status := lower(NULLIF(btrim(COALESCE(v_map #>> '{address_incorrect,shipment_status}', '')), ''));
  RETURN NEXT is(v_status, 'delivery_failed', 'address_incorrect shipment_status=delivery_failed');
  v_followup0 := lower(NULLIF(btrim(COALESCE(v_map #>> '{address_incorrect,followup_tasks,0,task_type_key}', '')), ''));
  RETURN NEXT is(v_followup0, 'dispatch_reschedule_delivery', 'address_incorrect follow-up task defaults to dispatch_reschedule_delivery');

  v_status := lower(NULLIF(btrim(COALESCE(v_map #>> '{phone_unreachable,shipment_status}', '')), ''));
  RETURN NEXT is(v_status, 'delivery_failed', 'phone_unreachable shipment_status=delivery_failed');
  v_followup0 := lower(NULLIF(btrim(COALESCE(v_map #>> '{phone_unreachable,followup_tasks,0,task_type_key}', '')), ''));
  RETURN NEXT is(v_followup0, 'dispatch_exception_review', 'phone_unreachable follow-up task defaults to dispatch_exception_review');

  v_status := lower(NULLIF(btrim(COALESCE(v_map #>> '{payment_issue,shipment_status}', '')), ''));
  RETURN NEXT is(v_status, 'delivery_failed', 'payment_issue shipment_status=delivery_failed');
  v_followup0 := lower(NULLIF(btrim(COALESCE(v_map #>> '{payment_issue,followup_tasks,0,task_type_key}', '')), ''));
  RETURN NEXT is(v_followup0, 'dispatch_exception_review', 'payment_issue follow-up task defaults to dispatch_exception_review');

  v_status := lower(NULLIF(btrim(COALESCE(v_map #>> '{package_damaged,shipment_status}', '')), ''));
  RETURN NEXT is(v_status, 'return_to_origin', 'package_damaged shipment_status=return_to_origin');
  v_followup0 := lower(NULLIF(btrim(COALESCE(v_map #>> '{package_damaged,followup_tasks,0,task_type_key}', '')), ''));
  RETURN NEXT is(v_followup0, 'dispatch_exception_review', 'package_damaged follow-up task defaults to dispatch_exception_review');

  v_status := lower(NULLIF(btrim(COALESCE(v_map #>> '{package_lost,shipment_status}', '')), ''));
  RETURN NEXT is(v_status, 'delivery_failed', 'package_lost shipment_status=delivery_failed');
  v_followup0 := lower(NULLIF(btrim(COALESCE(v_map #>> '{package_lost,followup_tasks,0,task_type_key}', '')), ''));
  RETURN NEXT is(v_followup0, 'dispatch_exception_review', 'package_lost follow-up task defaults to dispatch_exception_review');

  v_status := lower(NULLIF(btrim(COALESCE(v_map #>> '{other,shipment_status}', '')), ''));
  RETURN NEXT is(v_status, 'delivery_failed', 'other shipment_status=delivery_failed');
  v_followup0 := lower(NULLIF(btrim(COALESCE(v_map #>> '{other,followup_tasks,0,task_type_key}', '')), ''));
  RETURN NEXT is(v_followup0, 'dispatch_exception_review', 'other follow-up task defaults to dispatch_exception_review');

  v_business_followup := lower(
    NULLIF(
      btrim(
        COALESCE(
          v_map #>> '{business_closed,followup_tasks,0,task_type_key}',
          ''
        )
      ),
      ''
    )
  );
  RETURN NEXT is(v_business_followup, 'dispatch_reschedule_delivery', 'business_closed follow-up task defaults to dispatch_reschedule_delivery');
END;
$function$;

SELECT * FROM pg_temp.test_dispatch_stop_policy_outcome_map_v1();

SELECT * FROM finish();

ROLLBACK;
