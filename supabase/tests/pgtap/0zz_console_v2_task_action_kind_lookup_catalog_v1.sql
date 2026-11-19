-- pgTAP: Console V2 task action kind lookup catalog
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(11);

CREATE TEMP TABLE _task_action_lookup_actor (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Task Action Lookup Org', 'task-action-lookup-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (
    v_user,
    v_org,
    'task-action-lookup-' || left(v_user::text, 8) || '@example.com',
    'Task Action Lookup User',
    'tenant'
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_user);

  INSERT INTO _task_action_lookup_actor (organization_id, user_id)
  VALUES (v_org, v_user);
END $$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'task_action_kind'
      AND is_mutable = false
  ),
  'task_action_kind lookup definition exists as immutable row-driven registry'
);

SELECT is(
  (
    SELECT lv.metadata->>'next_status'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'task_action_kind'
      AND lv.value = 'resolve'
      AND lv.status = 'active'
  ),
  'completed',
  'task_action_kind.resolve transitions to completed'
);

SELECT is(
  (
    SELECT lv.metadata->>'bulk_strategy'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'task_action_kind'
      AND lv.value = 'resolve'
      AND lv.status = 'active'
  ),
  'status_transition',
  'task_action_kind.resolve carries status-transition bulk strategy'
);

SELECT is(
  (
    SELECT lv.metadata->>'next_status'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'task_action_kind'
      AND lv.value = 'approve'
      AND lv.status = 'active'
  ),
  'completed',
  'task_action_kind.approve transitions to completed'
);

SELECT is(
  (
    SELECT lv.metadata->>'next_status'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'task_action_kind'
      AND lv.value = 'reject'
      AND lv.status = 'active'
  ),
  'rejected',
  'task_action_kind.reject transitions to rejected'
);

SELECT is(
  (
    SELECT lv.metadata->>'next_status'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'task_action_kind'
      AND lv.value = 'escalate'
      AND lv.status = 'active'
  ),
  'escalated',
  'task_action_kind.escalate transitions to escalated'
);

SELECT is(
  (
    SELECT lv.metadata->>'bulk_strategy'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'task_action_kind'
      AND lv.value = 'claim'
      AND lv.status = 'active'
  ),
  'assignment',
  'task_action_kind.claim carries assignment bulk strategy'
);

SELECT ok(
  (
    SELECT (lv.metadata->>'is_snooze_action')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'task_action_kind'
      AND lv.value = 'snooze'
      AND lv.status = 'active'
  ),
  'task_action_kind.snooze is row-marked as the snooze action'
);

DO $$
DECLARE
  v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM _task_action_lookup_actor;
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
END $$;
SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT count(*)::int
    FROM public.list_lookup_values_v1('task_action_kind')
    WHERE value IN ('resolve', 'approve', 'reject', 'claim', 'snooze')
  ),
  5,
  'public.list_lookup_values_v1 exposes core task action rows'
);

SELECT is(
  (
    SELECT metadata->>'next_status'
    FROM public.list_lookup_values_v1('task_action_kind')
    WHERE value = 'resolve'
  ),
  'completed',
  'public.list_lookup_values_v1 exposes resolve next_status metadata'
);

SELECT is(
  (
    SELECT metadata->>'next_status'
    FROM api.list_lookup_values_v1('task_action_kind')
    WHERE value = 'resolve'
  ),
  'completed',
  'api.list_lookup_values_v1 exposes resolve next_status metadata for browser clients'
);

SELECT * FROM finish();
ROLLBACK;
