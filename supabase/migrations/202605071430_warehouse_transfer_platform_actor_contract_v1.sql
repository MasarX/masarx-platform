-- Console V2 first-tenant onboarding: platform operators may create
-- tenant-scoped warehouse transfer manifests while acting through the active
-- tenant lens. Driver/vehicle ownership remains tenant-bound; this only allows
-- the audit actor column to point at a platform user.

CREATE OR REPLACE FUNCTION public.warehouse_transfers_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_from_org UUID;
  v_to_org UUID;
  v_vehicle_org UUID;
  v_user_org UUID;
  v_actor_scope_type TEXT;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfers: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.from_branch_id IS NOT DISTINCT FROM NEW.to_branch_id THEN
    RAISE EXCEPTION 'warehouse_transfers: from_branch_id must differ from to_branch_id' USING ERRCODE = '23514';
  END IF;

  SELECT b.organization_id INTO v_from_org
  FROM public.branches b
  WHERE b.id = NEW.from_branch_id;
  IF v_from_org IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfers: from_branch % not found', NEW.from_branch_id USING ERRCODE = '23503';
  END IF;
  IF v_from_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'warehouse_transfers: organization mismatch (transfer org %, from_branch org %)', NEW.organization_id, v_from_org
      USING ERRCODE = '23514';
  END IF;

  SELECT b.organization_id INTO v_to_org
  FROM public.branches b
  WHERE b.id = NEW.to_branch_id;
  IF v_to_org IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfers: to_branch % not found', NEW.to_branch_id USING ERRCODE = '23503';
  END IF;
  IF v_to_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'warehouse_transfers: organization mismatch (transfer org %, to_branch org %)', NEW.organization_id, v_to_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.vehicle_id IS NOT NULL THEN
    SELECT v.organization_id INTO v_vehicle_org
    FROM public.vehicles v
    WHERE v.id = NEW.vehicle_id;

    IF v_vehicle_org IS NULL THEN
      RAISE EXCEPTION 'warehouse_transfers: vehicle % not found', NEW.vehicle_id USING ERRCODE = '23503';
    END IF;
    IF v_vehicle_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'warehouse_transfers: organization mismatch (transfer org %, vehicle org %)', NEW.organization_id, v_vehicle_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.driver_user_id IS NOT NULL THEN
    SELECT u.organization_id INTO v_user_org
    FROM public.users u
    WHERE u.id = NEW.driver_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'warehouse_transfers: user % not found', NEW.driver_user_id USING ERRCODE = '23503';
    END IF;
    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'warehouse_transfers: organization mismatch (transfer org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.created_by_user_id IS NOT NULL THEN
    SELECT u.organization_id, u.access_scope_type
      INTO v_user_org, v_actor_scope_type
    FROM public.users u
    WHERE u.id = NEW.created_by_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'warehouse_transfers: user % not found', NEW.created_by_user_id USING ERRCODE = '23503';
    END IF;
    IF v_user_org IS DISTINCT FROM NEW.organization_id
       AND COALESCE(v_actor_scope_type, '') IS DISTINCT FROM 'platform' THEN
      RAISE EXCEPTION 'warehouse_transfers: organization mismatch (transfer org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.warehouse_transfers_enforce_org_match_v1()
  IS 'Enforces branch, driver, vehicle, and tenant actor org consistency for warehouse transfers while allowing platform audit actors for active-tenant Console operations.';
