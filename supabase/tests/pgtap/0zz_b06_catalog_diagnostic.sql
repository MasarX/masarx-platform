SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
SELECT plan(1);

DO $catalog$
BEGIN
  RAISE NOTICE 'B06 catalog device registration: %',
    pg_get_functiondef('public.register_user_device_v1(jsonb)'::regprocedure);
  RAISE NOTICE 'B06 catalog mobile attestation trigger: %',
    pg_get_functiondef('public.tg_enforce_mobile_attestation_ingest_v1()'::regprocedure);
END;
$catalog$;

SELECT pass('B06 diagnostic captured both functions from the replayed catalog');
SELECT * FROM finish();
ROLLBACK;
