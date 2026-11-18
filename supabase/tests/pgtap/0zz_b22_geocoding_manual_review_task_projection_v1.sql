-- pgTAP: Geocoding manual review Tasks SSOT projection

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(37);

SELECT throws_ok(
  'SELECT public.geocoding_manual_review_queue_task_sync_v1(NULL::uuid)',
  '23514',
  'geocoding_manual_review_queue_task_sync_v1 requires manual_review_task_id',
  'current geocoding sync wrapper rejects NULL before source lookup'
);

WITH candidate AS MATERIALIZED (
  SELECT gen_random_uuid() AS id
), absent AS (
  SELECT candidate.id
  FROM candidate
  WHERE NOT EXISTS (
    SELECT 1 FROM public.manual_review_tasks mrt WHERE mrt.id = candidate.id
  )
)
SELECT is(
  public.geocoding_manual_review_queue_task_sync_v1((SELECT id FROM absent)),
  NULL::uuid,
  'current geocoding sync wrapper preserves NULL result for a verified absent nonnull UUID'
);



SELECT has_function(
  'public',
  'geocoding_manual_review_queue_task_sync_v1',
  ARRAY['uuid'],
  'geocoding manual-review task sync exists'
);
SELECT has_function(
  'public',
  'geocoding_manual_review_queue_task_sync_trigger_v1',
  ARRAY[]::TEXT[],
  'geocoding manual-review task sync trigger exists'
);
SELECT has_function(
  'public',
  'geocoding_manual_review_operator_task_resolve_v1',
  ARRAY[]::TEXT[],
  'geocoding manual-review task resolution trigger exists'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.geocoding_manual_review_queue_task_sync_v1(uuid)',
    'EXECUTE'
  ),
  'service_role can execute geocoding manual-review task sync'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.geocoding_manual_review_queue_task_sync_v1(uuid)',
    'EXECUTE'
  ),
  'authenticated cannot execute service-only geocoding task sync directly'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.geocoding_manual_review_queue_task_sync_v1(uuid)',
    'EXECUTE'
  ),
  'anon cannot execute service-only geocoding task sync directly'
);
SELECT ok(
  has_table_privilege('authenticated', 'public.tasks', 'SELECT'),
  'authenticated tenant users retain scoped canonical tasks read access'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS elem(value)
     WHERE s.category = 'task_type_catalog'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND elem.value->>'key' = 'geocoding_manual_review'
       AND elem.value->>'default_queue_key' = 'address_ops'
       AND elem.value#>>'{metadata,assignment_defaults,sla_minutes}' = '60'
  ),
  'task_type_catalog defines geocoding manual review queue and SLA defaults'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS elem(value)
     WHERE s.category = 'task_type_catalog'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND elem.value->>'key' = 'geocoding_manual_review'
       AND elem.value#>>'{metadata,manual_review_projection,terminal_status_outcomes,completed}' = 'resolved'
       AND elem.value#>>'{metadata,manual_review_projection,terminal_status_outcomes,exception}' = 'rejected'
  ),
  'task_type_catalog defines canonical terminal outcome mapping'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.manual_review_tasks'::regclass
       AND t.tgname = 'trg_geocoding_manual_review_queue_task_sync_v1'
       AND NOT t.tgisinternal
  ),
  'manual_review_tasks projection trigger is installed'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.tasks'::regclass
       AND t.tgname = 'trg_geocoding_manual_review_operator_task_resolve_v1'
       AND NOT t.tgisinternal
  ),
  'canonical tasks terminal resolution trigger is installed'
);

CREATE OR REPLACE FUNCTION pg_temp.test_b22_geocoding_manual_review_task_projection_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_review_resolved UUID := gen_random_uuid();
  v_review_rejected UUID := gen_random_uuid();
  v_review_unrelated UUID := gen_random_uuid();
  v_task_resolved UUID := NULL;
  v_task_rejected UUID := NULL;
  v_retry_task UUID := NULL;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B22 Geocoding Review Org', 'b22-geocode-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B22 Geocoding Review Client', 'b22-geocode-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.manual_review_tasks (
    id,
    organization_id,
    client_id,
    task_type,
    reason,
    status,
    metadata
  ) VALUES (
    v_review_resolved,
    v_org,
    v_client,
    'geocoding',
    'confidence_below_threshold',
    'pending',
    jsonb_build_object('source', 'pgtap')
  );

  SELECT t.id
    INTO v_task_resolved
    FROM public.tasks t
    JOIN public.task_types tt ON tt.id = t.task_type_id
   WHERE t.organization_id = v_org
     AND tt.key = 'geocoding_manual_review'
     AND t.metadata->>'manual_review_task_id' = v_review_resolved::text;

  RETURN NEXT ok(v_task_resolved IS NOT NULL, 'pending geocoding review projects into canonical tasks');
  RETURN NEXT is(
    (SELECT metadata->>'operator_task_id' FROM public.manual_review_tasks WHERE id = v_review_resolved),
    v_task_resolved::text,
    'manual-review source stores canonical task lineage'
  );
  RETURN NEXT is(
    (SELECT queue_key FROM public.tasks WHERE id = v_task_resolved),
    'address_ops',
    'canonical task inherits row-driven queue default'
  );
  RETURN NEXT is(
    (SELECT sla_minutes::text FROM public.tasks WHERE id = v_task_resolved),
    '60',
    'canonical task inherits row-driven SLA default'
  );

  v_retry_task := public.geocoding_manual_review_queue_task_sync_v1(v_review_resolved);
  RETURN NEXT is(v_retry_task, v_task_resolved, 'repeated sync returns the deterministic task');
  RETURN NEXT is(
    (
      SELECT count(*)::text
        FROM public.tasks t
       WHERE t.organization_id = v_org
         AND t.idempotency_key = 'geocoding-manual-review:' || v_review_resolved::text
    ),
    '1',
    'repeated sync does not duplicate canonical tasks'
  );

  UPDATE public.tasks
     SET status = 'completed',
         status_reason = 'address_match_confirmed'
   WHERE id = v_task_resolved;

  RETURN NEXT is(
    (SELECT status FROM public.manual_review_tasks WHERE id = v_review_resolved),
    'resolved',
    'completed canonical task resolves the source manual-review row'
  );
  RETURN NEXT is(
    (SELECT resolution_outcome FROM public.manual_review_tasks WHERE id = v_review_resolved),
    'resolved',
    'completed canonical task records resolved outcome'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.decision_log dl
       WHERE dl.organization_id = v_org
         AND dl.resource_type = 'manual_review_task'
         AND dl.resource_id = v_review_resolved
         AND dl.decision_point = 'resolve_from_canonical_task'
         AND dl.decision_outcome = 'resolved'
    ),
    'terminal task resolution records decision lineage'
  );

  INSERT INTO public.manual_review_tasks (
    id,
    organization_id,
    client_id,
    task_type,
    reason,
    status,
    metadata
  ) VALUES (
    v_review_rejected,
    v_org,
    v_client,
    'geocoding_auto_learn',
    'auto_learn_district_requires_approval',
    'pending',
    '{}'::jsonb
  );

  SELECT (metadata->>'operator_task_id')::uuid
    INTO v_task_rejected
    FROM public.manual_review_tasks
   WHERE id = v_review_rejected;

  UPDATE public.tasks
     SET status = 'exception',
         status_reason = 'candidate_rejected'
   WHERE id = v_task_rejected;

  RETURN NEXT is(
    (SELECT resolution_outcome FROM public.manual_review_tasks WHERE id = v_review_rejected),
    'rejected',
    'row-driven exception mapping rejects the source manual review'
  );

  INSERT INTO public.manual_review_tasks (
    id,
    organization_id,
    client_id,
    task_type,
    reason,
    status,
    metadata
  ) VALUES (
    v_review_unrelated,
    v_org,
    v_client,
    'settings_approval',
    'unrelated_review',
    'pending',
    '{}'::jsonb
  );

  RETURN NEXT is(
    (SELECT metadata->>'operator_task_id' FROM public.manual_review_tasks WHERE id = v_review_unrelated),
    NULL::text,
    'unconfigured manual-review types are not projected into geocoding tasks'
  );
END;
$function$;

SELECT * FROM pg_temp.test_b22_geocoding_manual_review_task_projection_v1();

CREATE OR REPLACE FUNCTION pg_temp.test_b22_geocoding_manual_review_projection_guards_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_other_client UUID := gen_random_uuid();
  v_catalog_org UUID := gen_random_uuid();
  v_catalog_client UUID := gen_random_uuid();
  v_duplicate_address UUID := gen_random_uuid();
  v_disabled_address UUID := gen_random_uuid();
  v_forged_address UUID := gen_random_uuid();
  v_collision_address UUID := gen_random_uuid();
  v_other_address UUID := gen_random_uuid();
  v_catalog_address UUID := gen_random_uuid();
  v_other_shipment UUID := gen_random_uuid();
  v_duplicate_one UUID := gen_random_uuid();
  v_duplicate_two UUID := gen_random_uuid();
  v_disabled_review UUID := gen_random_uuid();
  v_forged_review UUID := gen_random_uuid();
  v_other_review UUID := gen_random_uuid();
  v_collision_review UUID := gen_random_uuid();
  v_catalog_review UUID := gen_random_uuid();
  v_bad_resource_review UUID := gen_random_uuid();
  v_duplicate_task UUID := NULL;
  v_forged_task UUID := NULL;
  v_cross_tenant_task UUID := NULL;
  v_collision_task UUID := NULL;
  v_collision_rejected BOOLEAN := FALSE;
  v_resource_rejected BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'B22 Guard Org', 'b22-guard-' || left(v_org::text, 8)),
    (v_other_org, 'B22 Other Guard Org', 'b22-other-' || left(v_other_org::text, 8)),
    (v_catalog_org, 'B22 Catalog Guard Org', 'b22-catalog-' || left(v_catalog_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client, v_org, 'B22 Guard Client', 'b22-guard-client-' || left(v_client::text, 8), 'active'),
    (v_other_client, v_other_org, 'B22 Other Client', 'b22-other-client-' || left(v_other_client::text, 8), 'active'),
    (v_catalog_client, v_catalog_org, 'B22 Catalog Client', 'b22-catalog-client-' || left(v_catalog_client::text, 8), 'active');

  INSERT INTO public.addresses (
    id, organization_id, client_id, raw_input, city, province, country, validation_status, created_at, updated_at
  ) VALUES
    (v_duplicate_address, v_org, v_client, '{}'::jsonb, 'Riyadh', 'Riyadh', 'SA', 'pending', now(), now()),
    (v_disabled_address, v_org, v_client, '{}'::jsonb, 'Riyadh', 'Riyadh', 'SA', 'pending', now(), now()),
    (v_forged_address, v_org, v_client, '{}'::jsonb, 'Riyadh', 'Riyadh', 'SA', 'pending', now(), now()),
    (v_collision_address, v_org, v_client, '{}'::jsonb, 'Riyadh', 'Riyadh', 'SA', 'pending', now(), now()),
    (v_other_address, v_other_org, v_other_client, '{}'::jsonb, 'Jeddah', 'Makkah', 'SA', 'pending', now(), now()),
    (v_catalog_address, v_catalog_org, v_catalog_client, '{}'::jsonb, 'Dammam', 'Eastern', 'SA', 'pending', now(), now());

  INSERT INTO public.shipments (
    id, organization_id, client_id, service_type, tracking_number, status
  ) VALUES (
    v_other_shipment, v_other_org, v_other_client, 'delivery',
    'B22-RESOURCE-' || left(v_other_shipment::text, 8), 'pending'
  );

  INSERT INTO public.manual_review_tasks (
    id, organization_id, client_id, address_id, task_type, reason, status, created_at, metadata
  ) VALUES (
    v_duplicate_one, v_org, v_client, v_duplicate_address,
    'geocoding', 'duplicate_identity', 'pending', now() - interval '1 second', '{}'::jsonb
  );
  INSERT INTO public.manual_review_tasks (
    id, organization_id, client_id, address_id, task_type, reason, status, created_at, metadata
  ) VALUES (
    v_duplicate_two, v_org, v_client, v_duplicate_address,
    'geocoding', 'duplicate_identity', 'pending', now(), '{}'::jsonb
  );

  SELECT (metadata->>'operator_task_id')::uuid
    INTO v_duplicate_task
    FROM public.manual_review_tasks
   WHERE id = v_duplicate_one;

  RETURN NEXT is(
    (SELECT metadata->>'operator_task_id' FROM public.manual_review_tasks WHERE id = v_duplicate_two),
    v_duplicate_task::text,
    'active duplicate source identities share the earliest source task'
  );
  RETURN NEXT is(
    (SELECT count(*)::text FROM public.tasks WHERE organization_id = v_org AND id = v_duplicate_task),
    '1',
    'active duplicate source identities create one canonical task'
  );
  UPDATE public.tasks SET status = 'completed' WHERE id = v_duplicate_task;
  RETURN NEXT is(
    (SELECT count(*)::text FROM public.manual_review_tasks
      WHERE id IN (v_duplicate_one, v_duplicate_two) AND status = 'resolved'),
    '2',
    'one canonical terminal task resolves every reciprocally linked duplicate source'
  );

  UPDATE public.task_types
     SET enabled = FALSE
   WHERE organization_id = v_org
     AND key = 'geocoding_manual_review';

  INSERT INTO public.manual_review_tasks (
    id, organization_id, client_id, address_id, task_type, reason, status, metadata
  ) VALUES (
    v_disabled_review, v_org, v_client, v_disabled_address,
    'geocoding', 'disabled_type_repair', 'pending', '{}'::jsonb
  );

  RETURN NEXT ok(
    (SELECT enabled FROM public.task_types WHERE organization_id = v_org AND key = 'geocoding_manual_review'),
    'sync repairs a disabled existing geocoding task type before creation'
  );

  INSERT INTO public.manual_review_tasks (
    id, organization_id, client_id, address_id, task_type, reason, status, metadata
  ) VALUES (
    v_forged_review, v_org, v_client, v_forged_address,
    'geocoding', 'forged_same_tenant', 'pending', '{}'::jsonb
  );

  SELECT created.task_id INTO v_forged_task
    FROM public.create_task_system_v1(jsonb_build_object(
      'task_type_key', 'geocoding_manual_review',
      'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client),
      'resource_type', 'address',
      'resource_id', v_forged_address,
      'idempotency_key', 'b22-forged-same-tenant:' || v_forged_review::text,
      'metadata', jsonb_build_object('manual_review_task_id', v_forged_review),
      'actor_system', 'pgtap'
    )) created;
  UPDATE public.tasks SET status = 'completed' WHERE id = v_forged_task;

  RETURN NEXT is(
    (SELECT status FROM public.manual_review_tasks WHERE id = v_forged_review),
    'pending',
    'same-tenant forged task cannot resolve a source without reciprocal lineage'
  );

  INSERT INTO public.manual_review_tasks (
    id, organization_id, client_id, address_id, task_type, reason, status, metadata
  ) VALUES (
    v_other_review, v_other_org, v_other_client, v_other_address,
    'geocoding', 'forged_cross_tenant', 'pending', '{}'::jsonb
  );

  SELECT created.task_id INTO v_cross_tenant_task
    FROM public.create_task_system_v1(jsonb_build_object(
      'task_type_key', 'geocoding_manual_review',
      'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client),
      'resource_type', 'address',
      'resource_id', v_forged_address,
      'idempotency_key', 'b22-forged-cross-tenant:' || v_other_review::text,
      'metadata', jsonb_build_object('manual_review_task_id', v_other_review),
      'actor_system', 'pgtap'
    )) created;
  UPDATE public.tasks SET status = 'completed' WHERE id = v_cross_tenant_task;

  RETURN NEXT is(
    (SELECT status FROM public.manual_review_tasks WHERE id = v_other_review),
    'pending',
    'cross-tenant forged task cannot resolve another organization source'
  );

  BEGIN
    INSERT INTO public.manual_review_tasks (
      id, organization_id, client_id, shipment_id, task_type, reason, status, metadata
    ) VALUES (
      v_bad_resource_review, v_org, v_client, v_other_shipment,
      'geocoding', 'cross_tenant_resource', 'pending', '{}'::jsonb
    );
  EXCEPTION WHEN check_violation THEN
    v_resource_rejected := TRUE;
  END;

  RETURN NEXT ok(v_resource_rejected, 'cross-tenant shipment resource lineage fails closed');
  RETURN NEXT is(
    (SELECT count(*)::text FROM public.manual_review_tasks WHERE id = v_bad_resource_review),
    '0',
    'rejected resource projection leaves no partial source row'
  );

  SELECT created.task_id INTO v_collision_task
    FROM public.create_task_system_v1(jsonb_build_object(
      'task_type_key', 'geocoding_manual_review',
      'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client),
      'resource_type', 'address',
      'resource_id', v_collision_address,
      'idempotency_key', 'geocoding-manual-review:' || v_collision_review::text,
      'metadata', jsonb_build_object('manual_review_task_id', gen_random_uuid()),
      'actor_system', 'pgtap'
    )) created;

  BEGIN
    INSERT INTO public.manual_review_tasks (
      id, organization_id, client_id, address_id, task_type, reason, status, metadata
    ) VALUES (
      v_collision_review, v_org, v_client, v_collision_address,
      'geocoding', 'collision_mismatch', 'pending', '{}'::jsonb
    );
  EXCEPTION WHEN check_violation THEN
    v_collision_rejected := TRUE;
  END;

  RETURN NEXT ok(v_collision_rejected, 'mismatched idempotency collision fails closed');
  RETURN NEXT is(
    (SELECT count(*)::text FROM public.manual_review_tasks WHERE id = v_collision_review),
    '0',
    'failed collision projection leaves no partially linked source row'
  );

  PERFORM public.upsert_settings_value_v1(
    'task_type_catalog',
    'tenant',
    v_catalog_org,
    jsonb_build_object(
      'version', 1,
      'task_types', jsonb_build_array(jsonb_build_object(
        'key', 'geocoding_manual_review',
        'name', 'Tenant Override Attempt',
        'enabled', FALSE,
        'metadata', jsonb_build_object(
          'manual_review_projection', jsonb_build_object(
            'source_task_types', jsonb_build_array('settings_approval'),
            'terminal_status_outcomes', jsonb_build_object('completed', 'canceled')
          )
        )
      ))
    ),
    1,
    'B22 tenant override guard test'
  );

  INSERT INTO public.manual_review_tasks (
    id, organization_id, client_id, address_id, task_type, reason, status, metadata
  ) VALUES (
    v_catalog_review, v_catalog_org, v_catalog_client, v_catalog_address,
    'geocoding', 'catalog_override_guard', 'pending', '{}'::jsonb
  );

  RETURN NEXT ok(
    (SELECT enabled FROM public.task_types WHERE organization_id = v_catalog_org AND key = 'geocoding_manual_review'),
    'tenant catalog override cannot disable the canonical projection task type'
  );
  RETURN NEXT is(
    (SELECT metadata#>>'{manual_review_projection,terminal_status_outcomes,completed}'
       FROM public.task_types WHERE organization_id = v_catalog_org AND key = 'geocoding_manual_review'),
    'resolved',
    'tenant catalog override cannot rewrite canonical terminal outcomes'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.manual_review_tasks
       WHERE id = v_catalog_review AND metadata->>'operator_task_id' IS NOT NULL
    ),
    'tenant catalog override cannot prevent canonical task projection'
  );
END;
$function$;

SELECT * FROM pg_temp.test_b22_geocoding_manual_review_projection_guards_v1();
SELECT * FROM finish();

ROLLBACK;
