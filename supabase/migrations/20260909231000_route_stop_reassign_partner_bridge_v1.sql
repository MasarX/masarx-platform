-- Preserve selected-stop partner lineage through the canonical assignment writer.
BEGIN;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20260909231000_route_stop_reassign_partner_bridge_v1'));
DO $repair$
DECLARE
  v_definition TEXT := pg_get_functiondef('public.reassign_route_stops_v1(jsonb)'::regprocedure);
  v_old TEXT := $old$'partner', CASE WHEN v_requested_partner IS NULL THEN NULL ELSE v_requested_partner END,
          'notes', v_requested_notes,$old$;
  v_new TEXT := $new$'partner', CASE WHEN v_requested_partner IS NULL THEN NULL ELSE v_requested_partner END,
          'partner_id', NULLIF(v_requested_partner->>'partner_id', ''),
          'partner_name', NULLIF(v_requested_partner->>'partner_name', ''),
          'notes', v_requested_notes,$new$;
BEGIN
  IF position(v_new IN v_definition) > 0 THEN
    RETURN;
  END IF;
  IF position(v_old IN v_definition) = 0
     OR (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one canonical selected-stop partner assignment bridge';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
  IF position(v_new IN pg_get_functiondef('public.reassign_route_stops_v1(jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Selected-stop partner assignment bridge repair was not preserved';
  END IF;
END;
$repair$;
COMMENT ON FUNCTION public.reassign_route_stops_v1(JSONB)
  IS 'Canonical selected-stop reassignment preserving partner identity through assign_route_run_v1 and append-only event lineage.';
COMMIT;
