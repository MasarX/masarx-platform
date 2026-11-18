BEGIN;

SELECT plan(13);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'geocoding_attempt_status'
       AND lv.value = 'queued'
       AND lv.metadata->>'tone' = 'info'
       AND (lv.metadata->>'canonical_execution_status')::boolean IS TRUE
  ),
  'geocoding_attempt_status queued is a canonical execution status'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'geocoding_attempt_status'
       AND lv.value = 'in_progress'
       AND lv.metadata->>'tone' = 'info'
       AND (lv.metadata->>'canonical_execution_status')::boolean IS TRUE
  ),
  'geocoding_attempt_status in_progress is a canonical execution status'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'geocoding_attempt_status'
       AND lv.value = 'succeeded'
       AND lv.metadata->>'tone' = 'good'
       AND (lv.metadata->>'terminal')::boolean IS TRUE
  ),
  'geocoding_attempt_status succeeded is terminal success'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'geocoding_attempt_status'
       AND lv.value = 'failed'
       AND lv.metadata->>'tone' = 'danger'
       AND (lv.metadata->>'terminal')::boolean IS TRUE
  ),
  'geocoding_attempt_status failed is terminal danger'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'geocoding_attempt_status'
       AND lv.value = 'permanently_failed'
       AND lv.metadata->>'tone' = 'danger'
       AND (lv.metadata->>'terminal')::boolean IS TRUE
  ),
  'geocoding_attempt_status permanently_failed is terminal danger'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'geocoding_attempt_status'
       AND lv.value = 'skipped'
       AND lv.metadata->>'tone' = 'neutral'
       AND (lv.metadata->>'terminal')::boolean IS TRUE
  ),
  'geocoding_attempt_status skipped is terminal neutral'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'geocoding_attempt_status'
       AND lv.value = 'deferred'
       AND lv.metadata->>'tone' = 'warn'
       AND (lv.metadata->>'canonical_execution_status')::boolean IS TRUE
  ),
  'geocoding_attempt_status deferred is canonical execution status'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'geocoding_attempt_status'
       AND lv.value = 'manual_review'
       AND lv.metadata->>'tone' = 'warn'
       AND (lv.metadata->>'canonical_execution_status')::boolean IS TRUE
  ),
  'geocoding_attempt_status manual_review is row-driven for human review'
);

SELECT ok(
  to_regprocedure('public.ui_execute_shipment_update_geocode_v1(text,text,text[],text,integer,jsonb)') IS NOT NULL,
  'public.ui_execute_shipment_update_geocode_v1 remains the canonical geocode execution entrypoint'
);

SELECT ok(
  to_regprocedure('public.ui_execute_shipment_update_geocode_v1_execution_base(text,text,text[],text,integer,jsonb)') IS NOT NULL,
  'public.ui_execute_shipment_update_geocode_v1 delegates to its execution base for enrichment'
);

SELECT ok(
  position(
    'manual_review_tasks'
    IN pg_get_functiondef('public.ui_execute_shipment_update_geocode_v1(text,text,text[],text,integer,jsonb)'::regprocedure)
  ) > 0
  AND position(
    'geocoding_attempts'
    IN pg_get_functiondef('public.ui_execute_shipment_update_geocode_v1(text,text,text[],text,integer,jsonb)'::regprocedure)
  ) > 0,
  'public.ui_execute_shipment_update_geocode_v1 enriches live response from geocoding ledgers'
);

SELECT ok(
  to_regprocedure('api.ui_execute_shipment_update_geocode_v1(text,text,text[],text,integer,jsonb)') IS NOT NULL,
  'api.ui_execute_shipment_update_geocode_v1 remains browser-safe for Console execution'
);

SELECT ok(
  position(
    '{"role":"service_role"}'
    IN pg_get_functiondef('public.ui_execute_shipment_update_geocode_v1(text,text,text[],text,integer,jsonb)'::regprocedure)
  ) = 0,
  'public.ui_execute_shipment_update_geocode_v1 does not fabricate service_role claims for readback enrichment'
);

SELECT * FROM finish();

ROLLBACK;
