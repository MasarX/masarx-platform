-- E47: service authority comes from explicit JWT claims, never SQL execution identity.
BEGIN;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20260909234000_route_service_claim_boundary_v1'));
DO $repair$
DECLARE
  target REGPROCEDURE;
  definition TEXT;
  prior TEXT;
  replacement TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'public.assign_route_run_v1(jsonb)'::regprocedure,
    'public.route_run_prepare_partner_handoff_v1(uuid,uuid[],text,text)'::regprocedure,
    'public.reassign_route_stops_v1(jsonb)'::regprocedure,
    'public.respond_route_run_assignment_v1(jsonb)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(target);
    prior := CASE WHEN target='public.respond_route_run_assignment_v1(jsonb)'::regprocedure
      THEN 'v_is_service := v_role = ''service_role'';'
      ELSE 'v_is_service := session_user IN (''postgres'', ''supabase_admin'') OR v_role = ''service_role'';' END;
    replacement := 'v_is_service := COALESCE(v_role = ''service_role'', FALSE);';
    IF position(replacement IN definition)=0 THEN
      IF (length(definition)-length(replace(definition,prior,'')))/length(prior) <> 1 THEN
        RAISE EXCEPTION 'Expected one service authority expression in %',target;
      END IF;
      EXECUTE replace(definition,prior,replacement);
    END IF;
  END LOOP;
  target := 'public.route_run_actor_can_read_v1(uuid,uuid,uuid)'::regprocedure;
  definition := pg_get_functiondef(target);
  prior := $old$  v_is_service := v_claim_role = 'service_role'
    OR (
      v_claim_role IS NULL
      AND v_role_setting = 'service_role'
    )
    OR (
      v_claim_role IS NULL
      AND v_role_setting IS NULL
      AND session_user IN ('postgres', 'supabase_admin', 'service_role')
    );$old$;
  replacement := '  v_is_service := COALESCE(v_claim_role = ''service_role'', FALSE);';
  IF position(replacement IN definition)=0 THEN
    IF (length(definition)-length(replace(definition,prior,'')))/length(prior) <> 1 THEN
      RAISE EXCEPTION 'Expected latest route actor service expression';
    END IF;
    definition := replace(definition,prior,replacement);
    definition := replace(definition,$old$  v_role_setting TEXT := lower(NULLIF(btrim(COALESCE(current_setting('role', true), '')), ''));
$old$,'');
    definition := replace(definition,$old$  IF v_role_setting = 'none' THEN
    v_role_setting := NULL;
  END IF;

$old$,'');
    EXECUTE definition;
  END IF;
  FOREACH target IN ARRAY ARRAY[
    'public.route_run_actor_can_read_v1(uuid,uuid,uuid)'::regprocedure,
    'public.assign_route_run_v1(jsonb)'::regprocedure,
    'public.route_run_prepare_partner_handoff_v1(uuid,uuid[],text,text)'::regprocedure,
    'public.reassign_route_stops_v1(jsonb)'::regprocedure,
    'public.respond_route_run_assignment_v1(jsonb)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(target);
    IF definition ~* '(^|[^a-z_])(session_user|current_user)([^a-z_]|$)'
       OR definition ~* 'current_setting\(''role'''
       OR definition !~ 'v_is_service := COALESCE\(v_(claim_)?role = ''service_role'', FALSE\);' THEN
      RAISE EXCEPTION 'JWT-only nonnullable service authority not preserved in %',target;
    END IF;
  END LOOP;
END;
$repair$;
COMMIT;
