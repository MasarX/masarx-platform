BEGIN;
SET LOCAL lock_timeout = '10s';

DO $patch$
DECLARE
  v_definition TEXT := pg_get_functiondef('public.ui_upsert_webhook_source_v1(jsonb)'::regprocedure);
  v_marker TEXT := '    v_target_org := v_before.organization_id;';
  v_guard TEXT := $guard$    IF public.webhook_source_metadata_is_archived_v1(v_before.managed_metadata) THEN
      RAISE EXCEPTION 'Archived webhook sources require an explicit restore'
        USING ERRCODE = '23514';
    END IF;

$guard$;
BEGIN
  IF position(v_marker IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Webhook source update admission boundary changed';
  END IF;
  EXECUTE replace(v_definition, v_marker, v_guard || v_marker);
END;
$patch$;

COMMIT;
