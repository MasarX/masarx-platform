-- Migration: UC080 driver routes read capability seed
BEGIN;
SELECT pg_advisory_lock(hashtext('202604062240_uc080_driver_routes_read_capability_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_role_template_id UUID := NULL;
  v_lookup_definition_id UUID := NULL;
  v_permission_id UUID := NULL;
BEGIN
  SELECT ld.id
    INTO v_lookup_definition_id
    FROM public.lookup_definitions ld
   WHERE ld.category = 'rbac_permission'
   LIMIT 1;

  IF v_lookup_definition_id IS NULL THEN
    RAISE EXCEPTION 'rbac_permission lookup definition missing' USING ERRCODE = '23503';
  END IF;

  SELECT t.id
    INTO v_role_template_id
    FROM public.rbac_role_templates t
   WHERE t.key = 'driver'
   LIMIT 1;

  IF v_role_template_id IS NULL THEN
    RAISE EXCEPTION 'driver role template missing' USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.lookup_values (
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    metadata
  )
  VALUES (
    v_lookup_definition_id,
    'routes.read',
    'Routes read',
    'Read route run projections, assignments, and route-level execution ownership.',
    250,
    jsonb_build_object('seed', TRUE, 'source', 'uc080_driver_routes_read_capability_v1')
  )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata;

  SELECT lv.id
    INTO v_permission_id
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value = 'routes.read'
   LIMIT 1;

  IF v_permission_id IS NULL THEN
    RAISE EXCEPTION 'routes.read permission missing' USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.rbac_role_template_permissions (
    role_template_id,
    permission_id,
    metadata
  )
  VALUES (
    v_role_template_id,
    v_permission_id,
    jsonb_build_object('seed', TRUE, 'source', 'uc080_route_run_assignment_response_lifecycle_v1')
  )
  ON CONFLICT (role_template_id, permission_id) DO NOTHING;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604062240_uc080_driver_routes_read_capability_v1'));
COMMIT;
