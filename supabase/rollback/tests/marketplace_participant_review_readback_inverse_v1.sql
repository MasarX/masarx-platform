-- Manual inverse qualification only; intentionally outside normal pgTAP discovery.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT plan(10);
SELECT hasnt_view('public','marketplace_participant_request_review_read_v1','inverse removes only the additive view');
SELECT is((SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind,object_id,privilege,column_name),'[]'::jsonb)
  FROM public.ui_rpc_executor_privilege_plan_v1() p),
  (SELECT value FROM public.marketplace_review_readback_state_v1 WHERE key='plan_before'),'prior canonical plan restored');
SELECT is(obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class'),
  (SELECT value#>>'{}' FROM public.marketplace_review_readback_state_v1 WHERE key='baseline_seal'),'frozen executor epoch unchanged');
SELECT is(obj_description('public.marketplace_review_readback_state_v1'::regclass,'pg_class'),
  'marketplace_review_readback_state_v1:sha256:' || (SELECT encode(pg_catalog.sha256(convert_to(
    jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex') FROM public.marketplace_review_readback_state_v1),'additive evidence remains sealed');
SELECT ok(NOT EXISTS(SELECT 1 FROM public.marketplace_review_readback_state_v1 s,
  jsonb_array_elements(s.value) saved WHERE s.key='base_relations' AND NOT EXISTS(
    SELECT 1 FROM pg_class c WHERE c.oid=to_regclass(saved->>'relation')
      AND to_jsonb(c.relacl) IS NOT DISTINCT FROM saved->'acl')),
  'prior base dependency ACL preserved');
SELECT ok(EXISTS(SELECT 1 FROM public.settings s,public.marketplace_review_readback_state_v1 before_state
  WHERE before_state.key='registry_before' AND s.id=(before_state.value->>'id')::uuid
    AND s.cached_value=before_state.value->'value' AND s.settings_version_id<>(before_state.value->>'settings_version_id')::uuid),
  'registry before-image restored through a new version');
SELECT ok(EXISTS(SELECT 1 FROM public.settings_versions sv,public.marketplace_review_readback_state_v1 s
  WHERE s.key='registry_before' AND sv.id=(s.value->>'settings_version_id')::uuid
    AND sv.value=s.value->'value' AND sv.effective_until IS NOT NULL),'original history stays closed and unmodified');
SELECT ok(EXISTS(SELECT 1 FROM public.settings_versions sv,public.marketplace_review_readback_state_v1 s
  WHERE s.key='registry_after' AND sv.id=(s.value->>'version_id')::uuid
    AND sv.value=s.value->'value' AND sv.effective_until IS NOT NULL),'installed version stays closed and unmodified');
SELECT ok(NOT has_table_privilege('ui_rpc_executor','public.marketplace_review_readback_state_v1','SELECT')
  AND NOT has_table_privilege('service_role','public.marketplace_review_readback_state_v1','SELECT'),
  'retained inverse evidence remains private');
SELECT ok(EXISTS(SELECT 1 FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.id=(SELECT (value->>'id')::uuid FROM public.marketplace_review_readback_state_v1 WHERE key='registry_before')
    AND s.cached_value=sv.value AND sv.approved_at IS NOT NULL AND sv.effective_until IS NULL),
  'restored pointer/cache/current-version parity');
SELECT * FROM finish();
ROLLBACK;
