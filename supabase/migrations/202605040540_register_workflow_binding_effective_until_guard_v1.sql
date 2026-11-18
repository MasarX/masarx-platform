-- Ensure register_workflow_binding_v1 expires prior active settings versions
-- with a timestamp that always satisfies effective_until > effective_from.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031590_register_workflow_binding_effective_until_guard_v1'));
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('public.register_workflow_binding_v1(jsonb)'::regprocedure)
    INTO v_definition;

  v_definition := replace(
    v_definition,
    'SET effective_until = now()',
    'SET effective_until = GREATEST(now(), effective_from + interval ''1 millisecond'')'
  );

  EXECUTE v_definition;
END $$;

SELECT pg_advisory_unlock(hashtext('202605031590_register_workflow_binding_effective_until_guard_v1'));
COMMIT;
