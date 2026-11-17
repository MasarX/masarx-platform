-- Test Suite: webhook ingest policy resolution precedence

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

DO $$
DECLARE
  v_root_scope_type TEXT := public.get_root_scope_type_key_v1();
  v_client_scope_type TEXT;
  v_source_scope_type TEXT;
  v_provider_type TEXT;
  v_org_id UUID := gen_random_uuid();
  v_client_with_policy_id UUID := gen_random_uuid();
  v_client_no_policy_id UUID := gen_random_uuid();
  v_sender_with_policy_id UUID := gen_random_uuid();
  v_sender_no_policy_id UUID := gen_random_uuid();
  v_mapping_id UUID := gen_random_uuid();
  v_source_with_override_id UUID := gen_random_uuid();
  v_source_client_fallback_id UUID := gen_random_uuid();
  v_source_global_fallback_id UUID := gen_random_uuid();
BEGIN
  SELECT r.scope_type
    INTO v_client_scope_type
    FROM public.scope_type_registry r
   WHERE r.entity_table = 'clients'::regclass
     AND r.is_enabled = TRUE
   ORDER BY COALESCE(r.ladder_rank, 0) DESC, r.scope_type ASC
   LIMIT 1;

  v_client_scope_type := COALESCE(v_client_scope_type, 'client');

  SELECT r.scope_type
    INTO v_source_scope_type
    FROM public.scope_type_registry r
   WHERE r.entity_table = 'webhook_sources'::regclass
     AND r.is_enabled = TRUE
   ORDER BY COALESCE(r.ladder_rank, 0) DESC, r.scope_type ASC
   LIMIT 1;

  v_source_scope_type := COALESCE(v_source_scope_type, 'source');

  SELECT lv.value
    INTO v_provider_type
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv
      ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'integration_type'
     AND COALESCE(lv.status, 'active') = 'active'
   ORDER BY COALESCE(lv.sort_order, 2147483647), lv.value
   LIMIT 1;

  v_provider_type := COALESCE(v_provider_type, 'provider');

  -- Keep this test deterministic: disable onboarding side effects that now
  -- auto-materialize required defaults at tenant/client/sender scopes.
  PERFORM public.upsert_settings_value_v1(
    'saas_onboarding_policy',
    v_root_scope_type,
    NULL,
    jsonb_build_object(
      'version', 1,
      'enabled', FALSE,
      'ensure_global_required_defaults', FALSE,
      'materialize_defaults', jsonb_build_object(
        'tenant', jsonb_build_object(
          'use_registry_required_defaults', FALSE,
          'strict_required_coverage', FALSE,
          'include_categories', jsonb_build_array(),
          'exclude_categories', jsonb_build_array()
        ),
        'client', jsonb_build_object(
          'use_registry_required_defaults', FALSE,
          'strict_required_coverage', FALSE,
          'include_categories', jsonb_build_array(),
          'exclude_categories', jsonb_build_array()
        ),
        'sender', jsonb_build_object(
          'use_registry_required_defaults', FALSE,
          'strict_required_coverage', FALSE,
          'include_categories', jsonb_build_array(),
          'exclude_categories', jsonb_build_array()
        )
      ),
      'rbac', jsonb_build_object(
        'provision_templates', FALSE,
        'template_keys', jsonb_build_array()
      ),
      'client_defaults', jsonb_build_object(
        'create_default_sender', FALSE,
        'default_sender_name', 'Default Sender',
        'default_sender_brand_name', NULL
      )
    ),
    1,
    'pgTAP policy ladder test isolation: disable onboarding auto-bootstrap side effects'
  );

  INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status, default_settings)
  VALUES (
    v_org_id,
    'pgTAP Policy Ladder Org',
    'pgtap-policy-org-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
    'Asia/Riyadh',
    'en-US',
    'active',
    '{}'::jsonb
  );

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status, settings_override)
  VALUES
    (
      v_client_with_policy_id,
      v_org_id,
      'pgTAP Policy Client',
      'pgtap-policy-client-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
      'standard',
      'active',
      '{}'::jsonb
    ),
    (
      v_client_no_policy_id,
      v_org_id,
      'pgTAP Global Fallback Client',
      'pgtap-policy-client-global-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
      'standard',
      'active',
      '{}'::jsonb
    );

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status, settings_override)
  VALUES
    (
      v_sender_with_policy_id,
      v_client_with_policy_id,
      'pgTAP Policy Sender',
      'pgTAP Policy Sender',
      FALSE,
      TRUE,
      'active',
      '{}'::jsonb
    ),
    (
      v_sender_no_policy_id,
      v_client_no_policy_id,
      'pgTAP Global Sender',
      'pgTAP Global Sender',
      FALSE,
      TRUE,
      'active',
      '{}'::jsonb
    );

  INSERT INTO public.mapping_configs (
    id,
    mapping_type,
    mapping_key,
    mapping_config,
    mapping_version,
    notes,
    organization_id
  )
  VALUES (
    v_mapping_id,
    'webhook_inbound',
    'pgtap::policy-ladder::' || left(replace(gen_random_uuid()::text, '-', ''), 8),
    jsonb_build_object(
      'description', 'pgTAP policy ladder mapping',
      'external_id_path', 'event.id',
      'event_type_path', 'event.type'
    ),
    1,
    'pgTAP policy ladder fixture mapping',
    v_org_id
  );

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    rate_limit_per_hour,
    enabled,
    sender_id
  )
  VALUES
    (
      v_source_with_override_id,
      v_org_id,
      'pgtap-policy-source-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
      'pgTAP Policy Source Override',
      v_provider_type,
      'pgtap-policy-token-source-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
      v_mapping_id,
      500,
      TRUE,
      v_sender_with_policy_id
    ),
    (
      v_source_client_fallback_id,
      v_org_id,
      'pgtap-policy-client-fallback-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
      'pgTAP Policy Client Fallback',
      v_provider_type,
      'pgtap-policy-token-client-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
      v_mapping_id,
      500,
      TRUE,
      v_sender_with_policy_id
    ),
    (
      v_source_global_fallback_id,
      v_org_id,
      'pgtap-policy-global-fallback-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
      'pgTAP Policy Global Fallback',
      v_provider_type,
      'pgtap-policy-token-global-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
      v_mapping_id,
      500,
      TRUE,
      v_sender_no_policy_id
    );

  PERFORM public.upsert_settings_value_v1(
    'webhook_ingest_policy',
    v_root_scope_type,
    NULL,
    jsonb_build_object('workflow', jsonb_build_object('intent', 'global_intent')),
    1,
    'pgTAP policy ladder global fallback fixture'
  );

  PERFORM public.upsert_settings_value_v1(
    'webhook_ingest_policy',
    v_client_scope_type,
    v_client_with_policy_id,
    jsonb_build_object('workflow', jsonb_build_object('intent', 'client_intent')),
    1,
    'pgTAP policy ladder client fallback fixture'
  );

  PERFORM public.upsert_settings_value_v1(
    'webhook_ingest_policy',
    v_source_scope_type,
    v_source_with_override_id,
    jsonb_build_object('workflow', jsonb_build_object('intent', 'source_intent')),
    1,
    'pgTAP policy ladder source override fixture'
  );

  PERFORM is(
    (
      SELECT scope_type
      FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_source_with_override_id)
    ),
    v_source_scope_type,
    'resolve_webhook_ingest_policy prefers source-level configuration when present'
  );

  PERFORM is(
    (
      SELECT scope_type
      FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_source_client_fallback_id)
    ),
    v_client_scope_type,
    'resolve_webhook_ingest_policy falls back to client scope when no source override exists'
  );

  PERFORM is(
    (
      SELECT scope_type
      FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_source_global_fallback_id)
    ),
    v_root_scope_type,
    'resolve_webhook_ingest_policy falls back to global scope when no specific policy exists'
  );
END;
$$;

SELECT * FROM finish();

ROLLBACK;
