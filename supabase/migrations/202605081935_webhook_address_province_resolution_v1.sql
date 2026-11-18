BEGIN;

SELECT pg_advisory_lock(hashtext('202605081935_webhook_address_province_resolution_v1'));

CREATE OR REPLACE FUNCTION public.resolve_address_province_from_city_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_city text := NULLIF(btrim(COALESCE(NEW.city, '')), '');
  v_country text := NULLIF(btrim(COALESCE(NEW.country, '')), '');
  v_resolved_province text;
  v_resolved_country text;
BEGIN
  IF NULLIF(btrim(COALESCE(NEW.province, '')), '') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NULL OR v_city IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT NULLIF(btrim(cc.province), ''),
         NULLIF(btrim(cc.country_code), '')
    INTO v_resolved_province,
         v_resolved_country
    FROM public.canonical_cities cc
   WHERE cc.organization_id = NEW.organization_id
     AND COALESCE(cc.is_active, true)
     AND (
       lower(cc.name_canonical) = lower(v_city)
       OR EXISTS (
         SELECT 1
           FROM unnest(COALESCE(cc.alternate_names, ARRAY[]::text[])) AS alt(name)
          WHERE lower(alt.name) = lower(v_city)
       )
     )
   ORDER BY
     (NULLIF(btrim(cc.province), '') IS NOT NULL) DESC,
     cc.updated_at DESC NULLS LAST,
     cc.created_at DESC NULLS LAST,
     cc.id ASC
   LIMIT 1;

  IF v_resolved_province IS NOT NULL THEN
    NEW.province := v_resolved_province;
  END IF;

  IF v_country IS NULL AND v_resolved_country IS NOT NULL THEN
    NEW.country := v_resolved_country;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_addresses_resolve_province_from_city_v1 ON public.addresses;
CREATE TRIGGER trg_addresses_resolve_province_from_city_v1
BEFORE INSERT OR UPDATE OF organization_id, city, province, country
ON public.addresses
FOR EACH ROW
EXECUTE FUNCTION public.resolve_address_province_from_city_v1();

COMMENT ON FUNCTION public.resolve_address_province_from_city_v1()
  IS 'Fills missing address province from tenant canonical_cities during address writes so webhook/API shipment intake remains backend-backed and row-driven.';

SELECT pg_advisory_unlock(hashtext('202605081935_webhook_address_province_resolution_v1'));

COMMIT;
