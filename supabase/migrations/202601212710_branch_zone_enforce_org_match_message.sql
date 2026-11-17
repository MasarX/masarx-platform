-- Plan: PLAN-202601-branch-capacity-calendars-service-catalog / Step: S05
-- Fixup: Normalize org-mismatch error messages for branch/zone mappings
--
-- Motivation:
-- - `branch_zone_enforce_org_match_v1` is used as a shared trigger for:
--     - `branch_zones`
--     - `branch_coverage_windows`
-- - We need table-accurate, stable error messages (tests assert the message).
-- - Also remove the redundant legacy trigger function `branch_zones_enforce_org_match`.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212710_branch_zone_enforce_org_match_message'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.branch_zone_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_zone_org UUID;
  v_relname TEXT := TG_TABLE_NAME;
BEGIN
  SELECT b.organization_id
    INTO v_branch_org
    FROM public.branches b
   WHERE b.id = NEW.branch_id;

  IF v_branch_org IS NULL THEN
    RAISE EXCEPTION '%: branch % not found', v_relname, NEW.branch_id;
  END IF;

  SELECT z.organization_id
    INTO v_zone_org
    FROM public.zones z
   WHERE z.id = NEW.zone_id;

  IF v_zone_org IS NULL THEN
    RAISE EXCEPTION '%: zone % not found', v_relname, NEW.zone_id;
  END IF;

  IF v_branch_org IS DISTINCT FROM v_zone_org THEN
    RAISE EXCEPTION '%: organization mismatch (branch org %, zone org %)', v_relname, v_branch_org, v_zone_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

-- Redundancy cleanup: the legacy branch_zones trigger function is no longer used
-- (we bind `branch_zones` + `branch_coverage_windows` to the shared v1 helper).
DROP FUNCTION IF EXISTS public.branch_zones_enforce_org_match();

SELECT pg_advisory_unlock(hashtext('202601212710_branch_zone_enforce_org_match_message'));
COMMIT;

