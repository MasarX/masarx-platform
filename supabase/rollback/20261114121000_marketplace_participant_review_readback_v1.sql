-- Separately authorized inverse for this additive epoch only. Never invokes the frozen P1 inverse.
-- psql -X -v ON_ERROR_STOP=1 -f supabase/rollback/20261114121000_marketplace_participant_review_readback_v1.sql
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261114121000_marketplace_participant_review_readback_v1'));
LOCK TABLE public.marketplace_review_readback_state_v1 IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.ui_rpc_executor_rollback_state_v1 IN SHARE MODE;
LOCK TABLE public.settings,public.settings_versions IN SHARE ROW EXCLUSIVE MODE;

DO $inverse$
DECLARE
  before_registry JSONB;
  after_registry JSONB;
  view_after JSONB;
  plan_now JSONB;
  rec RECORD;
  saved JSONB;
  actual_acl JSONB;
BEGIN
  IF (SELECT relowner FROM pg_class WHERE oid='public.marketplace_review_readback_state_v1'::regclass)
      IS DISTINCT FROM current_user::regrole::oid THEN
    RAISE EXCEPTION 'Marketplace review inverse requires its snapshot owner' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid='ui_rpc_executor'::regrole
      AND (rolsuper OR rolbypassrls OR rolinherit OR rolcanlogin))
    OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member='ui_rpc_executor'::regrole
      OR (m.roleid='ui_rpc_executor'::regrole AND
        (COALESCE((to_jsonb(m)->>'inherit_option')::boolean,TRUE)
          OR COALESCE((to_jsonb(m)->>'set_option')::boolean,TRUE)))) THEN
    RAISE EXCEPTION 'Executor role or membership changed; additive inverse refused';
  END IF;
  IF obj_description('public.marketplace_review_readback_state_v1'::regclass,'pg_class') IS DISTINCT FROM
      'marketplace_review_readback_state_v1:sha256:' || (SELECT encode(pg_catalog.sha256(convert_to(
        jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex') FROM public.marketplace_review_readback_state_v1) THEN
    RAISE EXCEPTION 'Additive marketplace review snapshot integrity mismatch';
  END IF;
  IF obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class') IS DISTINCT FROM
      (SELECT value#>>'{}' FROM public.marketplace_review_readback_state_v1 WHERE key='baseline_seal')
    OR obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class') IS DISTINCT FROM
      'ui_rpc_executor_rollback_state_v1:sha256:' || (SELECT encode(pg_catalog.sha256(convert_to(
        jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex') FROM public.ui_rpc_executor_rollback_state_v1) THEN
    RAISE EXCEPTION 'Frozen executor epoch changed; additive inverse refused';
  END IF;
  SELECT value INTO STRICT before_registry FROM public.marketplace_review_readback_state_v1 WHERE key='registry_before';
  SELECT value INTO STRICT after_registry FROM public.marketplace_review_readback_state_v1 WHERE key='registry_after';
  IF NOT EXISTS (SELECT 1 FROM public.settings s JOIN public.settings_versions sv
      ON sv.id=s.settings_version_id AND sv.scope_hash=s.scope_hash AND sv.category=s.category
      AND sv.scope_type=s.scope_type AND sv.scope_id IS NOT DISTINCT FROM s.scope_id
    WHERE s.id=(after_registry->>'settings_id')::uuid
      AND s.category=before_registry->>'category' AND s.scope_type=before_registry->>'scope_type'
      AND s.scope_id IS NOT DISTINCT FROM (before_registry->>'scope_id')::uuid
      AND s.scope_hash=before_registry->>'scope_hash'
      AND s.settings_version_id=(after_registry->>'version_id')::uuid
      AND s.cached_value=after_registry->'value' AND sv.value=s.cached_value
      AND sv.approved_at IS NOT NULL AND sv.effective_until IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.settings_versions sv
      WHERE sv.id=(before_registry->>'settings_version_id')::uuid AND sv.value=before_registry->'value'
        AND sv.effective_until IS NOT NULL) THEN
    RAISE EXCEPTION 'Registry changed after marketplace review installation; reconcile before inverse';
  END IF;
  SELECT value INTO STRICT view_after FROM public.marketplace_review_readback_state_v1 WHERE key='view_after';
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.marketplace_participant_request_review_read_v1')
      AND c.relowner=(view_after->>'owner')::oid AND pg_get_viewdef(c.oid,TRUE)=view_after->>'definition'
      AND to_jsonb(c.reloptions) IS NOT DISTINCT FROM view_after->'options'
      AND to_jsonb(c.relacl) IS NOT DISTINCT FROM view_after->'acl') THEN
    RAISE EXCEPTION 'Marketplace review view changed after installation';
  END IF;
  FOR saved IN SELECT e FROM public.marketplace_review_readback_state_v1 s,
      jsonb_array_elements(s.value) e WHERE s.key='functions' LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(saved->>'signature')
        AND p.proowner=(saved->>'owner')::oid AND pg_get_functiondef(p.oid)=saved->>'definition'
        AND to_jsonb(p.proacl) IS NOT DISTINCT FROM saved->'acl') THEN
      RAISE EXCEPTION 'Marketplace review function dependency changed: %',saved->>'signature';
    END IF;
  END LOOP;
  FOR saved IN SELECT e FROM public.marketplace_review_readback_state_v1 s,
      jsonb_array_elements(s.value) e WHERE s.key='base_relations' LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass(saved->>'relation')
        AND c.relowner=(saved->>'owner')::oid AND c.relrowsecurity=(saved->>'rls')::boolean
        AND c.relforcerowsecurity=(saved->>'force_rls')::boolean
        AND to_jsonb(c.relacl) IS NOT DISTINCT FROM saved->'acl'
        AND (SELECT COALESCE(jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
          'roles',p.polroles,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))
          ORDER BY p.polname),'[]'::jsonb) FROM pg_policy p WHERE p.polrelid=c.oid) IS NOT DISTINCT FROM saved->'policies') THEN
      RAISE EXCEPTION 'Marketplace review base dependency RLS/ACL changed: %',saved->>'relation';
    END IF;
  END LOOP;
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind,object_id,privilege,column_name),'[]'::jsonb)
    INTO plan_now FROM public.ui_rpc_executor_privilege_plan_v1() p;
  IF plan_now IS DISTINCT FROM (SELECT value FROM public.marketplace_review_readback_state_v1 WHERE key='plan_after') THEN
    RAISE EXCEPTION 'Executor plan changed after marketplace review installation';
  END IF;
  FOR rec IN SELECT p.* FROM public.marketplace_review_readback_state_v1 s,
      jsonb_to_recordset(s.value) p(object_kind TEXT,object_id OID,privilege TEXT,column_name TEXT)
      WHERE s.key='grant_delta' LOOP
    IF rec.object_kind='relation' THEN SELECT to_jsonb(relacl) INTO actual_acl FROM pg_class WHERE oid=rec.object_id;
    ELSE SELECT to_jsonb(proacl) INTO actual_acl FROM pg_proc WHERE oid=rec.object_id; END IF;
    IF jsonb_build_object('acl',actual_acl) IS DISTINCT FROM (SELECT value FROM public.marketplace_review_readback_state_v1
        WHERE key='acl_after:'||rec.object_kind||':'||rec.object_id) THEN
      RAISE EXCEPTION 'Additive dependency ACL changed after installation';
    END IF;
  END LOOP;

  -- Restore metadata with a new version; never reopen or rewrite historical values.
  PERFORM public.upsert_settings_value_v1('ui_read_registry',before_registry->>'scope_type',
    (before_registry->>'scope_id')::uuid,before_registry->'value',(before_registry->>'schema_version')::int,
    'Restore pre-marketplace-review canonical participant routing through additive inverse');
  IF (SELECT cached_value FROM public.settings WHERE id=(before_registry->>'id')::uuid)
      IS DISTINCT FROM before_registry->'value' THEN
    RAISE EXCEPTION 'Inverse normalization did not restore the exact registry before-image';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind,object_id,privilege,column_name),'[]'::jsonb)
    INTO plan_now FROM public.ui_rpc_executor_privilege_plan_v1() p;
  IF plan_now IS DISTINCT FROM (SELECT value FROM public.marketplace_review_readback_state_v1 WHERE key='plan_before') THEN
    RAISE EXCEPTION 'Inverse did not restore the exact prior executor plan';
  END IF;
  FOR rec IN SELECT p.* FROM public.marketplace_review_readback_state_v1 s,
      jsonb_to_recordset(s.value) p(object_kind TEXT,object_id OID,privilege TEXT,column_name TEXT)
      WHERE s.key='grant_delta' LOOP
    IF rec.object_kind='relation' THEN
      EXECUTE format('REVOKE SELECT ON TABLE %s FROM ui_rpc_executor',rec.object_id::regclass);
      SELECT to_jsonb(relacl) INTO actual_acl FROM pg_class WHERE oid=rec.object_id;
    ELSE
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM ui_rpc_executor',rec.object_id::regprocedure);
      SELECT to_jsonb(proacl) INTO actual_acl FROM pg_proc WHERE oid=rec.object_id;
    END IF;
    IF jsonb_build_object('acl',actual_acl) IS DISTINCT FROM (SELECT value FROM public.marketplace_review_readback_state_v1
        WHERE key='acl_before:'||rec.object_kind||':'||rec.object_id) THEN
      RAISE EXCEPTION 'Inverse did not restore the exact prior dependency ACL';
    END IF;
  END LOOP;
  DROP VIEW public.marketplace_participant_request_review_read_v1 RESTRICT;
  -- Keep this sealed additive evidence table. It is not a mutable status ledger.
END;
$inverse$;
DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%' OR cache_key LIKE '%:marketplace_participant_requests:%';
COMMIT;
