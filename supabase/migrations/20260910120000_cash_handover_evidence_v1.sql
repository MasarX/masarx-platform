-- Draft append-only migration: optional evidence is not settlement approval.
BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('f619_cash_handover_evidence_v1'));
LOCK TABLE public.task_events IN SHARE ROW EXCLUSIVE MODE;
DO $reserved$
BEGIN
 IF EXISTS(SELECT 1 FROM public.task_events WHERE payload ? 'cash_handover_evidence_version') THEN
  RAISE EXCEPTION 'cash_handover_evidence_marker_preexisting' USING ERRCODE='23514';
 END IF;
END;
$reserved$;

CREATE FUNCTION public.enforce_cash_handover_evidence_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp AS $fn$
DECLARE
 t public.tasks%ROWTYPE;
 contract jsonb;
 artifact public.artifacts%ROWTYPE;
 object_metadata jsonb;
 prefix text;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.payload->'cash_handover_evidence_version'='1'::jsonb THEN
   RAISE EXCEPTION 'cash_handover_evidence_immutable' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 IF (TG_OP='INSERT' AND NEW.payload ? 'cash_handover_evidence_version') OR
  (TG_OP='UPDATE' AND NEW.payload->'cash_handover_evidence_version'
   IS DISTINCT FROM OLD.payload->'cash_handover_evidence_version') THEN
  RAISE EXCEPTION 'cash_handover_evidence_marker_reserved' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.payload->'cash_handover_evidence_version'='1'::jsonb AND
  (NEW.id IS DISTINCT FROM OLD.id OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.task_id IS DISTINCT FROM OLD.task_id
   OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
   OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.to_status IS DISTINCT FROM OLD.to_status
   OR NEW.ops_session_id IS DISTINCT FROM OLD.ops_session_id) THEN
  RAISE EXCEPTION 'cash_handover_evidence_immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.event_type IS DISTINCT FROM 'status_changed' OR NEW.to_status IS DISTINCT FROM 'completed' THEN
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT t FROM public.tasks WHERE id=NEW.task_id;
 SELECT tt.metadata->'completion_evidence_contract' INTO contract
 FROM public.task_types tt WHERE tt.id=t.task_type_id;
 IF contract IS NULL THEN RETURN NEW; END IF;
 -- Only INSERT can attest new acceptance; historical no-op updates cannot promote evidence.
 IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
 IF contract IS DISTINCT FROM '{"version":1,"supervisor_name":"optional_annotation","photo_artifact_id":"optional_owned_task_photo"}'::jsonb THEN
  RAISE EXCEPTION 'cash_handover_evidence_contract_invalid' USING ERRCODE='23514';
 END IF;
 -- Omission remains valid. Evidence never supplies actor, amount or authorization.
 IF NOT (NEW.payload ? 'supervisor_name' OR NEW.payload ? 'photo_artifact_id') THEN RETURN NEW; END IF;
 IF auth.uid() IS NULL OR NEW.actor_user_id IS DISTINCT FROM auth.uid()
    OR NEW.organization_id IS DISTINCT FROM t.organization_id
    OR t.organization_id IS DISTINCT FROM public.current_user_org_id()
    OR t.resource_type IS DISTINCT FROM 'settlement_batch' OR t.resource_id IS NULL THEN
  RAISE EXCEPTION 'cash_handover_evidence_forbidden' USING ERRCODE='42501';
 END IF;
 IF NEW.payload ? 'supervisor_name' AND (jsonb_typeof(NEW.payload->'supervisor_name') IS DISTINCT FROM 'string'
    OR btrim(NEW.payload->>'supervisor_name') = '') THEN
  RAISE EXCEPTION 'cash_handover_supervisor_invalid' USING ERRCODE='23514';
 END IF;
 IF NEW.payload ? 'photo_artifact_id' THEN
  IF jsonb_typeof(NEW.payload->'photo_artifact_id') IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'cash_handover_photo_invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO artifact FROM public.artifacts a
  WHERE a.id::text=NEW.payload->>'photo_artifact_id' AND a.organization_id=t.organization_id FOR SHARE;
  prefix:=t.organization_id::text||'/'||t.id::text||'/';
  IF NOT FOUND OR artifact.storage_bucket IS DISTINCT FROM 'fieldops-evidence'
    OR left(artifact.storage_key,length(prefix)) IS DISTINCT FROM prefix
    OR length(artifact.storage_key)<=length(prefix) THEN
   RAISE EXCEPTION 'cash_handover_photo_forbidden' USING ERRCODE='42501';
  END IF;
  -- Registration attribution is mutable; the locked Storage owner is authoritative.
  object_metadata:=public.assert_self_kyc_object_v1(artifact.storage_bucket,artifact.storage_key);
  IF left(COALESCE(object_metadata->>'mimetype',''),6) IS DISTINCT FROM 'image/' THEN
   RAISE EXCEPTION 'cash_handover_photo_invalid' USING ERRCODE='23514';
  END IF;
 END IF;
 NEW.payload:=NEW.payload||jsonb_build_object('cash_handover_evidence_version',1);
 RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.enforce_cash_handover_evidence_v1() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER trg_task_events_cash_handover_evidence
BEFORE INSERT OR UPDATE OR DELETE ON public.task_events
FOR EACH ROW EXECUTE FUNCTION public.enforce_cash_handover_evidence_v1();

DO $seed$
DECLARE r record; next_value jsonb;
 contract jsonb:='{"version":1,"supervisor_name":"optional_annotation","photo_artifact_id":"optional_owned_task_photo"}'::jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM public.task_types WHERE key='cod_cash_handover'
  AND ((metadata IS NOT NULL AND jsonb_typeof(metadata)<>'object') OR
   (metadata ? 'completion_evidence_contract' AND metadata->'completion_evidence_contract' IS DISTINCT FROM contract))) THEN
  RAISE EXCEPTION 'cash_handover_evidence_type_conflict';
 END IF;
 UPDATE public.task_types SET metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('completion_evidence_contract',contract)
 WHERE key='cod_cash_handover';
 FOR r IN SELECT s.category,s.scope_type,s.scope_id,sv.value,sv.schema_version
  FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='task_type_catalog' ORDER BY s.id FOR UPDATE OF s
 LOOP
  IF jsonb_typeof(r.value->'task_types') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'task_type_catalog_items_invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r.value->'task_types') e
   WHERE lower(btrim(e->>'key'))='cod_cash_handover' AND
    ((e ? 'metadata' AND jsonb_typeof(e->'metadata')<>'object') OR
     (e->'metadata' ? 'completion_evidence_contract' AND e#>'{metadata,completion_evidence_contract}' IS DISTINCT FROM contract))) THEN
   RAISE EXCEPTION 'cash_handover_evidence_catalog_conflict';
  END IF;
  SELECT jsonb_set(r.value,'{task_types}',COALESCE(jsonb_agg(CASE
   WHEN lower(btrim(e->>'key'))='cod_cash_handover' THEN
    jsonb_set(e,'{metadata}',COALESCE(e->'metadata','{}'::jsonb)||jsonb_build_object('completion_evidence_contract',contract))
   ELSE e END ORDER BY n),'[]'::jsonb)) INTO next_value
  FROM jsonb_array_elements(r.value->'task_types') WITH ORDINALITY x(e,n);
  IF next_value IS DISTINCT FROM r.value THEN
   PERFORM public.upsert_settings_value_v1(r.category,r.scope_type,r.scope_id,next_value,r.schema_version,
    'Preserve optional cash handover annotation and owned task photo');
  END IF;
 END LOOP;
END;
$seed$;
DO $variant$
DECLARE r record; item jsonb; next_value jsonb; found_count integer:=0;
 old_variant jsonb:=jsonb_build_object('normalization','financial_amount_v1',
  'title','Financial task completion','description','Record the amount using an authorized operational session. Settlement approval remains a separate workflow outcome.',
  'fields',jsonb_build_array(jsonb_build_object('key','amount','type','number','required',true,'label','Amount')));
 new_variant jsonb;
BEGIN
 new_variant:=old_variant||jsonb_build_object(
  'evidence_contract','{"version":1,"supervisor_name":"optional_annotation","photo_artifact_id":"optional_owned_task_photo"}'::jsonb,
  'fields',(old_variant->'fields')||jsonb_build_array(jsonb_build_object('key','supervisor_name','type','text','required',false,'label','Supervisor name (annotation only)')));
 FOR r IN SELECT s.scope_type,s.scope_id,sv.value,sv.schema_version
  FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='ui_command_registry' ORDER BY s.id FOR UPDATE OF s
 LOOP
  IF jsonb_typeof(r.value->'commands') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'cash_evidence_commands_invalid'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(r.value->'commands') e WHERE e->>'key'='tasks.complete')>1 THEN
   RAISE EXCEPTION 'cash_evidence_duplicate_command';
  END IF;
  SELECT e INTO item FROM jsonb_array_elements(r.value->'commands') e WHERE e->>'key'='tasks.complete';
  IF NOT FOUND THEN CONTINUE; END IF;
  found_count:=found_count+1;
  IF item#>'{execution,input_schema,task_type_overrides,cod_cash_handover}' IS DISTINCT FROM old_variant
   AND item#>'{execution,input_schema,task_type_overrides,cod_cash_handover}' IS DISTINCT FROM new_variant THEN
   RAISE EXCEPTION 'cash_evidence_variant_conflict';
  END IF;
  SELECT jsonb_set(r.value,'{commands}',jsonb_agg(CASE WHEN e->>'key'='tasks.complete' THEN
   jsonb_set(e,'{execution,input_schema,task_type_overrides,cod_cash_handover}',new_variant)
   ELSE e END ORDER BY n)) INTO next_value
  FROM jsonb_array_elements(r.value->'commands') WITH ORDINALITY x(e,n);
  IF next_value IS DISTINCT FROM r.value THEN
   PERFORM public.upsert_settings_value_v1('ui_command_registry',r.scope_type,r.scope_id,next_value,r.schema_version,
    'Expose optional cash handover annotation and owned task photo');
  END IF;
 END LOOP;
 IF found_count=0 THEN RAISE EXCEPTION 'cash_evidence_command_missing'; END IF;
END;
$variant$;
CREATE OR REPLACE FUNCTION public.ui_get_financial_task_context_v1(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp AS $fn$
DECLARE
  t public.tasks%ROWTYPE;
  task_type public.task_types%ROWTYPE;
  batch jsonb;
  policy jsonb;
  task_policy jsonb;
  required_type text;
  require_branch boolean := false;
  required_statuses jsonb := '["completed"]'::jsonb;
  requires_session boolean := false;
  required_branch_id uuid;
  sessions jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF NOT public.is_platform_user() AND public.current_user_scope_type() IS DISTINCT FROM 'tenant' THEN
    RAISE EXCEPTION 'transition_task_v1 requires tenant/platform write scope' USING ERRCODE='42501';
  END IF;
  IF public.ui_get_resource_v1('tasks',p_task_id) IS NULL THEN
    RAISE EXCEPTION 'Task not visible' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT t FROM public.tasks WHERE id=p_task_id;
  IF NOT public.user_has_permission_v1('tasks.complete',t.organization_id) THEN
    RAISE EXCEPTION 'Financial task action denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT task_type FROM public.task_types WHERE id=t.task_type_id;
  IF t.resource_type IS DISTINCT FROM 'settlement_batch' OR t.resource_id IS NULL
    OR task_type.metadata->'completion_amount_contract' IS DISTINCT FROM
      '{"version":1,"field":"amount","minimum":0}'::jsonb THEN RETURN NULL; END IF;
  -- Registry scope plus canonical settlement authorization: definer reads must
  -- not assume table RLS will run under their owner role.
  IF NOT public.can_read_settlement_batch_v1(t.organization_id,t.resource_id) THEN
    RAISE EXCEPTION 'Settlement not visible' USING ERRCODE='42501';
  END IF;
  batch:=public.ui_get_resource_v1('settlements',t.resource_id);
  IF batch IS NULL THEN RAISE EXCEPTION 'Settlement not visible' USING ERRCODE='42501'; END IF;
  SELECT b.branch_id INTO required_branch_id FROM public.settlement_batches b
    WHERE b.id=t.resource_id AND b.organization_id=t.organization_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT r.value INTO policy FROM public.resolve_settings_row_from_policy_context_v1(
    'task_ops_session_policy',jsonb_strip_nulls(jsonb_build_object(
      'organization_id',t.organization_id,'client_id',t.client_id,
      'sender_id',t.sender_id,'resource_id',required_branch_id))) r LIMIT 1;
  policy:=COALESCE(policy,'{}'::jsonb);
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object' THEN policy:='{}'::jsonb; END IF;
  task_policy:=COALESCE(policy#>ARRAY['task_type_map',task_type.key],'{}'::jsonb);
  IF jsonb_typeof(task_policy) IS DISTINCT FROM 'object' THEN task_policy:='{}'::jsonb; END IF;
  required_statuses:=COALESCE(policy#>'{defaults,required_on_statuses}',required_statuses);
  BEGIN require_branch:=COALESCE((policy#>>'{defaults,require_branch_match}')::boolean,require_branch);
  EXCEPTION WHEN others THEN require_branch:=require_branch; END;
  required_type:=NULLIF(btrim(COALESCE(task_policy->>'required_session_type','')),'');
  required_statuses:=COALESCE(task_policy->'required_on_statuses',required_statuses);
  BEGIN require_branch:=COALESCE((task_policy->>'require_branch_match')::boolean,require_branch);
  EXCEPTION WHEN others THEN require_branch:=require_branch; END;
  requires_session:=required_type IS NOT NULL AND COALESCE(
    jsonb_typeof(required_statuses)='array' AND 'completed' IN (SELECT jsonb_array_elements_text(required_statuses)),false);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',s.id,'session_type',s.session_type,'branch_id',s.branch_id,'opened_at',s.opened_at)
    ORDER BY s.opened_at,s.id),'[]'::jsonb) INTO sessions
  FROM public.ops_sessions s
  WHERE requires_session AND s.organization_id=t.organization_id AND s.actor_user_id=auth.uid()
    AND lower(COALESCE(s.session_type,''))=required_type AND s.closed_at IS NULL
    AND (NOT require_branch OR required_branch_id IS NULL OR s.branch_id=required_branch_id);
  RETURN jsonb_build_object('version',1,'actor_id',auth.uid(),'task_id',t.id,
    'organization_id',t.organization_id,'task_type_key',task_type.key,
    'settlement_id',t.resource_id,'task_status',t.status,
    'amount_contract',task_type.metadata->'completion_amount_contract',
    'evidence_contract',task_type.metadata->'completion_evidence_contract',
    'requires_session',requires_session,'required_session_type',required_type,'sessions',sessions);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.ui_get_financial_task_readback_v1(p_task_id uuid,p_task_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp AS $fn$
DECLARE
  t public.tasks%ROWTYPE;
  e public.task_events%ROWTYPE;
  s public.ops_sessions%ROWTYPE;
  batch jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF public.ui_get_resource_v1('tasks',p_task_id) IS NULL THEN
    RAISE EXCEPTION 'Task not visible' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT t FROM public.tasks WHERE id=p_task_id;
  IF t.resource_type IS DISTINCT FROM 'settlement_batch' OR t.resource_id IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.task_types tt WHERE tt.id=t.task_type_id
    AND tt.metadata->'completion_amount_contract'='{"version":1,"field":"amount","minimum":0}'::jsonb) THEN RETURN NULL; END IF;
  IF NOT public.can_read_settlement_batch_v1(t.organization_id,t.resource_id) THEN
    RAISE EXCEPTION 'Settlement not visible' USING ERRCODE='42501';
  END IF;
  batch:=public.ui_get_resource_v1('settlements',t.resource_id);
  IF batch IS NULL THEN RAISE EXCEPTION 'Settlement not visible' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.settlement_batches b
    WHERE b.id=t.resource_id AND b.organization_id=t.organization_id) THEN RETURN NULL; END IF;
  SELECT * INTO e FROM public.task_events WHERE id=p_task_event_id AND task_id=t.id
    AND organization_id=t.organization_id AND actor_user_id=auth.uid()
    AND event_type='status_changed' AND to_status='completed';
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM public.assert_task_completion_amount_v1(e.payload);
  IF e.ops_session_id IS NOT NULL THEN
    SELECT * INTO s FROM public.ops_sessions WHERE id=e.ops_session_id
      AND organization_id=e.organization_id AND actor_user_id=e.actor_user_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  -- Historical accepted session can now be closed; never require it to stay open.
  RETURN jsonb_build_object('version',1,'task_id',t.id,'task_event_id',e.id,
    'actor_id',e.actor_user_id,'organization_id',e.organization_id,
    'task_status',t.status,'event_status',e.to_status,'amount',e.payload->'amount',
    'ops_session_id',s.id,'session_type',s.session_type,'settlement_id',t.resource_id,
    'settlement_status',batch->'status') || CASE WHEN
      e.payload->'cash_handover_evidence_version'='1'::jsonb AND EXISTS(
      SELECT 1 FROM public.task_types tt WHERE tt.id=t.task_type_id AND
      tt.metadata->'completion_evidence_contract'=
      '{"version":1,"supervisor_name":"optional_annotation","photo_artifact_id":"optional_owned_task_photo"}'::jsonb)
    THEN jsonb_strip_nulls(jsonb_build_object('supervisor_name',e.payload->'supervisor_name',
      'photo_artifact_id',e.payload->'photo_artifact_id')) ELSE '{}'::jsonb END;
END;
$fn$;

COMMIT;
