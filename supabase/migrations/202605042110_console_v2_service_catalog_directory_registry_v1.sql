-- Migration: Console V2 service catalog directory registry repair
-- Purpose:
--   The backend-backed Console V2 service catalog must read tenant-scoped,
--   operator-friendly directory projections instead of demo/seed-only base
--   resources. Backfill the scoped ui_read_registry rows needed by the
--   service catalog route and creation drawer.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605042110_console_v2_service_catalog_directory_registry_v1'));

DO $do$
DECLARE
  v_keys TEXT[] := ARRAY[
    'service_level_directory',
    'branches',
    'subscriptions'
  ];
  v_service_level_directory JSONB := jsonb_build_object(
    'key', 'service_level_directory',
    'relation', 'public.v_service_level_directory',
    'id_column', 'id',
    'capability_read', 'service_offerings.read',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'default_sort', jsonb_build_object('column', 'priority_rank', 'direction', 'asc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'key', 'column', 'key', 'op', 'ilike'),
      jsonb_build_object('key', 'is_active', 'column', 'is_active', 'op', 'eq'),
      jsonb_build_object('key', 'tier', 'column', 'tier', 'op', 'eq')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'name', 'label', 'Name', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'key', 'label', 'Key', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'tier', 'label', 'Tier', 'sortable', TRUE, 'filterable', TRUE, 'lookup', 'service_level_tier'),
      jsonb_build_object('key', 'priority_rank', 'label', 'Rank', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number'),
      jsonb_build_object('key', 'sla_minutes', 'label', 'SLA (min)', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number'),
      jsonb_build_object('key', 'sla_label', 'label', 'SLA label', 'sortable', TRUE),
      jsonb_build_object('key', 'tenant_label', 'label', 'Tenant', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'is_active', 'label', 'Active', 'filterable', TRUE, 'sortable', TRUE),
      jsonb_build_object('key', 'offering_count', 'label', 'Offerings', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number'),
      jsonb_build_object('key', 'active_offering_count', 'label', 'Active offerings', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number'),
      jsonb_build_object('key', 'active_subscription_count', 'label', 'Active subs', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number'),
      jsonb_build_object('key', 'last_updated_at', 'label', 'Updated', 'format', 'datetime', 'sortable', TRUE)
    )
  );
  v_canonical_resources JSONB;
  v_row RECORD;
  v_filtered JSONB;
  v_next JSONB;
BEGIN
  FOR v_row IN
    SELECT sv.id, COALESCE(sv.value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings_versions sv
     WHERE sv.category = 'ui_read_registry'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND sv.effective_until IS NULL
  LOOP
    SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_row.value->'resources', '[]'::jsonb))
        WITH ORDINALITY AS resource(value, ordinality)
     WHERE resource.value->>'key' <> 'service_level_directory';

    v_next := jsonb_set(v_row.value, '{resources}', v_filtered || jsonb_build_array(v_service_level_directory), TRUE);

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now(),
           change_reason = 'Register Console V2 service level directory read'
     WHERE id = v_row.id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE settings_version_id = v_row.id;
  END LOOP;

  SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
    INTO v_canonical_resources
    FROM public.settings global_registry
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(global_registry.cached_value->'resources', '[]'::jsonb))
      WITH ORDINALITY AS resource(value, ordinality)
   WHERE global_registry.category = 'ui_read_registry'
     AND global_registry.scope_type = 'global'
     AND global_registry.scope_id IS NULL
     AND resource.value->>'key' = ANY(v_keys);

  IF jsonb_array_length(v_canonical_resources) <> array_length(v_keys, 1) THEN
    RAISE EXCEPTION 'global ui_read_registry is missing one or more Console V2 service catalog resources';
  END IF;

  FOR v_row IN
    SELECT sv.id, COALESCE(sv.value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings_versions sv
     WHERE sv.category = 'ui_read_registry'
       AND sv.scope_type <> 'global'
       AND sv.effective_until IS NULL
  LOOP
    SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_row.value->'resources', '[]'::jsonb))
        WITH ORDINALITY AS resource(value, ordinality)
     WHERE NOT (resource.value->>'key' = ANY(v_keys));

    v_next := jsonb_set(v_row.value, '{resources}', v_filtered || v_canonical_resources, TRUE);

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now(),
           change_reason = 'Backfill scoped Console V2 service catalog registry resources from global registry'
     WHERE id = v_row.id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE settings_version_id = v_row.id;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605042110_console_v2_service_catalog_directory_registry_v1'));

COMMIT;
