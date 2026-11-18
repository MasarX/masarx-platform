-- F619 G6: ledger-backed driver wallet and request-only withdrawal.
BEGIN;
SELECT pg_advisory_lock(hashtext('20260913103000_fieldops_driver_wallet_request_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_values(lookup_definition_id,value,label,description,sort_order,is_default,status,metadata)
SELECT d.id,'driver_wallet','Driver wallet','Driver earnings backed only by canonical finance events.',70,FALSE,'active','{}'
FROM public.lookup_definitions d WHERE d.category='finance_account_type'
ON CONFLICT(lookup_definition_id,value) DO NOTHING;

INSERT INTO public.lookup_values(lookup_definition_id,value,label,description,sort_order,is_default,status,metadata)
SELECT d.id,'finance.withdrawal.request','Finance withdrawal request',
  'Request finance review without posting payout or ledger truth.',170,FALSE,'active',
  '{"resource":"finance","action":"withdrawal.request"}'
FROM public.lookup_definitions d WHERE d.category='rbac_permission'
ON CONFLICT(lookup_definition_id,value) DO NOTHING;

WITH permission AS (
  SELECT lv.id FROM public.lookup_values lv
  JOIN public.lookup_definitions ld ON ld.id=lv.lookup_definition_id
  WHERE ld.category='rbac_permission' AND lv.value='finance.withdrawal.request'
), templates AS (
  SELECT id FROM public.rbac_role_templates WHERE key='driver'
)
INSERT INTO public.rbac_role_template_permissions(role_template_id,permission_id,metadata)
SELECT t.id,p.id,'{"seed":true,"source":"fieldops_driver_wallet_request_v1"}'
FROM templates t CROSS JOIN permission p
ON CONFLICT(role_template_id,permission_id) DO NOTHING;

WITH permission AS (
  SELECT lv.id FROM public.lookup_values lv
  JOIN public.lookup_definitions ld ON ld.id=lv.lookup_definition_id
  WHERE ld.category='rbac_permission' AND lv.value='finance.withdrawal.request'
)
INSERT INTO public.rbac_role_permissions(organization_id,role_id,permission_id,metadata)
SELECT r.organization_id,r.id,p.id,'{"source":"fieldops_driver_wallet_request_v1"}'
FROM public.rbac_roles r CROSS JOIN permission p
WHERE r.key='driver'
ON CONFLICT ON CONSTRAINT rbac_role_permissions_unique DO NOTHING;

DO $catalog$
DECLARE
  v_current_catalog JSONB; items JSONB; base_item JSONB; desired JSONB; next_items JSONB;
BEGIN
  SELECT cached_value INTO v_current_catalog FROM public.settings
  WHERE category='task_type_catalog' AND scope_type='global' AND scope_id IS NULL FOR UPDATE;
  IF jsonb_typeof(v_current_catalog->'task_types') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'driver wallet requires global task_type_catalog' USING ERRCODE='23514';
  END IF;
  items:=v_current_catalog->'task_types';
  SELECT value INTO base_item FROM jsonb_array_elements(items)
  WHERE value->>'key'='cod_cashier_count' LIMIT 1;
  IF base_item IS NULL THEN
    RAISE EXCEPTION 'driver wallet requires cod_cashier_count defaults' USING ERRCODE='23514';
  END IF;
  desired:=jsonb_build_object(
    'key','wallet_withdrawal_request','name','Wallet withdrawal request',
    'description','Finance review of a driver wallet withdrawal request.',
    'default_priority',COALESCE((base_item->>'default_priority')::int,50),
    'default_queue_key',base_item->>'default_queue_key','enabled',TRUE,
    'metadata',jsonb_build_object(
      'assignment_defaults',COALESCE(base_item#>'{metadata,assignment_defaults}','{}'),
      'request_only',TRUE,'finance_event_write',FALSE));
  SELECT COALESCE(jsonb_agg(
    CASE WHEN value->>'key'='wallet_withdrawal_request' THEN value||desired ELSE value END
    ORDER BY ordinality),'[]')
  INTO next_items FROM jsonb_array_elements(items) WITH ORDINALITY;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(items) e
    WHERE e->>'key'='wallet_withdrawal_request') THEN
    next_items:=next_items||jsonb_build_array(desired);
  END IF;
  IF next_items IS DISTINCT FROM items THEN
    PERFORM public.upsert_settings_value_v1(
      'task_type_catalog','global',NULL::uuid,
      jsonb_set(v_current_catalog,'{task_types}',next_items),1,
      'Add request-only driver wallet withdrawal task type');
  END IF;
END;
$catalog$;

DO $access$
DECLARE
  policy_row RECORD;
  next_value JSONB;
  capabilities JSONB;
  roles JSONB;
  next_roles JSONB;
  role_item JSONB;
  role_seen BOOLEAN;
BEGIN
  FOR policy_row IN
    SELECT s.scope_type,s.scope_id,sv.value,sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category='access_control_policy'
  LOOP
    next_value:=policy_row.value;
    capabilities:=COALESCE(next_value->'capabilities','[]');
    IF jsonb_typeof(capabilities) IS DISTINCT FROM 'array' THEN capabilities:='[]'; END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(capabilities) c
      WHERE c->>'key'='finance.withdrawal.request') THEN
      capabilities:=capabilities||jsonb_build_array(jsonb_build_object(
        'key','finance.withdrawal.request',
        'label','Request own wallet withdrawal',
        'description','Create a request-only finance review task.'));
    END IF;
    roles:=COALESCE(next_value->'roles','[]');
    IF jsonb_typeof(roles) IS DISTINCT FROM 'array' THEN roles:='[]'; END IF;
    next_roles:='[]';
    role_seen:=FALSE;
    FOR role_item IN SELECT value FROM jsonb_array_elements(roles) LOOP
      IF role_item->>'key'='driver' THEN
        role_seen:=TRUE;
        IF NOT COALESCE(role_item->'capability_keys','[]')
          ?| ARRAY['*','finance.withdrawal.request'] THEN
          role_item:=jsonb_set(role_item,'{capability_keys}',
            COALESCE(role_item->'capability_keys','[]')||'["finance.withdrawal.request"]');
        END IF;
      END IF;
      next_roles:=next_roles||jsonb_build_array(role_item);
    END LOOP;
    IF NOT role_seen THEN
      next_roles:=next_roles||jsonb_build_array(jsonb_build_object(
        'key','driver','label','Driver',
        'capability_keys',jsonb_build_array('finance.withdrawal.request')));
    END IF;
    next_value:=jsonb_set(jsonb_set(next_value,'{capabilities}',capabilities),'{roles}',next_roles);
    IF next_value IS DISTINCT FROM policy_row.value THEN
      PERFORM public.upsert_settings_value_v1(
        'access_control_policy',policy_row.scope_type,policy_row.scope_id,next_value,policy_row.schema_version,
        'Add request-only driver wallet withdrawal capability');
    END IF;
  END LOOP;
END;
$access$;

CREATE OR REPLACE FUNCTION public.compute_driver_wallet_summary_v1(
  p_organization_id UUID,p_driver_user_id UUID,p_currency TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public,extensions,pg_temp SET row_security TO on
AS $function$
DECLARE
  currency_code TEXT:=upper(NULLIF(btrim(COALESCE(p_currency,'')),''));
  balance_amount NUMERIC:=0;
  remitted_amount NUMERIC:=0;
  reserved_amount NUMERIC:=0;
BEGIN
  IF p_organization_id IS NULL OR p_driver_user_id IS NULL
    OR currency_code IS NULL OR currency_code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'driver_wallet_invalid_scope' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(sum(CASE direction WHEN 'in' THEN amount ELSE -amount END),0),
    COALESCE(sum(amount) FILTER(WHERE direction='out' AND event_type='payout'),0)
  INTO balance_amount,remitted_amount
  FROM public.finance_events
  WHERE organization_id=p_organization_id AND account_type='driver_wallet'
    AND account_id=p_driver_user_id AND upper(currency)=currency_code;

  SELECT COALESCE(sum((t.metadata->>'requested_amount')::numeric),0)
  INTO reserved_amount
  FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
  WHERE t.organization_id=p_organization_id AND tt.key='wallet_withdrawal_request'
    AND t.resource_type='user' AND t.resource_id=p_driver_user_id
    AND upper(t.metadata->>'currency')=currency_code
    AND t.canceled_at IS NULL AND lower(t.status)<>'canceled'
    AND NULLIF(t.metadata->>'payout_finance_event_id','') IS NULL
    AND COALESCE(t.metadata->>'requested_amount','') ~ '^[0-9]+([.][0-9]+)?$';

  RETURN jsonb_build_object(
    'organization_id',p_organization_id,'driver_user_id',p_driver_user_id,
    'currency',currency_code,'balance',balance_amount,'remitted_payout',remitted_amount,
    'reserved_withdrawal',reserved_amount,'available',GREATEST(balance_amount-reserved_amount,0));
END;
$function$;
COMMENT ON FUNCTION public.compute_driver_wallet_summary_v1(UUID,UUID,TEXT)
  IS 'Service-only projection of driver_wallet finance events and unlinked withdrawal-task reservations.';
REVOKE ALL ON FUNCTION public.compute_driver_wallet_summary_v1(UUID,UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.compute_driver_wallet_summary_v1(UUID,UUID,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.ui_get_driver_wallet_summary_v1(
  p_currency TEXT,p_driver_user_id UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public,extensions,pg_temp SET row_security TO on
AS $function$
DECLARE
  actor_id UUID:=auth.uid();
  org_id UUID:=public.current_user_org_id();
  driver_id UUID:=COALESCE(p_driver_user_id,actor_id);
  currency_code TEXT:=upper(NULLIF(btrim(COALESCE(p_currency,'')),''));
BEGIN
  IF actor_id IS NULL OR org_id IS NULL THEN
    RAISE EXCEPTION 'driver_wallet_authentication_required' USING ERRCODE='42501';
  END IF;
  IF currency_code IS NULL OR currency_code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'driver_wallet_invalid_currency' USING ERRCODE='22023';
  END IF;
  IF driver_id IS DISTINCT FROM actor_id AND NOT public.is_platform_user()
    AND NOT public.user_has_permission_v1('finance.read',org_id) THEN
    RAISE EXCEPTION 'driver_wallet_forbidden' USING ERRCODE='42501';
  END IF;
  RETURN public.compute_driver_wallet_summary_v1(org_id,driver_id,currency_code);
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_get_driver_wallet_summary_v1(
  p_currency TEXT,p_driver_user_id UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public,api,extensions,pg_temp
AS $function$ SELECT public.ui_get_driver_wallet_summary_v1($1,$2) $function$;

CREATE OR REPLACE FUNCTION public.ui_request_driver_wallet_withdrawal_v1(
  p_amount NUMERIC,p_currency TEXT,p_idempotency_key TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp SET row_security TO on
AS $function$
DECLARE
  actor_id UUID:=auth.uid();
  org_id UUID:=public.current_user_org_id();
  scope_type TEXT:=public.current_user_scope_type();
  scope_id UUID:=public.current_user_scope_id();
  currency_code TEXT:=upper(NULLIF(btrim(COALESCE(p_currency,'')),''));
  retry_key TEXT:=NULLIF(btrim(COALESCE(p_idempotency_key,'')),'');
  task_key TEXT;
  task_row public.tasks%ROWTYPE;
  created RECORD;
  wallet JSONB;
  claims JSONB;
  old_claims TEXT;
  old_role TEXT;
  old_sub TEXT;
  service_claims JSONB;
BEGIN
  IF actor_id IS NULL OR org_id IS NULL THEN
    RAISE EXCEPTION 'driver_wallet_authentication_required' USING ERRCODE='42501';
  END IF;
  PERFORM public.assert_capability_v1('finance.withdrawal.request',scope_type,scope_id);
  IF p_amount IS NULL OR p_amount<=0 THEN
    RAISE EXCEPTION 'driver_wallet_invalid_amount' USING ERRCODE='22023';
  END IF;
  IF currency_code IS NULL OR currency_code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'driver_wallet_invalid_currency' USING ERRCODE='22023';
  END IF;
  IF retry_key IS NULL OR length(retry_key)>200 OR retry_key !~ '^[A-Za-z0-9._:-]+$' THEN
    RAISE EXCEPTION 'driver_wallet_invalid_idempotency_key' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    org_id::text||':'||actor_id::text||':'||currency_code,0));
  task_key:='fieldops:wallet-withdrawal:'||actor_id||':'||retry_key;
  SELECT t.* INTO task_row
  FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
  WHERE t.organization_id=org_id AND t.idempotency_key=task_key
    AND tt.key='wallet_withdrawal_request' LIMIT 1;
  IF FOUND THEN
    IF task_row.resource_type IS DISTINCT FROM 'user'
      OR task_row.resource_id IS DISTINCT FROM actor_id
      OR task_row.metadata->>'requested_by_user_id' IS DISTINCT FROM actor_id::text
      OR upper(task_row.metadata->>'currency') IS DISTINCT FROM currency_code
      OR (task_row.metadata->>'requested_amount')::numeric IS DISTINCT FROM p_amount THEN
      RAISE EXCEPTION 'driver_wallet_idempotency_conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('status','existing','task_id',task_row.id,
      'wallet',public.compute_driver_wallet_summary_v1(org_id,actor_id,currency_code));
  END IF;
  wallet:=public.compute_driver_wallet_summary_v1(org_id,actor_id,currency_code);
  IF p_amount>(wallet->>'available')::numeric THEN
    RAISE EXCEPTION 'driver_wallet_insufficient_available_balance' USING ERRCODE='23514';
  END IF;

  old_claims:=COALESCE(current_setting('request.jwt.claims',true),'');
  old_role:=COALESCE(current_setting('request.jwt.claim.role',true),'');
  old_sub:=COALESCE(current_setting('request.jwt.claim.sub',true),'');
  BEGIN claims:=NULLIF(old_claims,'')::jsonb;
  EXCEPTION WHEN others THEN claims:='{}'; END;
  service_claims:=(COALESCE(claims,'{}')-'sub')||jsonb_build_object('role','service_role');
  PERFORM set_config('request.jwt.claims',service_claims::text,true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  BEGIN
    SELECT * INTO created FROM public.create_task_system_v1(jsonb_build_object(
      'task_type_key','wallet_withdrawal_request',
      'resource_type','user','resource_id',actor_id,
      'idempotency_key',task_key,'actor_system','fieldops_driver_wallet',
      'context',jsonb_build_object('organization_id',org_id),
      'metadata',jsonb_build_object(
        'requested_amount',p_amount,'currency',currency_code,
        'requested_by_user_id',actor_id,'request_only',TRUE)));
  EXCEPTION WHEN others THEN
    PERFORM set_config('request.jwt.claims',old_claims,true);
    PERFORM set_config('request.jwt.claim.role',old_role,true);
    PERFORM set_config('request.jwt.claim.sub',old_sub,true);
    RAISE;
  END;
  PERFORM set_config('request.jwt.claims',old_claims,true);
  PERFORM set_config('request.jwt.claim.role',old_role,true);
  PERFORM set_config('request.jwt.claim.sub',old_sub,true);

  SELECT t.* INTO STRICT task_row
  FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
  WHERE t.id=created.task_id AND t.organization_id=org_id
    AND tt.key='wallet_withdrawal_request';
  IF task_row.resource_type IS DISTINCT FROM 'user'
    OR task_row.resource_id IS DISTINCT FROM actor_id
    OR task_row.metadata->>'requested_by_user_id' IS DISTINCT FROM actor_id::text
    OR upper(task_row.metadata->>'currency') IS DISTINCT FROM currency_code
    OR (task_row.metadata->>'requested_amount')::numeric IS DISTINCT FROM p_amount THEN
    RAISE EXCEPTION 'driver_wallet_idempotency_conflict' USING ERRCODE='23505';
  END IF;
  RETURN jsonb_build_object('status','requested','task_id',task_row.id,
    'wallet',public.compute_driver_wallet_summary_v1(org_id,actor_id,currency_code));
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_request_driver_wallet_withdrawal_v1(
  p_amount NUMERIC,p_currency TEXT,p_idempotency_key TEXT)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public,api,extensions,pg_temp
AS $function$ SELECT public.ui_request_driver_wallet_withdrawal_v1($1,$2,$3) $function$;

DROP POLICY IF EXISTS tasks_select ON public.tasks;
CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated USING(
  public.is_platform_user()
  OR (
    EXISTS(SELECT 1 FROM public.task_types tt
      WHERE tt.id=tasks.task_type_id AND tt.key='wallet_withdrawal_request')
    AND organization_id=public.current_user_org_id()
    AND (
      (resource_type='user' AND resource_id=auth.uid())
      OR public.user_has_permission_v1('finance.read',organization_id)
    )
  )
  OR (
    NOT EXISTS(SELECT 1 FROM public.task_types tt
      WHERE tt.id=tasks.task_type_id AND tt.key='wallet_withdrawal_request')
    AND (
      (public.current_user_scope_type()='tenant' AND organization_id=public.current_user_org_id())
      OR (public.current_user_scope_type()='client' AND client_id=public.current_user_client_id())
      OR (public.current_user_scope_type()='sender' AND sender_id=public.current_user_sender_id())
    )
  )
);

ALTER FUNCTION public.close_route_run_v1(JSONB)
  RENAME TO close_route_run_without_wallet_v1;
REVOKE ALL ON FUNCTION public.close_route_run_without_wallet_v1(JSONB)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.close_route_run_v1(p_input JSONB DEFAULT '{}')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp SET row_security TO on
AS $function$
DECLARE
  result JSONB;
  route_id UUID;
  org_id UUID:=public.current_user_org_id();
  driver_id UUID;
  wallets JSONB:='[]';
  snapshot JSONB;
BEGIN
  result:=public.close_route_run_without_wallet_v1(p_input);
  route_id:=(result->>'route_run_id')::uuid;
  SELECT driver_user_id INTO driver_id
  FROM public.route_runs WHERE id=route_id AND organization_id=org_id;
  IF driver_id IS NOT NULL THEN
    WITH currencies AS (
      SELECT upper(currency) currency FROM public.finance_events
      WHERE organization_id=org_id AND account_type='driver_wallet'
        AND account_id=driver_id
        AND upper(currency) ~ '^[A-Z]{3}$'
      UNION
      SELECT upper(t.metadata->>'currency')
      FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
      WHERE t.organization_id=org_id AND tt.key='wallet_withdrawal_request'
        AND t.resource_type='user' AND t.resource_id=driver_id
        AND COALESCE(t.metadata->>'currency','') ~ '^[A-Za-z]{3}$'
    )
    SELECT COALESCE(jsonb_agg(
      public.compute_driver_wallet_summary_v1(org_id,driver_id,currency)
      ORDER BY currency),'[]')
    INTO wallets FROM currencies;
  END IF;
  snapshot:=jsonb_build_object(
    'captured_at',now(),'driver_user_id',driver_id,'summaries',wallets);
  UPDATE public.route_runs
  SET metadata=jsonb_set(COALESCE(metadata,'{}'),'{route_closeout,wallet_reconciliation}',snapshot,TRUE),
    updated_at=now()
  WHERE id=route_id AND organization_id=org_id;
  RETURN jsonb_set(result,'{route_closeout,wallet_reconciliation}',snapshot,TRUE);
END;
$function$;
COMMENT ON FUNCTION public.close_route_run_v1(JSONB)
  IS 'Canonical route closeout plus read-only driver-wallet reconciliation; does not force route status or create finance truth.';
REVOKE ALL ON FUNCTION public.close_route_run_v1(JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.close_route_run_v1(JSONB) TO authenticated,service_role;

REVOKE ALL ON FUNCTION public.ui_get_driver_wallet_summary_v1(TEXT,UUID) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION api.ui_get_driver_wallet_summary_v1(TEXT,UUID) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ui_request_driver_wallet_withdrawal_v1(NUMERIC,TEXT,TEXT) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION api.ui_request_driver_wallet_withdrawal_v1(NUMERIC,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ui_get_driver_wallet_summary_v1(TEXT,UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_get_driver_wallet_summary_v1(TEXT,UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_request_driver_wallet_withdrawal_v1(NUMERIC,TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_request_driver_wallet_withdrawal_v1(NUMERIC,TEXT,TEXT) TO authenticated;

SELECT pg_advisory_unlock(hashtext('20260913103000_fieldops_driver_wallet_request_v1'));
COMMIT;
