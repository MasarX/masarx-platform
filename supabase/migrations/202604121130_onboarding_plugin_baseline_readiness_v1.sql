-- Plan: PLAN-202604-client-go-live-release-closure / Step: S02
-- Migration: onboarding plugin baseline + readiness contract v1
-- Date: 2026-04-12
--
-- Purpose:
-- - Auto-install baseline integration plugins during onboarding bootstrap.
-- - Extend SaaS onboarding policy with workflow/plugin baseline selectors.
-- - Reconcile workflow + plugin defaults idempotently across tenant/client/sender scopes.
-- - Expose a browser-safe onboarding readiness RPC via public/api wrappers.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604121130_onboarding_plugin_baseline_readiness_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Policy registry updates and global defaults
-------------------------------------------------------------------------------

UPDATE public.schema_registry
   SET schema = jsonb_build_object(
         '$schema', 'http://json-schema.org/draft-07/schema#',
         'type', 'object',
         'additionalProperties', TRUE,
         'required', jsonb_build_array(
           'version',
           'enabled',
           'ensure_global_required_defaults',
           'materialize_defaults',
           'rbac',
           'client_defaults',
           'workflow_bindings',
           'integration_plugins'
         ),
         'properties', jsonb_build_object(
           'version', jsonb_build_object('type', 'integer', 'minimum', 1),
           'enabled', jsonb_build_object('type', 'boolean'),
           'ensure_global_required_defaults', jsonb_build_object('type', 'boolean'),
           'materialize_defaults', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
           'rbac', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
           'client_defaults', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
           'workflow_bindings', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
           'integration_plugins', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
         )
       ),
       examples = jsonb_build_array(
         jsonb_build_object(
           'version', 1,
           'enabled', TRUE,
           'ensure_global_required_defaults', TRUE,
           'materialize_defaults', jsonb_build_object(
             'tenant', jsonb_build_object(
               'use_registry_required_defaults', TRUE,
               'include_categories', jsonb_build_array(),
               'exclude_categories', jsonb_build_array(
                 'saas_onboarding_policy',
                 'workflow_binding_policy',
                 'integration_plugin_baseline_policy'
               )
             ),
             'client', jsonb_build_object(
               'use_registry_required_defaults', FALSE,
               'include_categories', jsonb_build_array(),
               'exclude_categories', jsonb_build_array()
             ),
             'sender', jsonb_build_object(
               'use_registry_required_defaults', FALSE,
               'include_categories', jsonb_build_array(),
               'exclude_categories', jsonb_build_array()
             )
           ),
           'rbac', jsonb_build_object(
             'provision_templates', TRUE,
             'template_keys', jsonb_build_array(
               'ops_admin',
               'finance',
               'agreements_admin',
               'fleet_manager',
               'warehouse_operator',
               'driver'
             )
           ),
           'client_defaults', jsonb_build_object(
             'create_default_sender', TRUE,
             'default_sender_name', 'Default Sender',
             'default_sender_brand_name', NULL
           ),
           'workflow_bindings', jsonb_build_object(
             'clone_defaults_for_tenant', TRUE,
             'baseline_profile', 'standard_operations'
           ),
           'integration_plugins', jsonb_build_object(
             'baseline_profile', 'standard_operations'
           )
         )
       ),
       updated_at = now()
 WHERE category = 'saas_onboarding_policy'
   AND version = 1;

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'integration_plugin_baseline_policy',
  'Row-driven baseline integration plugin profile catalog for onboarding bootstrap and readiness.',
  TRUE,
  TRUE,
  TRUE,
  'hard_fail',
  '["global","tenant"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'integration_plugin_baseline_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', FALSE,
    'required', jsonb_build_array('version', 'default_profile', 'profiles'),
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'default_profile', jsonb_build_object('type', 'string', 'minLength', 1),
      'profiles', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
    )
  ),
  'Baseline onboarding plugin profile catalog.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'default_profile', 'standard_operations',
      'profiles', jsonb_build_object(
        'standard_operations',
        jsonb_build_object(
          'key', 'standard_operations',
          'label', 'Standard Operations',
          'entries', jsonb_build_array(
            jsonb_build_object(
              'key', 'provider_webhook_handoff',
              'plugin_key', 'baseline.provider_webhook_handoff',
              'name', 'Provider Webhook Handoff',
              'description', 'Baseline provider webhook handoff plugin installed during onboarding and held pending external credentials.',
              'scope_type', 'tenant',
              'plugin_kind', 'webhook',
              'binding_type', 'webhook_source',
              'source_type', 'manual',
              'required', TRUE,
              'activation_mode', 'auto_install_pending_credentials',
              'validation_pack', 'provider_handoff_minimum',
              'task_template_key', 'integration_plugin_credentials_setup'
            )
          )
        )
      )
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active,
  updated_at = now();

DO $seed$
DECLARE
  v_default JSONB := jsonb_build_object(
    'version', 1,
    'default_profile', 'standard_operations',
    'profiles', jsonb_build_object(
      'standard_operations',
      jsonb_build_object(
        'key', 'standard_operations',
        'label', 'Standard Operations',
        'entries', jsonb_build_array(
          jsonb_build_object(
            'key', 'provider_webhook_handoff',
            'plugin_key', 'baseline.provider_webhook_handoff',
            'name', 'Provider Webhook Handoff',
            'description', 'Baseline provider webhook handoff plugin installed during onboarding and held pending external credentials.',
            'scope_type', 'tenant',
            'plugin_kind', 'webhook',
            'binding_type', 'webhook_source',
            'source_type', 'manual',
            'required', TRUE,
            'activation_mode', 'auto_install_pending_credentials',
            'validation_pack', 'provider_handoff_minimum',
            'task_template_key', 'integration_plugin_credentials_setup'
          )
        )
      )
    )
  );
BEGIN
  PERFORM public.upsert_settings_value_v1(
    'integration_plugin_baseline_policy',
    'global',
    NULL,
    v_default,
    1,
    'seed integration_plugin_baseline_policy global defaults'
  );
END;
$seed$;

DO $task_type$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings_version_id UUID;
  v_value JSONB;
  v_task_types JSONB;
  v_item JSONB := jsonb_build_object(
    'key', 'integration_plugin_credentials_setup',
    'name', 'Integration Plugin Credentials Setup',
    'description', 'Collect and validate external credentials required for auto-installed baseline integration plugins.',
    'default_priority', 55,
    'default_queue_key', 'integration_plugin_credentials_setup',
    'enabled', TRUE,
    'metadata', jsonb_build_object(
      'assignment_defaults', jsonb_build_object(
        'queue_key', 'integration_plugin_credentials_setup',
        'sla_minutes', 240
      )
    )
  );
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_value
    FROM public.settings s
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'task_type_catalog global settings missing'
      USING ERRCODE = '23503';
  END IF;

  v_task_types := COALESCE(v_value->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) IS DISTINCT FROM 'array' THEN
    v_task_types := '[]'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_task_types) AS t(value)
     WHERE lower(NULLIF(btrim(COALESCE(t.value->>'key', '')), '')) = 'integration_plugin_credentials_setup'
  ) THEN
    v_task_types := v_task_types || jsonb_build_array(v_item);
  END IF;

  v_value := jsonb_set(COALESCE(v_value, '{}'::jsonb), '{task_types}', v_task_types, TRUE);
  IF NULLIF(btrim(COALESCE(v_value->>'version', '')), '') IS NULL THEN
    v_value := jsonb_set(v_value, '{version}', to_jsonb(1), TRUE);
  END IF;

  UPDATE public.settings_versions sv
     SET value = v_value,
         approved_at = now()
   WHERE sv.id = v_settings_version_id;

  UPDATE public.settings s
     SET cached_value = v_value,
         last_updated = now()
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash;
END;
$task_type$;

-------------------------------------------------------------------------------
-- 2) Baseline policy + scope helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_baseline_policy_default_v1()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'version', 1,
    'default_profile', 'standard_operations',
    'profiles', jsonb_build_object(
      'standard_operations',
      jsonb_build_object(
        'key', 'standard_operations',
        'label', 'Standard Operations',
        'entries', jsonb_build_array(
          jsonb_build_object(
            'key', 'provider_webhook_handoff',
            'plugin_key', 'baseline.provider_webhook_handoff',
            'name', 'Provider Webhook Handoff',
            'description', 'Baseline provider webhook handoff plugin installed during onboarding and held pending external credentials.',
            'scope_type', 'tenant',
            'plugin_kind', 'webhook',
            'binding_type', 'webhook_source',
            'source_type', 'manual',
            'required', TRUE,
            'activation_mode', 'auto_install_pending_credentials',
            'validation_pack', 'provider_handoff_minimum',
            'task_template_key', 'integration_plugin_credentials_setup'
          )
        )
      )
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.resolve_integration_plugin_baseline_policy_v1(
  p_organization_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_default JSONB := public.integration_plugin_baseline_policy_default_v1();
  v_resolved JSONB;
BEGIN
  IF p_organization_id IS NULL THEN
    v_resolved := public.resolve_settings('integration_plugin_baseline_policy', 'global', NULL);
  ELSE
    v_resolved := public.resolve_settings('integration_plugin_baseline_policy', 'tenant', p_organization_id);
  END IF;

  IF v_resolved IS NULL OR jsonb_typeof(v_resolved) <> 'object' THEN
    RETURN v_default;
  END IF;

  RETURN public.jsonb_deep_merge(v_default, v_resolved);
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_baseline_profile_v1(
  p_organization_id UUID DEFAULT NULL,
  p_profile_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := public.resolve_integration_plugin_baseline_policy_v1(p_organization_id);
  v_profile_key TEXT := lower(
    COALESCE(
      NULLIF(btrim(p_profile_key), ''),
      NULLIF(btrim(v_policy->>'default_profile'), ''),
      'standard_operations'
    )
  );
  v_profile JSONB;
BEGIN
  v_profile := v_policy #> ARRAY['profiles', v_profile_key];
  IF v_profile IS NULL OR jsonb_typeof(v_profile) <> 'object' THEN
    RETURN jsonb_build_object(
      'key', v_profile_key,
      'label', initcap(replace(v_profile_key, '_', ' ')),
      'entries', jsonb_build_array()
    );
  END IF;

  RETURN jsonb_build_object(
    'key', COALESCE(NULLIF(btrim(v_profile->>'key'), ''), v_profile_key),
    'label', COALESCE(NULLIF(btrim(v_profile->>'label'), ''), initcap(replace(v_profile_key, '_', ' '))),
    'entries', COALESCE(v_profile->'entries', '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_baseline_plugin_key_v1(
  p_profile_key TEXT,
  p_entry JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_key TEXT := lower(
    COALESCE(
      NULLIF(btrim(p_entry->>'plugin_key'), ''),
      NULLIF(btrim(p_entry->>'key'), ''),
      NULLIF(btrim(p_entry->>'name'), ''),
      'baseline_plugin'
    )
  );
BEGIN
  v_key := regexp_replace(v_key, '[^a-z0-9._-]+', '_', 'g');
  IF position('baseline.' in v_key) <> 1 THEN
    v_key := format('baseline.%s.%s', regexp_replace(lower(COALESCE(NULLIF(btrim(p_profile_key), ''), 'default')), '[^a-z0-9._-]+', '_', 'g'), v_key);
  END IF;
  RETURN v_key;
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_baseline_entry_hash_v1(
  p_entry JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT md5(COALESCE(p_entry, '{}'::jsonb)::text);
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_baseline_scope_context_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS TABLE (
  scope_type TEXT,
  scope_id UUID,
  organization_id UUID,
  client_id UUID,
  sender_id UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_org_id UUID;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;
BEGIN
  IF p_scope_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_baseline_scope_context_v1 requires non-NULL scope_id for %', v_scope_type;
  END IF;

  IF v_scope_type = 'tenant' THEN
    PERFORM 1 FROM public.organizations WHERE id = p_scope_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'organization % not found', p_scope_id USING ERRCODE = '23503';
    END IF;
    v_org_id := p_scope_id;
  ELSIF v_scope_type = 'client' THEN
    SELECT c.organization_id, c.id
      INTO v_org_id, v_client_id
      FROM public.clients c
     WHERE c.id = p_scope_id;
    IF v_org_id IS NULL THEN
      RAISE EXCEPTION 'client % not found', p_scope_id USING ERRCODE = '23503';
    END IF;
  ELSIF v_scope_type = 'sender' THEN
    SELECT c.organization_id, s.client_id, s.id
      INTO v_org_id, v_client_id, v_sender_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = p_scope_id;
    IF v_org_id IS NULL THEN
      RAISE EXCEPTION 'sender % not found', p_scope_id USING ERRCODE = '23503';
    END IF;
  ELSE
    RAISE EXCEPTION 'integration_plugin_baseline_scope_context_v1 unsupported scope_type=%', p_scope_type USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  SELECT v_scope_type, p_scope_id, v_org_id, v_client_id, v_sender_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_baseline_ensure_pending_task_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_sender_id UUID,
  p_plugin_id UUID,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_profile_key TEXT,
  p_entry JSONB,
  p_actor_context TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_task RECORD;
  v_task_key TEXT := lower(COALESCE(NULLIF(btrim(p_entry->>'task_template_key'), ''), 'integration_plugin_credentials_setup'));
  v_idempotency_key TEXT := format(
    'baseline-plugin-credentials:%s:%s:%s',
    p_plugin_id,
    p_scope_type,
    COALESCE(p_scope_id::text, 'null')
  );
BEGIN
  IF p_plugin_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'plugin_missing');
  END IF;

  SELECT *
    INTO v_task
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', v_task_key,
        'resource_type', 'integration_plugin',
        'resource_id', p_plugin_id,
        'idempotency_key', v_idempotency_key,
        'actor_system', COALESCE(NULLIF(btrim(p_actor_context), ''), 'onboarding:integration_plugin_baseline'),
        'metadata', jsonb_strip_nulls(
          jsonb_build_object(
            'baseline_profile_key', p_profile_key,
            'baseline_entry_key', COALESCE(NULLIF(btrim(p_entry->>'key'), ''), p_entry->>'plugin_key'),
            'activation_mode', p_entry->>'activation_mode',
            'validation_pack', p_entry->>'validation_pack',
            'scope_type', p_scope_type,
            'scope_id', p_scope_id
          )
        ),
        'context', jsonb_strip_nulls(
          jsonb_build_object(
            'organization_id', p_organization_id,
            'client_id', p_client_id,
            'sender_id', p_sender_id,
            'scope_type', p_scope_type,
            'scope_id', p_scope_id
          )
        )
      )
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'task_id', v_task.task_id,
    'task_event_id', v_task.task_event_id,
    'workflow_run_id', v_task.workflow_run_id,
    'idempotency_key', v_idempotency_key
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_baseline_install_entry_v1(
  p_organization_id UUID,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_profile_key TEXT,
  p_entry JSONB,
  p_actor_context TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_scope RECORD;
  v_entry JSONB := COALESCE(p_entry, '{}'::jsonb);
  v_entry_key TEXT := lower(COALESCE(NULLIF(btrim(v_entry->>'key'), ''), NULLIF(btrim(v_entry->>'plugin_key'), ''), 'baseline_plugin'));
  v_entry_hash TEXT := public.integration_plugin_baseline_entry_hash_v1(v_entry);
  v_plugin_key TEXT := public.integration_plugin_baseline_plugin_key_v1(p_profile_key, v_entry);
  v_plugin_name TEXT := COALESCE(NULLIF(btrim(v_entry->>'name'), ''), initcap(replace(v_entry_key, '_', ' ')));
  v_description TEXT := NULLIF(btrim(v_entry->>'description'), '');
  v_plugin_kind TEXT := lower(COALESCE(NULLIF(btrim(v_entry->>'plugin_kind'), ''), 'webhook'));
  v_binding_type TEXT := lower(COALESCE(NULLIF(btrim(v_entry->>'binding_type'), ''), 'webhook_source'));
  v_source_type TEXT := lower(COALESCE(NULLIF(btrim(v_entry->>'source_type'), ''), 'manual'));
  v_activation_mode TEXT := lower(COALESCE(NULLIF(btrim(v_entry->>'activation_mode'), ''), 'auto_install_pending_credentials'));
  v_validation_pack TEXT := lower(COALESCE(NULLIF(btrim(v_entry->>'validation_pack'), ''), 'baseline_minimum'));
  v_required BOOLEAN := COALESCE((v_entry->>'required')::BOOLEAN, FALSE);
  v_plugin_status TEXT;
  v_version_status TEXT;
  v_plugin RECORD;
  v_latest_version RECORD;
  v_version_id UUID;
  v_binding RECORD;
  v_task_result JSONB := NULL;
BEGIN
  IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid_entry');
  END IF;

  SELECT *
    INTO v_scope
    FROM public.integration_plugin_baseline_scope_context_v1(v_scope_type, p_scope_id)
   LIMIT 1;

  IF v_scope.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'integration_plugin_baseline_install_entry_v1 scope %/% does not belong to organization %',
      v_scope_type, p_scope_id, p_organization_id
      USING ERRCODE = '23514';
  END IF;

  v_plugin_status := CASE WHEN v_activation_mode = 'auto_activate' THEN 'active' ELSE 'approved' END;
  v_version_status := CASE WHEN v_activation_mode = 'auto_activate' THEN 'active' ELSE 'approved' END;

  INSERT INTO public.integration_plugins (
    organization_id,
    plugin_key,
    name,
    description,
    plugin_kind,
    status,
    managed_by,
    metadata
  ) VALUES (
    p_organization_id,
    v_plugin_key,
    v_plugin_name,
    v_description,
    v_plugin_kind,
    v_plugin_status,
    'platform',
    jsonb_build_object(
      'baseline', jsonb_build_object(
        'profile_key', p_profile_key,
        'entry_key', v_entry_key,
        'entry_hash', v_entry_hash,
        'required', v_required,
        'activation_mode', v_activation_mode
      )
    )
  )
  ON CONFLICT (organization_id, plugin_key) DO UPDATE
  SET
    name = EXCLUDED.name,
    description = COALESCE(EXCLUDED.description, public.integration_plugins.description),
    plugin_kind = EXCLUDED.plugin_kind,
    status = CASE
      WHEN public.integration_plugins.status = 'active' AND EXCLUDED.status <> 'active' THEN public.integration_plugins.status
      ELSE EXCLUDED.status
    END,
    managed_by = 'platform',
    metadata = public.jsonb_deep_merge(public.integration_plugins.metadata, EXCLUDED.metadata),
    updated_at = now()
  RETURNING *
  INTO v_plugin;

  SELECT pv.id, pv.version_no, pv.status, pv.metadata
    INTO v_latest_version
    FROM public.integration_plugin_versions pv
   WHERE pv.plugin_id = v_plugin.id
   ORDER BY pv.version_no DESC
   LIMIT 1;

  IF v_latest_version.id IS NULL
     OR COALESCE(v_latest_version.metadata->>'baseline_entry_hash', '') <> v_entry_hash THEN
    INSERT INTO public.integration_plugin_versions (
      plugin_id,
      organization_id,
      version_no,
      status,
      source_type,
      normalized_contract,
      inbound_config,
      workflow_binding,
      auth_bindings,
      validation_summary,
      approved_at,
      activated_at,
      metadata
    ) VALUES (
      v_plugin.id,
      p_organization_id,
      COALESCE(v_latest_version.version_no, 0) + 1,
      v_version_status,
      v_source_type,
      jsonb_build_object(
        'baseline_profile_key', p_profile_key,
        'baseline_entry_key', v_entry_key,
        'scope_type', v_scope_type,
        'scope_id', p_scope_id
      ),
      COALESCE(v_entry->'inbound_config', '{}'::jsonb),
      COALESCE(v_entry->'workflow_binding', '{}'::jsonb),
      COALESCE(v_entry->'auth_bindings', '{}'::jsonb),
      jsonb_build_object(
        'validation_pack', v_validation_pack,
        'state', CASE WHEN v_activation_mode = 'auto_activate' THEN 'healthy' ELSE 'pending_credentials' END
      ),
      now(),
      CASE WHEN v_activation_mode = 'auto_activate' THEN now() ELSE NULL END,
      jsonb_build_object(
        'baseline_profile_key', p_profile_key,
        'baseline_entry_key', v_entry_key,
        'baseline_entry_hash', v_entry_hash,
        'required', v_required,
        'activation_mode', v_activation_mode
      )
    )
    RETURNING id
      INTO v_version_id;
  ELSE
    v_version_id := v_latest_version.id;
  END IF;

  SELECT b.*
    INTO v_binding
    FROM public.integration_plugin_bindings b
   WHERE b.plugin_version_id = v_version_id
     AND b.scope_type = v_scope_type
     AND b.scope_id = p_scope_id
     AND b.binding_type = v_binding_type
     AND b.runtime_resource_type IS NULL
     AND b.runtime_resource_id IS NULL
   LIMIT 1;

  IF v_binding.id IS NULL THEN
    INSERT INTO public.integration_plugin_bindings (
      plugin_version_id,
      organization_id,
      scope_type,
      scope_id,
      binding_type,
      enabled,
      activation_payload,
      metadata
    ) VALUES (
      v_version_id,
      p_organization_id,
      v_scope_type,
      p_scope_id,
      v_binding_type,
      v_activation_mode = 'auto_activate',
      jsonb_build_object(
        'activation_mode', v_activation_mode,
        'validation_pack', v_validation_pack
      ),
      jsonb_build_object(
        'baseline_profile_key', p_profile_key,
        'baseline_entry_key', v_entry_key,
        'baseline_entry_hash', v_entry_hash,
        'required', v_required
      )
    )
    RETURNING *
      INTO v_binding;
  ELSE
    UPDATE public.integration_plugin_bindings
       SET enabled = v_activation_mode = 'auto_activate',
           activation_payload = jsonb_build_object(
             'activation_mode', v_activation_mode,
             'validation_pack', v_validation_pack
           ),
           metadata = public.jsonb_deep_merge(
             public.integration_plugin_bindings.metadata,
             jsonb_build_object(
               'baseline_profile_key', p_profile_key,
               'baseline_entry_key', v_entry_key,
               'baseline_entry_hash', v_entry_hash,
               'required', v_required
             )
           ),
           updated_at = now()
     WHERE id = v_binding.id
     RETURNING *
      INTO v_binding;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.integration_plugin_validation_runs vr
     WHERE vr.plugin_version_id = v_version_id
       AND vr.run_type = 'validate'
  ) THEN
    INSERT INTO public.integration_plugin_validation_runs (
      plugin_version_id,
      organization_id,
      run_type,
      status,
      request_payload,
      result_payload,
      completed_at,
      error_message
    ) VALUES (
      v_version_id,
      p_organization_id,
      'validate',
      CASE WHEN v_activation_mode = 'auto_activate' THEN 'succeeded' ELSE 'pending' END,
      jsonb_build_object('validation_pack', v_validation_pack),
      jsonb_build_object(
        'baseline_profile_key', p_profile_key,
        'baseline_entry_key', v_entry_key,
        'activation_mode', v_activation_mode
      ),
      CASE WHEN v_activation_mode = 'auto_activate' THEN now() ELSE NULL END,
      CASE WHEN v_activation_mode = 'auto_activate' THEN NULL ELSE 'Pending external credentials' END
    );
  END IF;

  IF v_activation_mode = 'auto_activate' THEN
    UPDATE public.integration_plugins
       SET active_version_id = v_version_id,
           status = 'active',
           updated_at = now()
     WHERE id = v_plugin.id;
  ELSE
    UPDATE public.integration_plugins
       SET status = 'approved',
           updated_at = now()
     WHERE id = v_plugin.id;

    v_task_result := public.integration_plugin_baseline_ensure_pending_task_v1(
      p_organization_id,
      v_scope.client_id,
      v_scope.sender_id,
      v_plugin.id,
      v_scope_type,
      p_scope_id,
      p_profile_key,
      v_entry,
      p_actor_context
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'organization_id', p_organization_id,
    'scope_type', v_scope_type,
    'scope_id', p_scope_id,
    'plugin_id', v_plugin.id,
    'plugin_key', v_plugin_key,
    'plugin_version_id', v_version_id,
    'binding_id', v_binding.id,
    'activation_mode', v_activation_mode,
    'required', v_required,
    'task', v_task_result
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_integration_plugin_defaults_v1(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_actor_context TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope RECORD;
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_enabled BOOLEAN := public.onboarding_policy_bool_v1(v_policy, ARRAY['enabled'], TRUE);
  v_profile_key TEXT := lower(
    COALESCE(
      NULLIF(btrim(v_policy #>> ARRAY['integration_plugins', 'baseline_profile']), ''),
      'standard_operations'
    )
  );
  v_profile JSONB;
  v_entry JSONB;
  v_entries JSONB;
  v_results JSONB := '[]'::jsonb;
  v_entry_scope_type TEXT;
  v_entry_scope_id UUID;
BEGIN
  IF p_scope_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_integration_plugin_defaults_v1 requires non-NULL scope_id';
  END IF;

  SELECT *
    INTO v_scope
    FROM public.integration_plugin_baseline_scope_context_v1(p_scope_type, p_scope_id)
   LIMIT 1;

  IF NOT v_enabled THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', FALSE,
      'scope_type', v_scope.scope_type,
      'scope_id', v_scope.scope_id,
      'profile_key', v_profile_key,
      'items', jsonb_build_array()
    );
  END IF;

  v_profile := public.integration_plugin_baseline_profile_v1(v_scope.organization_id, v_profile_key);
  v_entries := COALESCE(v_profile->'entries', '[]'::jsonb);
  IF jsonb_typeof(v_entries) IS DISTINCT FROM 'array' THEN
    v_entries := '[]'::jsonb;
  END IF;

  FOR v_entry IN
    SELECT value
      FROM jsonb_array_elements(v_entries)
  LOOP
    v_entry_scope_type := public.normalize_scope_type_v1(
      COALESCE(NULLIF(btrim(v_entry->>'scope_type'), ''), 'tenant'),
      FALSE
    );
    v_entry_scope_id := CASE
      WHEN v_entry_scope_type = 'tenant' THEN v_scope.organization_id
      WHEN v_entry_scope_type = 'client' THEN v_scope.client_id
      WHEN v_entry_scope_type = 'sender' THEN v_scope.sender_id
      ELSE NULL
    END;

    IF v_entry_scope_id IS NULL THEN
      CONTINUE;
    END IF;

    v_results := v_results || jsonb_build_array(
      public.integration_plugin_baseline_install_entry_v1(
        v_scope.organization_id,
        v_entry_scope_type,
        v_entry_scope_id,
        v_profile_key,
        v_entry,
        p_actor_context
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'organization_id', v_scope.organization_id,
    'scope_type', v_scope.scope_type,
    'scope_id', v_scope.scope_id,
    'profile_key', v_profile_key,
    'items', v_results
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_baseline_readiness_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope RECORD;
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_profile_key TEXT := lower(
    COALESCE(
      NULLIF(btrim(v_policy #>> ARRAY['integration_plugins', 'baseline_profile']), ''),
      'standard_operations'
    )
  );
  v_profile JSONB;
  v_entries JSONB;
  v_entry JSONB;
  v_items JSONB := '[]'::jsonb;
  v_entry_scope_type TEXT;
  v_entry_scope_id UUID;
  v_plugin_key TEXT;
  v_required BOOLEAN;
  v_activation_mode TEXT;
  v_plugin RECORD;
  v_version RECORD;
  v_binding RECORD;
  v_open_task_id UUID;
  v_item JSONB;
  v_status TEXT;
  v_blocking_total INT := 0;
  v_pending_total INT := 0;
  v_active_total INT := 0;
  v_required_total INT := 0;
  v_installed_total INT := 0;
BEGIN
  SELECT *
    INTO v_scope
    FROM public.integration_plugin_baseline_scope_context_v1(p_scope_type, p_scope_id)
   LIMIT 1;

  v_profile := public.integration_plugin_baseline_profile_v1(v_scope.organization_id, v_profile_key);
  v_entries := COALESCE(v_profile->'entries', '[]'::jsonb);
  IF jsonb_typeof(v_entries) IS DISTINCT FROM 'array' THEN
    v_entries := '[]'::jsonb;
  END IF;

  FOR v_entry IN
    SELECT value
      FROM jsonb_array_elements(v_entries)
  LOOP
    v_entry_scope_type := public.normalize_scope_type_v1(
      COALESCE(NULLIF(btrim(v_entry->>'scope_type'), ''), 'tenant'),
      FALSE
    );
    v_entry_scope_id := CASE
      WHEN v_entry_scope_type = 'tenant' THEN v_scope.organization_id
      WHEN v_entry_scope_type = 'client' THEN v_scope.client_id
      WHEN v_entry_scope_type = 'sender' THEN v_scope.sender_id
      ELSE NULL
    END;

    IF v_entry_scope_id IS NULL THEN
      CONTINUE;
    END IF;

    v_required := COALESCE((v_entry->>'required')::BOOLEAN, FALSE);
    v_activation_mode := lower(COALESCE(NULLIF(btrim(v_entry->>'activation_mode'), ''), 'auto_install_pending_credentials'));
    v_plugin_key := public.integration_plugin_baseline_plugin_key_v1(v_profile_key, v_entry);

    IF v_required THEN
      v_required_total := v_required_total + 1;
    END IF;

    SELECT p.*
      INTO v_plugin
      FROM public.integration_plugins p
     WHERE p.organization_id = v_scope.organization_id
       AND p.plugin_key = v_plugin_key
     LIMIT 1;

    SELECT pv.*
      INTO v_version
      FROM public.integration_plugin_versions pv
     WHERE pv.plugin_id = v_plugin.id
     ORDER BY pv.version_no DESC
     LIMIT 1;

    SELECT b.*
      INTO v_binding
      FROM public.integration_plugin_bindings b
     WHERE b.plugin_version_id = v_version.id
       AND b.scope_type = v_entry_scope_type
       AND b.scope_id = v_entry_scope_id
       AND b.binding_type = lower(COALESCE(NULLIF(btrim(v_entry->>'binding_type'), ''), 'webhook_source'))
     LIMIT 1;

    SELECT t.id
      INTO v_open_task_id
      FROM public.tasks t
      JOIN public.task_types tt ON tt.id = t.task_type_id
     WHERE t.organization_id = v_scope.organization_id
       AND t.resource_type = 'integration_plugin'
       AND t.resource_id = v_plugin.id
       AND tt.key = lower(COALESCE(NULLIF(btrim(v_entry->>'task_template_key'), ''), 'integration_plugin_credentials_setup'))
       AND t.status NOT IN ('completed', 'canceled')
     ORDER BY t.created_at DESC
     LIMIT 1;

    IF v_plugin.id IS NULL OR v_version.id IS NULL OR v_binding.id IS NULL THEN
      v_status := 'missing';
      IF v_required THEN
        v_blocking_total := v_blocking_total + 1;
      END IF;
    ELSIF v_activation_mode = 'auto_activate' THEN
      IF v_plugin.status = 'active' AND v_binding.enabled IS TRUE AND v_plugin.active_version_id = v_version.id THEN
        v_status := 'active';
        v_active_total := v_active_total + 1;
      ELSE
        v_status := 'blocked';
        IF v_required THEN
          v_blocking_total := v_blocking_total + 1;
        END IF;
      END IF;
      v_installed_total := v_installed_total + 1;
    ELSE
      v_installed_total := v_installed_total + 1;
      IF v_open_task_id IS NOT NULL THEN
        v_status := 'pending_credentials';
        v_pending_total := v_pending_total + 1;
      ELSE
        v_status := 'blocked';
        IF v_required THEN
          v_blocking_total := v_blocking_total + 1;
        END IF;
      END IF;
    END IF;

    v_item := jsonb_strip_nulls(
      jsonb_build_object(
        'plugin_key', v_plugin_key,
        'entry_key', COALESCE(NULLIF(btrim(v_entry->>'key'), ''), v_plugin_key),
        'name', COALESCE(NULLIF(btrim(v_entry->>'name'), ''), v_plugin_key),
        'scope_type', v_entry_scope_type,
        'scope_id', v_entry_scope_id,
        'required', v_required,
        'activation_mode', v_activation_mode,
        'validation_pack', NULLIF(btrim(v_entry->>'validation_pack'), ''),
        'status', v_status,
        'plugin_id', v_plugin.id,
        'plugin_version_id', v_version.id,
        'binding_id', v_binding.id,
        'task_id', v_open_task_id
      )
    );
    v_items := v_items || jsonb_build_array(v_item);
  END LOOP;

  RETURN jsonb_build_object(
    'profile_key', v_profile_key,
    'required_total', v_required_total,
    'installed_total', v_installed_total,
    'blocking_total', v_blocking_total,
    'pending_credentials_total', v_pending_total,
    'active_total', v_active_total,
    'status', CASE WHEN v_blocking_total > 0 THEN 'blocked' ELSE 'ready' END,
    'items', v_items
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 3) Onboarding bootstrap + reconcile overrides
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_saas_onboarding_policy_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_default JSONB := jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'ensure_global_required_defaults', TRUE,
    'materialize_defaults', jsonb_build_object(
      'tenant', jsonb_build_object(
        'use_registry_required_defaults', TRUE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array(
          'saas_onboarding_policy',
          'workflow_binding_policy',
          'integration_plugin_baseline_policy'
        )
      ),
      'client', jsonb_build_object(
        'use_registry_required_defaults', FALSE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array()
      ),
      'sender', jsonb_build_object(
        'use_registry_required_defaults', FALSE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array()
      )
    ),
    'rbac', jsonb_build_object(
      'provision_templates', TRUE,
      'template_keys', jsonb_build_array(
        'ops_admin',
        'finance',
        'agreements_admin',
        'fleet_manager',
        'warehouse_operator',
        'driver'
      )
    ),
    'client_defaults', jsonb_build_object(
      'create_default_sender', TRUE,
      'default_sender_name', 'Default Sender',
      'default_sender_brand_name', NULL
    ),
    'workflow_bindings', jsonb_build_object(
      'clone_defaults_for_tenant', TRUE,
      'baseline_profile', 'standard_operations'
    ),
    'integration_plugins', jsonb_build_object(
      'baseline_profile', 'standard_operations'
    )
  );
  v_resolved JSONB;
BEGIN
  v_resolved := public.resolve_settings('saas_onboarding_policy', public.get_root_scope_type_key_v1(), NULL);
  IF v_resolved IS NULL OR jsonb_typeof(v_resolved) <> 'object' THEN
    RETURN v_default;
  END IF;

  RETURN public.jsonb_deep_merge(v_default, v_resolved);
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_workflow_binding_defaults_v1(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_source_policy JSONB;
  v_target_policy JSONB := jsonb_build_object('version', 1, 'bindings', jsonb_build_object());
  v_source_row RECORD;
  v_binding RECORD;
  v_stage RECORD;
  v_stage_value JSONB;
  v_source_template_id UUID := NULL;
  v_target_template_id UUID := NULL;
  v_seeded JSONB := '[]'::jsonb;
  v_upserted RECORD;
  v_enabled BOOLEAN;
  v_trigger_source TEXT := COALESCE(NULLIF(btrim(COALESCE(p_trigger_source, '')), ''), 'manual');
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_baseline_profile TEXT := lower(
    COALESCE(
      NULLIF(btrim(v_policy #>> ARRAY['workflow_bindings', 'baseline_profile']), ''),
      'standard_operations'
    )
  );
BEGIN
  IF v_scope_type <> 'tenant' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'scope_type', v_scope_type,
      'scope_id', p_scope_id,
      'baseline_profile', v_baseline_profile,
      'seeded', FALSE,
      'reason', 'clone_defaults_for_tenant_only'
    );
  END IF;

  IF p_scope_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_workflow_binding_defaults_v1 requires non-NULL scope_id for %', v_scope_type;
  END IF;

  v_enabled := public.onboarding_policy_bool_v1(
    v_policy,
    ARRAY['workflow_bindings', 'clone_defaults_for_tenant'],
    TRUE
  );

  IF NOT v_enabled THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'scope_type', v_scope_type,
      'scope_id', p_scope_id,
      'baseline_profile', v_baseline_profile,
      'seeded', FALSE,
      'reason', 'disabled_by_policy'
    );
  END IF;

  SELECT *
    INTO v_source_row
    FROM public.resolve_settings_row('workflow_binding_policy', public.get_root_scope_type_key_v1(), NULL)
   LIMIT 1;

  v_source_policy := COALESCE(v_source_row.value, public.workflow_binding_policy_default_v1());

  FOR v_binding IN
    SELECT key, value
      FROM jsonb_each(COALESCE(v_source_policy->'bindings', '{}'::jsonb))
  LOOP
    IF jsonb_typeof(v_binding.value) <> 'object' THEN
      CONTINUE;
    END IF;

    v_target_policy := public.jsonb_deep_merge(
      v_target_policy,
      jsonb_build_object(
        'bindings',
        jsonb_build_object(
          v_binding.key,
          jsonb_strip_nulls(
            jsonb_build_object(
              'label', NULLIF(btrim(COALESCE(v_binding.value->>'label', '')), ''),
              'description', NULLIF(btrim(COALESCE(v_binding.value->>'description', '')), '')
            )
          )
        )
      )
    );

    FOR v_stage IN
      SELECT key, value
        FROM jsonb_each(COALESCE(v_binding.value->'stages', '{}'::jsonb))
    LOOP
      IF jsonb_typeof(v_stage.value) <> 'object' THEN
        CONTINUE;
      END IF;

      v_stage_value := v_stage.value;
      BEGIN
        v_source_template_id := public.workflow_binding_stage_template_id_v1(v_stage_value);
      EXCEPTION
        WHEN others THEN
          v_source_template_id := NULL;
      END;

      IF v_source_template_id IS NOT NULL THEN
        v_target_template_id := public.clone_workflow_template_service_v1(
          v_source_template_id,
          v_scope_type,
          p_scope_id,
          NULL,
          jsonb_build_object(
            'binding_key', v_binding.key,
            'stage_key', v_stage.key,
            'bootstrap_scope_type', v_scope_type,
            'bootstrap_scope_id', p_scope_id,
            'baseline_profile', v_baseline_profile
          )
        );
        v_stage_value := public.jsonb_deep_merge(
          v_stage_value,
          jsonb_build_object('workflow_template_id', v_target_template_id::TEXT)
        );
      END IF;

      v_target_policy := public.workflow_binding_stage_set_v1(
        v_target_policy,
        v_binding.key,
        v_stage.key,
        v_stage_value
      );

      v_seeded := v_seeded || jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'binding_key', v_binding.key,
            'stage_key', v_stage.key,
            'workflow_template_id', v_target_template_id
          )
        )
      );
    END LOOP;
  END LOOP;

  SELECT *
    INTO v_upserted
    FROM public.upsert_settings_value_v1(
      'workflow_binding_policy',
      v_scope_type,
      p_scope_id,
      v_target_policy,
      1,
      format('Workflow binding bootstrap (%s) for %s/%s', v_trigger_source, v_scope_type, p_scope_id)
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'scope_type', v_scope_type,
    'scope_id', p_scope_id,
    'baseline_profile', v_baseline_profile,
    'settings_id', v_upserted.settings_id,
    'settings_version_id', v_upserted.settings_version_id,
    'seeded_bindings', v_seeded
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_onboarding_v1(
  p_organization_id UUID,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_ensure_globals BOOLEAN;
  v_provision_templates BOOLEAN;
  v_scope_result JSONB := '{}'::jsonb;
  v_globals_result JSONB := '{}'::jsonb;
  v_binding_result JSONB := '{}'::jsonb;
  v_plugin_result JSONB := '{}'::jsonb;
  v_template_keys_json JSONB;
  v_template_keys TEXT[] := ARRAY[]::TEXT[];
  v_template TEXT;
  v_provisioned JSONB := '[]'::jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_tenant_onboarding_v1: organization_id is required' USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.organizations o WHERE o.id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap_tenant_onboarding_v1: organization % not found', p_organization_id USING ERRCODE = '23503';
  END IF;

  v_policy := public.resolve_saas_onboarding_policy_v1();
  v_enabled := public.onboarding_policy_bool_v1(v_policy, ARRAY['enabled'], TRUE);
  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object('ok', TRUE, 'enabled', FALSE, 'organization_id', p_organization_id, 'reason', 'disabled_by_policy');
  END IF;

  v_ensure_globals := public.onboarding_policy_bool_v1(v_policy, ARRAY['ensure_global_required_defaults'], TRUE);
  IF v_ensure_globals THEN
    v_globals_result := public.ensure_required_global_defaults_v1();
  END IF;

  v_scope_result := public.bootstrap_scope_settings_defaults_v1('tenant', p_organization_id, v_policy, p_trigger_source);
  v_binding_result := public.bootstrap_workflow_binding_defaults_v1('tenant', p_organization_id, p_trigger_source);
  v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('tenant', p_organization_id, p_trigger_source);

  v_provision_templates := public.onboarding_policy_bool_v1(v_policy, ARRAY['rbac', 'provision_templates'], TRUE);
  IF v_provision_templates THEN
    v_template_keys_json := COALESCE(v_policy #> ARRAY['rbac', 'template_keys'], '[]'::jsonb);
    IF jsonb_typeof(v_template_keys_json) <> 'array' THEN
      v_template_keys_json := '[]'::jsonb;
    END IF;

    SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
      INTO v_template_keys
      FROM jsonb_array_elements_text(v_template_keys_json);

    IF array_length(v_template_keys, 1) IS NOT NULL THEN
      PERFORM public.provision_rbac_roles_from_templates_v1(p_organization_id, v_template_keys, NULL);
      FOREACH v_template IN ARRAY v_template_keys LOOP
        v_provisioned := v_provisioned || jsonb_build_array(v_template);
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'organization_id', p_organization_id,
    'scope_defaults', v_scope_result,
    'global_defaults', v_globals_result,
    'workflow_bindings', v_binding_result,
    'integration_plugins', v_plugin_result,
    'rbac_templates_provisioned', v_provisioned
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_client_onboarding_v1(
  p_client_id UUID,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_scope_result JSONB := '{}'::jsonb;
  v_plugin_result JSONB := '{}'::jsonb;
  v_create_default_sender BOOLEAN;
  v_default_sender_name TEXT;
  v_default_sender_brand_name TEXT;
  v_default_sender_created BOOLEAN := FALSE;
BEGIN
  IF p_client_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_client_onboarding_v1: client_id is required' USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.clients c WHERE c.id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap_client_onboarding_v1: client % not found', p_client_id USING ERRCODE = '23503';
  END IF;

  v_policy := public.resolve_saas_onboarding_policy_v1();
  v_enabled := public.onboarding_policy_bool_v1(v_policy, ARRAY['enabled'], TRUE);
  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object('ok', TRUE, 'enabled', FALSE, 'client_id', p_client_id, 'reason', 'disabled_by_policy');
  END IF;

  v_scope_result := public.bootstrap_scope_settings_defaults_v1('client', p_client_id, v_policy, p_trigger_source);
  v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('client', p_client_id, p_trigger_source);

  v_create_default_sender := public.onboarding_policy_bool_v1(v_policy, ARRAY['client_defaults', 'create_default_sender'], TRUE);
  IF v_create_default_sender THEN
    v_default_sender_name := NULLIF(btrim(COALESCE(v_policy #>> ARRAY['client_defaults', 'default_sender_name'], 'Default Sender')), '');
    IF v_default_sender_name IS NULL THEN
      v_default_sender_name := 'Default Sender';
    END IF;

    v_default_sender_brand_name := NULLIF(btrim(v_policy #>> ARRAY['client_defaults', 'default_sender_brand_name']), '');

    IF NOT EXISTS (SELECT 1 FROM public.senders s WHERE s.client_id = p_client_id) THEN
      INSERT INTO public.senders (
        client_id,
        name,
        brand_name,
        auto_provisioned,
        auto_recreate,
        status
      ) VALUES (
        p_client_id,
        v_default_sender_name,
        v_default_sender_brand_name,
        FALSE,
        TRUE,
        'active'
      );
      v_default_sender_created := TRUE;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'client_id', p_client_id,
    'scope_defaults', v_scope_result,
    'integration_plugins', v_plugin_result,
    'default_sender_created', v_default_sender_created
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_sender_onboarding_v1(
  p_sender_id UUID,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_scope_result JSONB := '{}'::jsonb;
  v_plugin_result JSONB := '{}'::jsonb;
BEGIN
  IF p_sender_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_sender_onboarding_v1: sender_id is required' USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.senders s WHERE s.id = p_sender_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap_sender_onboarding_v1: sender % not found', p_sender_id USING ERRCODE = '23503';
  END IF;

  v_policy := public.resolve_saas_onboarding_policy_v1();
  v_enabled := public.onboarding_policy_bool_v1(v_policy, ARRAY['enabled'], TRUE);
  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object('ok', TRUE, 'enabled', FALSE, 'sender_id', p_sender_id, 'reason', 'disabled_by_policy');
  END IF;

  v_scope_result := public.bootstrap_scope_settings_defaults_v1('sender', p_sender_id, v_policy, p_trigger_source);
  v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('sender', p_sender_id, p_trigger_source);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'sender_id', p_sender_id,
    'scope_defaults', v_scope_result,
    'integration_plugins', v_plugin_result
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_saas_onboarding_defaults_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL,
  p_trigger_source TEXT DEFAULT 'manual:reconcile_saas_onboarding_defaults_v1'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := lower(btrim(COALESCE(p_scope_type, '')));
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_global_result JSONB := public.ensure_required_global_defaults_v1();
  v_scope_result JSONB := '{}'::jsonb;
  v_workflow_result JSONB := NULL;
  v_plugin_result JSONB := NULL;
  v_provision_templates BOOLEAN;
  v_template_keys_json JSONB;
  v_template_keys TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_scope_type = '' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'scope_type', NULL,
      'scope_id', NULL,
      'global_defaults', v_global_result,
      'scope_defaults', NULL,
      'workflow_bindings', NULL,
      'integration_plugins', NULL
    );
  END IF;

  IF v_scope_type = 'global' THEN
    IF p_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=global requires NULL scope_id';
    END IF;
    v_scope_result := public.bootstrap_scope_settings_defaults_v1('global', NULL, v_policy, p_trigger_source);
  ELSIF v_scope_type = 'tenant' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=tenant requires non-NULL scope_id';
    END IF;

    PERFORM 1 FROM public.organizations WHERE id = p_scope_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 tenant % not found', p_scope_id USING ERRCODE = '23503';
    END IF;

    v_scope_result := public.bootstrap_scope_settings_defaults_v1('tenant', p_scope_id, v_policy, p_trigger_source);
    v_workflow_result := public.bootstrap_workflow_binding_defaults_v1('tenant', p_scope_id, p_trigger_source);
    v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('tenant', p_scope_id, p_trigger_source);

    v_provision_templates := public.onboarding_policy_bool_v1(v_policy, ARRAY['rbac', 'provision_templates'], TRUE);
    IF v_provision_templates THEN
      v_template_keys_json := COALESCE(v_policy #> ARRAY['rbac', 'template_keys'], '[]'::jsonb);
      IF jsonb_typeof(v_template_keys_json) <> 'array' THEN
        v_template_keys_json := '[]'::jsonb;
      END IF;

      SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
        INTO v_template_keys
        FROM jsonb_array_elements_text(v_template_keys_json);

      IF array_length(v_template_keys, 1) IS NOT NULL THEN
        PERFORM public.provision_rbac_roles_from_templates_v1(p_scope_id, v_template_keys, NULL);
      END IF;
    END IF;
  ELSIF v_scope_type = 'client' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=client requires non-NULL scope_id';
    END IF;

    PERFORM 1 FROM public.clients WHERE id = p_scope_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 client % not found', p_scope_id USING ERRCODE = '23503';
    END IF;

    v_scope_result := public.bootstrap_scope_settings_defaults_v1('client', p_scope_id, v_policy, p_trigger_source);
    v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('client', p_scope_id, p_trigger_source);
  ELSIF v_scope_type = 'sender' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=sender requires non-NULL scope_id';
    END IF;

    PERFORM 1 FROM public.senders WHERE id = p_scope_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 sender % not found', p_scope_id USING ERRCODE = '23503';
    END IF;

    v_scope_result := public.bootstrap_scope_settings_defaults_v1('sender', p_scope_id, v_policy, p_trigger_source);
    v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('sender', p_scope_id, p_trigger_source);
  ELSE
    RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 unsupported scope_type=%', p_scope_type;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'scope_type', v_scope_type,
    'scope_id', p_scope_id,
    'global_defaults', v_global_result,
    'scope_defaults', v_scope_result,
    'workflow_bindings', v_workflow_result,
    'integration_plugins', v_plugin_result
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 4) Onboarding readiness UI contract
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_get_onboarding_readiness_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope RECORD;
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_settings_expected TEXT[] := ARRAY[]::TEXT[];
  v_category TEXT;
  v_missing_categories JSONB := '[]'::jsonb;
  v_settings_status TEXT := 'ready';
  v_workflow_eval JSONB;
  v_plugin_eval JSONB;
  v_workflow_source RECORD;
  v_requested_policy JSONB;
  v_requested_scope_type TEXT;
  v_requested_scope_id UUID;
  v_plugin_summary JSONB;
  v_plugin_items JSONB := '[]'::jsonb;
  v_can_view_plugin_details BOOLEAN := FALSE;
  v_can_view_workflow_details BOOLEAN := FALSE;
  v_workflow_status TEXT := 'ready';
  v_blocking_findings JSONB := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_get_onboarding_readiness_v1 requires authenticated user';
  END IF;

  SELECT *
    INTO v_scope
    FROM public.resolve_settings_scope_context_v1(p_scope_type, p_scope_id)
   LIMIT 1;

  v_requested_scope_type := v_scope.scope_type;
  v_requested_scope_id := v_scope.scope_id;

  SELECT COALESCE(array_agg(category), ARRAY[]::TEXT[])
    INTO v_settings_expected
    FROM public.onboarding_policy_categories_v1(v_policy, v_requested_scope_type);

  FOREACH v_category IN ARRAY v_settings_expected LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM public.settings s
       WHERE s.category = v_category
         AND s.scope_type = v_requested_scope_type
         AND s.scope_id IS NOT DISTINCT FROM v_requested_scope_id
    ) THEN
      v_missing_categories := v_missing_categories || jsonb_build_array(v_category);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_missing_categories) > 0 THEN
    v_settings_status := 'blocked';
    v_blocking_findings := v_blocking_findings || jsonb_build_array(
      jsonb_build_object(
        'surface', 'settings_defaults',
        'code', 'missing_categories',
        'categories', v_missing_categories
      )
    );
  END IF;

  v_workflow_eval := public.user_capability_eval_v1('workflow_runs.read', v_requested_scope_type, v_requested_scope_id);
  v_can_view_workflow_details := COALESCE((v_workflow_eval->>'allowed')::BOOLEAN, FALSE);

  SELECT *
    INTO v_workflow_source
    FROM public.resolve_settings_row('workflow_binding_policy', v_requested_scope_type, v_requested_scope_id)
   LIMIT 1;

  SELECT s.cached_value
    INTO v_requested_policy
    FROM public.settings s
   WHERE s.category = 'workflow_binding_policy'
     AND s.scope_type = v_requested_scope_type
     AND s.scope_id IS NOT DISTINCT FROM v_requested_scope_id
   LIMIT 1;

  IF v_requested_scope_type = 'tenant' AND v_requested_policy IS NULL THEN
    v_workflow_status := 'blocked';
    v_blocking_findings := v_blocking_findings || jsonb_build_array(
      jsonb_build_object(
        'surface', 'workflow_bindings',
        'code', 'tenant_baseline_missing'
      )
    );
  ELSIF v_workflow_source.settings_id IS NULL THEN
    v_workflow_status := 'blocked';
    v_blocking_findings := v_blocking_findings || jsonb_build_array(
      jsonb_build_object(
        'surface', 'workflow_bindings',
        'code', 'resolved_policy_missing'
      )
    );
  END IF;

  v_plugin_eval := public.user_capability_eval_v1('integration_plugins.read', v_requested_scope_type, v_requested_scope_id);
  v_can_view_plugin_details := COALESCE((v_plugin_eval->>'allowed')::BOOLEAN, FALSE);
  v_plugin_summary := public.integration_plugin_baseline_readiness_v1(v_requested_scope_type, v_requested_scope_id);
  IF v_can_view_plugin_details THEN
    v_plugin_items := COALESCE(v_plugin_summary->'items', '[]'::jsonb);
  END IF;

  IF COALESCE((v_plugin_summary->>'blocking_total')::INT, 0) > 0 THEN
    v_blocking_findings := v_blocking_findings || jsonb_build_array(
      jsonb_build_object(
        'surface', 'integration_plugins',
        'code', 'baseline_blocking_items',
        'blocking_total', COALESCE((v_plugin_summary->>'blocking_total')::INT, 0)
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'scope_type', v_requested_scope_type,
    'scope_id', v_requested_scope_id,
    'organization_id', v_scope.organization_id,
    'client_id', v_scope.client_id,
    'sender_id', v_scope.sender_id,
    'status', CASE
      WHEN v_settings_status = 'blocked'
        OR v_workflow_status = 'blocked'
        OR COALESCE((v_plugin_summary->>'blocking_total')::INT, 0) > 0 THEN 'blocked'
      ELSE 'ready'
    END,
    'settings_defaults', jsonb_build_object(
      'status', v_settings_status,
      'expected_categories', to_jsonb(COALESCE(v_settings_expected, ARRAY[]::TEXT[])),
      'missing_categories', v_missing_categories
    ),
    'workflow_bindings', jsonb_build_object(
      'status', v_workflow_status,
      'baseline_profile', COALESCE(v_policy #>> ARRAY['workflow_bindings', 'baseline_profile'], 'standard_operations'),
      'requested_scope_type', v_requested_scope_type,
      'requested_scope_id', v_requested_scope_id,
      'resolved_scope_type', v_workflow_source.scope_type,
      'resolved_scope_id', v_workflow_source.scope_id,
      'settings_id', v_workflow_source.settings_id,
      'settings_version_id', v_workflow_source.settings_version_id,
      'scope_path', v_workflow_source.scope_path,
      'is_overridden_at_requested_scope', v_requested_policy IS NOT NULL,
      'can_view_details', v_can_view_workflow_details
    ),
    'integration_plugins', jsonb_build_object(
      'status', COALESCE(v_plugin_summary->>'status', 'unknown'),
      'baseline_profile', COALESCE(v_plugin_summary->>'profile_key', 'standard_operations'),
      'required_total', COALESCE((v_plugin_summary->>'required_total')::INT, 0),
      'installed_total', COALESCE((v_plugin_summary->>'installed_total')::INT, 0),
      'blocking_total', COALESCE((v_plugin_summary->>'blocking_total')::INT, 0),
      'pending_credentials_total', COALESCE((v_plugin_summary->>'pending_credentials_total')::INT, 0),
      'active_total', COALESCE((v_plugin_summary->>'active_total')::INT, 0),
      'can_view_details', v_can_view_plugin_details,
      'items', v_plugin_items
    ),
    'blocking_findings', v_blocking_findings
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_get_onboarding_readiness_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_get_onboarding_readiness_v1(p_scope_type, p_scope_id);
$function$;

-------------------------------------------------------------------------------
-- 5) Grants
-------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.integration_plugin_baseline_policy_default_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_integration_plugin_baseline_policy_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_baseline_profile_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_baseline_plugin_key_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_baseline_entry_hash_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_baseline_scope_context_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_baseline_ensure_pending_task_v1(UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_baseline_install_entry_v1(UUID, TEXT, UUID, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_integration_plugin_defaults_v1(TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_baseline_readiness_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION api.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.integration_plugin_baseline_policy_default_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_integration_plugin_baseline_policy_v1(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_baseline_profile_v1(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_baseline_plugin_key_v1(TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_baseline_entry_hash_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_baseline_scope_context_v1(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_baseline_ensure_pending_task_v1(UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_baseline_install_entry_v1(UUID, TEXT, UUID, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_integration_plugin_defaults_v1(TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_baseline_readiness_v1(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.ui_get_onboarding_readiness_v1(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_get_onboarding_readiness_v1(TEXT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604121130_onboarding_plugin_baseline_readiness_v1'));
COMMIT;
