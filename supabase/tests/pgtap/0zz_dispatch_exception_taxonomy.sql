-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Dispatch exception taxonomy + task types (SSOT)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions ld
    WHERE ld.category = 'dispatch_exception_reason'
  ),
  'dispatch_exception_reason lookup_definitions seeded'
);

SELECT ok(
  (
    SELECT COUNT(*)
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'dispatch_exception_reason'
      AND lv.status = 'active'
  ) >= 6,
  'dispatch_exception_reason has active values'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'dispatch_exception_reason'
      AND lv.value = 'no_answer'
  ),
  'dispatch_exception_reason includes no_answer'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'dispatch_exception_reason'
      AND lv.value = 'customer_refused'
  ),
  'dispatch_exception_reason includes customer_refused'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'route_stop_kind'
      AND lv.value = 'return_to_origin'
  ),
  'route_stop_kind includes return_to_origin alias'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'task_type_catalog'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  'task_type_catalog global settings present'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) elem
    WHERE s.category = 'task_type_catalog'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND elem->>'key' = 'dispatch_reschedule_delivery'
  ),
  'task_type_catalog includes dispatch_reschedule_delivery'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) elem
    WHERE s.category = 'task_type_catalog'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND elem->>'key' = 'dispatch_reattempt_delivery'
  ),
  'task_type_catalog includes dispatch_reattempt_delivery'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_templates wt
    WHERE wt.name = 'dispatch_reattempt_delivery_schedule_v1'
      AND wt.status = 'active'
  ),
  'workflow_templates includes dispatch_reattempt_delivery_schedule_v1'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) elem
    WHERE s.category = 'task_type_catalog'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND elem->>'key' = 'dispatch_rto_pickup'
  ),
  'task_type_catalog includes dispatch_rto_pickup'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) elem
    WHERE s.category = 'task_type_catalog'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND elem->>'key' = 'dispatch_return_pickup'
  ),
  'task_type_catalog includes dispatch_return_pickup'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) elem
    WHERE s.category = 'task_type_catalog'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND elem->>'key' = 'dispatch_swap_completion'
  ),
  'task_type_catalog includes dispatch_swap_completion'
);

SELECT * FROM finish();

ROLLBACK;
