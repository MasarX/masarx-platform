-- Manual inverse qualification only; intentionally outside normal pgTAP discovery.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT plan(10);
SELECT hasnt_view('public','webhook_inbox_followup_read_v1','inverse removes only the additive view');
SELECT is((SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind,object_id,privilege,column_name),'[]'::jsonb)
  FROM public.ui_rpc_executor_privilege_plan_v1() p),
  (SELECT value FROM public.webhook_followup_readback_state_v1 WHERE key='plan_before'),'prior canonical plan restored');
SELECT is(obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class'),
  (SELECT value#>>'{}' FROM public.webhook_followup_readback_state_v1 WHERE key='baseline_seal'),'frozen executor epoch unchanged');
SELECT is(obj_description('public.webhook_followup_readback_state_v1'::regclass,'pg_class'),
  'webhook_followup_readback_state_v1:sha256:' || (SELECT encode(pg_catalog.sha256(convert_to(
    jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex') FROM public.webhook_followup_readback_state_v1),'additive evidence remains sealed');
SELECT ok(NOT EXISTS(SELECT 1 FROM public.webhook_followup_readback_state_v1 s,
  jsonb_to_recordset(s.value) p(object_kind TEXT,object_id OID,privilege TEXT,column_name TEXT)
  WHERE s.key='grant_delta' AND p.object_kind='function' AND
    (SELECT jsonb_build_object('acl',proacl) FROM pg_proc WHERE oid=p.object_id) IS DISTINCT FROM
    (SELECT value FROM public.webhook_followup_readback_state_v1 WHERE key='acl_before:function:'||p.object_id)),
  'prior dependency ACL restored');
SELECT ok(EXISTS(SELECT 1 FROM public.settings s,public.webhook_followup_readback_state_v1 before_state
  WHERE before_state.key='registry_before' AND s.id=(before_state.value->>'id')::uuid
    AND s.cached_value=before_state.value->'value' AND s.settings_version_id<>(before_state.value->>'settings_version_id')::uuid),
  'registry before-image restored through a new version');
SELECT ok(EXISTS(SELECT 1 FROM public.settings_versions sv,public.webhook_followup_readback_state_v1 s
  WHERE s.key='registry_before' AND sv.id=(s.value->>'settings_version_id')::uuid
    AND sv.value=s.value->'value' AND sv.effective_until IS NOT NULL),'original history stays closed and unmodified');
SELECT ok(EXISTS(SELECT 1 FROM public.settings_versions sv,public.webhook_followup_readback_state_v1 s
  WHERE s.key='registry_after' AND sv.id=(s.value->>'version_id')::uuid
    AND sv.value=s.value->'value' AND sv.effective_until IS NOT NULL),'installed version stays closed and unmodified');
SELECT ok(NOT has_table_privilege('ui_rpc_executor','public.webhook_followup_readback_state_v1','SELECT')
  AND NOT has_table_privilege('service_role','public.webhook_followup_readback_state_v1','SELECT'),
  'retained inverse evidence remains private');
SELECT ok(EXISTS(SELECT 1 FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.id=(SELECT (value->>'id')::uuid FROM public.webhook_followup_readback_state_v1 WHERE key='registry_before')
    AND s.cached_value=sv.value AND sv.approved_at IS NOT NULL AND sv.effective_until IS NULL),
  'restored pointer/cache/current-version parity');
SELECT * FROM finish();
ROLLBACK;
