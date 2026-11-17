-- Plan: PLAN-202601-settings-policy-context-resolver-v1 / Step: S95
-- pgTAP: Canonical policy-context resolver invariants (precedence + derivation)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

SELECT has_function(
  'public',
  'resolve_settings_row_from_policy_context_v1',
  ARRAY['text','jsonb'],
  'resolve_settings_row_from_policy_context_v1(text,jsonb) exists'
);

SELECT has_function(
  'public',
  'resolve_cod_policy',
  ARRAY['jsonb'],
  'resolve_cod_policy(jsonb) exists'
);

SELECT has_function(
  'public',
  'resolve_settlement_policy',
  ARRAY['jsonb'],
  'resolve_settlement_policy(jsonb) exists'
);

SELECT has_function(
  'public',
  'resolve_commercial_terms_v1',
  ARRAY['jsonb'],
  'resolve_commercial_terms_v1(jsonb) exists'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_mapping UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();

  v_tenant_version UUID;
  v_client_version UUID;
  v_sender_version UUID;
  v_source_version UUID;
  v_resource_version UUID;

  v_res RECORD;
  v_terms JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Policy Context Org', 'policy-ctx-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Policy Context Client', 'policy-ctx-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Policy Context Sender', 'active');

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES (v_branch, v_org, 'branch-' || left(v_branch::text, 6), 'Policy Branch', TRUE);

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_mapping, 'webhook_inbound', 'pgtap-policy-ctx::default', '{}'::jsonb, 1, 'pgTAP policy context mapping');

  INSERT INTO public.webhook_sources (
    id, organization_id, sender_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
  )
  VALUES (
    v_source, v_org, v_sender, 'pgtap-policy-ctx', 'pgTAP Policy Context Source', 'provider', 'token-pgtap-policy-ctx', v_mapping, TRUE
  );

  -- Tenant row: flat=10 (fallback when no higher scope matches).
  SELECT up.settings_version_id
    INTO v_tenant_version
    FROM public.upsert_settings_value_v1(
      p_category := 'pricing_policy',
      p_scope_type := 'tenant',
      p_scope_id := v_org,
      p_value := jsonb_build_object('version', 1, 'enabled', true, 'currency', 'SAR', 'rules', jsonb_build_array()),
      p_schema_version := 1,
      p_change_reason := 'pgtap settings_policy_context_resolver_v1'
    ) AS up
   LIMIT 1;

  -- Client row.
  SELECT up.settings_version_id
    INTO v_client_version
    FROM public.upsert_settings_value_v1(
      p_category := 'pricing_policy',
      p_scope_type := 'client',
      p_scope_id := v_client,
      p_value := jsonb_build_object('version', 1, 'enabled', true, 'currency', 'SAR', 'rules', jsonb_build_array(jsonb_build_object('priority', 1))),
      p_schema_version := 1,
      p_change_reason := 'pgtap settings_policy_context_resolver_v1'
    ) AS up
   LIMIT 1;

  -- Sender row.
  SELECT up.settings_version_id
    INTO v_sender_version
    FROM public.upsert_settings_value_v1(
      p_category := 'pricing_policy',
      p_scope_type := 'sender',
      p_scope_id := v_sender,
      p_value := jsonb_build_object('version', 1, 'enabled', true, 'currency', 'SAR', 'rules', jsonb_build_array(jsonb_build_object('priority', 2))),
      p_schema_version := 1,
      p_change_reason := 'pgtap settings_policy_context_resolver_v1'
    ) AS up
   LIMIT 1;

  -- Source row.
  SELECT up.settings_version_id
    INTO v_source_version
    FROM public.upsert_settings_value_v1(
      p_category := 'pricing_policy',
      p_scope_type := 'source',
      p_scope_id := v_source,
      p_value := jsonb_build_object('version', 1, 'enabled', true, 'currency', 'SAR', 'rules', jsonb_build_array(jsonb_build_object('priority', 3))),
      p_schema_version := 1,
      p_change_reason := 'pgtap settings_policy_context_resolver_v1'
    ) AS up
   LIMIT 1;

  -- Resource row (branch).
  SELECT up.settings_version_id
    INTO v_resource_version
    FROM public.upsert_settings_value_v1(
      p_category := 'pricing_policy',
      p_scope_type := 'resource',
      p_scope_id := v_branch,
      p_value := jsonb_build_object('version', 1, 'enabled', true, 'currency', 'SAR', 'rules', jsonb_build_array(jsonb_build_object('priority', 4))),
      p_schema_version := 1,
      p_change_reason := 'pgtap settings_policy_context_resolver_v1'
    ) AS up
   LIMIT 1;

  DELETE FROM public.settings_cache
  WHERE cache_key LIKE 'pricing_policy:%';

  SELECT *
    INTO v_res
    FROM public.resolve_settings_row_from_policy_context_v1(
      'pricing_policy',
      jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender, 'webhook_source_id', v_source, 'resource_id', v_branch)
    )
   LIMIT 1;

  PERFORM is(v_res.scope_type, 'resource', 'policy context resolver prefers resource over source/sender/client/tenant');

  -- Without resource_id, source should win (even if sender/client/tenant are present).
  SELECT *
    INTO v_res
    FROM public.resolve_settings_row_from_policy_context_v1(
      'pricing_policy',
      jsonb_build_object('webhook_source_id', v_source, 'sender_id', v_sender, 'client_id', v_client, 'organization_id', v_org)
    )
   LIMIT 1;

  PERFORM is(v_res.scope_type, 'source', 'policy context resolver prefers source when resource is absent');

  -- With only sender/client/tenant provided: sender wins.
  SELECT *
    INTO v_res
    FROM public.resolve_settings_row_from_policy_context_v1(
      'pricing_policy',
      jsonb_build_object('sender_id', v_sender, 'client_id', v_client, 'organization_id', v_org)
    )
   LIMIT 1;

  PERFORM is(v_res.scope_type, 'sender', 'policy context resolver prefers sender when source/resource absent');

  -- Tenant fallback derived from resource_scope_rel when organization_id is omitted and resource row is missing.
  DELETE FROM public.settings WHERE category = 'pricing_policy' AND scope_type = 'resource' AND scope_id = v_branch;

  SELECT *
    INTO v_res
    FROM public.resolve_settings_row_from_policy_context_v1(
      'pricing_policy',
      jsonb_build_object('resource_id', v_branch)
    )
   LIMIT 1;

  PERFORM is(v_res.scope_type, 'tenant', 'tenant fallback is derived from resource_scope_rel when org is absent');

  -- Commercial terms bundle returns pricing_policy at tenant scope for this context.
  v_terms := public.resolve_commercial_terms_v1(jsonb_build_object('resource_id', v_branch));
  PERFORM is(v_terms #>> '{pricing_policy,scope_type}', 'tenant', 'resolve_commercial_terms_v1 includes pricing_policy resolution');

END $$;

SELECT * FROM finish();

ROLLBACK;
