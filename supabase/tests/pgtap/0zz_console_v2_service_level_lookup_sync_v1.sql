-- pgTAP: Console-created service levels remain valid for lookup-enforced
-- shipment creation.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

SELECT has_function(
  'public',
  'ensure_service_level_lookup_value_v1',
  ARRAY['uuid'],
  'service-level lookup sync helper exists'
);

SELECT function_returns(
  'public',
  'ensure_service_level_lookup_value_v1',
  ARRAY['uuid'],
  'uuid',
  'service-level lookup sync helper returns lookup_values.id'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.lookup_column_contracts
    WHERE table_schema = 'public' AND table_name = 'service_levels'
      AND column_name = 'key' AND lookup_category = 'service_level' AND NOT allow_inactive
  ),
  'service level catalog writes require an active canonical lookup key'
);

SELECT ok(
  pg_get_functiondef('public.service_level_create_v1(jsonb)'::regprocedure)
    LIKE '%assert_capability_v1(''agreements.write'')%',
  'service_level_create_v1 remains product-backed and capability-gated'
);

SELECT ok(
  has_function_privilege('service_role', 'public.ensure_service_level_lookup_value_v1(uuid)', 'EXECUTE'),
  'service role can execute server-side service-level lookup sync helper'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.ensure_service_level_lookup_value_v1(uuid)', 'EXECUTE'),
  'authenticated users cannot call service-level lookup sync helper directly'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.service_levels sl
     WHERE sl.is_active IS TRUE
       AND NOT EXISTS (
         SELECT 1
           FROM public.lookup_values lv
           JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
          WHERE ld.category = 'service_level'
            AND lv.value = sl.key
            AND lv.status = 'active'
            AND lv.retired_at IS NULL
            AND lv.archived_at IS NULL
       )
  ),
  'every active service_levels.key has an active service_level lookup value'
);

DO $$
DECLARE
  v_org_a uuid := '00000000-0000-0000-0000-00000000c101';
  v_org_b uuid := '00000000-0000-0000-0000-00000000c102';
  v_level_a uuid := '00000000-0000-0000-0000-00000000c111';
  v_level_b uuid := '00000000-0000-0000-0000-00000000c112';
  v_key text := 'pgtap_shared_lookup_key';
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org_a, 'pgTAP Shared Lookup Org A', 'pgtap-shared-lookup-org-a'),
    (v_org_b, 'pgTAP Shared Lookup Org B', 'pgtap-shared-lookup-org-b')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.lookup_definitions (category, description, owner_role, is_mutable)
  VALUES ('service_level', 'Service level lookup values for shipment creation.', 'operations', true)
  ON CONFLICT (category) DO NOTHING;

  INSERT INTO public.lookup_values (lookup_definition_id, value, label, status)
  SELECT id, v_key, 'Fixture service level', 'active'
  FROM public.lookup_definitions
  WHERE category = 'service_level'
  ON CONFLICT (lookup_definition_id, value) DO NOTHING;

  INSERT INTO public.service_levels (id, organization_id, key, name, is_active, metadata)
  VALUES
    (v_level_a, v_org_a, v_key, 'Shared Lookup A', true, jsonb_build_object('tone', 'info')),
    (v_level_b, v_org_b, v_key, 'Shared Lookup B', true, jsonb_build_object('tone', 'warning'))
  ON CONFLICT (organization_id, key) DO UPDATE
     SET name = EXCLUDED.name,
         is_active = EXCLUDED.is_active,
         metadata = EXCLUDED.metadata;

  PERFORM public.ensure_service_level_lookup_value_v1(v_level_a);
  PERFORM public.ensure_service_level_lookup_value_v1(v_level_b);

  PERFORM set_config('test.service_level_lookup_key', v_key, true);
  PERFORM set_config('test.service_level_lookup_org_a', v_org_a::text, true);
  PERFORM set_config('test.service_level_lookup_org_b', v_org_b::text, true);
  PERFORM set_config('test.service_level_lookup_level_a', v_level_a::text, true);
  PERFORM set_config('test.service_level_lookup_level_b', v_level_b::text, true);
END $$;

SELECT is(
  (
    SELECT COUNT(*)::int
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'service_level'
       AND lv.value = current_setting('test.service_level_lookup_key')
  ),
  1,
  'same service level key across two tenants keeps one global lookup row'
);

SELECT ok(
  (
    SELECT jsonb_typeof(lv.metadata->'service_levels_by_organization') = 'object'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'service_level'
       AND lv.value = current_setting('test.service_level_lookup_key')
  ),
  'service-level lookup metadata stores tenant lineage as an organization-keyed map'
);

SELECT ok(
  (
    SELECT lv.metadata->'service_levels_by_organization' ? current_setting('test.service_level_lookup_org_a')
       AND lv.metadata->'service_levels_by_organization' ? current_setting('test.service_level_lookup_org_b')
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'service_level'
       AND lv.value = current_setting('test.service_level_lookup_key')
  ),
  'service-level lookup metadata preserves both tenant lineage entries'
);

SELECT ok(
  (
    SELECT lv.metadata->'service_levels_by_organization'->current_setting('test.service_level_lookup_org_a')->>'service_level_id'
             = current_setting('test.service_level_lookup_level_a')
       AND lv.metadata->'service_levels_by_organization'->current_setting('test.service_level_lookup_org_b')->>'service_level_id'
             = current_setting('test.service_level_lookup_level_b')
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'service_level'
       AND lv.value = current_setting('test.service_level_lookup_key')
  ),
  'service-level lookup metadata keeps each tenant mapped to its own service level'
);

SELECT ok(
  (
    SELECT NOT (lv.metadata ? 'service_level_id')
       AND NOT (lv.metadata ? 'service_level_organization_id')
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'service_level'
       AND lv.value = current_setting('test.service_level_lookup_key')
  ),
  'service-level lookup metadata does not use tenant-overwriting singleton lineage keys'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.ensure_service_level_lookup_value_v1(uuid)', 'EXECUTE'),
  'anonymous users cannot call the service-level lookup sync helper'
);

SELECT * FROM finish();

ROLLBACK;
