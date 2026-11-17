-- Plan: B02 Pickup & first-mile handoff / Step: contract regression pack
-- pgTAP: pickup batch 2 contract + policy matrix

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(26);

SELECT has_function(
  'public',
  'create_pickup_request_v1',
  ARRAY['jsonb'],
  'create_pickup_request_v1 exists'
);

SELECT has_function(
  'public',
  'create_pickup_wave_v1',
  ARRAY['jsonb'],
  'create_pickup_wave_v1 exists'
);

SELECT has_function(
  'public',
  'assign_pickup_wave_v1',
  ARRAY['jsonb'],
  'assign_pickup_wave_v1 exists'
);

SELECT has_function(
  'public',
  'resolve_pickup_policy',
  ARRAY['jsonb'],
  'resolve_pickup_policy exists'
);

SELECT has_function(
  'public',
  'pickup_generate_tracking_number_v1',
  ARRAY['uuid', 'text', 'text'],
  'pickup_generate_tracking_number_v1 exists'
);

SELECT has_view('public', 'pickup_requests', 'pickup_requests view exists');
SELECT has_view('public', 'pickup_waves', 'pickup_waves view exists');
SELECT has_view('public', 'pickup_failures', 'pickup_failures view exists');

SELECT has_column('public', 'pickup_requests', 'pickup_request', 'pickup_requests exposes pickup_request');
SELECT has_column('public', 'pickup_waves', 'pickup_assignment', 'pickup_waves exposes pickup_assignment');
SELECT has_column('public', 'pickup_failures', 'followup_tasks', 'pickup_failures exposes followup_tasks');

SELECT ok(
  has_table_privilege('authenticated', 'public.pickup_requests', 'SELECT')
    AND has_table_privilege('service_role', 'public.pickup_requests', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.pickup_requests', 'SELECT'),
  'pickup_requests is readable by authenticated + service_role only'
);

SELECT ok(
  has_table_privilege('authenticated', 'public.pickup_waves', 'SELECT')
    AND has_table_privilege('service_role', 'public.pickup_waves', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.pickup_waves', 'SELECT'),
  'pickup_waves is readable by authenticated + service_role only'
);

SELECT ok(
  has_table_privilege('authenticated', 'public.pickup_failures', 'SELECT')
    AND has_table_privilege('service_role', 'public.pickup_failures', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.pickup_failures', 'SELECT'),
  'pickup_failures is readable by authenticated + service_role only'
);

SELECT is(
  (public.pickup_policy_default_v1()) #>> '{request,shipment_status}',
  'pickup_requested',
  'pickup policy default request shipment_status = pickup_requested'
);

SELECT is(
  (public.pickup_policy_default_v1()) #>> '{wave,shipment_status}',
  'pickup_scheduled',
  'pickup policy default wave shipment_status = pickup_scheduled'
);

SELECT ok(
  COALESCE(((public.pickup_policy_default_v1()) #>> '{failure,followup,reschedule_task_type_key}') = 'dispatch_reschedule_pickup', FALSE)
  AND COALESCE(((public.pickup_policy_default_v1()) #>> '{failure,followup,escalation_task_type_key}') = 'dispatch_pickup_escalation_review', FALSE),
  'pickup policy default follow-up task types are pickup-specific'
);

SELECT ok(
  public.pickup_generate_tracking_number_v1(
    '00000000-0000-0000-0000-000000000123'::uuid,
    NULL,
    'pickup-tracking-seed'
  ) LIKE 'PU%',
  'pickup tracking generator defaults to PU prefix'
);

SELECT is(
  public.pickup_generate_tracking_number_v1(
    '00000000-0000-0000-0000-000000000123'::uuid,
    NULL,
    'pickup-tracking-seed'
  ),
  public.pickup_generate_tracking_number_v1(
    '00000000-0000-0000-0000-000000000123'::uuid,
    NULL,
    'pickup-tracking-seed'
  ),
  'pickup tracking generator is deterministic for the same idempotency seed'
);

SELECT ok(
  (
    SELECT COUNT(*)::int = 3
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'shipment_status'
      AND lv.value IN ('pickup_requested', 'pickup_scheduled', 'pickup_failed')
  ),
  'shipment_status lookup includes pickup_requested, pickup_scheduled, and pickup_failed'
);

SELECT ok(
  (
    SELECT COUNT(*)::int = 4
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'dispatch_exception_reason'
      AND lv.value IN ('sender_unavailable', 'pickup_not_ready', 'access_restricted', 'quantity_mismatch')
  ),
  'dispatch_exception_reason lookup includes pickup-specific failure reasons'
);

SELECT ok(
  (
    SELECT COUNT(*)::int = 2
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) elem
    WHERE s.category = 'task_type_catalog'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND elem->>'key' IN ('dispatch_reschedule_pickup', 'dispatch_pickup_escalation_review')
  ),
  'task_type_catalog includes pickup follow-up task types'
);

SELECT ok(
  COALESCE((
    SELECT (s.cached_value->'task_type_map' ? 'dispatch_reschedule_pickup')
      AND (s.cached_value->'task_type_map' ? 'dispatch_pickup_escalation_review')
      AND (s.cached_value #>> '{task_type_map,dispatch_reschedule_pickup,shipment_status}') = 'pickup_requested'
      AND (s.cached_value #>> '{task_type_map,dispatch_pickup_escalation_review,shipment_status}') = 'pickup_failed'
    FROM public.settings s
    WHERE s.category = 'task_completion_effects_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    LIMIT 1
  ), FALSE),
  'task_completion_effects_policy maps pickup follow-up completions to pickup statuses'
);

SELECT ok(
  COALESCE((
    SELECT (s.cached_value #>> '{stop_kind_map,pickup,outcome_map,sender_unavailable,shipment_status}') = 'pickup_failed'
      AND (s.cached_value #>> '{stop_kind_map,pickup,outcome_map,quantity_mismatch,shipment_status}') = 'pickup_failed'
    FROM public.settings s
    WHERE s.category = 'dispatch_stop_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    LIMIT 1
  ), FALSE),
  'dispatch_stop_policy pickup outcomes map failure reasons to pickup_failed'
);

SELECT is(
  COALESCE(NULLIF(public.resolve_domain_event_policy('00000000-0000-0000-0000-000000000000'::uuid, 'task.completed.dispatch_reschedule_pickup')->>'workflow_template_id', ''), ''),
  (
    SELECT wt.id::text
    FROM public.workflow_templates wt
    WHERE wt.name = 'task_completion_effects_v1'
    LIMIT 1
  ),
  'domain_event_policy maps task.completed.dispatch_reschedule_pickup to task_completion_effects_v1'
);

SELECT is(
  COALESCE(NULLIF(public.resolve_domain_event_policy('00000000-0000-0000-0000-000000000000'::uuid, 'task.completed.dispatch_pickup_escalation_review')->>'workflow_template_id', ''), ''),
  (
    SELECT wt.id::text
    FROM public.workflow_templates wt
    WHERE wt.name = 'task_completion_effects_v1'
    LIMIT 1
  ),
  'domain_event_policy maps task.completed.dispatch_pickup_escalation_review to task_completion_effects_v1'
);

SELECT * FROM finish();

ROLLBACK;
