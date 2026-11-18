BEGIN;

SELECT plan(5);

SELECT has_function(
  'public',
  'ui_read_registry_enrich_lookup_defaults_v1',
  ARRAY['jsonb'],
  'public.ui_read_registry_enrich_lookup_defaults_v1 exists for row-driven import defaults'
);

SELECT is(
  (
    SELECT lv.value
      FROM public.lookup_values AS lv
      JOIN public.lookup_definitions AS ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'address_validation_status'
       AND lv.is_default IS TRUE
     ORDER BY lv.sort_order NULLS LAST, lv.value
     LIMIT 1
  ),
  'pending',
  'address_validation_status has a row-driven pending default for imported inline addresses'
);

SELECT is(
  public.ui_read_registry_enrich_lookup_defaults_v1(
    jsonb_build_object(
      'resources',
      jsonb_build_array(
        jsonb_build_object(
          'key', 'addresses',
          'columns',
          jsonb_build_array(
            jsonb_build_object(
              'key', 'validation_status',
              'import', jsonb_build_object(
                'enabled', true,
                'required', true,
                'lookup', jsonb_build_object('category', 'address_validation_status')
              )
            )
          )
        )
      )
    )
  ) #>> '{resources,0,columns,0,import,default_value}',
  'pending',
  'lookup default enrichment writes default_value onto import metadata'
);

SELECT ok(
  position(
    'ui_read_registry_enrich_lookup_defaults_v1'
    IN pg_get_functiondef('public.ui_read_registry_v1()'::regprocedure)
  ) > 0,
  'ui_read_registry_v1 includes lookup default enrichment'
);

SELECT ok(
  position(
    'lookup_default'
    IN pg_get_functiondef('public.ui_read_registry_enrich_lookup_defaults_v1(jsonb)'::regprocedure)
  ) > 0,
  'lookup default enrichment records the default source'
);

SELECT * FROM finish();

ROLLBACK;
