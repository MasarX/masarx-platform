-- Plan: B10 UC221 shipment identifier search / Step: E01
-- pgTAP: shipment identifier search UI contract

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(41);

CREATE OR REPLACE FUNCTION pg_temp.index_contract_matches(
  p_index_oid OID,
  p_columns TEXT[],
  p_opclasses TEXT[],
  p_collations TEXT[],
  p_predicate TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $contract$
  SELECT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_am am ON am.oid = ic.relam
     WHERE i.indexrelid = p_index_oid
       AND i.indisready
       AND i.indisvalid
       AND NOT i.indisunique
       AND NOT i.indisprimary
       AND am.amname = 'btree'
       AND i.indnatts = cardinality(p_columns)
       AND i.indnkeyatts = cardinality(p_columns)
       AND ARRAY(
         SELECT attribute.attname::text
           FROM generate_series(0, i.indnkeyatts - 1) AS key_position(position)
           JOIN pg_attribute attribute
             ON attribute.attrelid = i.indrelid
            AND attribute.attnum = (i.indkey::int2[])[key_position.position]
          ORDER BY key_position.position
       ) = p_columns
       AND ARRAY(
         SELECT opclass.opcname::text
           FROM generate_series(0, i.indnkeyatts - 1) AS key_position(position)
           JOIN pg_opclass opclass
             ON opclass.oid = (i.indclass::oid[])[key_position.position]
          ORDER BY key_position.position
       ) = p_opclasses
       AND ARRAY(
         SELECT (i.indoption::int2[])[key_position.position]
           FROM generate_series(0, i.indnkeyatts - 1) AS key_position(position)
          ORDER BY key_position.position
       ) = array_fill(0::smallint, ARRAY[cardinality(p_columns)])
       AND ARRAY(
         SELECT collation_row.collname::text
           FROM generate_series(0, i.indnkeyatts - 1) AS key_position(position)
           LEFT JOIN pg_collation collation_row
             ON collation_row.oid = (i.indcollation::oid[])[key_position.position]
          ORDER BY key_position.position
       ) IS NOT DISTINCT FROM p_collations
       AND regexp_replace(
             lower(COALESCE(pg_get_expr(i.indpred, i.indrelid), '')),
             '["()[:space:]]',
             '',
             'g'
           ) = p_predicate
  );
$contract$;

CREATE OR REPLACE FUNCTION pg_temp.test_b10_uc221_shipment_identifier_search_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_client_operator UUID := gen_random_uuid();
  v_sender_operator UUID := gen_random_uuid();
  v_denied_operator UUID := gen_random_uuid();
  v_role_id UUID := NULL;
  v_recipient UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_peer_client UUID := gen_random_uuid();
  v_peer_client_sender UUID := gen_random_uuid();
  v_peer_client_recipient UUID := gen_random_uuid();
  v_peer_client_shipment UUID := gen_random_uuid();
  v_peer_sender UUID := gen_random_uuid();
  v_peer_sender_recipient UUID := gen_random_uuid();
  v_peer_sender_shipment UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_other_client UUID := gen_random_uuid();
  v_other_sender UUID := gen_random_uuid();
  v_other_recipient UUID := gen_random_uuid();
  v_other_shipment UUID := gen_random_uuid();
  v_decision_correlation UUID := gen_random_uuid();
  v_workflow_correlation UUID := gen_random_uuid();
  v_domain_correlation UUID := gen_random_uuid();
  v_outbound_correlation UUID := gen_random_uuid();
  v_workflow_template UUID := gen_random_uuid();
  v_workflow_template_step UUID := gen_random_uuid();
  v_workflow_run UUID := gen_random_uuid();
  v_workflow_run_step UUID := gen_random_uuid();
  v_tracking TEXT := 'UC221-' || upper(left(v_shipment::text, 8));
  v_peer_client_tracking TEXT := 'UC221-CLIENT-' || upper(left(v_peer_client_shipment::text, 8));
  v_peer_sender_tracking TEXT := 'UC221-SENDER-' || upper(left(v_peer_sender_shipment::text, 8));
  v_other_tracking TEXT := 'UC221-OTHER-' || upper(left(v_other_shipment::text, 8));
  v_reference TEXT := 'UC221-REF-' || upper(left(v_shipment::text, 8));
  v_phone TEXT := '+966551234567';
  v_peer_sender_phone TEXT := '+966551234568';
  v_search_ids UUID[] := ARRAY[]::uuid[];
  v_uuid_ids UUID[] := ARRAY[]::uuid[];
  v_list JSONB := NULL;
  v_function_def TEXT := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'public',
    'ui_search_shipment_identifier_ids_v1',
    ARRAY['text[]'],
    'public.ui_search_shipment_identifier_ids_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'public.ui_search_shipment_identifier_ids_v1(text[])',
      'EXECUTE'
    ),
    'authenticated can execute public.ui_search_shipment_identifier_ids_v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings setting_row
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(setting_row.cached_value->'resources', '[]'::jsonb)
      ) AS resource(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS filter(value)
      WHERE setting_row.category = 'ui_read_registry'
        AND resource.value->>'key' = 'shipments'
        AND filter.value->>'key' = 'identifier'
        AND filter.value->>'resolver' = 'shipment_identifier'
    ),
    'ui_read_registry exposes shipments.identifier with shipment_identifier resolver'
  );
  RETURN NEXT matches(
    pg_get_functiondef('public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure),
    'ui_read_caller_filter_sql_v1',
    'ui_list_resource_v1 uses checked caller-filter compilation'
  );
  RETURN NEXT matches(
    pg_get_functiondef('public.ui_resource_metrics_v1(text,jsonb,text[])'::regprocedure),
    'ui_read_caller_filter_sql_v1',
    'ui_resource_metrics_v1 uses checked caller-filter compilation'
  );

  RETURN NEXT matches(
    pg_get_functiondef('public.ui_read_caller_filter_sql_v1(jsonb,jsonb,text[])'::regprocedure),
    'ui_filter_flat_sql_v1',
    'checked caller-filter compiler delegates flat filters to the shared compiler'
  );

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'UC221 Search Org', 'uc221-search-' || left(v_org::text, 8));

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_other_org, 'UC221 Other Org', 'uc221-other-' || left(v_other_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (v_client, v_org, 'UC221 Search Client', 'uc221-client-' || left(v_client::text, 8), 'standard', 'active');

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (v_peer_client, v_org, 'UC221 Peer Client', 'uc221-peer-client-' || left(v_peer_client::text, 8), 'standard', 'active');

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (v_other_client, v_other_org, 'UC221 Other Client', 'uc221-other-client-' || left(v_other_client::text, 8), 'standard', 'active');

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'UC221 Search Sender', 'active');

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_peer_sender, v_client, 'UC221 Peer Sender', 'active');

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_peer_client_sender, v_peer_client, 'UC221 Peer Client Sender', 'active');

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_other_sender, v_other_client, 'UC221 Other Sender', 'active');

  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:uc221-search-fixture-bootstrap');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_operator,
    v_org,
    'uc221-search-' || left(v_operator::text, 8) || '@example.com',
    'UC221 Operator',
    'ops_admin',
    'tenant'
  );

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_denied_operator,
    v_org,
    'uc221-denied-' || left(v_denied_operator::text, 8) || '@example.com',
    'UC221 Denied Operator',
    'driver',
    'tenant'
  );

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_client_operator,
    v_org,
    'uc221-client-' || left(v_client_operator::text, 8) || '@example.com',
    'UC221 Client Operator',
    'client_admin',
    'client',
    v_client
  );

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_sender_operator,
    v_org,
    'uc221-sender-' || left(v_sender_operator::text, 8) || '@example.com',
    'UC221 Sender Operator',
    'sender_user',
    'sender',
    v_sender
  );

  SELECT role_id
    INTO v_role_id
    FROM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin']::TEXT[], v_operator)
   LIMIT 1;

  IF v_role_id IS NOT NULL THEN
    INSERT INTO public.rbac_user_role_assignments (
      organization_id,
      user_id,
      role_id,
      assigned_by_user_id,
      metadata
    )
    VALUES (
      v_org,
      v_operator,
      v_role_id,
      v_operator,
      '{"seed":true,"source":"pgtap","template_key":"ops_admin"}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.recipients (
    id,
    organization_id,
    client_id,
    name,
    phone_number,
    phone_number_normalized,
    preferred_language
  )
  VALUES (
    v_recipient,
    v_org,
    v_client,
    'UC221 Recipient',
    v_phone,
    public.normalize_phone_number(v_phone),
    'en'
  );

  INSERT INTO public.recipients (
    id,
    organization_id,
    client_id,
    name,
    phone_number,
    phone_number_normalized,
    preferred_language
  )
  VALUES (
    v_peer_client_recipient,
    v_org,
    v_peer_client,
    'UC221 Peer Client Recipient',
    v_phone,
    public.normalize_phone_number(v_phone),
    'en'
  );

  INSERT INTO public.recipients (
    id,
    organization_id,
    client_id,
    name,
    phone_number,
    phone_number_normalized,
    preferred_language
  )
  VALUES (
    v_peer_sender_recipient,
    v_org,
    v_client,
    'UC221 Peer Sender Recipient',
    v_peer_sender_phone,
    public.normalize_phone_number(v_peer_sender_phone),
    'en'
  );

  INSERT INTO public.recipients (
    id,
    organization_id,
    client_id,
    name,
    phone_number,
    phone_number_normalized,
    preferred_language
  )
  VALUES (
    v_other_recipient,
    v_other_org,
    v_other_client,
    'UC221 Other Recipient',
    v_phone,
    public.normalize_phone_number(v_phone),
    'en'
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    recipient_id,
    box_count
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    'delivery',
    v_tracking,
    'pending',
    v_recipient,
    1
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    recipient_id,
    box_count
  )
  VALUES (
    v_peer_client_shipment,
    v_org,
    v_peer_client,
    v_peer_client_sender,
    'delivery',
    v_peer_client_tracking,
    'pending',
    v_peer_client_recipient,
    1
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    recipient_id,
    box_count
  )
  VALUES (
    v_peer_sender_shipment,
    v_org,
    v_client,
    v_peer_sender,
    'delivery',
    v_peer_sender_tracking,
    'pending',
    v_peer_sender_recipient,
    1
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    recipient_id,
    box_count
  )
  VALUES (
    v_other_shipment,
    v_other_org,
    v_other_client,
    v_other_sender,
    'delivery',
    v_other_tracking,
    'pending',
    v_other_recipient,
    1
  );

  INSERT INTO public.shipment_reference_numbers (
    organization_id,
    client_id,
    shipment_id,
    reference_type,
    reference_value,
    source_type,
    metadata
  )
  VALUES (
    v_org,
    v_client,
    v_shipment,
    'client_reference_number',
    v_reference,
    'pgtap',
    '{}'::jsonb
  );

  INSERT INTO public.decision_log (
    id,
    organization_id,
    decision_category,
    resource_type,
    resource_id,
    decision_point,
    decision_outcome,
    decision_inputs,
    performed_by_system,
    correlation_id
  )
  VALUES (
    gen_random_uuid(),
    v_org,
    'security',
    'shipment',
    v_shipment,
    'uc221_identifier_search',
    'matched',
    '{}'::jsonb,
    'pgtap',
    v_decision_correlation
  );

  INSERT INTO public.workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type
  )
  VALUES (
    v_workflow_template,
    'uc221_identifier_search_' || left(v_workflow_template::text, 8),
    'UC221 identifier correlation fixture',
    1,
    'active',
    'global'
  );

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    handler_key,
    handler_version,
    enabled
  )
  VALUES (
    v_workflow_template_step,
    v_workflow_template,
    1,
    'uc221_identifier_search',
    'always',
    'workflow_control',
    'v1',
    TRUE
  );

  PERFORM set_config('app.workflow_run_id', v_workflow_run::text, true);
  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    triggered_by_request_id,
    entry_point,
    workflow_status,
    context
  )
  VALUES (
    v_workflow_run,
    v_workflow_template,
    1,
    v_workflow_correlation,
    'pgtap',
    'pending',
    jsonb_build_object('shipment_id', v_shipment)
  );

  INSERT INTO public.workflow_run_steps (
    id,
    workflow_run_id,
    workflow_template_step_id,
    sequence_order,
    step_status,
    operation_name,
    handler_key,
    handler_version,
    max_retries,
    enqueued_at,
    created_at,
    updated_at
  )
  VALUES (
    v_workflow_run_step,
    v_workflow_run,
    v_workflow_template_step,
    1,
    'pending',
    'uc221_identifier_search',
    'workflow_control',
    'v1',
    1,
    now(),
    now(),
    now()
  );

  INSERT INTO public.domain_events (
    organization_id,
    event_type,
    resource_type,
    resource_id,
    correlation_id,
    payload,
    status
  )
  VALUES (
    v_org,
    'uc221_identifier_search',
    'shipment',
    v_shipment,
    v_domain_correlation,
    '{}'::jsonb,
    'pending'
  );

  PERFORM set_config('app.workflow_run_step_id', v_workflow_run_step::text, true);
  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    status,
    correlation_id,
    shipment_id,
    context,
    workflow_run_step_id
  )
  VALUES (
    'client_webhook',
    'recipient',
    v_recipient,
    'POST',
    'https://example.invalid/uc221',
    'pending',
    v_outbound_correlation,
    v_shipment,
    '{}'::jsonb,
    v_workflow_run_step
  );

  PERFORM set_config('test.uc221_denied_user', v_denied_operator::text, true);
  PERFORM set_config('test.uc221_denied_query', v_tracking, true);

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_operator::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_search_ids := public.ui_search_shipment_identifier_ids_v1(ARRAY[v_tracking, v_reference, v_phone]);
  RETURN NEXT ok(
    v_shipment = ANY(COALESCE(v_search_ids, ARRAY[]::uuid[])),
    'ui_search_shipment_identifier_ids_v1 resolves shipment from tracking/reference/phone inputs'
  );
  RETURN NEXT ok(
    NOT (v_other_shipment = ANY(COALESCE(v_search_ids, ARRAY[]::uuid[]))),
    'ui_search_shipment_identifier_ids_v1 keeps same-phone matches tenant isolated'
  );

  RETURN NEXT is(
    cardinality(public.ui_search_shipment_identifier_ids_v1(ARRAY['UC221-NOT-FOUND'])),
    0,
    'ui_search_shipment_identifier_ids_v1 returns empty for absent identifiers'
  );

  v_uuid_ids := public.ui_search_shipment_identifier_ids_v1(ARRAY[v_decision_correlation::text]);
  RETURN NEXT ok(
    v_shipment = ANY(COALESCE(v_uuid_ids, ARRAY[]::uuid[])),
    'decision_log correlation resolves for an audit-capable caller'
  );

  RETURN NEXT ok(
    v_shipment = ANY(public.ui_search_shipment_identifier_ids_v1(ARRAY[v_workflow_correlation::text])),
    'workflow_runs correlation resolves for an observability-capable caller'
  );
  RETURN NEXT ok(
    v_shipment = ANY(public.ui_search_shipment_identifier_ids_v1(ARRAY[v_domain_correlation::text])),
    'domain_events correlation resolves for a requests-capable caller'
  );
  RETURN NEXT ok(
    v_shipment = ANY(public.ui_search_shipment_identifier_ids_v1(ARRAY[v_outbound_correlation::text])),
    'outbound_calls correlation resolves for an observability-capable caller'
  );

  v_list := public.ui_list_resource_v1(
    'shipments',
    jsonb_build_object('identifier', v_reference),
    10,
    0,
    NULL
  );
  RETURN NEXT is(
    (v_list->>'total')::INT,
    1,
    'ui_list_resource_v1 filters shipments by identifier'
  );
  RETURN NEXT is(
    v_list->'items'->0->>'id',
    v_shipment::text,
    'ui_list_resource_v1 returns the matched shipment row'
  );

  EXECUTE 'RESET ROLE';
  UPDATE public.shipments SET client_reference_number = v_tracking WHERE id = v_peer_client_shipment;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_list := public.ui_list_resource_v1('shipments', jsonb_build_object('identifier', v_tracking), 2);
  RETURN NEXT is((v_list->>'total')::INT, 2, 'generic identifier includes another shipment client-reference collision');
  v_list := public.ui_list_resource_v1('shipments', jsonb_build_object('op', 'and', 'rules', jsonb_build_array(
    jsonb_build_object('key', 'tracking_number', 'op', 'eq', 'value', v_tracking)
  )), 1);
  RETURN NEXT is((v_list->>'total')::INT, 1, 'handoff exact-source equality is applied before count and limit');
  RETURN NEXT is(v_list->'items'->0->>'id', v_shipment::TEXT, 'handoff ignores the unrelated client-reference collision');

  EXECUTE 'RESET ROLE';
  UPDATE public.shipments SET tracking_number = v_tracking WHERE id = v_other_shipment;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_list := public.ui_list_resource_v1('shipments', jsonb_build_object('op', 'and', 'rules', jsonb_build_array(
    jsonb_build_object('key', 'tracking_number', 'op', 'eq', 'value', v_tracking)
  )), 2);
  RETURN NEXT is((v_list->>'total')::INT, 1, 'handoff exact-source equality preserves tenant isolation');

  EXECUTE 'RESET ROLE';
  UPDATE public.shipments SET tracking_number = v_tracking WHERE id = v_peer_client_shipment;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_list := public.ui_list_resource_v1('shipments', jsonb_build_object('op', 'and', 'rules', jsonb_build_array(
    jsonb_build_object('key', 'tracking_number', 'op', 'eq', 'value', v_tracking)
  )), 2);
  RETURN NEXT is((v_list->>'total')::INT, 2, 'handoff retains true duplicate configured-source matches');
  RETURN NEXT is(jsonb_array_length(v_list->'items'), 2, 'handoff receives both true duplicates to fail closed');
  EXECUTE 'RESET ROLE';
  UPDATE public.shipments SET tracking_number = v_peer_client_tracking, client_reference_number = NULL WHERE id = v_peer_client_shipment;
  UPDATE public.shipments SET tracking_number = v_other_tracking WHERE id = v_other_shipment;
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is(
    (public.ui_resource_metrics_v1(
      'shipments',
      jsonb_build_object('identifier', v_tracking),
      ARRAY['box_count']
    )->>'total')::INT,
    1,
    'ui_resource_metrics_v1 honors the identifier filter'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_client_operator::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_client_operator::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT ok(
    v_shipment = ANY(public.ui_search_shipment_identifier_ids_v1(ARRAY[v_tracking])),
    'client-scoped caller resolves identifiers in its own client'
  );
  RETURN NEXT is(
    cardinality(public.ui_search_shipment_identifier_ids_v1(ARRAY[v_peer_client_tracking])),
    0,
    'client-scoped caller cannot resolve another client in the same tenant'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_sender_operator::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sender_operator::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT ok(
    public.user_has_capability_v1('shipments.read', 'sender', v_sender)
      AND NOT public.user_has_capability_v1('audit_log.read', 'sender', v_sender)
      AND NOT public.user_has_capability_v1('requests.read', 'sender', v_sender),
    'sender fixture has shipments.read without audit_log.read or requests.read'
  );
  RETURN NEXT ok(
    v_shipment = ANY(public.ui_search_shipment_identifier_ids_v1(ARRAY[v_tracking])),
    'sender-scoped caller still resolves ordinary identifiers in its own scope'
  );
  RETURN NEXT is(
    cardinality(public.ui_search_shipment_identifier_ids_v1(ARRAY[v_peer_sender_tracking])),
    0,
    'sender-scoped caller cannot resolve another sender in the same client'
  );
  RETURN NEXT is(
    cardinality(public.ui_search_shipment_identifier_ids_v1(ARRAY[v_decision_correlation::text])),
    0,
    'decision_log correlation is hidden without audit_log.read'
  );
  RETURN NEXT is(
    cardinality(public.ui_search_shipment_identifier_ids_v1(ARRAY[v_workflow_correlation::text])),
    0,
    'workflow_runs correlation is hidden without audit_log.read or requests.read'
  );
  RETURN NEXT is(
    cardinality(public.ui_search_shipment_identifier_ids_v1(ARRAY[v_domain_correlation::text])),
    0,
    'domain_events correlation is hidden without requests.read'
  );
  RETURN NEXT is(
    cardinality(public.ui_search_shipment_identifier_ids_v1(ARRAY[v_outbound_correlation::text])),
    0,
    'outbound_calls correlation is hidden without audit_log.read or requests.read'
  );

  v_function_def := pg_get_functiondef('public.ui_search_shipment_identifier_ids_v1(text[])'::regprocedure);
  RETURN NEXT ok(
    position('v_has_uuid_query' IN v_function_def) > 0,
    'ui_search_shipment_identifier_ids_v1 precomputes UUID query presence'
  );
  RETURN NEXT ok(
    v_function_def LIKE '%JOIN public.workflow_runs wr%'
      AND v_function_def LIKE '%ON (v_can_read_audit_log OR v_can_read_requests)%'
      AND v_function_def LIKE '%wr.triggered_by_request_id = nq.query_uuid%',
    'workflow correlation branch remains capability gated and UUID scoped'
  );
  RETURN NEXT ok(
    v_function_def LIKE '%JOIN public.decision_log dl%'
      AND v_function_def LIKE '%ON v_can_read_audit_log%'
      AND v_function_def LIKE '%dl.correlation_id = nq.query_uuid%',
    'audit correlation branch remains capability gated and UUID scoped'
  );
  RETURN NEXT ok(
    v_function_def LIKE '%JOIN public.domain_events de%'
      AND v_function_def LIKE '%ON v_can_read_requests%'
      AND v_function_def LIKE '%de.correlation_id = nq.query_uuid%',
    'domain event correlation branch remains capability gated and UUID scoped'
  );
  RETURN NEXT ok(
    position('JOIN public.outbound_calls oc' IN v_function_def) > 0
      AND position('ON (v_can_read_audit_log OR v_can_read_requests)' IN substring(
        v_function_def
        FROM position('JOIN public.outbound_calls oc' IN v_function_def)
      )) > 0
      AND position('oc.correlation_id = nq.query_uuid' IN substring(
        v_function_def
        FROM position('JOIN public.outbound_calls oc' IN v_function_def)
      )) > 0,
    'outbound_calls correlation branch remains capability gated and UUID scoped'
  );
  RETURN NEXT ok(
    position('IF NOT v_has_uuid_query THEN' IN v_function_def) > 0
      AND position('IF NOT v_has_uuid_query THEN' IN v_function_def)
        < position('JOIN public.workflow_runs wr' IN v_function_def),
    'non-UUID input returns before any correlation relation statement is reached'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_am am ON am.oid = ic.relam
       WHERE i.indrelid = 'public.workflow_runs'::regclass
         AND ic.relname = 'idx_workflow_runs_triggered_by_request_id_not_null'
         AND pg_temp.index_contract_matches(
           i.indexrelid,
           ARRAY['triggered_by_request_id']::text[],
           ARRAY['uuid_ops']::text[],
           ARRAY[NULL::text],
           'triggered_by_request_idisnotnull'
         )
    ),
    'workflow_runs correlation index has the exact ready and valid partial-index contract'
  );
  RETURN NEXT ok(
    (
      WITH RECURSIVE index_tree AS (
        SELECT i.indexrelid, i.indrelid
          FROM pg_index i
          JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE i.indrelid = 'public.decision_log'::regclass
           AND ic.relname = 'idx_decision_log_org_correlation_not_null'
        UNION ALL
        SELECT child_i.indexrelid, child_i.indrelid
          FROM index_tree parent_i
          JOIN pg_inherits inh ON inh.inhparent = parent_i.indexrelid
          JOIN pg_index child_i ON child_i.indexrelid = inh.inhrelid
      ), table_tree AS (
        SELECT relid FROM pg_partition_tree('public.decision_log'::regclass)
      )
      SELECT
        (SELECT count(*) FROM index_tree) = (SELECT count(*) FROM table_tree)
        AND NOT EXISTS (
          SELECT 1 FROM table_tree t
          WHERE NOT EXISTS (SELECT 1 FROM index_tree i WHERE i.indrelid = t.relid)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM index_tree tree_index
          WHERE NOT pg_temp.index_contract_matches(
            tree_index.indexrelid,
            ARRAY['organization_id', 'correlation_id']::text[],
            ARRAY['uuid_ops', 'uuid_ops']::text[],
            ARRAY[NULL::text, NULL::text],
            'correlation_idisnotnull'
          )
        )
    ),
    'decision_log online index is ready, valid, and attached across the complete HASH-to-RANGE tree'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_am am ON am.oid = ic.relam
       WHERE i.indrelid = 'public.domain_events'::regclass
         AND ic.relname = 'idx_domain_events_org_correlation_resource_not_null'
         AND pg_temp.index_contract_matches(
           i.indexrelid,
           ARRAY['organization_id', 'correlation_id', 'resource_type', 'resource_id']::text[],
           ARRAY['uuid_ops', 'uuid_ops', 'text_ops', 'uuid_ops']::text[],
           ARRAY[NULL::text, NULL::text, 'default'::text, NULL::text],
           'correlation_idisnotnullandresource_idisnotnull'
         )
    ),
    'domain_events correlation index has the exact ready and valid partial-index contract'
  );

  EXECUTE 'RESET ROLE';
END;
$function$;

SELECT * FROM pg_temp.test_b10_uc221_shipment_identifier_search_v1();

SELECT set_config('request.jwt.claim.sub', current_setting('test.uc221_denied_user'), true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('test.uc221_denied_user'), 'role', 'authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_search_shipment_identifier_ids_v1(ARRAY[current_setting('test.uc221_denied_query')]) $$,
  '42501',
  'Capability denied: shipments.read'
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
