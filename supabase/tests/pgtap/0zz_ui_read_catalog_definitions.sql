BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SET LOCAL client_min_messages TO notice;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(1);

DO $catalog$
DECLARE
  reader regprocedure;
BEGIN
  FOREACH reader IN ARRAY ARRAY[
    'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure,
    'public.ui_get_resource_v1(text,uuid)'::regprocedure,
    'public.ui_resource_metrics_v1(text,jsonb,text[])'::regprocedure,
    'public.ui_filter_distinct_values_v1(text,text,text,integer)'::regprocedure
  ] LOOP
    RAISE NOTICE E'Catalog definition %:\n%\nEnd catalog definition',
      reader, pg_catalog.pg_get_functiondef(reader);
  END LOOP;
END;
$catalog$;

SELECT pass('Resource reader catalog definitions collected');
SELECT * FROM finish();
ROLLBACK;
