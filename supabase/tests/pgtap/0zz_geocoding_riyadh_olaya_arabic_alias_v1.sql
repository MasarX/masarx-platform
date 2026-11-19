-- pgTAP: Riyadh / Olaya Arabic aliases for local geocoding lookup.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.canonical_cities c
     WHERE lower(c.name_canonical) = 'riyadh'
       AND c.country_code = 'SA'
       AND c.name_arabic = U&'\0627\0644\0631\064A\0627\0636'
       AND U&'\0627\0644\0631\064A\0627\0636' = ANY(COALESCE(c.alternate_names, ARRAY[]::text[]))
  ),
  'Riyadh canonical city keeps Arabic alias and alternate name'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.canonical_cities c
     WHERE lower(c.name_canonical) = 'riyadh'
       AND c.country_code = 'SA'
       AND (
         c.name_arabic IS DISTINCT FROM U&'\0627\0644\0631\064A\0627\0636'
         OR NOT (U&'\0627\0644\0631\064A\0627\0636' = ANY(COALESCE(c.alternate_names, ARRAY[]::text[])))
         OR lower(COALESCE(c.province, '')) <> 'riyadh'
       )
  ),
  'All Riyadh canonical city rows keep Arabic local lookup fields'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.canonical_districts d
      JOIN public.canonical_cities c ON c.id = d.city_id
     WHERE lower(c.name_canonical) = 'riyadh'
       AND c.country_code = 'SA'
       AND (
         lower(d.name_canonical) IN ('olaya', 'al olaya', 'al olaya dist.')
         OR 'Al Olaya' = ANY(COALESCE(d.alternate_names, ARRAY[]::text[]))
         OR 'Al-Olaya' = ANY(COALESCE(d.alternate_names, ARRAY[]::text[]))
       )
       AND d.name_arabic = U&'\0627\0644\0639\0644\064A\0627'
       AND U&'\0627\0644\0639\0644\064A\0627' = ANY(COALESCE(d.alternate_names, ARRAY[]::text[]))
  ),
  'Riyadh Olaya canonical district keeps Arabic alias and alternate name'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.canonical_districts d
      JOIN public.canonical_cities c ON c.id = d.city_id
     WHERE lower(c.name_canonical) = 'riyadh'
       AND c.country_code = 'SA'
       AND (
         lower(d.name_canonical) IN ('olaya', 'al olaya', 'al olaya dist.')
         OR 'Al Olaya' = ANY(COALESCE(d.alternate_names, ARRAY[]::text[]))
         OR 'Al-Olaya' = ANY(COALESCE(d.alternate_names, ARRAY[]::text[]))
       )
       AND (
         d.name_arabic IS DISTINCT FROM U&'\0627\0644\0639\0644\064A\0627'
         OR NOT (U&'\0627\0644\0639\0644\064A\0627' = ANY(COALESCE(d.alternate_names, ARRAY[]::text[])))
       )
  ),
  'All Riyadh Olaya canonical district rows keep Arabic local lookup fields'
);

SELECT * FROM finish();

ROLLBACK;
