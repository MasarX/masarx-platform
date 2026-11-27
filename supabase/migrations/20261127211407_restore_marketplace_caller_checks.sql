BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Apply each caller check to the installed definition.
DO $migration$
DECLARE
  guard_location constant text := '  IF v_req.id IS NULL THEN';
  patch record;
  definition text;
BEGIN
  FOR patch IN
    SELECT * FROM (VALUES
      ('public.marketplace_matching_suggestions_v1(uuid,integer)'::regprocedure, $guard$
  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND (public.current_user_org_id() = v_req.requester_organization_id
          AND public.marketplace_can_read_request_v1(v_req.id)) IS NOT TRUE THEN
    RAISE EXCEPTION 'marketplace_request_access_denied' USING ERRCODE = '42501';
  END IF;

$guard$),
      ('public.marketplace_application_status_v1(uuid)'::regprocedure, $guard$
  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND (public.current_user_org_id() = v_req.requested_organization_id) IS NOT TRUE THEN
    PERFORM public.marketplace_assert_reviewer_v1();
  END IF;

$guard$)
    ) AS changes(signature, guard_sql)
  LOOP
    definition := pg_get_functiondef(patch.signature);
    IF cardinality(string_to_array(definition, guard_location)) <> 2 THEN
      RAISE EXCEPTION 'Unexpected definition for % while restoring caller check', patch.signature;
    END IF;
    EXECUTE replace(definition, guard_location, patch.guard_sql || guard_location);
  END LOOP;
END;
$migration$;

COMMIT;
