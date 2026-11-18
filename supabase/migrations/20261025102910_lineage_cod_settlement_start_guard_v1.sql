-- Carrier-native driver-shift business deduplication; donor b8c9cb1b442148cb910e6c30933bc00bb95586e6, blob a30daf394a51016c7ead00aec5dca4af0c9da810.
BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('lineage_cod_settlement_start_guard_v1'));

-- One decoder for production flat/system and payload/browser contexts; malformed historic rows cannot abort a scan.
CREATE OR REPLACE FUNCTION public.cod_driver_shift_settlement_identity_v1(p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path TO public,extensions,pg_temp SET timezone TO 'UTC'
AS $identity$
DECLARE
  v_input jsonb; v_org uuid; v_branch uuid; v_subject uuid;
  v_subject_type text; v_start timestamptz; v_end timestamptz;
BEGIN
  IF jsonb_typeof(p_context) IS DISTINCT FROM 'object'
    OR (p_context ? 'payload' AND jsonb_typeof(p_context->'payload') IS DISTINCT FROM 'object') THEN RETURN NULL; END IF;
  v_input:=(p_context-'payload')||COALESCE(p_context->'payload','{}'::jsonb);
  v_org:=NULLIF(v_input->>'organization_id','')::uuid;
  IF NULLIF(p_context->>'organization_id','') IS NOT NULL
    AND (p_context->>'organization_id')::uuid IS DISTINCT FROM v_org THEN RETURN NULL; END IF;
  v_branch:=NULLIF(v_input->>'branch_id','')::uuid;
  v_subject:=NULLIF(v_input->>'subject_id','')::uuid;
  v_subject_type:=lower(btrim(v_input->>'subject_type'));
  v_start:=NULLIF(v_input->>'window_start_at','')::timestamptz;
  v_end:=NULLIF(v_input->>'window_end_at','')::timestamptz;
  IF v_org IS NULL OR v_subject IS NULL OR NULLIF(v_subject_type,'') IS NULL
    OR lower(v_input->>'kind') IS DISTINCT FROM 'cod'
    OR lower(v_input->>'scope_type') IS DISTINCT FROM 'driver_shift'
    OR v_start IS NULL OR v_end IS NULL OR NOT isfinite(v_start) OR NOT isfinite(v_end) OR v_start>v_end THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('organization_id',v_org,'branch_id',v_branch,
    'subject_type',CASE WHEN v_subject_type IN ('user','driver') THEN 'driver' ELSE v_subject_type END,
    'subject_id',v_subject,'window_start_epoch',extract(epoch FROM v_start),'window_end_epoch',extract(epoch FROM v_end));
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END;
$identity$;
REVOKE ALL ON FUNCTION public.cod_driver_shift_settlement_identity_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_cod_subject_window_v1 ON public.workflow_runs
  ((lower(COALESCE(context->>'organization_id',context#>>'{payload,organization_id}'))),
   (lower(COALESCE(context#>>'{payload,subject_id}',context->>'subject_id'))))
  WHERE workflow_status IN ('pending','in_progress','continue');

CREATE OR REPLACE FUNCTION public.assert_cod_settlement_start_allowed_v1(
  p_workflow_template_id uuid,p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp SET row_security=on
AS $guard$
DECLARE v_identity jsonb; v_org uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.workflow_templates wt WHERE wt.id=p_workflow_template_id
    AND (wt.name='cod_driver_shift_settlement_v2' OR wt.metadata->>'source_template_name'='cod_driver_shift_settlement_v2')) THEN RETURN; END IF;
  v_identity:=public.cod_driver_shift_settlement_identity_v1(p_payload);
  IF v_identity IS NULL THEN
    RAISE EXCEPTION 'COD driver-shift start requires a valid organization, subject and time window' USING ERRCODE='22023';
  END IF;
  v_org:=(v_identity->>'organization_id')::uuid;
  IF auth.uid() IS NOT NULL AND NOT COALESCE(public.is_platform_user(),FALSE)
    AND v_org IS DISTINCT FROM public.current_user_org_id() THEN
    RAISE EXCEPTION 'COD settlement organization is outside caller scope' USING ERRCODE='42501';
  END IF;
  IF auth.uid() IS NULL AND session_user NOT IN ('postgres','supabase_admin')
    AND NOT COALESCE(public.request_is_service_role_v1(),FALSE) THEN
    RAISE EXCEPTION 'COD settlement requires a trusted actor' USING ERRCODE='42501';
  END IF;
  -- Browser starts promote payload into a service-only settlement writer's input.
  IF auth.uid() IS NOT NULL AND NOT COALESCE(public.request_is_service_role_v1(),FALSE) THEN
    IF public.current_user_scope_type() IS DISTINCT FROM 'tenant'
      OR NOT COALESCE(public.user_has_permission_v1('finance.write',v_org),FALSE) THEN
      RAISE EXCEPTION 'COD settlement browser starts require tenant scope and finance.write' USING ERRCODE='42501';
    END IF;
  END IF;
  -- The lock must be followed by a fresh statement snapshot to observe the previous starter's commit.
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'COD settlement starts require READ COMMITTED isolation' USING ERRCODE='25001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cod_driver_shift_settlement_start'),hashtext(v_identity::text));
  IF EXISTS(SELECT 1 FROM public.settlement_batches b
    WHERE b.organization_id=v_org AND b.kind='cod' AND b.scope_type='driver_shift'
      AND b.subject_id=(v_identity->>'subject_id')::uuid
      AND b.branch_id IS NOT DISTINCT FROM (v_identity->>'branch_id')::uuid
      AND CASE WHEN b.subject_type IN ('user','driver') THEN 'driver' ELSE lower(b.subject_type) END=v_identity->>'subject_type'
      AND extract(epoch FROM b.window_start_at)=(v_identity->>'window_start_epoch')::numeric
      AND extract(epoch FROM b.window_end_at)=(v_identity->>'window_end_epoch')::numeric
      AND b.status<>'canceled') THEN
    RAISE EXCEPTION 'COD settlement already exists for this driver-shift window' USING ERRCODE='23505';
  END IF;
  IF EXISTS(SELECT 1 FROM public.workflow_runs wr JOIN public.workflow_templates wt ON wt.id=wr.workflow_template_id
    WHERE wr.workflow_status IN ('pending','in_progress','continue')
      AND (wt.name='cod_driver_shift_settlement_v2' OR wt.metadata->>'source_template_name'='cod_driver_shift_settlement_v2')
      AND lower(COALESCE(wr.context->>'organization_id',wr.context#>>'{payload,organization_id}'))=v_org::text
      AND lower(COALESCE(wr.context#>>'{payload,subject_id}',wr.context->>'subject_id'))=v_identity->>'subject_id'
      AND public.cod_driver_shift_settlement_identity_v1(wr.context)=v_identity) THEN
    RAISE EXCEPTION 'COD settlement workflow already exists for this driver-shift window' USING ERRCODE='23505';
  END IF;
END;
$guard$;
REVOKE ALL ON FUNCTION public.assert_cod_settlement_start_allowed_v1(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.workflow_runs_cod_settlement_start_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp
AS $trigger$
DECLARE v_input jsonb; v_identity jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.workflow_templates wt WHERE wt.id=NEW.workflow_template_id
    AND (wt.name='cod_driver_shift_settlement_v2' OR wt.metadata->>'source_template_name'='cod_driver_shift_settlement_v2')) THEN RETURN NEW; END IF;
  PERFORM public.assert_cod_settlement_start_allowed_v1(NEW.workflow_template_id,NEW.context);
  v_identity:=public.cod_driver_shift_settlement_identity_v1(NEW.context);
  v_input:=(NEW.context-'payload')||COALESCE(NEW.context->'payload','{}'::jsonb);
  -- The current settlement handler reads flat context; retain browser payload and expose only its settlement inputs there.
  NEW.context:=NEW.context||jsonb_build_object('organization_id',v_identity->'organization_id',
    'kind','cod','scope_type','driver_shift','branch_id',v_identity->'branch_id',
    'subject_type',lower(v_input->>'subject_type'),'subject_id',v_identity->'subject_id',
    'window_start_at',v_input->'window_start_at','window_end_at',v_input->'window_end_at');
  RETURN NEW;
END;
$trigger$;
REVOKE ALL ON FUNCTION public.workflow_runs_cod_settlement_start_guard_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS workflow_runs_cod_settlement_start_guard ON public.workflow_runs;
CREATE TRIGGER workflow_runs_cod_settlement_start_guard BEFORE INSERT ON public.workflow_runs
FOR EACH ROW EXECUTE FUNCTION public.workflow_runs_cod_settlement_start_guard_v1();
COMMIT;
