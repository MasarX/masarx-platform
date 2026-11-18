-- Preserve service_offerings effective range validity when archiving rows that
-- were created in the same transaction.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031600_service_offering_archive_effective_range_repair_v1'));
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('public.service_offering_archive_v1(jsonb)'::regprocedure)
    INTO v_definition;

  v_definition := replace(
    v_definition,
    'effective_to = COALESCE(effective_to, now()),',
    'effective_to = COALESCE(effective_to, GREATEST(now(), effective_from + interval ''1 millisecond'')),'
  );

  EXECUTE v_definition;
END $$;

SELECT pg_advisory_unlock(hashtext('202605031600_service_offering_archive_effective_range_repair_v1'));
COMMIT;
