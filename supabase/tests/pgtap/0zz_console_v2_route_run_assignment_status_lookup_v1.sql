-- pgTAP: Console V2 dispatch has live lookup labels for route-run assignments.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_route_run_assignment_status_lookup_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions
       WHERE category = 'route_run_assignment_status'
         AND owner_role = 'dispatch'
    ),
    'route_run_assignment_status lookup definition exists for Dispatch'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'route_run_assignment_status'
         AND lv.value = 'assigned'
         AND lv.label = 'Assigned'
         AND lv.status = 'active'
         AND COALESCE(lv.metadata->>'tone', '') = 'info'
    ),
    'assigned assignment status has active label and tone'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'route_run_assignment_status'
         AND lv.value = 'accepted'
         AND lv.label = 'Accepted'
         AND lv.status = 'active'
         AND COALESCE(lv.metadata->>'tone', '') = 'good'
    ),
    'accepted assignment status has active label and tone'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'route_run_assignment_status'
         AND lv.value = 'acknowledged'
         AND lv.label = 'Acknowledged'
         AND lv.status = 'active'
         AND COALESCE(lv.metadata->>'tone', '') = 'info'
    ),
    'acknowledged assignment status has active label and tone'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'route_run_assignment_status'
         AND lv.value = 'refused'
         AND lv.label = 'Refused'
         AND lv.status = 'active'
         AND COALESCE(lv.metadata->>'tone', '') = 'danger'
    ),
    'refused assignment status has active label and tone'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'route_run_assignment_status'
         AND lv.value IN ('assigned', 'accepted', 'acknowledged', 'refused')
         AND lv.label ~ '\(missing\)'
    ),
    'canonical route-run assignment statuses do not render as missing labels'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_route_run_assignment_status_lookup_v1();

SELECT * FROM finish();

ROLLBACK;
