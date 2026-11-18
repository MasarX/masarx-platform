-- Repair Riyadh / Olaya Arabic district aliases used by local geocoding lookup.

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

SELECT pg_advisory_lock(hashtext('202606061045_geocoding_riyadh_olaya_arabic_alias_v1'));

UPDATE public.canonical_districts d
   SET name_arabic = U&'\0627\0644\0639\0644\064A\0627',
       alternate_names = (
         SELECT ARRAY(
           SELECT DISTINCT alias_value
             FROM unnest(
                    COALESCE(d.alternate_names, ARRAY[]::text[])
                    || ARRAY[
                      'Olaya',
                      'Al Olaya',
                      'Al-Olaya',
                      U&'\0627\0644\0639\0644\064A\0627',
                      U&'\062D\064A \0627\0644\0639\0644\064A\0627'
                    ]::text[]
                  ) AS aliases(alias_value)
            WHERE NULLIF(btrim(alias_value), '') IS NOT NULL
            ORDER BY alias_value
         )
       ),
       updated_at = now()
  FROM public.canonical_cities c
 WHERE c.id = d.city_id
   AND lower(c.name_canonical) = 'riyadh'
   AND c.country_code = 'SA'
   AND (
     lower(d.name_canonical) IN ('olaya', 'al olaya', 'al olaya dist.')
     OR 'Al Olaya' = ANY(COALESCE(d.alternate_names, ARRAY[]::text[]))
     OR 'Al-Olaya' = ANY(COALESCE(d.alternate_names, ARRAY[]::text[]))
   );

SELECT pg_advisory_unlock(hashtext('202606061045_geocoding_riyadh_olaya_arabic_alias_v1'));

COMMIT;
