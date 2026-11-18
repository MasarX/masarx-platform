-- Keep workflow_binding_policy settings single-active before writing a new
-- approved settings version from register_workflow_binding_v1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031580_register_workflow_binding_active_version_repair_v1'));
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('public.register_workflow_binding_v1(jsonb)'::regprocedure)
    INTO v_definition;

  v_definition := replace(
    v_definition,
    '  INSERT INTO public.settings_versions (
    category, scope_type, scope_id, version, value, schema_version,
    change_reason, approved_at, effective_from
  ) VALUES (',
    '  UPDATE public.settings_versions
     SET effective_until = now()
   WHERE category = ''workflow_binding_policy''
     AND scope_type = v_scope_type
     AND scope_id IS NOT DISTINCT FROM v_scope_id
     AND approved_at IS NOT NULL
     AND effective_until IS NULL;

  INSERT INTO public.settings_versions (
    category, scope_type, scope_id, version, value, schema_version,
    change_reason, approved_at, effective_from
  ) VALUES ('
  );

  EXECUTE v_definition;
END $$;

SELECT pg_advisory_unlock(hashtext('202605031580_register_workflow_binding_active_version_repair_v1'));
COMMIT;
