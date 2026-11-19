-- pgTAP: Shipment UC23 NDR recovery actions repair derives missing allowed
-- actions from row-driven dispatch_exception_reason policy.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT has_function(
  'public',
  'repair_dispatch_exception_review_allowed_actions_v1',
  ARRAY['uuid'],
  'public.repair_dispatch_exception_review_allowed_actions_v1(uuid) exists'
);

SELECT isnt(
  has_function_privilege(
    'authenticated',
    'public.repair_dispatch_exception_review_allowed_actions_v1(uuid)',
    'EXECUTE'
  ),
  true,
  'authenticated cannot execute NDR repair directly'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.repair_dispatch_exception_review_allowed_actions_v1(uuid)',
    'EXECUTE'
  ),
  'service_role can execute NDR repair'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_task UUID := gen_random_uuid();
  v_task_type UUID;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Shipment NDR Repair Org', 'shipment-ndr-repair-' || left(v_org::text, 8));

  v_task_type := public.ensure_task_type_from_catalog_v1(
    v_org,
    'dispatch_exception_review',
    jsonb_build_object('organization_id', v_org)
  );

  INSERT INTO public.tasks (
    id,
    organization_id,
    task_type_id,
    task_type_key,
    resource_type,
    resource_id,
    status,
    priority,
    metadata
  )
  VALUES (
    v_task,
    v_org,
    v_task_type,
    'dispatch_exception_review',
    'shipment',
    gen_random_uuid(),
    'open',
    1,
    jsonb_build_object(
      'source', 'pgtap-shipment-ndr-repair',
      'dispatch_exception_reason', 'access_restricted'
    )
  );

  PERFORM set_config('pgtap.shipment_ndr_repair_task_id', v_task::text, true);
END $$;

SELECT is(
  (
    SELECT metadata->'allowed_ndr_actions'
      FROM public.tasks
     WHERE id = current_setting('pgtap.shipment_ndr_repair_task_id')::uuid
  ),
  NULL::jsonb,
  'fixture task starts without allowed_ndr_actions'
);

SELECT is(
  public.repair_dispatch_exception_review_allowed_actions_v1(
    current_setting('pgtap.shipment_ndr_repair_task_id')::uuid
  )->>'repaired_count',
  '1',
  'repair updates the missing-action task'
);

SELECT is(
  (
    SELECT metadata->'allowed_ndr_actions'
      FROM public.tasks
     WHERE id = current_setting('pgtap.shipment_ndr_repair_task_id')::uuid
  ),
  jsonb_build_array('reattempt'),
  'allowed actions derive from access_restricted.default_ndr_action'
);

SELECT is(
  (
    SELECT metadata->>'resolution_action'
      FROM public.tasks
     WHERE id = current_setting('pgtap.shipment_ndr_repair_task_id')::uuid
  ),
  'reattempt',
  'resolution_action is projected for Console readback'
);

SELECT * FROM finish();

ROLLBACK;
