BEGIN;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT plan(35);

SELECT has_function('public','compute_driver_wallet_summary_v1',
  ARRAY['uuid','uuid','text'],'service wallet projection exists');
SELECT has_function('api','ui_get_driver_wallet_summary_v1',
  ARRAY['text','uuid'],'browser-safe wallet read exists');
SELECT has_function('api','ui_request_driver_wallet_withdrawal_v1',
  ARRAY['numeric','text','text'],'browser-safe withdrawal request exists');
SELECT has_function('api','ui_request_driver_wallet_withdrawal_v2',
  ARRAY['numeric','text','text','uuid','uuid'],'scope-bound browser withdrawal request exists');
SELECT ok(NOT has_function_privilege(
  'authenticated','public.compute_driver_wallet_summary_v1(uuid,uuid,text)','EXECUTE'),
  'raw projection is service-only');
SELECT ok(has_function_privilege(
  'authenticated','api.ui_get_driver_wallet_summary_v1(text,uuid)','EXECUTE'),
  'authenticated wallet read is granted');
SELECT ok(has_function_privilege(
  'authenticated','api.ui_request_driver_wallet_withdrawal_v1(numeric,text,text)','EXECUTE'),
  'authenticated withdrawal request is granted');
SELECT ok(has_function_privilege(
  'authenticated','api.ui_request_driver_wallet_withdrawal_v2(numeric,text,text,uuid,uuid)','EXECUTE'),
  'authenticated scope-bound withdrawal request is granted');
SELECT ok(EXISTS(
  SELECT 1 FROM public.lookup_values lv
  JOIN public.lookup_definitions ld ON ld.id=lv.lookup_definition_id
  WHERE ld.category='finance_account_type' AND lv.value='driver_wallet'),
  'driver_wallet account type is registered');
SELECT ok(EXISTS(
  SELECT 1 FROM public.settings s,
    LATERAL jsonb_array_elements(s.cached_value->'task_types') e
  WHERE s.category='task_type_catalog'
    AND e->>'key'='wallet_withdrawal_request'
    AND e#>>'{metadata,request_only}'='true'),
  'withdrawal remains request-only Tasks SSOT');

CREATE TEMP TABLE wallet_fixture(
  organization_id UUID,driver_user_id UUID,other_user_id UUID,outside_user_id UUID,
  finance_count BIGINT,settlement_count BIGINT,settlement_event_count BIGINT,payout_count BIGINT
) ON COMMIT DROP;
GRANT SELECT ON wallet_fixture TO authenticated;

DO $fixture$
DECLARE
  org_id UUID:=gen_random_uuid(); other_org_id UUID:=gen_random_uuid();
  driver_id UUID:=gen_random_uuid(); other_id UUID:=gen_random_uuid(); outside_id UUID:=gen_random_uuid();
BEGIN
  INSERT INTO public.organizations(id,name,slug) VALUES
    (org_id,'Wallet Test Org','wallet-test-'||left(org_id::text,8)),
    (other_org_id,'Outside Wallet Org','wallet-outside-'||left(other_org_id::text,8));
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,access_scope_type) VALUES
    (driver_id,org_id,'wallet-'||left(driver_id::text,8)||'@example.com','Wallet Driver','driver','tenant'),
    (other_id,org_id,'wallet-'||left(other_id::text,8)||'@example.com','Other Driver','driver','tenant'),
    (outside_id,other_org_id,'wallet-'||left(outside_id::text,8)||'@example.com','Outside Driver','driver','tenant');
  PERFORM public.provision_rbac_roles_from_templates_v1(org_id,ARRAY['driver'],driver_id);
  PERFORM public.provision_rbac_roles_from_templates_v1(other_org_id,ARRAY['driver'],outside_id);
  INSERT INTO public.rbac_user_role_assignments(
    organization_id,user_id,role_id,assigned_by_user_id,metadata)
  SELECT org_id,u.id,r.id,driver_id,'{"source":"pgtap"}'
  FROM (VALUES(driver_id),(other_id)) u(id)
  CROSS JOIN public.rbac_roles r
  WHERE r.organization_id=org_id AND r.key='driver'
  ON CONFLICT DO NOTHING;
  INSERT INTO public.rbac_user_role_assignments(
    organization_id,user_id,role_id,assigned_by_user_id,metadata)
  SELECT other_org_id,outside_id,r.id,outside_id,'{"source":"pgtap"}'
  FROM public.rbac_roles r WHERE r.organization_id=other_org_id AND r.key='driver'
  ON CONFLICT DO NOTHING;
  INSERT INTO public.finance_events(
    organization_id,event_type,direction,amount,currency,account_type,account_id,idempotency_key)
  VALUES
    (org_id,'adjustment','in',100,'SAR','driver_wallet',driver_id,'pgtap-wallet-credit'),
    (org_id,'payout','out',25,'SAR','driver_wallet',driver_id,'pgtap-wallet-payout'),
    (org_id,'adjustment','in',9007199254740993.123456789,'USD','driver_wallet',driver_id,'pgtap-wallet-precise-credit'),
    (org_id,'payout','out',0.000000001,'USD','driver_wallet',driver_id,'pgtap-wallet-precise-payout');
  INSERT INTO wallet_fixture SELECT org_id,driver_id,other_id,outside_id,
    (SELECT count(*) FROM public.finance_events),
    (SELECT count(*) FROM public.settlement_batches),
    (SELECT count(*) FROM public.settlement_events),
    (SELECT count(*) FROM public.finance_events WHERE event_type='payout');
END;
$fixture$;

SELECT is((public.compute_driver_wallet_summary_v1(
  organization_id,driver_user_id,'SAR')->>'balance')::numeric,75::numeric,
  'wallet balance is canonical in minus out') FROM wallet_fixture;
SELECT is((public.compute_driver_wallet_summary_v1(
  organization_id,driver_user_id,'SAR')->>'remitted_payout')::numeric,25::numeric,
  'wallet reports remitted payout outflow') FROM wallet_fixture;
SELECT ok((SELECT bool_and(jsonb_typeof(summary->key)='string')
  FROM wallet_fixture f
  CROSS JOIN LATERAL public.compute_driver_wallet_summary_v1(
    f.organization_id,f.driver_user_id,'USD') AS wallet(summary)
  CROSS JOIN (VALUES('balance'),('remitted_payout'),('reserved_withdrawal'),('available')) fields(key)),
  'all caller-visible wallet amounts are JSON strings');
SELECT is((public.compute_driver_wallet_summary_v1(
  organization_id,driver_user_id,'USD')->>'balance'),'9007199254740993.123456788',
  'high-precision balance is not rounded by JSON transport') FROM wallet_fixture;
SELECT is((public.compute_driver_wallet_summary_v1(
  organization_id,driver_user_id,'USD')->>'remitted_payout'),'0.000000001',
  'high-precision posted payout remains exact') FROM wallet_fixture;
SELECT is((public.compute_driver_wallet_summary_v1(
  organization_id,driver_user_id,'USD')->>'available'),'9007199254740993.123456788',
  'available remains exact decimal text') FROM wallet_fixture;


SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',(SELECT driver_user_id::text FROM wallet_fixture),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'role','authenticated','sub',(SELECT driver_user_id FROM wallet_fixture))::text,true);
SELECT is((public.ui_get_driver_wallet_summary_v1('USD')->>'balance'),
  '9007199254740993.123456788','authenticated wallet read preserves exact decimal text');
SELECT throws_ok(format(
  'SELECT api.ui_request_driver_wallet_withdrawal_v2(30,''SAR'',''pgtap-wrong-actor'',%L::uuid,%L::uuid)',
  gen_random_uuid(),organization_id),
  '42501','driver_wallet_scope_changed','switched actor cannot submit old wallet request')
  FROM wallet_fixture;
SELECT throws_ok(format(
  'SELECT api.ui_request_driver_wallet_withdrawal_v2(30,''SAR'',''pgtap-wrong-org'',%L::uuid,%L::uuid)',
  driver_user_id,gen_random_uuid()),
  '42501','driver_wallet_scope_changed','switched organization cannot submit old wallet request')
  FROM wallet_fixture;
SELECT is((SELECT count(*) FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
  WHERE tt.key='wallet_withdrawal_request'),0::bigint,
  'identity mismatch creates no withdrawal task');
SELECT is((api.ui_request_driver_wallet_withdrawal_v2(
  30,'sar','pgtap-request',driver_user_id,organization_id)->>'status'),
  'requested','bound API request succeeds for current driver and org') FROM wallet_fixture;
SELECT is((public.ui_get_driver_wallet_summary_v1('SAR')->>'reserved_withdrawal')::numeric,
  30::numeric,'request reserves wallet funds');
SELECT is((public.ui_get_driver_wallet_summary_v1('SAR')->>'available')::numeric,
  45::numeric,'available balance subtracts reservation');
SELECT is((public.ui_request_driver_wallet_withdrawal_v1(
  30,'SAR','pgtap-request')->>'status'),'existing','same retry converges');
SELECT throws_ok(
  $$SELECT public.ui_request_driver_wallet_withdrawal_v1(31,'SAR','pgtap-request')$$,
  '23505','driver_wallet_idempotency_conflict','mismatched retry fails');
SELECT throws_ok(
  $$SELECT public.ui_request_driver_wallet_withdrawal_v1(46,'SAR','pgtap-overdraw')$$,
  '23514','driver_wallet_insufficient_available_balance','overdraw fails');
SELECT ok(current_setting('request.jwt.claim.sub',true)=(SELECT driver_user_id::text FROM wallet_fixture)
  AND current_setting('request.jwt.claim.role',true)='authenticated'
  AND current_setting('request.jwt.claims',true)::jsonb->>'sub'=(SELECT driver_user_id::text FROM wallet_fixture),
  'request restores caller claims');

SELECT set_config('request.jwt.claim.sub',(SELECT other_user_id::text FROM wallet_fixture),true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'role','authenticated','sub',(SELECT other_user_id FROM wallet_fixture))::text,true);
SELECT throws_ok(format('SELECT public.ui_get_driver_wallet_summary_v1(''SAR'',''%s''::uuid)',
  (SELECT driver_user_id FROM wallet_fixture)),'42501','driver_wallet_forbidden',
  'same-org driver cannot read another wallet');
SELECT is((SELECT count(*) FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
  WHERE tt.key='wallet_withdrawal_request'),0::bigint,'same-org wallet task is private');

SELECT set_config('request.jwt.claim.sub',(SELECT outside_user_id::text FROM wallet_fixture),true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'role','authenticated','sub',(SELECT outside_user_id FROM wallet_fixture))::text,true);
SELECT is((SELECT count(*) FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
  WHERE tt.key='wallet_withdrawal_request'),0::bigint,'cross-org wallet task is private');

SET LOCAL ROLE postgres;
SELECT ok((SELECT count(*) FROM public.finance_events)=(SELECT finance_count FROM wallet_fixture)
  AND (SELECT count(*) FROM public.settlement_batches)=(SELECT settlement_count FROM wallet_fixture)
  AND (SELECT count(*) FROM public.settlement_events)=(SELECT settlement_event_count FROM wallet_fixture)
  AND (SELECT count(*) FROM public.finance_events WHERE event_type='payout')=(SELECT payout_count FROM wallet_fixture),
  'request writes no finance, settlement, or payout truth');

ALTER TABLE wallet_fixture ADD COLUMN route_run_id UUID;
ALTER TABLE wallet_fixture ADD COLUMN route_task_id UUID;
DO $route$
DECLARE
  f wallet_fixture%ROWTYPE;
  branch_id UUID:=gen_random_uuid(); vehicle_id UUID:=gen_random_uuid();
  client_id UUID:=gen_random_uuid(); shipment_id UUID:=gen_random_uuid();
  route_id UUID; stop_id UUID; task_id UUID;
BEGIN
  SELECT * INTO f FROM wallet_fixture;
  INSERT INTO public.finance_events(
    organization_id,event_type,direction,amount,currency,account_type,account_id,idempotency_key)
  VALUES(f.organization_id,'adjustment','in',10,'POINTS','driver_wallet',
    f.driver_user_id,'pgtap-wallet-non-iso');
  INSERT INTO public.branches(id,organization_id,code,name,timezone,is_active)
  VALUES(branch_id,f.organization_id,'wallet-'||left(branch_id::text,8),
    'Wallet Branch','Asia/Riyadh',TRUE);
  INSERT INTO public.vehicles(id,organization_id,status,is_active)
  VALUES(vehicle_id,f.organization_id,'active',TRUE);
  INSERT INTO public.clients(id,organization_id,name,slug,sla_tier,status,settings_override)
  VALUES(client_id,f.organization_id,'Wallet Client','wallet-client-'||left(client_id::text,8),
    'standard','active','{}');
  INSERT INTO public.shipments(
    id,organization_id,client_id,service_type,tracking_number,status,
    shipment_settings_override,metadata)
  VALUES(shipment_id,f.organization_id,client_id,'delivery','WAL-'||left(shipment_id::text,8),
    'out_for_delivery','{}','{}');
  SELECT made.route_run_id,made.stop_ids[1] INTO route_id,stop_id
  FROM public.create_route_run_v1(jsonb_build_object(
    'organization_id',f.organization_id,'branch_id',branch_id,
    'driver_user_id',f.driver_user_id,'vehicle_id',vehicle_id,
    'idempotency_key','pgtap-wallet-route',
    'stops',jsonb_build_array(jsonb_build_object(
      'client_id',client_id,'shipment_id',shipment_id,
      'stop_kind','delivery','sequence_order',1)))) made;
  UPDATE public.route_runs SET status='in_progress',
    metadata='{"cod_truth":{"expected_amount":11},"parcel_mismatch":{"status":"open"}}'
  WHERE id=route_id;
  SELECT made.task_id INTO task_id FROM public.create_task_system_v1(jsonb_build_object(
    'task_type_key','route_stop_execute',
    'context',jsonb_build_object('organization_id',f.organization_id),
    'resource_type','route_stop','resource_id',stop_id,
    'idempotency_key','pgtap-wallet-route-task')) made;
  UPDATE wallet_fixture SET route_run_id=route_id,route_task_id=task_id;
END;
$route$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',(SELECT driver_user_id::text FROM wallet_fixture),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'role','authenticated','sub',(SELECT driver_user_id FROM wallet_fixture))::text,true);
SELECT lives_ok(format('SELECT public.close_route_run_v1(%L::jsonb)',
  jsonb_build_object(
    'task_id',(SELECT route_task_id FROM wallet_fixture),
    'vehicle_secured_ack','confirmed','proofs_synced_ack','confirmed',
    'exceptions_reviewed_ack','confirmed','leftover_stop_count',1,
    'leftover_notes','One stop remains','closeout_notes','Wallet reconciliation')::text),
  'route closeout records wallet reconciliation');

SET LOCAL ROLE postgres;
SELECT ok((SELECT status='in_progress'
  AND metadata#>>'{cod_truth,expected_amount}'='11'
  AND metadata#>>'{parcel_mismatch,status}'='open'
  FROM public.route_runs rr JOIN wallet_fixture f ON f.route_run_id=rr.id),
  'closeout preserves route status, COD truth, and parcel mismatch');
SELECT is((SELECT (entry->>'balance')::numeric
  FROM public.route_runs rr JOIN wallet_fixture f ON f.route_run_id=rr.id
  CROSS JOIN LATERAL jsonb_array_elements(
    rr.metadata#>'{route_closeout,wallet_reconciliation,summaries}') entry
  WHERE entry->>'currency'='SAR'),75::numeric,
  'closeout stores wallet snapshot');
SELECT ok(NOT EXISTS(
  SELECT 1 FROM public.route_runs rr JOIN wallet_fixture f ON f.route_run_id=rr.id
  CROSS JOIN LATERAL jsonb_array_elements(
    rr.metadata#>'{route_closeout,wallet_reconciliation,summaries}') entry
  WHERE entry->>'currency'='POINTS'),
  'closeout excludes non-ISO ledger currencies');

SELECT * FROM finish();
ROLLBACK;
