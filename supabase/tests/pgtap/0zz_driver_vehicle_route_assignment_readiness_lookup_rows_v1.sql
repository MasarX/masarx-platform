-- pgTAP: first-tenant driver and vehicle assignment readiness lookups.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

CREATE OR REPLACE FUNCTION pg_temp.test_driver_vehicle_route_assignment_readiness_lookup_rows_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions
       WHERE category = 'vehicle_assignment_state'
         AND owner_role = 'operations'
         AND approval_policy = 'tier_1'
    ),
    'vehicle_assignment_state lookup definition exists for Console fleet readback'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'vehicle_assignment_state'
         AND lv.value = 'active'
         AND lv.label = 'Active'
         AND lv.status = 'active'
         AND COALESCE(lv.metadata->>'tone', '') = 'good'
    ),
    'active vehicle assignment state has active row-driven label and tone'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'vehicle_assignment_state'
         AND lv.value = 'historical'
         AND lv.label = 'Historical'
         AND lv.status = 'active'
         AND COALESCE(lv.metadata->>'tone', '') = 'neutral'
    ),
    'historical vehicle assignment state has active row-driven label and tone'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'decision_category'
         AND lv.value = 'compliance.driver_document_uploaded'
         AND lv.label = 'Compliance Driver Document Uploaded'
         AND lv.status = 'active'
    ),
    'driver document upload decision category is registered'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'decision_outcome'
         AND lv.value = 'submitted'
         AND lv.label = 'Submitted'
         AND lv.status = 'active'
    ),
    'driver document upload submitted decision outcome is registered'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'vehicle_assignment_state'
         AND lv.value IN ('active', 'historical')
         AND lv.label ~ '\(missing\)'
    ),
    'vehicle assignment states do not render missing labels'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_driver_vehicle_route_assignment_readiness_lookup_rows_v1();

SELECT * FROM finish();

ROLLBACK;
