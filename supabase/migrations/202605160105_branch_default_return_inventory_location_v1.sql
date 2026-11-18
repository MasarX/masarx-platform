-- Returned-to-branch intake depends on resolve_branch_inventory_location_v1,
-- which is intentionally fail-closed when a branch has no active warehouse
-- location. First-tenant onboarding creates the default warehouse branch, so
-- keep that branch operational by provisioning a canonical return intake
-- location from the backend SSOT.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605160105_branch_default_return_inventory_location_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.ensure_branch_return_inventory_location_v1(
  p_organization_id UUID,
  p_branch_id UUID,
  p_trigger_source TEXT DEFAULT 'system'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch RECORD;
  v_location_id UUID;
  v_source TEXT := COALESCE(NULLIF(btrim(p_trigger_source), ''), 'system');
BEGIN
  IF p_organization_id IS NULL OR p_branch_id IS NULL THEN
    RAISE EXCEPTION 'ensure_branch_return_inventory_location_v1 requires organization_id and branch_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT b.id, b.organization_id, b.branch_type, b.is_active
    INTO v_branch
    FROM public.branches b
   WHERE b.id = p_branch_id
     AND b.organization_id = p_organization_id
   LIMIT 1;

  IF v_branch.id IS NULL THEN
    RAISE EXCEPTION 'ensure_branch_return_inventory_location_v1 branch % not found for organization %',
      p_branch_id, p_organization_id
      USING ERRCODE = '23503';
  END IF;

  IF COALESCE(v_branch.is_active, TRUE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ensure_branch_return_inventory_location_v1 branch % is inactive', p_branch_id
      USING ERRCODE = '23514';
  END IF;

  IF lower(COALESCE(v_branch.branch_type, '')) <> 'warehouse' THEN
    RAISE EXCEPTION 'ensure_branch_return_inventory_location_v1 branch % is not a warehouse branch', p_branch_id
      USING ERRCODE = '23514';
  END IF;

  SELECT wl.id
    INTO v_location_id
    FROM public.warehouse_locations wl
   WHERE wl.organization_id = p_organization_id
     AND wl.branch_id = p_branch_id
     AND COALESCE(wl.is_active, TRUE) IS TRUE
   ORDER BY
     CASE WHEN wl.code = 'returns-qc' THEN 0 ELSE 1 END,
     wl.created_at ASC,
     wl.id ASC
   LIMIT 1;

  IF v_location_id IS NOT NULL THEN
    RETURN v_location_id;
  END IF;

  INSERT INTO public.warehouse_locations (
    organization_id,
    branch_id,
    code,
    name,
    location_type,
    is_active,
    metadata
  )
  VALUES (
    p_organization_id,
    p_branch_id,
    'returns-qc',
    'Returns QC',
    'returns_qc',
    TRUE,
    jsonb_build_object(
      'system_managed', TRUE,
      'purpose', 'return_to_branch_intake',
      'onboarding', jsonb_build_object(
        'auto_provisioned', TRUE,
        'default_key', 'returns-qc',
        'trigger_source', v_source
      )
    )
  )
  ON CONFLICT (branch_id, code) DO UPDATE
    SET is_active = TRUE,
        location_type = COALESCE(NULLIF(public.warehouse_locations.location_type, ''), EXCLUDED.location_type),
        metadata = public.jsonb_deep_merge(
          COALESCE(public.warehouse_locations.metadata, '{}'::jsonb),
          EXCLUDED.metadata
        ),
        updated_at = now()
  RETURNING id INTO v_location_id;

  RETURN v_location_id;
END;
$function$;

COMMENT ON FUNCTION public.ensure_branch_return_inventory_location_v1(UUID, UUID, TEXT)
  IS 'Ensures an active system-managed Returns QC warehouse location exists for an active warehouse branch so returned-to-branch scans can resolve canonical inventory location.';
REVOKE ALL ON FUNCTION public.ensure_branch_return_inventory_location_v1(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_branch_return_inventory_location_v1(UUID, UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.branches_ensure_default_return_location_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF COALESCE(NEW.is_active, TRUE) IS TRUE
     AND lower(COALESCE(NEW.branch_type, '')) = 'warehouse' THEN
    PERFORM public.ensure_branch_return_inventory_location_v1(
      NEW.organization_id,
      NEW.id,
      'trigger:branches.ensure_default_return_location'
    );
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.branches_ensure_default_return_location_v1()
  IS 'Branch trigger that keeps active warehouse branches ready for canonical returned-to-branch inventory intake.';

DROP TRIGGER IF EXISTS trg_branches_ensure_default_return_location ON public.branches;
CREATE TRIGGER trg_branches_ensure_default_return_location
  AFTER INSERT OR UPDATE OF branch_type, is_active
  ON public.branches
  FOR EACH ROW
  EXECUTE FUNCTION public.branches_ensure_default_return_location_v1();

DO $do$
DECLARE
  v_branch RECORD;
BEGIN
  FOR v_branch IN
    SELECT b.organization_id, b.id
      FROM public.branches b
     WHERE COALESCE(b.is_active, TRUE) IS TRUE
       AND lower(COALESCE(b.branch_type, '')) = 'warehouse'
       AND NOT EXISTS (
         SELECT 1
           FROM public.warehouse_locations wl
          WHERE wl.organization_id = b.organization_id
            AND wl.branch_id = b.id
            AND COALESCE(wl.is_active, TRUE) IS TRUE
       )
     ORDER BY b.created_at ASC, b.id ASC
  LOOP
    PERFORM public.ensure_branch_return_inventory_location_v1(
      v_branch.organization_id,
      v_branch.id,
      'migration:202605160105_branch_default_return_inventory_location_v1'
    );
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605160105_branch_default_return_inventory_location_v1'));
COMMIT;
