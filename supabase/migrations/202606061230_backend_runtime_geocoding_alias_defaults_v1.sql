BEGIN;

SET LOCAL search_path TO public, extensions, pg_temp;

DO $do$
DECLARE
  v_root_scope TEXT := public.get_root_scope_type_key_v1();
  v_current JSONB;
  v_geography JSONB := jsonb_build_object(
    'enabled', TRUE,
    'cities',
    jsonb_build_array(
      jsonb_build_object(
        'name_canonical', 'Riyadh',
        'name_arabic', U&'\0627\0644\0631\064A\0627\0636',
        'alternate_names', jsonb_build_array(
          'Riyadh',
          'Riyad',
          'Riyadh City',
          U&'\0627\0644\0631\064A\0627\0636'
        ),
        'province', 'Riyadh',
        'country_code', 'SA',
        'source', 'ops_verified',
        'lat', 24.7136,
        'lng', 46.6753,
        'districts', jsonb_build_array(
          jsonb_build_object(
            'name_canonical', 'Olaya',
            'name_arabic', U&'\0627\0644\0639\0644\064A\0627',
            'alternate_names', jsonb_build_array(
              'Olaya',
              'Al Olaya',
              'Al-Olaya',
              U&'\0627\0644\0639\0644\064A\0627',
              U&'\062D\064A \0627\0644\0639\0644\064A\0627'
            ),
            'source', 'ops_verified',
            'lat', 24.7130,
            'lng', 46.6766
          ),
          jsonb_build_object(
            'name_canonical', 'Sulaymaniyah',
            'alternate_names', jsonb_build_array('Al Sulaymaniyah', 'Sulaimaniyah'),
            'source', 'ops_verified',
            'lat', 24.7041,
            'lng', 46.7002
          ),
          jsonb_build_object(
            'name_canonical', 'Malqa',
            'alternate_names', jsonb_build_array('Al Malqa', 'Al-Malqa'),
            'source', 'ops_verified',
            'lat', 24.8020,
            'lng', 46.6170
          )
        )
      )
    )
  );
BEGIN
  SELECT s.cached_value
    INTO v_current
    FROM public.settings s
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = v_root_scope
     AND s.scope_id IS NULL
   ORDER BY s.last_updated DESC NULLS LAST, s.updated_at DESC NULLS LAST
   LIMIT 1;

  v_current := COALESCE(v_current, public.resolve_saas_onboarding_policy_v1(), '{}'::jsonb);

  PERFORM public.upsert_settings_value_v1(
    'saas_onboarding_policy',
    v_root_scope,
    NULL,
    jsonb_set(v_current, '{geography_defaults}', v_geography, TRUE),
    1,
    'ensure Riyadh/Olaya Arabic alias defaults for backend runtime proof'
  );
END;
$do$;

UPDATE public.canonical_cities
   SET name_arabic = COALESCE(name_arabic, U&'\0627\0644\0631\064A\0627\0636'),
       alternate_names = (
         SELECT ARRAY(
           SELECT DISTINCT name
             FROM unnest(
               COALESCE(alternate_names, ARRAY[]::text[])
               || ARRAY[
                 'Riyadh',
                 'Riyad',
                 'Riyadh City',
                 U&'\0627\0644\0631\064A\0627\0636'
               ]::text[]
             ) AS candidate(name)
            WHERE NULLIF(btrim(name), '') IS NOT NULL
            ORDER BY name
         )
       ),
       updated_at = now()
 WHERE lower(name_canonical) = 'riyadh'
   AND country_code = 'SA';

UPDATE public.canonical_districts d
   SET name_arabic = COALESCE(d.name_arabic, U&'\0627\0644\0639\0644\064A\0627'),
       alternate_names = (
         SELECT ARRAY(
           SELECT DISTINCT name
             FROM unnest(
               COALESCE(d.alternate_names, ARRAY[]::text[])
               || ARRAY[
                 'Olaya',
                 'Al Olaya',
                 'Al-Olaya',
                 U&'\0627\0644\0639\0644\064A\0627',
                 U&'\062D\064A \0627\0644\0639\0644\064A\0627'
               ]::text[]
             ) AS candidate(name)
            WHERE NULLIF(btrim(name), '') IS NOT NULL
            ORDER BY name
         )
       ),
       updated_at = now()
  FROM public.canonical_cities c
 WHERE c.id = d.city_id
   AND lower(c.name_canonical) = 'riyadh'
   AND lower(d.name_canonical) IN ('olaya', 'al olaya');

-- Keeps Riyadh/Olaya Arabic aliases in row-driven tenant geography defaults and reset/bootstrap fixture rows.

COMMIT;
