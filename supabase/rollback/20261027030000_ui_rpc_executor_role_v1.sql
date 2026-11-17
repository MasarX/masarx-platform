-- Manual, explicitly authorized rollback only; never part of automatic migration discovery.
-- psql -X -v ON_ERROR_STOP=1 -f supabase/rollback/20261027030000_ui_rpc_executor_role_v1.sql
-- Restoring original ownership restores the prior UI security boundary. Contain access first.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261027030000_ui_rpc_executor_role_v1'));
LOCK TABLE public.ui_rpc_executor_rollback_state_v1 IN ACCESS EXCLUSIVE MODE;

DO $rollback$
DECLARE
  entry JSONB;
  rec RECORD;
  v_roles TEXT;
  v_later_policies TEXT;
BEGIN
  IF obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class')
      IS DISTINCT FROM 'ui_rpc_executor_rollback_state_v1:sha256:' || (SELECT
        encode(pg_catalog.sha256(convert_to(COALESCE(jsonb_object_agg(key,value ORDER BY key),'{}'::jsonb)::text,'UTF8')),'hex')
        FROM public.ui_rpc_executor_rollback_state_v1) THEN
    RAISE EXCEPTION 'executor rollback snapshot integrity mismatch; restore reviewed before-images before rollback';
  END IF;
  IF (SELECT jsonb_array_length(value) FROM public.ui_rpc_executor_rollback_state_v1 WHERE key='entrypoints')
      IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'executor rollback requires all six original definitions';
  END IF;
  SELECT string_agg(format('%I ON %s',p.polname,p.polrelid::regclass),', ' ORDER BY p.polrelid,p.polname)
    INTO v_later_policies FROM pg_policy p
   WHERE 'ui_rpc_executor'::regrole::oid=ANY(p.polroles)
     AND NOT EXISTS(SELECT 1 FROM public.ui_rpc_executor_rollback_state_v1 s,
       jsonb_array_elements(CASE WHEN s.key='policies' THEN s.value ELSE '[]'::jsonb END) f
       WHERE s.key='policies' AND p.polrelid=to_regclass(f->>'relation') AND p.polname=f->>'name')
     AND NOT EXISTS(SELECT 1 FROM public.ui_rpc_executor_rollback_state_v1 s,
       jsonb_array_elements(CASE WHEN s.key='created_policies' THEN s.value ELSE '[]'::jsonb END) f
       WHERE s.key='created_policies' AND p.polrelid=to_regclass(f->>'relation') AND p.polname=f->>'name'
         AND p.polcmd='r' AND p.polpermissive AND p.polwithcheck IS NULL
         AND p.polroles=ARRAY['ui_rpc_executor'::regrole::oid]
         AND pg_get_expr(p.polqual,p.polrelid) IS NOT DISTINCT FROM f->>'using')
     AND NOT (p.polname='ui_rpc_executor_trusted' AND EXISTS(
       SELECT 1 FROM public.ui_rpc_executor_rollback_state_v1 s,
         jsonb_array_elements_text(CASE WHEN s.key='trusted_relations' THEN s.value ELSE '[]'::jsonb END) r
        WHERE s.key='trusted_relations' AND p.polrelid=to_regclass(r)));
  IF v_later_policies IS NOT NULL THEN
    RAISE EXCEPTION 'executor rollback blocked by later policies: %. Reconcile their executor role lists in an explicitly reviewed rollback before retrying.',v_later_policies;
  END IF;
  FOR entry IN SELECT f FROM public.ui_rpc_executor_rollback_state_v1 s,
      jsonb_array_elements(CASE WHEN s.key='modified_functions' THEN s.value ELSE '[]'::jsonb END) f
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(entry->>'signature')
        AND pg_get_userbyid(p.proowner)=entry->>'owner'
        AND pg_get_functiondef(p.oid)=entry->>'after_definition') THEN
      RAISE EXCEPTION 'executor shared read guard changed after installation; reconcile before rollback';
    END IF;
  END LOOP;
  FOR entry IN SELECT f FROM public.ui_rpc_executor_rollback_state_v1 s,
      jsonb_array_elements(CASE WHEN s.key='created_functions' THEN s.value ELSE '[]'::jsonb END) f
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(entry->>'signature')
        AND pg_get_userbyid(p.proowner)=entry->>'owner'
        AND pg_get_functiondef(p.oid)=entry->>'definition') THEN
      RAISE EXCEPTION 'executor read helper changed after installation; reconcile before rollback';
    END IF;
  END LOOP;
  FOR entry IN SELECT f FROM public.ui_rpc_executor_rollback_state_v1 s,
      jsonb_array_elements(CASE WHEN s.key='read_relations' THEN s.value ELSE '[]'::jsonb END) f
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass(entry->>'relation')
        AND pg_get_viewdef(c.oid,TRUE)=entry->>'after_definition'
        AND to_jsonb(c.reloptions) IS NOT DISTINCT FROM entry->'options') THEN
      RAISE EXCEPTION 'executor read relation changed after installation; reconcile before rollback';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.ui_rpc_executor_rollback_state_v1 s,
      jsonb_array_elements(CASE WHEN s.key='entrypoints' THEN s.value ELSE '[]'::jsonb END) f
      WHERE s.key='entrypoints' AND (f->>'owner' IS NULL OR to_regrole(f->>'owner') IS NULL)) THEN
    RAISE EXCEPTION 'executor rollback requires every original owner to exist in the snapshot and catalog';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class WHERE relowner='ui_rpc_executor'::regrole)
     OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.proowner='ui_rpc_executor'::regrole AND NOT EXISTS(
       SELECT 1 FROM public.ui_rpc_executor_rollback_state_v1 s,
         jsonb_array_elements(CASE WHEN s.key='entrypoints' THEN s.value ELSE '[]'::jsonb END) f WHERE s.key='entrypoints' AND p.oid=to_regprocedure(f->>'signature'))) THEN
    RAISE EXCEPTION 'executor acquired unrelated objects; review rollback dependencies';
  END IF;
  -- Do not overwrite registry changes made after this candidate.
  FOR entry IN SELECT value FROM public.ui_rpc_executor_rollback_state_v1 WHERE key LIKE 'settings:%'
  LOOP
    IF public.resolve_settings_merged('ui_read_registry',entry->>'scope_type',(entry->>'scope_id')::uuid)
        IS DISTINCT FROM entry->'after' THEN
      RAISE EXCEPTION 'ui_read_registry changed after executor installation; reconcile before rollback';
    END IF;
  END LOOP;
  IF current_setting('server_version_num')::int >= 160000 THEN
    -- ALTER OWNER checks inherited ownership privileges on PG16+, even with SET allowed.
    EXECUTE format('GRANT ui_rpc_executor TO %I WITH INHERIT TRUE, SET TRUE',current_user);
  ELSE
    EXECUTE format('GRANT ui_rpc_executor TO %I',current_user);
  END IF;
  FOR entry IN SELECT f FROM public.ui_rpc_executor_rollback_state_v1 s,
      LATERAL jsonb_array_elements(CASE WHEN s.key='entrypoints' THEN s.value ELSE '[]'::jsonb END) f
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I',to_regprocedure(entry->>'signature'),entry->>'owner');
    EXECUTE entry->>'definition';
  END LOOP;
  FOR entry IN SELECT f FROM public.ui_rpc_executor_rollback_state_v1 s,
      jsonb_array_elements(CASE WHEN s.key='modified_functions' THEN s.value ELSE '[]'::jsonb END) f
  LOOP
    EXECUTE entry->>'before_definition';
  END LOOP;
  FOR entry IN SELECT p FROM public.ui_rpc_executor_rollback_state_v1 s,
      LATERAL jsonb_array_elements(CASE WHEN s.key='policies' THEN s.value ELSE '[]'::jsonb END) p
  LOOP
    SELECT string_agg(quote_ident(role),', ' ORDER BY role) INTO v_roles
      FROM jsonb_array_elements_text(entry->'roles') role;
    EXECUTE format('ALTER POLICY %I ON %s TO %s',entry->>'name',to_regclass(entry->>'relation'),v_roles);
  END LOOP;
  FOR entry IN SELECT r FROM public.ui_rpc_executor_rollback_state_v1 s,
      LATERAL jsonb_array_elements(CASE WHEN s.key='trusted_relations' THEN s.value ELSE '[]'::jsonb END) r
  LOOP
    EXECUTE format('DROP POLICY ui_rpc_executor_trusted ON %s',to_regclass(entry#>>'{}'));
  END LOOP;
  FOR entry IN SELECT f FROM public.ui_rpc_executor_rollback_state_v1 s,
      jsonb_array_elements(CASE WHEN s.key='created_policies' THEN s.value ELSE '[]'::jsonb END) f
  LOOP
    EXECUTE format('DROP POLICY %I ON %s',entry->>'name',to_regclass(entry->>'relation'));
  END LOOP;
  FOR entry IN SELECT f FROM public.ui_rpc_executor_rollback_state_v1 s,
      jsonb_array_elements(CASE WHEN s.key='read_relations' THEN s.value ELSE '[]'::jsonb END) f
  LOOP
    EXECUTE format('CREATE OR REPLACE VIEW %s WITH(security_invoker=true) AS %s',
      to_regclass(entry->>'relation'),entry->>'before_definition');
  END LOOP;
  FOR rec IN SELECT p.* FROM public.ui_rpc_executor_rollback_state_v1 s,
      LATERAL jsonb_to_recordset(CASE WHEN s.key='grants' THEN s.value ELSE '[]'::jsonb END)
        p(object_kind TEXT,object_id OID,privilege TEXT,column_name TEXT)
  LOOP
    IF rec.object_kind='relation' THEN
      EXECUTE format('REVOKE %s%s ON TABLE %s FROM ui_rpc_executor',rec.privilege,
        CASE WHEN rec.column_name IS NULL THEN '' ELSE format(' (%I)',rec.column_name) END,rec.object_id::regclass);
    ELSIF rec.object_kind='function' THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM ui_rpc_executor',rec.object_id::regprocedure);
    ELSIF rec.object_kind='schema' THEN
      EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM ui_rpc_executor',
        (SELECT nspname FROM pg_namespace WHERE oid=rec.object_id));
    END IF;
  END LOOP;
  FOR entry IN SELECT value FROM public.ui_rpc_executor_rollback_state_v1 WHERE key LIKE 'settings:%'
  LOOP
    PERFORM public.upsert_settings_value_v1('ui_read_registry',entry->>'scope_type',(entry->>'scope_id')::uuid,
      entry->'before',(entry->>'schema_version')::int,'Authorized UI executor rollback');
  END LOOP;
  FOR entry IN SELECT r FROM public.ui_rpc_executor_rollback_state_v1 s,
      LATERAL jsonb_array_elements(CASE WHEN s.key='registry_schema' THEN s.value ELSE '[]'::jsonb END) r
  LOOP
    UPDATE public.schema_registry SET schema=entry->'schema' WHERE id=(entry->>'id')::uuid;
  END LOOP;
  EXECUTE format('REVOKE ui_rpc_executor FROM %I',current_user);
  FOR entry IN SELECT f FROM public.ui_rpc_executor_rollback_state_v1 s,
      jsonb_array_elements(CASE WHEN s.key='created_functions' THEN s.value ELSE '[]'::jsonb END) f
  LOOP
    EXECUTE format('DROP FUNCTION %s',to_regprocedure(entry->>'signature'));
  END LOOP;
END;
$rollback$;
DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';

DROP FUNCTION public.ui_rpc_executor_privilege_plan_v1();
DROP FUNCTION public.ui_resource_scope_predicate_v1(JSONB,REGCLASS,TEXT,UUID,TEXT);
DROP FUNCTION public.ui_rpc_assert_mutation_v1(TEXT,JSONB,TEXT);
DROP FUNCTION public.ui_rpc_registry_v1(TEXT,UUID);
DROP FUNCTION public.ui_rpc_relation_rls_active_v1(REGCLASS);
DROP FUNCTION public.ui_rpc_request_is_service_v1();
DROP FUNCTION public.ui_rpc_current_user_id_v1();
DROP TABLE public.ui_rpc_executor_rollback_state_v1;
DELETE FROM public.table_contracts WHERE table_schema='public' AND table_name='ui_rpc_executor_rollback_state_v1';
DROP ROLE ui_rpc_executor;
COMMIT;
