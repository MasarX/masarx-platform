-- Preserve the trusted resolver contract in the executor's canonical dependency roots.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '10s';

DO $settings_dependencies$
DECLARE
  definition TEXT := pg_get_functiondef('public.ui_rpc_executor_privilege_plan_v1()'::regprocedure);
  before_seam CONSTANT TEXT := $before$'public.ui_rpc_current_user_id_v1()'::regprocedure::oid])$before$;
  after_seam CONSTANT TEXT := $after$'public.ui_rpc_current_user_id_v1()'::regprocedure::oid,
      -- Trusted raw-settings dependencies retain the credential resolver ACL contract.
      'public.resolve_settings(text,text,uuid)'::regprocedure::oid,
      'public.resolve_settings_row(text,text,uuid)'::regprocedure::oid])$after$;
  plan_before JSONB;
  plan_after JSONB;
  added JSONB;
  removed JSONB;
  expected JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb) INTO plan_before
  FROM public.ui_rpc_executor_privilege_plan_v1() p;
  IF (length(definition)-length(replace(definition,before_seam,'')))/length(before_seam) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one executor dependency-root seam';
  END IF;
  EXECUTE replace(definition,before_seam,after_seam);

  SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb) INTO plan_after
  FROM public.ui_rpc_executor_privilege_plan_v1() p;
  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb) INTO added
  FROM jsonb_array_elements(plan_after) entry WHERE NOT plan_before @> jsonb_build_array(entry);
  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb) INTO removed
  FROM jsonb_array_elements(plan_before) entry WHERE NOT plan_after @> jsonb_build_array(entry);
  SELECT jsonb_agg(jsonb_build_object('object_kind','function','object_id',signature::regprocedure::oid,
    'privilege','EXECUTE','column_name',NULL)) INTO expected
  FROM unnest(ARRAY['public.resolve_settings(text,text,uuid)',
    'public.resolve_settings_row(text,text,uuid)']) signature;
  IF removed <> '[]'::jsonb OR NOT (added @> expected AND expected @> added) THEN
    RAISE EXCEPTION 'Unexpected executor settings dependency-plan delta: added %, removed %',added,removed;
  END IF;

  GRANT EXECUTE ON FUNCTION public.resolve_settings(TEXT,TEXT,UUID),
    public.resolve_settings_row(TEXT,TEXT,UUID) TO ui_rpc_executor;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(expected) entry
    WHERE NOT has_function_privilege('ui_rpc_executor',(entry->>'object_id')::oid,'EXECUTE')
  ) OR EXISTS (
    SELECT 1 FROM unnest(ARRAY['anon','authenticated']) browser_role
      CROSS JOIN jsonb_array_elements(expected) entry
    WHERE has_function_privilege(browser_role,(entry->>'object_id')::oid,'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Trusted resolver grants or browser denial changed' USING ERRCODE='42501';
  END IF;
END;
$settings_dependencies$;
COMMIT;
