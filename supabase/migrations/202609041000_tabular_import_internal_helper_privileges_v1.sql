-- Keep dynamic-relation tabular import helpers behind the governed prepare wrapper.
BEGIN;

SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('202609041000_tabular_import_internal_helper_privileges_v1'));

REVOKE ALL ON FUNCTION public.tabular_import_match_target_v1(TEXT, TEXT, JSONB, TEXT[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tabular_import_stage_related_nodes_v1(UUID, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.tabular_import_match_target_v1(TEXT, TEXT, JSONB, TEXT[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.tabular_import_stage_related_nodes_v1(UUID, JSONB, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.tabular_import_prepare_v1(JSONB)
  TO authenticated, service_role;

DO $assert$
BEGIN
  IF has_function_privilege(
       'anon',
       'public.tabular_import_match_target_v1(text,text,jsonb,text[])',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.tabular_import_match_target_v1(text,text,jsonb,text[])',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.tabular_import_match_target_v1(text,text,jsonb,text[])',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'tabular_import_match_target_v1 privilege boundary drifted';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.tabular_import_stage_related_nodes_v1(uuid,jsonb,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.tabular_import_stage_related_nodes_v1(uuid,jsonb,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.tabular_import_stage_related_nodes_v1(uuid,jsonb,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.tabular_import_prepare_v1(jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'tabular import governed wrapper privilege boundary drifted';
  END IF;
END;
$assert$;

COMMIT;
