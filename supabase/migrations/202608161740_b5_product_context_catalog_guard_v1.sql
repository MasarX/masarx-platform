-- B5 audit repair: bind tenant service catalogs to the canonical lookup
-- vocabulary and keep offering resolution internal, active, and tenant-exact.

BEGIN;
SELECT pg_advisory_lock(hashtext('202608161740_b5_product_context_catalog_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_column_contracts (
  table_schema,
  table_name,
  column_name,
  lookup_category,
  allow_inactive
)
VALUES ('public', 'service_levels', 'key', 'service_level', FALSE)
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique
DO UPDATE SET
  lookup_category = EXCLUDED.lookup_category,
  allow_inactive = FALSE;

SELECT public.apply_lookup_column_contracts('public');

-- Preserve historical rows but remove invalid/retired catalog values and
-- inactive branches from availability before installing the strict guard.
UPDATE public.service_offerings so
   SET is_active = FALSE
  FROM public.service_levels sl,
       public.branches branch
 WHERE so.service_level_id = sl.id
   AND so.branch_id = branch.id
   AND so.is_active IS TRUE
   AND (
     sl.is_active IS DISTINCT FROM TRUE
     OR branch.is_active IS DISTINCT FROM TRUE
     OR NOT EXISTS (
       SELECT 1
         FROM public.lookup_definitions ld
         JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
        WHERE ld.category = 'service_level'
          AND lv.value = sl.key
          AND lv.status = 'active'
          AND lv.retired_at IS NULL
          AND (lv.effective_from IS NULL OR lv.effective_from <= public.workflow_now())
          AND (lv.effective_until IS NULL OR lv.effective_until > public.workflow_now())
     )
   );

UPDATE public.service_levels sl
   SET is_active = FALSE
 WHERE sl.is_active IS TRUE
   AND NOT EXISTS (
     SELECT 1
       FROM public.lookup_definitions ld
       JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
      WHERE ld.category = 'service_level'
        AND lv.value = sl.key
        AND lv.status = 'active'
        AND lv.retired_at IS NULL
        AND (lv.effective_from IS NULL OR lv.effective_from <= public.workflow_now())
        AND (lv.effective_until IS NULL OR lv.effective_until > public.workflow_now())
   );

CREATE OR REPLACE FUNCTION public.service_offerings_validate_catalog_context_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF NEW.is_active IS DISTINCT FROM TRUE THEN
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM public.service_levels sl
    JOIN public.lookup_definitions ld
      ON ld.category = 'service_level'
    JOIN public.lookup_values lv
      ON lv.lookup_definition_id = ld.id
     AND lv.value = sl.key
   WHERE sl.id = NEW.service_level_id
     AND sl.is_active IS TRUE
     AND lv.status = 'active'
     AND lv.retired_at IS NULL
     AND (lv.effective_from IS NULL OR lv.effective_from <= public.workflow_now())
     AND (lv.effective_until IS NULL OR lv.effective_until > public.workflow_now());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active service offering requires an active canonical service_level lookup value'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.branches branch
   WHERE branch.id = NEW.branch_id
     AND branch.is_active IS TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active service offering requires an active branch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_service_offerings_validate_catalog_context_v1 ON public.service_offerings;
CREATE TRIGGER trg_service_offerings_validate_catalog_context_v1
  BEFORE INSERT OR UPDATE OF service_level_id, branch_id, is_active
  ON public.service_offerings
  FOR EACH ROW
  EXECUTE FUNCTION public.service_offerings_validate_catalog_context_v1();

CREATE OR REPLACE FUNCTION public.resolve_service_offering_context_v1(
  p_organization_id UUID,
  p_service_offering_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_context JSONB;
BEGIN
  IF p_organization_id IS NULL OR p_service_offering_id IS NULL THEN
    RAISE EXCEPTION 'resolve_service_offering_context_v1 requires organization_id and service_offering_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT jsonb_strip_nulls(jsonb_build_object(
           'service_offering_id', so.id,
           'service_level_id', sl.id,
           'service_level_key', sl.key,
           'service_level_name', sl.name,
           'service_offering_branch_id', so.branch_id,
           'service_offering_zone_id', so.zone_id,
           'service_offering_display_name', NULLIF(btrim(so.metadata#>>'{display,name}'), '')
         ))
    INTO v_context
    FROM public.service_offerings so
    JOIN public.service_levels sl ON sl.id = so.service_level_id
    JOIN public.branches branch ON branch.id = so.branch_id
    LEFT JOIN public.zones zone ON zone.id = so.zone_id
    JOIN public.lookup_definitions ld ON ld.category = 'service_level'
    JOIN public.lookup_values lv
      ON lv.lookup_definition_id = ld.id
     AND lv.value = sl.key
   WHERE so.id = p_service_offering_id
     AND sl.organization_id = p_organization_id
     AND branch.organization_id = p_organization_id
     AND (zone.id IS NULL OR zone.organization_id = p_organization_id)
     AND sl.is_active IS TRUE
     AND so.is_active IS TRUE
     AND branch.is_active IS TRUE
     AND lv.status = 'active'
     AND lv.retired_at IS NULL
     AND (lv.effective_from IS NULL OR lv.effective_from <= public.workflow_now())
     AND (lv.effective_until IS NULL OR lv.effective_until > public.workflow_now())
     AND public.workflow_now() >= so.effective_from
     AND (so.effective_to IS NULL OR public.workflow_now() < so.effective_to)
   LIMIT 1;

  IF v_context IS NULL THEN
    RAISE EXCEPTION 'service offering % is unavailable for organization %',
      p_service_offering_id,
      p_organization_id
      USING ERRCODE = '23503';
  END IF;

  RETURN v_context;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_service_offering_context_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_service_offering_context_v1(UUID, UUID)
  TO service_role;

-- Make product-context assignment run before the canonical shipment lookup
-- trigger; the generic lookup trigger then validates the assigned value.
DROP TRIGGER IF EXISTS trg_shipments_apply_service_offering_context_v1 ON public.shipments;
DROP TRIGGER IF EXISTS trg_00_shipments_apply_service_offering_context_v1 ON public.shipments;
CREATE TRIGGER trg_00_shipments_apply_service_offering_context_v1
  BEFORE INSERT OR UPDATE OF organization_id, metadata ON public.shipments
  FOR EACH ROW
  EXECUTE FUNCTION public.shipments_apply_service_offering_context_v1();

CREATE OR REPLACE VIEW public.service_offering_directory
  WITH (security_invoker = true)
AS
SELECT
  so.id,
  sl.organization_id,
  so.service_level_id,
  sl.key AS service_level_key,
  sl.name AS service_level_name,
  so.branch_id,
  branch.name AS branch_name,
  so.zone_id,
  zone.name AS zone_name,
  so.effective_from,
  so.effective_to,
  so.priority,
  so.is_active,
  so.metadata,
  COALESCE(
    NULLIF(btrim(so.metadata#>>'{display,name}'), ''),
    concat_ws(' - ', sl.name, branch.name, zone.name)
  ) AS display_name,
  (
    sl.is_active IS TRUE
    AND so.is_active IS TRUE
    AND branch.is_active IS TRUE
    AND EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'service_level'
         AND lv.value = sl.key
         AND lv.status = 'active'
         AND lv.retired_at IS NULL
         AND (lv.effective_from IS NULL OR lv.effective_from <= public.workflow_now())
         AND (lv.effective_until IS NULL OR lv.effective_until > public.workflow_now())
    )
    AND public.workflow_now() >= so.effective_from
    AND (so.effective_to IS NULL OR public.workflow_now() < so.effective_to)
  ) AS is_available,
  so.created_at,
  so.updated_at
FROM public.service_offerings so
JOIN public.service_levels sl ON sl.id = so.service_level_id
JOIN public.branches branch ON branch.id = so.branch_id
LEFT JOIN public.zones zone ON zone.id = so.zone_id;

COMMENT ON FUNCTION public.resolve_service_offering_context_v1(UUID, UUID)
  IS 'Internal resolver for active tenant-exact service offerings bound to canonical service_level lookup truth.';
COMMENT ON FUNCTION public.service_offerings_validate_catalog_context_v1()
  IS 'Reject active offerings whose service-level lookup value or branch is inactive.';

COMMIT;
