BEGIN;

SET LOCAL lock_timeout = '30s';

-- Include the canonical match label before the existing attempt and cache writes.
DO $repair$
DECLARE
  v_change RECORD;
  v_definition TEXT;
BEGIN
  FOR v_change IN
    SELECT * FROM (VALUES
      (
        'workflow_handlers.execute_geo_local_lookup_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::REGPROCEDURE,
        $old$        'provider_name', 'canonical_lookup',$old$,
        $new$        'provider_name', 'canonical_lookup',
        'formatted_address', NULLIF(concat_ws(', ',
            NULLIF(btrim(v_district.name_canonical), ''),
            NULLIF(btrim(v_city.name_canonical), ''),
            NULLIF(btrim(v_country_text), '')
        ), ''),$new$
      ),
      (
        'workflow_handlers.execute_geo_coordinate_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::REGPROCEDURE,
        $old$                'provider_name', 'reverse_local',$old$,
        $new$                'provider_name', 'reverse_local',
                'formatted_address', NULLIF(concat_ws(', ',
                    COALESCE(NULLIF(btrim(v_loc.district_en), ''), NULLIF(btrim(v_loc.district_ar), '')),
                    COALESCE(NULLIF(btrim(v_loc.city_en), ''), NULLIF(btrim(v_loc.city_ar), '')),
                    COALESCE(NULLIF(btrim(v_loc.region_en), ''), NULLIF(btrim(v_loc.region_ar), ''))
                ), ''),$new$
      )
    ) AS changes(handler, old_fragment, new_fragment)
  LOOP
    SELECT pg_get_functiondef(v_change.handler) INTO v_definition;
    IF position(v_change.new_fragment IN v_definition) > 0 THEN
      CONTINUE;
    END IF;
    IF (length(v_definition) - length(replace(v_definition, v_change.old_fragment, ''))) <> length(v_change.old_fragment) THEN
      RAISE EXCEPTION 'Unexpected geocoding handler definition for %', v_change.handler;
    END IF;
    EXECUTE replace(v_definition, v_change.old_fragment, v_change.new_fragment);
  END LOOP;
END;
$repair$;

COMMIT;
