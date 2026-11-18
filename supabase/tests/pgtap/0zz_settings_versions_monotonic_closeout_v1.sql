BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SET search_path TO public, pgtap, extensions;

DO $$
DECLARE
  v_def_apply TEXT;
  v_def_upsert TEXT;
  v_initial RECORD;
BEGIN
  v_def_apply := pg_get_functiondef('workflow_handlers.execute_settings_apply_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure);
  PERFORM ok(
    position('GREATEST(' IN v_def_apply) > 0
      AND position('effective_from + INTERVAL ''1 microsecond''' IN v_def_apply) > 0,
    'execute_settings_apply_v1 keeps prior settings_versions closeout monotonic'
  );

  v_def_upsert := pg_get_functiondef('public.upsert_settings_value_v1(text,text,uuid,jsonb,integer,text)'::regprocedure);
  PERFORM ok(
    position('GREATEST(' IN v_def_upsert) > 0
      AND position('effective_from + INTERVAL ''1 microsecond''' IN v_def_upsert) > 0,
    'upsert_settings_value_v1 keeps prior settings_versions closeout monotonic'
  );

  SELECT *
    INTO v_initial
    FROM public.upsert_settings_value_v1(
      'webhook_ingest_policy',
      'global',
      NULL,
      '{"allow_provider_mirror": false}'::jsonb,
      1,
      'monotonic-closeout seed'
    );

  UPDATE public.settings_versions
     SET effective_from = clock_timestamp() + INTERVAL '1 minute',
         effective_until = NULL
   WHERE id = v_initial.settings_version_id;

  PERFORM public.upsert_settings_value_v1(
    'webhook_ingest_policy',
    'global',
    NULL,
    '{"allow_provider_mirror": true}'::jsonb,
    1,
    'monotonic-closeout verify'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.settings_versions
       WHERE id = v_initial.settings_version_id
         AND effective_until > effective_from
    ),
    'upsert_settings_value_v1 never closes a current settings_versions row at or before effective_from'
  );

  PERFORM is(
    (
      SELECT COUNT(*)
        FROM public.settings_versions
       WHERE category = 'webhook_ingest_policy'
         AND scope_type = 'global'
         AND effective_until IS NULL
         AND approved_at IS NOT NULL
    ),
    1::bigint,
    'upsert_settings_value_v1 leaves exactly one approved current settings_versions row'
  );
END
$$;

SELECT * FROM finish();

ROLLBACK;
