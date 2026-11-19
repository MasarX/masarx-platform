-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: COD driver shift settlement workflow v2 (variance gate + optional manager task + finance transfer)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(229);

-- Insert before the existing main fixture function in
-- supabase/tests/pgtap/0zz_cod_settlement_driver_shift_workflow_v2.sql.
-- Native contract proof only: fixture Storage rows are not browser-upload proof.
CREATE TEMP TABLE cash_evidence_fixture(photo_id uuid) ON COMMIT DROP;
GRANT SELECT,INSERT ON cash_evidence_fixture TO authenticated;
CREATE FUNCTION pg_temp.check_cash_evidence(p_task uuid,p_session uuid,p_org uuid,p_actor uuid,p_other uuid)
RETURNS SETOF text LANGUAGE plpgsql AS $test$
DECLARE
 photo uuid:=gen_random_uuid(); absent_photo uuid:=gen_random_uuid();
 foreign_photo uuid:=gen_random_uuid(); wrong_task_photo uuid:=gen_random_uuid();
 non_image uuid:=gen_random_uuid();
 prefix text:=p_org::text||'/'||p_task::text||'/';
 bad_payload jsonb; before_events jsonb; before_settlement jsonb; result text; case_number integer:=0;
 expected_errors text[]:=ARRAY['42501:cash_handover_photo_forbidden','42501:self_kyc_evidence_forbidden',
  '42501:self_kyc_evidence_forbidden','42501:cash_handover_photo_forbidden','23514:cash_handover_photo_invalid',
  '23514:cash_handover_photo_invalid','23514:cash_handover_supervisor_invalid','23514:cash_handover_supervisor_invalid',
  '23514:cash_handover_evidence_marker_reserved','23514:cash_handover_supervisor_invalid',
  '23514:cash_handover_evidence_marker_reserved'];
BEGIN
 EXECUTE 'SET LOCAL ROLE postgres';
 INSERT INTO storage.objects(bucket_id,name,owner,metadata) VALUES
  ('fieldops-evidence',prefix||photo::text||'.jpg',p_actor,'{"mimetype":"image/jpeg"}'),
  ('fieldops-evidence',prefix||foreign_photo::text||'.jpg',p_other,'{"mimetype":"image/jpeg"}'),
  ('fieldops-evidence',p_org::text||'/'||gen_random_uuid()::text||'/'||wrong_task_photo::text||'.jpg',p_actor,'{"mimetype":"image/jpeg"}'),
  ('fieldops-evidence',prefix||non_image::text||'.txt',p_actor,'{"mimetype":"text/plain"}');
 INSERT INTO public.artifacts(id,organization_id,storage_bucket,storage_key,created_by_user_id)
 SELECT CASE WHEN o.name=prefix||photo::text||'.jpg' THEN photo
  WHEN o.name=prefix||foreign_photo::text||'.jpg' THEN foreign_photo
  WHEN o.name=prefix||non_image::text||'.txt' THEN non_image ELSE wrong_task_photo END,
  p_org,o.bucket_id,o.name,p_actor
 FROM storage.objects o WHERE o.bucket_id='fieldops-evidence' AND
  (o.name IN(prefix||foreign_photo::text||'.jpg',prefix||non_image::text||'.txt')
   OR o.name LIKE p_org::text||'/%/'||wrong_task_photo::text||'.jpg');
 INSERT INTO public.artifacts(id,organization_id,storage_bucket,storage_key,created_by_user_id)
 VALUES(absent_photo,p_org,'fieldops-evidence',prefix||absent_photo::text||'.jpg',p_actor);
 SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) INTO before_events FROM public.task_events e WHERE e.task_id=p_task;
 SELECT to_jsonb(b) INTO before_settlement FROM public.settlement_batches b
 JOIN public.tasks t ON t.resource_id=b.id WHERE t.id=p_task;
 EXECUTE 'SET LOCAL ROLE authenticated';
 SELECT artifact_id INTO photo FROM public.register_mobile_artifact_v1(jsonb_build_object(
  'organization_id',p_org,'storage_bucket','fieldops-evidence','storage_key',prefix||photo::text||'.jpg',
  'mime_type','image/jpeg','metadata',jsonb_build_object('task_id',p_task,'artifact_kind','photo')));
 INSERT INTO cash_evidence_fixture VALUES(photo);
 FOR bad_payload IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
  jsonb_build_object('photo_artifact_id',gen_random_uuid()),
  jsonb_build_object('photo_artifact_id',absent_photo),
  jsonb_build_object('photo_artifact_id',foreign_photo),
  jsonb_build_object('photo_artifact_id',wrong_task_photo),
  jsonb_build_object('photo_artifact_id',non_image),
  '{"photo_artifact_id":null}'::jsonb,'{"supervisor_name":42}'::jsonb,'{"supervisor_name":" "}'::jsonb,
  '{"cash_handover_evidence_version":1}'::jsonb,'{"supervisor_name":null}'::jsonb,
  '{"cash_handover_evidence_version":null}'::jsonb))
 LOOP
  -- Each rejected transition runs through the actual canonical task event trigger.
  BEGIN
   PERFORM public.transition_task_v1(p_task,'completed','evidence rejection probe',
    jsonb_build_object('amount',80,'ops_session_id',p_session)||bad_payload,gen_random_uuid()::text);
   result:='accepted';
  EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '23514' THEN result:=SQLSTATE||':'||SQLERRM; END;
  case_number:=case_number+1;
  RETURN NEXT is(result,expected_errors[case_number],'cash evidence rejects invalid supplied input '||bad_payload::text);
 END LOOP;
 EXECUTE 'SET LOCAL ROLE postgres';
 RETURN NEXT is((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.task_events e WHERE e.task_id=p_task),
  before_events,'rejected evidence leaves task events unchanged');
 RETURN NEXT is((SELECT to_jsonb(b) FROM public.settlement_batches b JOIN public.tasks t ON t.resource_id=b.id WHERE t.id=p_task),
  before_settlement,'rejected evidence leaves settlement unchanged');
 EXECUTE 'SET LOCAL ROLE authenticated';
END;
$test$;


CREATE FUNCTION pg_temp.cod_visibility_contract(p_org uuid,p_branch uuid,p_driver uuid,p_other uuid)
RETURNS SETOF text LANGUAGE plpgsql AS $test$
DECLARE
 b_user uuid; b_driver uuid; b_billing uuid; b_day uuid; b_other uuid;
BEGIN
 -- Caller is the existing fixture service principal; all batches use canonical creation.
 SELECT settlement_batch_id INTO STRICT b_user FROM public.create_settlement_batch_v1(jsonb_build_object(
 'organization_id',p_org,'branch_id',p_branch,'kind','cod','scope_type','driver_shift',
 'subject_type','user','subject_id',p_driver,'actor_system','pgtap_visibility','idempotency_key','visibility-user'));
 SELECT settlement_batch_id INTO STRICT b_driver FROM public.create_settlement_batch_v1(jsonb_build_object(
 'organization_id',p_org,'branch_id',p_branch,'kind','cod','scope_type','driver_shift',
 'subject_type','driver','subject_id',p_driver,'actor_system','pgtap_visibility','idempotency_key','visibility-driver'));
 SELECT settlement_batch_id INTO STRICT b_billing FROM public.create_settlement_batch_v1(jsonb_build_object(
 'organization_id',p_org,'branch_id',p_branch,'kind','billing','scope_type','driver_shift',
 'subject_type','user','subject_id',p_driver,'actor_system','pgtap_visibility','idempotency_key','visibility-billing'));
 SELECT settlement_batch_id INTO STRICT b_day FROM public.create_settlement_batch_v1(jsonb_build_object(
 'organization_id',p_org,'branch_id',p_branch,'kind','cod','scope_type','branch_day',
 'subject_type','user','subject_id',p_driver,'actor_system','pgtap_visibility','idempotency_key','visibility-day'));
 SELECT settlement_batch_id INTO STRICT b_other FROM public.create_settlement_batch_v1(jsonb_build_object(
 'organization_id',p_org,'branch_id',p_branch,'kind','cod','scope_type','driver_shift',
 'subject_type','user','subject_id',p_other,'actor_system','pgtap_visibility','idempotency_key','visibility-other'));
 PERFORM set_config('request.jwt.claim.sub',p_driver::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',p_driver)::text,true);
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT ok(public.user_has_permission_v1('tasks.read',p_org) AND NOT public.user_has_permission_v1('finance.read',p_org)
   AND NOT public.is_platform_user(),'visibility actor exercises self branch, not finance/platform bypass');
 RETURN NEXT ok(public.can_read_settlement_batch_v1(p_org,b_user),'persisted COD driver-shift user subject is visible');
 RETURN NEXT ok(public.can_read_settlement_batch_v1(p_org,b_driver),'persisted driver subject remains visible');
 RETURN NEXT ok(NOT public.can_read_settlement_batch_v1(p_org,b_other),'different persisted actor is denied');
 RETURN NEXT ok(NOT public.can_read_settlement_batch_v1(gen_random_uuid(),b_user),'wrong organization is denied');
 RETURN NEXT ok(NOT public.can_read_settlement_batch_v1(p_org,b_billing),'billing user subject does not gain COD self visibility');
 RETURN NEXT ok(NOT public.can_read_settlement_batch_v1(p_org,b_day),'non-driver-shift user subject does not gain self visibility');
 RETURN NEXT ok(NOT public.can_read_settlement_batch_v1(p_org,b_other,'driver',p_driver),'forged driver arguments cannot override persisted actor');
 RETURN NEXT ok(NOT public.can_read_settlement_batch_v1(p_org,b_other,'user',p_driver),'forged user arguments cannot override persisted actor');
 EXECUTE 'SET LOCAL ROLE service_role';
 PERFORM set_config('request.jwt.claim.sub','',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
END;
$test$;



CREATE OR REPLACE FUNCTION pg_temp.check_cod_catalog_seed(p_org uuid)
RETURNS SETOF text LANGUAGE plpgsql AS $probe$
DECLARE seed_sql text := $seed$DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM public.task_types
    WHERE key IN ('cod_cash_handover','cod_cashier_count')
    AND ((metadata IS NOT NULL AND jsonb_typeof(metadata) <> 'object')
      OR (metadata ? 'completion_amount_contract' AND metadata->'completion_amount_contract'
        IS DISTINCT FROM '{"version":1,"field":"amount","minimum":0}'::jsonb))) THEN
    RAISE EXCEPTION 'existing_completion_amount_contract_conflict';
  END IF;
END;
$check$;
UPDATE public.task_types
SET metadata=COALESCE(metadata,'{}'::jsonb)||
  '{"completion_amount_contract":{"version":1,"field":"amount","minimum":0}}'::jsonb
WHERE key IN ('cod_cash_handover','cod_cashier_count');

-- Preserve unrelated catalog entries and metadata; ensure future organizations inherit it.
DO $do$
DECLARE r record; v_next jsonb;
BEGIN
  FOR r IN SELECT s.id settings_id,s.settings_version_id,sv.value,sv.version
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category='task_type_catalog'
  LOOP
    IF jsonb_typeof(r.value->'task_types') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'task_type_catalog_items_invalid';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(r.value->'task_types') x(entry)
      WHERE lower(btrim(entry->>'key')) IN ('cod_cash_handover','cod_cashier_count')
      AND ((entry ? 'metadata' AND jsonb_typeof(entry->'metadata') <> 'object')
        OR (entry->'metadata' ? 'completion_amount_contract' AND entry#>'{metadata,completion_amount_contract}'
          IS DISTINCT FROM '{"version":1,"field":"amount","minimum":0}'::jsonb))) THEN
      RAISE EXCEPTION 'catalog_completion_amount_contract_conflict';
    END IF;
    SELECT jsonb_set(r.value,'{task_types}',COALESCE(jsonb_agg(
      CASE WHEN lower(btrim(entry->>'key')) IN ('cod_cash_handover','cod_cashier_count') THEN
        jsonb_set(entry,'{metadata}',COALESCE(entry->'metadata','{}'::jsonb)||
          '{"completion_amount_contract":{"version":1,"field":"amount","minimum":0}}'::jsonb)
      ELSE entry END ORDER BY ordinal),'[]'::jsonb)) INTO v_next
    FROM jsonb_array_elements(r.value->'task_types') WITH ORDINALITY x(entry,ordinal);
    IF v_next IS DISTINCT FROM r.value THEN
      UPDATE public.settings_versions SET value=v_next,version=r.version+1,
        change_reason='Validate configured COD task completion amounts',approved_at=now(),effective_from=now()
      WHERE id=r.settings_version_id;
      UPDATE public.settings SET cached_value=v_next,last_updated=now() WHERE id=r.settings_id;
    END IF;
  END LOOP;
END;
$do$;
$seed$;
  before_unrelated jsonb; after_unrelated jsonb; before_conflict jsonb; id_a uuid; id_b uuid;
BEGIN
  BEGIN
    SELECT jsonb_agg(jsonb_build_array(s.id,sv.value-'task_types',
      (SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(sv.value->'task_types') WITH ORDINALITY a(e,n)
       WHERE lower(btrim(e->>'key')) NOT IN ('cod_cash_handover','cod_cashier_count'))) ORDER BY s.id)
      INTO before_unrelated FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
      WHERE s.category='task_type_catalog';
    UPDATE public.settings_versions sv SET value=jsonb_set(sv.value,'{task_types}',
      (SELECT jsonb_agg(CASE WHEN lower(btrim(e->>'key')) IN ('cod_cash_handover','cod_cashier_count') THEN
        jsonb_set(jsonb_set(e,'{key}',to_jsonb(' '||upper(e->>'key')||' ')),
          '{metadata}',COALESCE(e->'metadata','{}'::jsonb)-'completion_amount_contract') ELSE e END ORDER BY n)
       FROM jsonb_array_elements(sv.value->'task_types') WITH ORDINALITY a(e,n)))
      WHERE sv.id IN (SELECT settings_version_id FROM public.settings WHERE category='task_type_catalog');
    EXECUTE seed_sql;
    id_a := public.ensure_task_type_from_catalog_v1(p_org,'cod_cash_handover');
    id_b := public.ensure_task_type_from_catalog_v1(p_org,'cod_cashier_count');
    RETURN NEXT is((SELECT metadata->'completion_amount_contract' FROM public.task_types WHERE id=id_a),
      '{"version":1,"field":"amount","minimum":0}'::jsonb,'padded uppercase handover catalog materializes guarded type');
    RETURN NEXT is((SELECT metadata->'completion_amount_contract' FROM public.task_types WHERE id=id_b),
      '{"version":1,"field":"amount","minimum":0}'::jsonb,'padded uppercase cashier catalog materializes guarded type');
    SELECT jsonb_agg(jsonb_build_array(s.id,sv.value-'task_types',
      (SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(sv.value->'task_types') WITH ORDINALITY a(e,n)
       WHERE lower(btrim(e->>'key')) NOT IN ('cod_cash_handover','cod_cashier_count'))) ORDER BY s.id)
      INTO after_unrelated FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
      WHERE s.category='task_type_catalog';
    RETURN NEXT is(after_unrelated,before_unrelated,'all existing catalog scopes preserve unrelated entries and top-level fields');
    RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
      WHERE s.category='task_type_catalog' AND s.cached_value IS DISTINCT FROM sv.value),'catalog caches agree after seed');
    UPDATE public.settings_versions sv SET value=jsonb_set(sv.value,'{task_types}',
      (SELECT jsonb_agg(CASE WHEN lower(btrim(e->>'key'))='cod_cash_handover' THEN
        jsonb_set(e,'{metadata,completion_amount_contract}','{"version":99}'::jsonb) ELSE e END ORDER BY n)
       FROM jsonb_array_elements(sv.value->'task_types') WITH ORDINALITY a(e,n)))
      WHERE sv.id IN (SELECT settings_version_id FROM public.settings WHERE category='task_type_catalog');
    SELECT jsonb_agg(to_jsonb(sv) ORDER BY sv.id) INTO before_conflict FROM public.settings_versions sv;
    RETURN NEXT throws_ok(seed_sql,'P0001','catalog_completion_amount_contract_conflict','conflicting scoped catalog rejects whole seed');
    RETURN NEXT is((SELECT jsonb_agg(to_jsonb(sv) ORDER BY sv.id) FROM public.settings_versions sv),
      before_conflict,'conflicting seed leaves every settings version unchanged');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback seed probes';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;
  END;
END;
$probe$;
-- Eleven direct-reader cases per existing genuine workflow completion; rollback-owned probes only.
CREATE FUNCTION pg_temp.check_financial_reads(p_task uuid,p_event uuid,p_session uuid,p_actor uuid,p_other uuid)
RETURNS SETOF text LANGUAGE plpgsql AS $probe$
DECLARE original_sub text:=current_setting('request.jwt.claim.sub',true);
  original_claims text:=current_setting('request.jwt.claims',true);
  session_row public.ops_sessions%ROWTYPE; task_row public.tasks%ROWTYPE;
  other_type text; foreign_org uuid:=gen_random_uuid(); foreign_actor uuid:=gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT * INTO STRICT session_row FROM public.ops_sessions WHERE id=p_session;
  SELECT * INTO STRICT task_row FROM public.tasks WHERE id=p_task;
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(api.ui_get_financial_task_readback_v1(p_task,p_event) IS NOT NULL,'read-probe genuine event prerequisite');
  BEGIN
    EXECUTE 'SET LOCAL ROLE postgres';
    UPDATE public.ops_sessions SET actor_user_id=p_other WHERE id=p_session;
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(api.ui_get_financial_task_context_v1(p_task)->'sessions') s WHERE s->>'id'=p_session::text),'other actor session excluded by context');
    RETURN NEXT ok(api.ui_get_financial_task_readback_v1(p_task,p_event) IS NULL,'event with wrong session actor cannot verify');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='restore session actor';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL; END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE postgres';
    UPDATE public.ops_sessions SET closed_at=GREATEST(now(),opened_at) WHERE id=p_session;
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(api.ui_get_financial_task_context_v1(p_task)->'sessions') s WHERE s->>'id'=p_session::text),'closed session excluded from new action');
    RETURN NEXT ok(api.ui_get_financial_task_readback_v1(p_task,p_event) IS NOT NULL,'historical accepted event survives later session closure');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='restore session closure';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL; END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE postgres';
    SELECT lv.value INTO STRICT other_type FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id=lv.lookup_definition_id
      WHERE ld.category='ops_session_type' AND lv.value<>session_row.session_type ORDER BY lv.value LIMIT 1;
    UPDATE public.ops_sessions SET session_type=other_type WHERE id=p_session;
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(api.ui_get_financial_task_context_v1(p_task)->'sessions') s WHERE s->>'id'=p_session::text),'wrong session type excluded by context');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='restore session type';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL; END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE postgres';
    UPDATE public.tasks SET resource_id=gen_random_uuid() WHERE id=p_task;
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT throws_ok(format('SELECT api.ui_get_financial_task_readback_v1(%L::uuid,%L::uuid)',p_task,p_event),'42501',NULL,'unknown settlement cannot supply financial readback');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='restore task target';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL; END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE postgres';
    INSERT INTO public.organizations(id,name,slug) VALUES(foreign_org,'Financial read probe','financial-read-'||foreign_org);
    INSERT INTO public.users(id,organization_id,email,full_name,access_scope_type)
      VALUES(foreign_actor,foreign_org,foreign_actor||'@example.com','Financial read probe','tenant');
    PERFORM public.provision_rbac_roles_from_templates_v1(foreign_org,ARRAY['driver'],foreign_actor);
    INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
      SELECT foreign_org,foreign_actor,id,foreign_actor,'{}'::jsonb FROM public.rbac_roles
      WHERE organization_id=foreign_org AND key='driver' ON CONFLICT DO NOTHING;
    PERFORM set_config('request.jwt.claim.sub',foreign_actor::text,true);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',foreign_actor)::text,true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT ok(public.user_has_permission_v1('tasks.read',foreign_org),'foreign reader has real task-read capability');
    RETURN NEXT throws_ok(format('SELECT api.ui_get_financial_task_context_v1(%L::uuid)',p_task),'42501',NULL,'foreign actor cannot obtain completion context');
    RETURN NEXT throws_ok(format('SELECT api.ui_get_financial_task_readback_v1(%L::uuid,%L::uuid)',p_task,p_event),'42501',NULL,'foreign actor cannot obtain financial readback');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='restore foreign actor';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL; END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE postgres';
    UPDATE public.users SET access_scope_type='client',access_scope_id=(SELECT id FROM public.clients WHERE organization_id=task_row.organization_id LIMIT 1) WHERE id=p_actor;
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT throws_ok(format('SELECT api.ui_get_financial_task_context_v1(%L::uuid)',p_task),'42501','transition_task_v1 requires tenant/platform write scope','client read scope is not financial write eligibility');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='restore scope';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL; END;
  PERFORM set_config('request.jwt.claim.sub',COALESCE(original_sub,''),true);
  PERFORM set_config('request.jwt.claims',COALESCE(original_claims,'{}'),true);
END;
$probe$;

-- Nine executed context/writer/readback assertions per real task, with rollback-only policy corruption.
CREATE FUNCTION pg_temp.check_financial_policy_matrix(p_task uuid,p_session uuid)
RETURNS SETOF text LANGUAGE plpgsql AS $matrix$
DECLARE t public.tasks%ROWTYPE; winner record; kind text; session_kind text; branch uuid;
  base_policy jsonb; policy jsonb; case_name text; context jsonb; payload jsonb; accepted_event uuid; readback jsonb;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT * INTO STRICT t FROM public.tasks WHERE id=p_task;
  SELECT key INTO STRICT kind FROM public.task_types WHERE id=t.task_type_id;
  SELECT session_type INTO STRICT session_kind FROM public.ops_sessions WHERE id=p_session;
  SELECT branch_id INTO branch FROM public.settlement_batches WHERE id=t.resource_id;
  SELECT * INTO STRICT winner FROM public.resolve_settings_row_from_policy_context_v1('task_ops_session_policy',
    jsonb_strip_nulls(jsonb_build_object('organization_id',t.organization_id,'client_id',t.client_id,'sender_id',t.sender_id,'resource_id',branch)));
  base_policy:=winner.value;
  EXECUTE 'SET LOCAL ROLE authenticated';
  FOREACH case_name IN ARRAY ARRAY['absent_defaults','malformed_boolean','optional_statuses','uppercase_type'] LOOP
    BEGIN
      policy:=jsonb_set(base_policy-'defaults','{task_type_map}',jsonb_build_object(kind,jsonb_build_object('required_session_type',session_kind)));
      IF case_name='malformed_boolean' THEN
        policy:=jsonb_set(policy,'{defaults}','{"require_branch_match":"not-a-boolean"}'::jsonb);
        policy:=jsonb_set(policy,ARRAY['task_type_map',kind,'require_branch_match'],'"not-a-boolean"'::jsonb);
      ELSIF case_name='optional_statuses' THEN
        policy:=jsonb_set(policy,ARRAY['task_type_map',kind,'required_on_statuses'],'[]'::jsonb);
      ELSIF case_name='uppercase_type' THEN
        policy:=jsonb_set(policy,ARRAY['task_type_map',kind,'required_session_type'],to_jsonb(upper(session_kind)));
      END IF;
      EXECUTE 'SET LOCAL ROLE postgres';
      UPDATE public.settings_versions SET value=policy WHERE id=winner.settings_version_id;
      UPDATE public.settings SET cached_value=policy WHERE id=winner.settings_id;
      -- Branch mismatch is allowed when the writer's default/tolerant boolean resolves false.
      IF case_name IN ('absent_defaults','malformed_boolean') THEN
        UPDATE public.ops_sessions SET branch_id=NULL WHERE id=p_session;
      END IF;
      EXECUTE 'SET LOCAL ROLE authenticated';
      context:=api.ui_get_financial_task_context_v1(p_task);
      IF case_name='optional_statuses' THEN
        RETURN NEXT is(context->'requires_session','false'::jsonb,'optional statuses do not invent mandatory session');
        payload:='{"amount":0}'::jsonb;
      ELSIF case_name='uppercase_type' THEN
        RETURN NEXT ok(context->>'required_session_type'=upper(session_kind) AND context->'sessions'='[]'::jsonb,'uppercase required type is not normalized into eligibility');
        payload:=jsonb_build_object('amount',0,'ops_session_id',p_session);
      ELSE
        RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(context->'sessions') s WHERE s->>'id'=p_session::text),case_name||' retains writer branch-default eligibility');
        payload:=jsonb_build_object('amount',0,'ops_session_id',p_session);
      END IF;
      IF case_name='uppercase_type' THEN
        RETURN NEXT throws_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,''completed'',NULL,%L::jsonb,%L)',p_task,payload,'financial-policy-'||case_name||p_task),
          '23514',format('transition_task_v1 ops_session type mismatch (required %s, got %s)',upper(session_kind),session_kind),'writer rejects the same uppercase required type');
      ELSIF case_name='optional_statuses' THEN
        SELECT task_event_id INTO accepted_event FROM public.transition_task_v1(p_task,'completed',NULL,payload,'financial-policy-'||case_name||p_task);
        RETURN NEXT ok(accepted_event IS NOT NULL,'optional statuses real writer returns accepted event');
        readback:=api.ui_get_financial_task_readback_v1(p_task,accepted_event);
        RETURN NEXT is(jsonb_build_object('amount',readback->'amount','session',readback->'ops_session_id','settlement',readback->'settlement_id'),
          jsonb_build_object('amount',0,'session',NULL,'settlement',t.resource_id),'optional accepted event readback preserves zero amount, null session and batch');
      ELSE
        RETURN NEXT lives_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,''completed'',NULL,%L::jsonb,%L)',p_task,payload,'financial-policy-'||case_name||p_task),case_name||' matches real writer acceptance');
      END IF;
      RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback policy matrix case';
    EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL; END;
  END LOOP;
END;
$matrix$;

-- Runs inside the existing COD fixture, before each real completion.
CREATE OR REPLACE FUNCTION pg_temp.check_cod_amount_boundary(p_task uuid,p_session uuid,p_org uuid,p_actor uuid,p_other_actor uuid)
RETURNS SETOF text LANGUAGE plpgsql AS $f$
DECLARE bad jsonb; old_status text; old_count bigint; e uuid; good boolean:=false;
  wrong_session uuid; foreign_org uuid:=gen_random_uuid(); foreign_user uuid:=gen_random_uuid();
  other_branch uuid:=gen_random_uuid(); original_branch uuid;
BEGIN
  SELECT status INTO old_status FROM public.tasks WHERE id=p_task;
  SELECT count(*) INTO old_count FROM public.task_events WHERE task_id=p_task;
  FOREACH bad IN ARRAY ARRAY['{}','{"amount":null}','{"amount":-1}','{"amount":"1"}',
    '{"amount":"NaN"}','{"amount":"Infinity"}','{"amount":true}']::jsonb[] LOOP
    RETURN NEXT throws_ok(format(
      'SELECT * FROM public.transition_task_v1(%L::uuid,''completed'',NULL,%L::jsonb,%L)',
      p_task,bad||jsonb_build_object('ops_session_id',p_session),'invalid-'||md5(bad::text)),
      '23514','task_completion_amount_required_nonnegative_number','transition rejects malformed amount '||bad::text);
  END LOOP;
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id=p_task),old_status,'invalid amounts preserve task state');
  RETURN NEXT is((SELECT count(*) FROM public.task_events WHERE task_id=p_task),old_count,'invalid amounts preserve event count');

  -- Same actor but opposite session type must fail canonical session policy.
  SELECT ops_session_id INTO wrong_session FROM public.open_ops_session_v1(jsonb_build_object(
    'session_type',(SELECT CASE session_type WHEN 'driver_shift' THEN 'branch_cash_drawer' ELSE 'driver_shift' END FROM public.ops_sessions WHERE id=p_session),
    'branch_id',(SELECT branch_id FROM public.ops_sessions WHERE id=p_session),
    'idempotency_key','wrong-type-'||p_task));
  RETURN NEXT throws_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,''completed'',NULL,%L::jsonb,%L)',
    p_task,jsonb_build_object('amount',1,'ops_session_id',wrong_session),'wrong-session-'||p_task),
    '23514',NULL,'wrong session type refused');

  PERFORM set_config('request.jwt.claim.sub',p_other_actor::text,true);
  RETURN NEXT is(auth.uid(),p_other_actor,'effective actor changed for ownership denial');
  RETURN NEXT ok(public.user_has_permission_v1('tasks.complete',p_org),'other actor has permission so denial reaches session owner');
  RETURN NEXT throws_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,''completed'',NULL,%L::jsonb,%L)',
    p_task,jsonb_build_object('amount',1,'ops_session_id',p_session),'wrong-actor-'||p_task),
    '42501','transition_task_v1 ops_session actor mismatch','other actor cannot use original actor session');
  PERFORM set_config('request.jwt.claim.sub',p_actor::text,true);

  BEGIN
    EXECUTE 'SET LOCAL ROLE postgres';
    SELECT branch_id INTO original_branch FROM public.ops_sessions WHERE id=p_session;
    INSERT INTO public.branches(id,organization_id,code,name,is_active)
      VALUES(other_branch,p_org,'probe-'||left(other_branch::text,8),'Other COD branch',true);
    UPDATE public.ops_sessions SET branch_id=other_branch WHERE id=p_session;
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT throws_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,''completed'',NULL,%L::jsonb,%L)',
      p_task,jsonb_build_object('amount',1,'ops_session_id',p_session),'wrong-branch-'||p_task),
      '23514',format('transition_task_v1 ops_session branch mismatch (required %s, got %s)',original_branch,other_branch),
      'wrong branch session rejected');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback branch probe';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;
  END;

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations(id,name,slug) VALUES(foreign_org,'Foreign COD probe','cod-probe-'||foreign_org);
  INSERT INTO public.users(id,organization_id,email,full_name,access_scope_type)
    VALUES(foreign_user,foreign_org,foreign_user||'@example.com','Foreign COD probe','tenant');
  PERFORM set_config('request.jwt.claim.sub',foreign_user::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(auth.uid(),foreign_user,'effective foreign actor selected');
  RETURN NEXT is(public.current_user_org_id(),foreign_org,'effective foreign tenant selected');
  RETURN NEXT throws_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,''completed'',NULL,%L::jsonb,%L)',
    p_task,jsonb_build_object('amount',1,'ops_session_id',p_session),'foreign-org-'||p_task),
    '42501',format('transition_task_v1 task %s is outside current tenant scope',p_task),'cross-org actor cannot complete task');
  PERFORM set_config('request.jwt.claim.sub',p_actor::text,true);

  BEGIN
    EXECUTE 'SET LOCAL ROLE postgres';
    UPDATE public.ops_sessions SET closed_at=now() WHERE id=p_session;
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT throws_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,''completed'',NULL,%L::jsonb,%L)',
      p_task,jsonb_build_object('amount',1,'ops_session_id',p_session),'final-session-'||p_task),
      '23514','transition_task_v1 ops_session is final','final session rejected');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback final session probe';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;
  END;

  BEGIN
    EXECUTE 'SET LOCAL ROLE postgres';
    UPDATE public.task_types SET metadata=jsonb_set(metadata,'{completion_amount_contract}','null'::jsonb)
      WHERE id=(SELECT task_type_id FROM public.tasks WHERE id=p_task);
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT throws_ok(format('SELECT * FROM public.transition_task_v1(%L::uuid,''completed'',NULL,%L::jsonb,%L)',
      p_task,jsonb_build_object('amount',1,'ops_session_id',p_session),'bad-contract-'||p_task),
      '23514','task_completion_amount_contract_invalid','malformed configured contract rejected');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback malformed contract probe';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;
  END;

  BEGIN
    SELECT task_event_id INTO e FROM public.transition_task_v1(p_task,'completed',NULL,
      jsonb_build_object('amount',10.123456,'ops_session_id',p_session),'decimal-'||p_task);
    good := (SELECT payload->'amount'='10.123456'::jsonb FROM public.task_events WHERE id=e);
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback decimal probe';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;
  END;
  RETURN NEXT ok(good,'actual transition preserves decimal without rounding');

  -- Successful zero event is inspected, then rolled back so the original workflow fixture continues unchanged.
  BEGIN
    SELECT task_event_id INTO e FROM public.transition_task_v1(p_task,'completed',NULL,
      jsonb_build_object('amount',0,'ops_session_id',p_session),'zero-'||p_task);
    SELECT payload->'amount'='0'::jsonb INTO good FROM public.task_events WHERE id=e;
    EXECUTE 'SET LOCAL ROLE postgres';
    RETURN NEXT throws_ok(format('UPDATE public.task_events SET payload=''{}''::jsonb WHERE id=%L',e),
      '23514','task_completion_amount_required_nonnegative_number','direct update cannot remove amount');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback zero probe';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;
  END;
  RETURN NEXT ok(good,'zero persisted through actual transition before rollback');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT throws_ok(format('INSERT INTO public.task_events(task_id,organization_id,event_type,to_status,actor_user_id,payload,task_version) VALUES(%L,%L,''status_changed'',''completed'',%L,''{}'',999999)',
    p_task,p_org,p_actor),'23514','task_completion_amount_required_nonnegative_number','direct write cannot bypass configured guard');
  BEGIN
    RETURN NEXT lives_ok(format('INSERT INTO public.task_events(task_id,organization_id,event_type,to_status,actor_user_id,payload,task_version) VALUES(%L,%L,''status_changed'',''in_progress'',%L,''{}'',999998)',
      p_task,p_org,p_actor),'non-completion event remains compatible');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback compatibility probe';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;
  END;
  EXECUTE 'SET LOCAL ROLE authenticated';
END;
$f$;

CREATE OR REPLACE FUNCTION pg_temp.test_cod_settlement_driver_shift_workflow_v2()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_template_id UUID;
  v_financial_context JSONB;
  v_nested_context_consistent BOOLEAN;

  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_cashier UUID := gen_random_uuid();
  v_manager UUID := gen_random_uuid();

  v_task_type_handover UUID := gen_random_uuid();
  v_task_type_cashier UUID := gen_random_uuid();
  v_task_type_manager UUID := gen_random_uuid();

  v_client_a UUID := gen_random_uuid();
  v_sender_a UUID := gen_random_uuid();
  v_vehicle_a UUID := gen_random_uuid();
  v_shipment_a UUID := gen_random_uuid();
  v_route_seed_a RECORD;
  v_route_stop_a UUID;

  v_client_b UUID := gen_random_uuid();
  v_sender_b UUID := gen_random_uuid();
  v_vehicle_b UUID := gen_random_uuid();
  v_shipment_b UUID := gen_random_uuid();
  v_route_seed_b RECORD;
  v_route_stop_b UUID;

  v_run_a UUID;
  v_run_b UUID;

  v_progress JSONB;
  v_ctx JSONB;

  v_settlement_batch_id UUID;
  v_task_id UUID;
  v_task_done_event_id UUID;
  v_requires_manager BOOLEAN := FALSE;
  v_driver_shift_session_id UUID;
  v_cash_drawer_session_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'task_enqueue' AND is_active IS TRUE),
    'handler registered: task_enqueue'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'task_wait' AND is_active IS TRUE),
    'handler registered: task_wait'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'settlement_batch' AND is_active IS TRUE),
    'handler registered: settlement_batch'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'finance_transfer' AND is_active IS TRUE),
    'handler registered: finance_transfer'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'variance_gate' AND is_active IS TRUE),
    'handler registered: variance_gate'
  );

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'cod_driver_shift_settlement_v2'
    LIMIT 1;

  RETURN NEXT ok(v_template_id IS NOT NULL, 'workflow template exists: cod_driver_shift_settlement_v2');
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id),
    11,
    'template has 11 steps'
  );

  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 1), 'settlement_batch', 'step 1 handler_key = settlement_batch');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 2), 'task_enqueue', 'step 2 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 3), 'task_wait', 'step 3 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 4), 'task_enqueue', 'step 4 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 5), 'task_wait', 'step 5 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 6), 'variance_gate', 'step 6 handler_key = variance_gate');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 7), 'finance_transfer', 'step 7 handler_key = finance_transfer');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 8), 'settlement_batch', 'step 8 handler_key = settlement_batch');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 9), 'task_enqueue', 'step 9 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 10), 'task_wait', 'step 10 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 11), 'settlement_batch', 'step 11 handler_key = settlement_batch');

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', TRUE);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'COD Settlement Workflow v2 Org', 'cod-settle-v2-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES (v_branch, v_org, 'b-' || left(v_branch::text, 8), 'Branch ' || left(v_branch::text, 8), TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_driver, v_org, 'driver-' || left(v_driver::text, 8) || '@example.com', 'Driver ' || left(v_driver::text, 8), 'tenant'),
    (v_cashier, v_org, 'cashier-' || left(v_cashier::text, 8) || '@example.com', 'Cashier ' || left(v_cashier::text, 8), 'tenant'),
    (v_manager, v_org, 'manager-' || left(v_manager::text, 8) || '@example.com', 'Manager ' || left(v_manager::text, 8), 'tenant');

  -- RBAC: task mutation RPCs are permission-gated; grant baseline roles to the actor users.
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver', 'ops_admin'], v_manager);

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_manager, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_cashier, r.id, v_manager, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_manager, r.id, v_manager, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT * FROM pg_temp.check_cod_catalog_seed(v_org);
  v_task_type_handover := public.ensure_task_type_from_catalog_v1(v_org,'cod_cash_handover');
  v_task_type_cashier := public.ensure_task_type_from_catalog_v1(v_org,'cod_cashier_count');
  RETURN NEXT is((SELECT metadata->'completion_amount_contract' FROM public.task_types WHERE id=v_task_type_handover),
    '{"version":1,"field":"amount","minimum":0}'::jsonb,'driver type inherits canonical catalog amount contract');
  RETURN NEXT is((SELECT metadata->'completion_amount_contract' FROM public.task_types WHERE id=v_task_type_cashier),
    '{"version":1,"field":"amount","minimum":0}'::jsonb,'cashier type inherits canonical catalog amount contract');
  INSERT INTO public.task_types(id,organization_id,key,name,enabled,default_priority,default_queue_key)
    VALUES(v_task_type_manager,v_org,'cod_manager_approval','COD Manager Approval',TRUE,50,'default');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client_a, v_org, 'COD Settlement Client A', 'cod-settlement-client-a-' || left(v_client_a::text, 8), 'active'),
    (v_client_b, v_org, 'COD Settlement Client B', 'cod-settlement-client-b-' || left(v_client_b::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES
    (v_sender_a, v_client_a, 'COD Settlement Sender A', 'COD Settlement Sender A', TRUE, 'active'),
    (v_sender_b, v_client_b, 'COD Settlement Sender B', 'COD Settlement Sender B', TRUE, 'active');

  PERFORM set_config('app.organization_onboarding_source', '', TRUE);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:cod-settlement-driver-shift-v2-fixture-bootstrap');

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES
    (v_vehicle_a, v_org, 'active', TRUE),
    (v_vehicle_b, v_org, 'active', TRUE);

  INSERT INTO public.shipments (
    id, organization_id, client_id, sender_id, service_type, tracking_number, status, box_count, cod_amount, cod_currency
  )
  VALUES
    (v_shipment_a, v_org, v_client_a, v_sender_a, 'delivery', 'CODSETA' || upper(left(v_shipment_a::text, 8)), 'out_for_delivery', 1, 100, 'SAR'),
    (v_shipment_b, v_org, v_client_b, v_sender_b, 'delivery', 'CODSETB' || upper(left(v_shipment_b::text, 8)), 'out_for_delivery', 1, 100, 'SAR');

  SELECT *
    INTO v_route_seed_a
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle_a,
        'idempotency_key', 'pgtap-v2-route-seed-a',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client_a, 'shipment_id', v_shipment_a, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;
  v_route_stop_a := (v_route_seed_a.stop_ids)[1];

  SELECT *
    INTO v_route_seed_b
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle_b,
        'idempotency_key', 'pgtap-v2-route-seed-b',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client_b, 'shipment_id', v_shipment_b, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;
  v_route_stop_b := (v_route_seed_b.stop_ids)[1];

  -- Seed canonical delivery payment collection truth as test owner; the
  -- service-role workflow execution starts after these fixture rows.
  INSERT INTO public.shipment_actions (
    organization_id,
    client_id,
    shipment_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_system,
    action_data,
    timestamp
  )
  VALUES (
    v_org,
    v_client_a,
    v_shipment_a,
    'status_change',
    'operational',
    'delivered',
    'pgtap',
    jsonb_build_object(
      'route_stop_id', v_route_stop_a,
      'delivery_completion', jsonb_build_object(
        'completion_kind', 'full',
        'payment_collection', jsonb_build_object(
          'required', TRUE,
          'outcome', 'collected',
          'method', 'cash',
          'expected_amount', 100,
          'collected_amount', 100,
          'variance_amount', 0,
          'has_discrepancy', FALSE,
          'discrepancy_kind', 'matched',
          'currency', 'SAR',
          'allowed_methods', jsonb_build_array('cash'),
          'payment_mode_label', 'Cash',
          'receipt_context', 'scenario-a-seed'
        )
      )
    ),
    now() - make_interval(hours => 6)
  );

  INSERT INTO public.shipment_actions (
    organization_id,
    client_id,
    shipment_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_system,
    action_data,
    timestamp
  )
  VALUES (
    v_org,
    v_client_b,
    v_shipment_b,
    'status_change',
    'operational',
    'delivered',
    'pgtap',
    jsonb_build_object(
      'route_stop_id', v_route_stop_b,
      'delivery_completion', jsonb_build_object(
        'completion_kind', 'full',
        'payment_collection', jsonb_build_object(
          'required', TRUE,
          'outcome', 'collected',
          'method', 'cash',
          'expected_amount', 100,
          'collected_amount', 100,
          'variance_amount', 0,
          'has_discrepancy', FALSE,
          'discrepancy_kind', 'matched',
          'currency', 'SAR',
          'allowed_methods', jsonb_build_array('cash'),
          'payment_mode_label', 'Cash',
          'receipt_context', 'scenario-b-seed'
        )
      )
    ),
    now() - make_interval(hours => 2)
  );

  -- Service-role workflow execution (auth.uid() NULL; actor_system captured via app.actor_system).
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  ---------------------------------------------------------------------------
  RETURN QUERY SELECT * FROM pg_temp.cod_visibility_contract(v_org,v_branch,v_driver,v_manager);

  -- Scenario A: variance within tolerance (manager steps skipped)
  ---------------------------------------------------------------------------

  v_run_a := start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'kind', 'cod',
      'scope_type', 'driver_shift',
      'branch_id', v_branch,
      'subject_type', 'user',
      'subject_id', v_driver,
      'window_start_at', now() - make_interval(hours => 8),
      'window_end_at', now() - make_interval(hours => 4),
      'trigger_source', 'pgtap'
    ))
  );

  RETURN NEXT ok(v_run_a IS NOT NULL, 'scenario A: start_workflow_run returns run_id');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 1 completes');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  v_settlement_batch_id := NULLIF(v_ctx->>'settlement_batch_id', '')::uuid;
  RETURN NEXT ok(v_settlement_batch_id IS NOT NULL, 'scenario A: context has settlement_batch_id');
  RETURN NEXT is(v_ctx->'settlement'->>'expected_amount', '100', 'scenario A: settlement context uses canonical COD expected amount');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 2 completes');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario A: step 3 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  BEGIN v_task_id := NULLIF((v_ctx->'driver_handover_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT ops_session_id
    INTO v_driver_shift_session_id
    FROM public.open_ops_session_v1(jsonb_build_object(
      'session_type', 'driver_shift',
      'branch_id', v_branch,
      'idempotency_key', 'pgtap-v2-a-driver-shift'
    ))
   LIMIT 1;

  RETURN QUERY SELECT * FROM pg_temp.check_cod_amount_boundary(v_task_id,v_driver_shift_session_id,v_org,v_driver,v_manager);
  v_financial_context := api.ui_get_financial_task_context_v1(v_task_id);
  -- Compare a fresh API session projection with the independently captured policy.
  -- Full nested RPC composition is covered by the retained prior-command diagnostic.
  EXECUTE $nested$
    SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(api.ui_get_financial_task_context_v1($1)->'sessions') s
      WHERE (s->>'session_type') IS DISTINCT FROM $2::text)
  $nested$ INTO v_nested_context_consistent USING v_task_id, v_financial_context->>'required_session_type';
  RETURN NEXT ok(v_nested_context_consistent,
    'driver: fresh API sessions match independently captured required type');
  RETURN NEXT is(api.ui_get_financial_task_context_v1(v_task_id)
    - 'sessions' - 'task_status', v_financial_context - 'sessions' - 'task_status',
    'driver: repeated top-level context preserves actor/task/policy identity');
  RETURN NEXT is(v_financial_context->>'task_id',v_task_id::text,'driver: financial context uses canonical task');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(v_financial_context->'sessions') s
    WHERE s->>'id'=v_driver_shift_session_id::text),'driver: own required session is selectable');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_financial_context->'sessions') s
    WHERE (s->>'session_type') IS DISTINCT FROM (v_financial_context->>'required_session_type')),
    'driver: no wrong session type is selectable');

  RETURN QUERY SELECT * FROM pg_temp.check_cash_evidence(v_task_id,v_driver_shift_session_id,v_org,v_driver,v_manager);
  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'handover completed',
      p_payload := jsonb_build_object('amount', 80, 'currency', 'SAR', 'source', 'pgtap', 'ops_session_id', v_driver_shift_session_id,'supervisor_name','Fixture supervisor annotation','photo_artifact_id',(SELECT photo_id FROM cash_evidence_fixture)),
      p_idempotency_key := 'pgtap-v2-a-driver-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario A: driver completes handover task');
  RETURN NEXT is(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id)->>'supervisor_name',
    'Fixture supervisor annotation','supervisor text is accepted annotation');
  RETURN NEXT is(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id)->>'photo_artifact_id',
    (SELECT photo_id::text FROM cash_evidence_fixture),'owned task photo has exact accepted-event readback');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT throws_ok(format('UPDATE public.task_events SET payload=payload-''photo_artifact_id'' WHERE id=%L',v_task_done_event_id),
    '23514','cash_handover_evidence_immutable','accepted photo cannot be removed');
  RETURN NEXT throws_ok(format('UPDATE public.task_events SET payload=jsonb_set(payload,''{supervisor_name}'',''"changed"''::jsonb) WHERE id=%L',v_task_done_event_id),
    '23514','cash_handover_evidence_immutable','accepted annotation cannot be replaced');
  RETURN NEXT throws_ok(format('DELETE FROM public.task_events WHERE id=%L',v_task_done_event_id),
    '23514','cash_handover_evidence_immutable','accepted evidence event cannot be deleted');
  RETURN NEXT throws_ok(format('UPDATE public.task_events SET id=gen_random_uuid() WHERE id=%L',v_task_done_event_id),
    '23514','cash_handover_evidence_immutable','accepted event ID cannot change');
  RETURN NEXT throws_ok('DO $reserved$ BEGIN IF EXISTS(SELECT 1 FROM public.task_events WHERE payload ? ''cash_handover_evidence_version'') THEN RAISE EXCEPTION ''cash_handover_evidence_marker_preexisting'' USING ERRCODE=''23514''; END IF; END; $reserved$',
    '23514','cash_handover_evidence_marker_preexisting','migration precondition rejects occupied reserved marker');
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id)->>'task_event_id',v_task_done_event_id::text,'driver: real accepted event readback');
  RETURN NEXT is(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id)->>'ops_session_id',v_driver_shift_session_id::text,'driver: persisted session column lineage');
  RETURN NEXT is(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id)->'amount','80'::jsonb,'driver: real workflow amount retained');
  RETURN NEXT is(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id)->>'settlement_id',
    (SELECT resource_id::text FROM public.tasks WHERE id=v_task_id),'driver: canonical settlement target');
  RETURN NEXT ok(api.ui_get_financial_task_readback_v1(v_task_id,gen_random_uuid()) IS NULL,'driver: unknown accepted event cannot verify');
  RETURN NEXT ok(NOT(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id) ? 'payload'), 'driver: raw financial payload not projected');
  RETURN QUERY SELECT * FROM pg_temp.check_financial_reads(v_task_id,v_task_done_event_id,v_driver_shift_session_id,v_driver,v_manager);
  RETURN QUERY SELECT * FROM pg_temp.check_financial_policy_matrix(v_task_id,v_driver_shift_session_id);
  RETURN NEXT is((SELECT task_event_id FROM public.transition_task_v1(v_task_id,'completed','handover completed',
    jsonb_build_object('amount',80,'currency','SAR','source','pgtap','ops_session_id',v_driver_shift_session_id,'supervisor_name','Fixture supervisor annotation','photo_artifact_id',(SELECT photo_id FROM cash_evidence_fixture)),'pgtap-v2-a-driver-done')),
    v_task_done_event_id,'driver replay returns same event');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_a AND sequence_order = 3;

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 3 completes after driver completion');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 4 completes');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario A: step 5 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  BEGIN v_task_id := NULLIF((v_ctx->'cashier_count_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_cashier::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT ops_session_id
    INTO v_cash_drawer_session_id
    FROM public.open_ops_session_v1(jsonb_build_object(
      'session_type', 'branch_cash_drawer',
      'branch_id', v_branch,
      'idempotency_key', 'pgtap-v2-a-cash-drawer'
    ))
   LIMIT 1;

  RETURN QUERY SELECT * FROM pg_temp.check_cod_amount_boundary(v_task_id,v_cash_drawer_session_id,v_org,v_cashier,v_manager);
  v_financial_context := api.ui_get_financial_task_context_v1(v_task_id);
  -- Compare the independently scoped cashier API response with its captured policy.
  -- No exception suppression or volatility/authorization override is used.
  EXECUTE $nested$
    SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(api.ui_get_financial_task_context_v1($1)->'sessions') s
      WHERE (s->>'session_type') IS DISTINCT FROM $2::text)
  $nested$ INTO v_nested_context_consistent USING v_task_id, v_financial_context->>'required_session_type';
  RETURN NEXT ok(v_nested_context_consistent,
    'cashier: fresh API sessions match independently captured required type');
  RETURN NEXT is(api.ui_get_financial_task_context_v1(v_task_id)
    - 'sessions' - 'task_status', v_financial_context - 'sessions' - 'task_status',
    'cashier: repeated top-level context preserves actor/task/policy identity');
  RETURN NEXT is(v_financial_context->>'task_id',v_task_id::text,'cashier: financial context uses canonical task');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(v_financial_context->'sessions') s
    WHERE s->>'id'=v_cash_drawer_session_id::text),'cashier: own required session is selectable');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_financial_context->'sessions') s
    WHERE (s->>'session_type') IS DISTINCT FROM (v_financial_context->>'required_session_type')),
    'cashier: no wrong session type is selectable');

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'cashier counted and accepted',
      p_payload := jsonb_build_object('amount', 100, 'currency', 'SAR', 'source', 'pgtap', 'ops_session_id', v_cash_drawer_session_id),
      p_idempotency_key := 'pgtap-v2-a-cashier-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario A: cashier completes count task');
  RETURN NEXT is(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id)->>'task_event_id',v_task_done_event_id::text,'cashier: real accepted event readback');
  RETURN NEXT is(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id)->>'ops_session_id',v_cash_drawer_session_id::text,'cashier: persisted session column lineage');
  RETURN NEXT is(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id)->'amount','100'::jsonb,'cashier: real workflow amount retained');
  RETURN NEXT is(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id)->>'settlement_id',
    (SELECT resource_id::text FROM public.tasks WHERE id=v_task_id),'cashier: canonical settlement target');
  RETURN NEXT ok(api.ui_get_financial_task_readback_v1(v_task_id,gen_random_uuid()) IS NULL,'cashier: unknown accepted event cannot verify');
  RETURN NEXT ok(NOT(api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id) ? 'payload'), 'cashier: raw financial payload not projected');
  RETURN QUERY SELECT * FROM pg_temp.check_financial_reads(v_task_id,v_task_done_event_id,v_cash_drawer_session_id,v_cashier,v_manager);
  RETURN QUERY SELECT * FROM pg_temp.check_financial_policy_matrix(v_task_id,v_cash_drawer_session_id);
  RETURN NEXT is((SELECT task_event_id FROM public.transition_task_v1(v_task_id,'completed','cashier counted and accepted',
    jsonb_build_object('amount',100,'currency','SAR','source','pgtap','ops_session_id',v_cash_drawer_session_id),'pgtap-v2-a-cashier-done')),
    v_task_done_event_id,'cashier replay returns same event');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_a AND sequence_order = 5;

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 5 completes after cashier completion');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 6 completes (variance gate)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  RETURN NEXT is(v_ctx->'cod_variance'->>'expected_amount', '100', 'scenario A: variance gate expected amount comes from settlement summary');
  RETURN NEXT is(v_ctx->'cod_variance'->>'actual_amount', '100', 'scenario A: variance gate actual amount uses cashier count');
  BEGIN v_requires_manager := COALESCE((v_ctx->'cod_variance'->>'requires_manager_approval')::boolean, FALSE); EXCEPTION WHEN others THEN v_requires_manager := FALSE; END;
  RETURN NEXT is(v_requires_manager, FALSE, 'scenario A: variance does not require manager approval');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 7 completes (finance transfer)');

  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'cod_handover'),
    2,
    'scenario A: two finance events attached (cod_handover)'
  );
  RETURN NEXT is(
    (SELECT MIN(fe.amount)::numeric
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'cod_handover'),
    100::numeric,
    'scenario A: finance transfer amount matches cashier count (min)'
  );
  RETURN NEXT is(
    (SELECT MAX(fe.amount)::numeric
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'cod_handover'),
    100::numeric,
    'scenario A: finance transfer amount matches cashier count (max)'
  );

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 8 completes (lock)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 9 completes (manager enqueue skipped)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  RETURN NEXT ok(
    NULLIF(btrim(COALESCE(v_ctx->'manager_approval_task'->>'task_id', '')), '') IS NULL,
    'scenario A: manager approval task_id is absent'
  );

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 10 completes (manager wait skipped)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 11 completes (approve)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: workflow run finalizes');
  RETURN NEXT is((SELECT workflow_status FROM public.workflow_runs WHERE id = v_run_a), 'completed', 'scenario A: workflow_runs.workflow_status is completed');
  RETURN NEXT is((SELECT status FROM public.settlement_batches WHERE id = v_settlement_batch_id), 'approved', 'scenario A: settlement batch approved');
  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.tasks t
     JOIN public.task_types tt ON tt.id = t.task_type_id
     WHERE t.organization_id = v_org
       AND t.resource_type = 'settlement_batch'
       AND t.resource_id = v_settlement_batch_id
       AND tt.key = 'cod_manager_approval'),
    0,
    'scenario A: no manager task created'
  );

  ---------------------------------------------------------------------------
  -- Scenario B: variance requires manager approval
  ---------------------------------------------------------------------------

  v_run_b := start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'kind', 'cod',
      'scope_type', 'driver_shift',
      'branch_id', v_branch,
      'subject_type', 'user',
      'subject_id', v_driver,
      'window_start_at', now() - make_interval(hours => 4),
      'window_end_at', now(),
      'trigger_source', 'pgtap'
    ))
  );

  RETURN NEXT ok(v_run_b IS NOT NULL, 'scenario B: start_workflow_run returns run_id');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 1 completes');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  v_settlement_batch_id := NULLIF(v_ctx->>'settlement_batch_id', '')::uuid;
  RETURN NEXT is(v_ctx->'settlement'->>'expected_amount', '100', 'scenario B: settlement context uses canonical COD expected amount');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 2 completes');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario B: step 3 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  BEGIN v_task_id := NULLIF((v_ctx->'driver_handover_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'handover completed',
      p_payload := jsonb_build_object('amount', 100, 'currency', 'SAR', 'source', 'pgtap', 'ops_session_id', v_driver_shift_session_id),
      p_idempotency_key := 'pgtap-v2-b-driver-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario B: driver completes handover task');
  RETURN NEXT ok(NOT (api.ui_get_financial_task_readback_v1(v_task_id,v_task_done_event_id) ? 'photo_artifact_id'),
    'cash handover still completes without optional photo');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.task_events SET payload=payload||'{"supervisor_name":"historical annotation"}'::jsonb WHERE id=v_task_done_event_id;
  UPDATE public.task_events SET payload=payload WHERE id=v_task_done_event_id;
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.task_events WHERE id=v_task_done_event_id AND payload ? 'cash_handover_evidence_version'),
    'historical completed event cannot gain acceptance marker through update');
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_b AND sequence_order = 3;

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 3 completes after driver completion');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 4 completes');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario B: step 5 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  BEGIN v_task_id := NULLIF((v_ctx->'cashier_count_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_cashier::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'cashier counted with variance',
      p_payload := jsonb_build_object('amount', 90, 'currency', 'SAR', 'source', 'pgtap', 'ops_session_id', v_cash_drawer_session_id),
      p_idempotency_key := 'pgtap-v2-b-cashier-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario B: cashier completes count task (variance)');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_b AND sequence_order = 5;

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 5 completes after cashier completion');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 6 completes (variance gate)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  RETURN NEXT is(v_ctx->'cod_variance'->>'expected_amount', '100', 'scenario B: variance gate expected amount comes from settlement summary');
  RETURN NEXT is(v_ctx->'cod_variance'->>'actual_amount', '90', 'scenario B: variance gate actual amount uses cashier count');
  BEGIN v_requires_manager := COALESCE((v_ctx->'cod_variance'->>'requires_manager_approval')::boolean, FALSE); EXCEPTION WHEN others THEN v_requires_manager := FALSE; END;
  RETURN NEXT is(v_requires_manager, TRUE, 'scenario B: variance requires manager approval');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 7 completes (finance transfer)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 8 completes (lock)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 9 completes (manager task enqueued)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  BEGIN v_task_id := NULLIF((v_ctx->'manager_approval_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;
  RETURN NEXT ok(v_task_id IS NOT NULL, 'scenario B: manager approval task_id exists');
  RETURN NEXT is(
    (SELECT metadata->'allowed_actions' FROM public.tasks WHERE id = v_task_id),
    jsonb_build_array('approve', 'reject'),
    'scenario B: manager approval task exposes row-driven approve/reject actions'
  );
  RETURN NEXT is(
    (SELECT queue_key FROM public.tasks WHERE id = v_task_id),
    'finance',
    'scenario B: manager approval task is routed to finance queue'
  );
  RETURN NEXT is(
    (SELECT metadata->>'description' FROM public.tasks WHERE id = v_task_id),
    'Review the COD variance decision and approve or reject the settlement closeout.',
    'scenario B: manager approval task carries operator decision description'
  );

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario B: step 10 pending while manager task is open');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_manager::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'variance approved',
      p_payload := jsonb_build_object('approved', TRUE, 'source', 'pgtap'),
      p_idempotency_key := 'pgtap-v2-b-manager-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario B: manager completes approval task');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_b AND sequence_order = 10;

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 10 completes after manager approval');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 11 completes (approve)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: workflow run finalizes');

  RETURN NEXT is((SELECT status FROM public.settlement_batches WHERE id = v_settlement_batch_id), 'approved', 'scenario B: settlement batch approved');
  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.tasks t
     JOIN public.task_types tt ON tt.id = t.task_type_id
     WHERE t.organization_id = v_org
       AND t.resource_type = 'settlement_batch'
       AND t.resource_id = v_settlement_batch_id
       AND tt.key = 'cod_manager_approval'),
    1,
    'scenario B: manager task created'
  );
  RETURN NEXT is(
    (SELECT MIN(fe.amount)::numeric
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'cod_handover'),
    90::numeric,
    'scenario B: finance transfer amount matches cashier count (min)'
  );
  RETURN NEXT is(
    (SELECT MAX(fe.amount)::numeric
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'cod_handover'),
    90::numeric,
    'scenario B: finance transfer amount matches cashier count (max)'
  );

  RETURN;
END;
$$;

SELECT * FROM pg_temp.test_cod_settlement_driver_shift_workflow_v2();

SELECT * FROM finish();

ROLLBACK;
