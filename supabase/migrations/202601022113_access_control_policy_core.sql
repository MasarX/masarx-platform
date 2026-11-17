-- Migration: Access control policy core (capabilities + policy helpers)
-- Plan: PLAN-202601-access-control-capabilities-v2 / Step: S04
-- Purpose: Add access_control_policy schema/category, seed defaults, and capability helpers.
BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Lookup: user_type governance (idempotent)
-- ---------------------------------------------------------------------------
INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'user_type',
  'User access role keys for capability mapping',
  'security',
  'tier_1',
  true
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

WITH def AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'user_type'
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT
  def.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM def
CROSS JOIN (VALUES
  ('super_admin', 'Super Admin', 'Platform-wide admin role', 1, false, '{}'::jsonb),
  ('ops_admin', 'Ops Admin', 'Operations admin role', 2, true, '{}'::jsonb),
  ('account_manager', 'Account Manager', 'Client-facing manager role', 3, false, '{}'::jsonb),
  ('client_admin', 'Client Admin', 'Client portal admin role', 4, false, '{}'::jsonb),
  ('sender_user', 'Sender User', 'Sender portal user role', 5, false, '{}'::jsonb)
) AS v(value, label, description, sort_order, is_default, metadata)
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) Settings category registry (SSOT)
-- ---------------------------------------------------------------------------
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
  'access_control_policy',
  'Capability-driven access control policy',
  true,
  true,
  false,
  'hard_fail',
  '["global","tenant","client","sender"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- 3) Schema registry (access_control_policy)
-- ---------------------------------------------------------------------------
WITH schema_doc AS (
  SELECT
    'access_control_policy'::text AS category,
    1 AS version,
    '{
      "$schema":"http://json-schema.org/draft-07/schema#",
      "type":"object",
      "additionalProperties":true,
      "properties":{
        "version":{"type":"integer"},
        "capabilities":{
          "type":"array",
          "items":{
            "type":"object",
            "additionalProperties":true,
            "properties":{
              "key":{"type":"string"},
              "label":{"type":"string"},
              "description":{"type":"string"},
              "category":{"type":"string"},
              "actions":{"type":"array","items":{"type":"string"}},
              "apps":{"type":"array","items":{"type":"string"}},
              "tags":{"type":"array","items":{"type":"string"}}
            },
            "required":["key"]
          }
        },
        "roles":{
          "type":"array",
          "items":{
            "type":"object",
            "additionalProperties":true,
            "properties":{
              "key":{"type":"string"},
              "label":{"type":"string"},
              "description":{"type":"string"},
              "capability_keys":{"type":"array","items":{"type":"string"}}
            },
            "required":["key","capability_keys"]
          }
        },
        "assignments":{
          "type":"object",
          "additionalProperties":true,
          "properties":{
            "user_type":{
              "type":"object",
              "additionalProperties":{"type":"array","items":{"type":"string"}}
            },
            "user_id":{
              "type":"object",
              "additionalProperties":{"type":"array","items":{"type":"string","format":"uuid"}}
            }
          }
        },
        "denies":{
          "type":"array",
          "items":{
            "type":"object",
            "additionalProperties":true,
            "properties":{
              "capability_key":{"type":"string"},
              "scope_type":{"type":"string"},
              "scope_id":{"type":["string","null"]},
              "reason":{"type":"string"}
            },
            "required":["capability_key"]
          }
        },
        "resource_map":{
          "type":"object",
          "additionalProperties":{
            "type":"object",
            "properties":{
              "read":{"type":"string"},
              "write":{"type":"string"},
              "execute":{"type":"string"}
            }
          }
        }
      }
    }'::jsonb AS schema,
    'Capability-driven access control policy (v1)'::text AS description
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT category, version, schema, description, NULL, true
FROM schema_doc
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    is_active = true;

-- ---------------------------------------------------------------------------
-- 4) Seed global access_control_policy (fail-closed defaults)
-- ---------------------------------------------------------------------------
WITH policy AS (
  SELECT '{
    "version": 1,
    "capabilities": [
      {"key":"system.write","label":"System write","description":"Broad system write access"},
      {"key":"organizations.read","label":"Organizations read"},
      {"key":"organizations.write","label":"Organizations write"},
      {"key":"clients.read","label":"Clients read"},
      {"key":"clients.write","label":"Clients write"},
      {"key":"senders.read","label":"Senders read"},
      {"key":"senders.write","label":"Senders write"},
      {"key":"shipments.read","label":"Shipments read"},
      {"key":"shipments.write","label":"Shipments write"},
      {"key":"recipients.read","label":"Recipients read"},
      {"key":"recipients.write","label":"Recipients write"},
      {"key":"addresses.read","label":"Addresses read"},
      {"key":"addresses.write","label":"Addresses write"},
      {"key":"labels.read","label":"Labels read"},
      {"key":"labels.download","label":"Labels download"},
      {"key":"manual_review.read","label":"Manual review read"},
      {"key":"manual_review.resolve","label":"Manual review resolve"},
      {"key":"settings.read","label":"Settings read"},
      {"key":"settings.request","label":"Settings request change"},
      {"key":"settings.approve","label":"Settings approve"},
      {"key":"access_policy.read","label":"Access policy read"},
      {"key":"access_policy.request","label":"Access policy request change"},
      {"key":"access_policy.approve","label":"Access policy approve"},
      {"key":"token_rotation.read","label":"Token rotation read"},
      {"key":"token_rotation.request","label":"Token rotation request"},
      {"key":"token_rotation.approve","label":"Token rotation approve"},
      {"key":"audit_log.read","label":"Audit log read"},
      {"key":"users.read","label":"Users read"},
      {"key":"users.manage","label":"Users manage"},
      {"key":"integrations.read","label":"Integrations read"},
      {"key":"api_routes.read","label":"API routes read"},
      {"key":"webhook_sources.read","label":"Webhook sources read"},
      {"key":"provider_auth.read","label":"Provider auth read"},
      {"key":"workflow_runs.read","label":"Workflow runs read"},
      {"key":"requests.read","label":"Requests read"},
      {"key":"requests.create","label":"Requests create"}
    ],
    "roles": [
      {"key":"super_admin","label":"Super Admin","capability_keys":["*"]},
      {"key":"ops_admin","label":"Ops Admin","capability_keys":[
        "system.write",
        "organizations.read","organizations.write",
        "clients.read","clients.write",
        "senders.read","senders.write",
        "shipments.read","shipments.write",
        "recipients.read","recipients.write",
        "addresses.read","addresses.write",
        "labels.read","labels.download",
        "manual_review.read","manual_review.resolve",
        "settings.read","settings.request","settings.approve",
        "access_policy.read","access_policy.request","access_policy.approve",
        "token_rotation.read","token_rotation.request","token_rotation.approve",
        "audit_log.read",
        "users.read","users.manage",
        "integrations.read","api_routes.read","webhook_sources.read","provider_auth.read",
        "workflow_runs.read",
        "requests.read","requests.create"
      ]},
      {"key":"account_manager","label":"Account Manager","capability_keys":[
        "clients.read","clients.write",
        "senders.read","senders.write",
        "shipments.read",
        "recipients.read",
        "addresses.read",
        "labels.read","labels.download",
        "settings.read",
        "requests.read","requests.create"
      ]},
      {"key":"client_admin","label":"Client Admin","capability_keys":[
        "shipments.read",
        "recipients.read",
        "addresses.read",
        "labels.read","labels.download",
        "requests.read","requests.create"
      ]},
      {"key":"sender_user","label":"Sender User","capability_keys":[
        "shipments.read",
        "recipients.read",
        "addresses.read",
        "labels.read","labels.download"
      ]}
    ],
    "assignments": {
      "user_type": {
        "super_admin": ["super_admin"],
        "ops_admin": ["ops_admin"],
        "account_manager": ["account_manager"],
        "client_admin": ["client_admin"],
        "sender_user": ["sender_user"]
      }
    },
    "resource_map": {
      "organizations": {"read":"organizations.read","write":"organizations.write"},
      "clients": {"read":"clients.read","write":"clients.write"},
      "senders": {"read":"senders.read","write":"senders.write"},
      "shipments": {"read":"shipments.read","write":"shipments.write"},
      "recipients": {"read":"recipients.read","write":"recipients.write"},
      "addresses": {"read":"addresses.read","write":"addresses.write"},
      "shipment_actions": {"read":"shipments.read"},
      "manual_review_tasks": {"read":"manual_review.read","write":"manual_review.resolve"}
    },
    "denies": []
  }'::jsonb AS body
), inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at
  )
  SELECT
    'access_control_policy',
    'global',
    NULL::uuid,
    1,
    policy.body,
    1,
    'seed access_control_policy global defaults',
    now()
  FROM policy
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions sv
    WHERE sv.category = 'access_control_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'access_control_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings s
  WHERE s.category = 'access_control_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
);

-- ---------------------------------------------------------------------------
-- 5) Capability helpers (SSOT, no hardcoded role checks)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capability_key_match(
  p_capability TEXT,
  p_rule TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_rule IS NULL OR btrim(p_rule) = '' THEN FALSE
    WHEN p_rule = '*' THEN TRUE
    WHEN p_rule = p_capability THEN TRUE
    WHEN right(p_rule, 2) = '.*' THEN p_capability LIKE left(p_rule, length(p_rule) - 1) || '%'
    ELSE FALSE
  END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_role_keys_v1(
  p_policy JSONB,
  p_user_id UUID,
  p_user_type TEXT
)
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_roles JSONB;
  v_keys TEXT[] := ARRAY[]::text[];
BEGIN
  IF p_policy IS NULL OR p_user_id IS NULL THEN
    RETURN v_keys;
  END IF;

  v_roles := p_policy #> ARRAY['assignments','user_id', p_user_id::text];
  IF v_roles IS NOT NULL AND jsonb_typeof(v_roles) = 'array' THEN
    SELECT array_agg(DISTINCT value) INTO v_keys
    FROM jsonb_array_elements_text(v_roles);
    RETURN COALESCE(v_keys, ARRAY[]::text[]);
  END IF;

  v_roles := p_policy #> ARRAY['assignments','user_type', COALESCE(p_user_type, '')];
  IF v_roles IS NOT NULL AND jsonb_typeof(v_roles) = 'array' THEN
    SELECT array_agg(DISTINCT value) INTO v_keys
    FROM jsonb_array_elements_text(v_roles);
    RETURN COALESCE(v_keys, ARRAY[]::text[]);
  END IF;

  IF p_user_type IS NOT NULL AND btrim(p_user_type) <> '' THEN
    RETURN ARRAY[p_user_type];
  END IF;

  RETURN v_keys;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_capabilities_v1(
  p_policy JSONB,
  p_role_keys TEXT[]
)
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_role JSONB;
  v_keys TEXT[] := ARRAY[]::text[];
  v_caps TEXT[];
BEGIN
  IF p_policy IS NULL OR p_role_keys IS NULL THEN
    RETURN v_keys;
  END IF;

  FOR v_role IN SELECT jsonb_array_elements(COALESCE(p_policy->'roles', '[]'::jsonb)) LOOP
    IF v_role->>'key' = ANY(p_role_keys) THEN
      v_caps := ARRAY(
        SELECT jsonb_array_elements_text(COALESCE(v_role->'capability_keys', '[]'::jsonb))
      );
      IF v_caps IS NOT NULL THEN
        v_keys := v_keys || v_caps;
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_keys, 1) IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;

  SELECT array_agg(DISTINCT k) INTO v_keys FROM unnest(v_keys) AS k;
  RETURN COALESCE(v_keys, ARRAY[]::text[]);
END;
$$;

CREATE OR REPLACE FUNCTION public.access_eval_capability_v1(
  p_policy JSONB,
  p_capability_key TEXT,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_user_id UUID,
  p_user_type TEXT
)
RETURNS TABLE (
  allowed BOOLEAN,
  reason TEXT,
  role_keys TEXT[],
  capability_keys TEXT[]
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_roles TEXT[];
  v_caps TEXT[];
  v_deny JSONB;
  v_deny_key TEXT;
  v_deny_scope_type TEXT;
  v_deny_scope_id UUID;
BEGIN
  allowed := FALSE;
  reason := 'no_policy';
  role_keys := ARRAY[]::text[];
  capability_keys := ARRAY[]::text[];

  IF p_policy IS NULL OR p_capability_key IS NULL OR btrim(p_capability_key) = '' THEN
    RETURN NEXT;
    RETURN;
  END IF;

  role_keys := public.resolve_role_keys_v1(p_policy, p_user_id, p_user_type);
  IF role_keys IS NULL OR array_length(role_keys, 1) IS NULL THEN
    reason := 'no_roles';
    RETURN NEXT;
    RETURN;
  END IF;

  IF jsonb_typeof(p_policy->'denies') = 'array' THEN
    FOR v_deny IN SELECT jsonb_array_elements(p_policy->'denies') LOOP
      v_deny_key := NULLIF(v_deny->>'capability_key', '');
      IF v_deny_key IS NULL THEN
        CONTINUE;
      END IF;
      IF public.capability_key_match(p_capability_key, v_deny_key) THEN
        v_deny_scope_type := NULLIF(v_deny->>'scope_type', '');
        v_deny_scope_id := NULLIF(v_deny->>'scope_id', '')::uuid;
        IF v_deny_scope_type IS NULL THEN
          reason := 'explicit_deny';
          RETURN NEXT;
          RETURN;
        END IF;
        IF v_deny_scope_type = p_scope_type
           AND (v_deny_scope_id IS NULL OR v_deny_scope_id = p_scope_id) THEN
          reason := 'explicit_deny';
          RETURN NEXT;
          RETURN;
        END IF;
      END IF;
    END LOOP;
  END IF;

  v_caps := public.resolve_capabilities_v1(p_policy, role_keys);
  capability_keys := COALESCE(v_caps, ARRAY[]::text[]);
  IF array_length(capability_keys, 1) IS NULL THEN
    reason := 'no_capabilities';
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(capability_keys) AS cap
    WHERE public.capability_key_match(p_capability_key, cap)
  ) THEN
    allowed := TRUE;
    reason := 'allowed';
  ELSE
    reason := 'missing_capability';
  END IF;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_role_key()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_role TEXT;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT u.user_type
    INTO v_role
    FROM public.users u
   WHERE u.id = v_user_id;

  RETURN v_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_access_control_policy_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL,
  p_log BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  policy JSONB,
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  scope_path JSONB,
  settings_resolution_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), public.current_user_scope_type(), 'global'));
  v_scope_id UUID := COALESCE(p_scope_id, public.current_user_scope_id());
  v_row RECORD;
  v_policy JSONB;
  v_org_id UUID;
  v_resolution_id UUID := NULL;
BEGIN
  IF v_scope_type = 'platform' THEN
    v_scope_type := 'global';
    v_scope_id := NULL;
  ELSIF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  SELECT *
    INTO v_row
    FROM public.resolve_settings_row('access_control_policy', v_scope_type, v_scope_id)
    LIMIT 1;

  IF v_row.settings_id IS NULL THEN
    RETURN;
  END IF;

  v_policy := public.resolve_settings_merged('access_control_policy', v_scope_type, v_scope_id);

  IF p_log THEN
    IF v_scope_type = 'tenant' THEN
      v_org_id := v_scope_id;
    ELSIF v_scope_type = 'client' THEN
      SELECT organization_id INTO v_org_id FROM public.clients WHERE id = v_scope_id;
    ELSIF v_scope_type = 'sender' THEN
      SELECT c.organization_id
        INTO v_org_id
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_scope_id;
    ELSE
      v_org_id := public.current_user_org_id();
    END IF;

    IF v_org_id IS NOT NULL THEN
      v_resolution_id := public.log_settings_resolution(
        p_organization_id := v_org_id,
        p_category := 'access_control_policy',
        p_winning_scope_type := v_row.scope_type,
        p_winning_scope_id := v_row.scope_id,
        p_winning_settings_id := v_row.settings_id,
        p_winning_settings_version_id := v_row.settings_version_id,
        p_winning_version := v_row.version,
        p_scope_path := v_row.scope_path,
        p_inputs := jsonb_build_object(
          'requested_scope_type', v_scope_type,
          'requested_scope_id', v_scope_id
        ),
        p_merge_notes := jsonb_build_object('merged', true)
      );
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_policy,
    v_row.settings_id,
    v_row.settings_version_id,
    v_row.scope_type,
    v_row.scope_id,
    v_row.scope_path,
    v_resolution_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.user_has_capability_v1(
  p_capability_key TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_user_type TEXT;
  v_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), public.current_user_scope_type(), 'global'));
  v_scope_id UUID := COALESCE(p_scope_id, public.current_user_scope_id());
  v_policy JSONB;
  v_allowed BOOLEAN := FALSE;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_scope_type = 'platform' THEN
    v_scope_type := 'global';
    v_scope_id := NULL;
  ELSIF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  SELECT user_type INTO v_user_type
    FROM public.users
   WHERE id = v_user_id;

  SELECT policy INTO v_policy
    FROM public.resolve_access_control_policy_v1(v_scope_type, v_scope_id, FALSE)
    LIMIT 1;

  IF v_policy IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT allowed INTO v_allowed
    FROM public.access_eval_capability_v1(
      v_policy,
      p_capability_key,
      v_scope_type,
      v_scope_id,
      v_user_id,
      v_user_type
    );

  RETURN COALESCE(v_allowed, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.user_has_resource_capability_v1(
  p_resource TEXT,
  p_action TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_user_type TEXT;
  v_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), public.current_user_scope_type(), 'global'));
  v_scope_id UUID := COALESCE(p_scope_id, public.current_user_scope_id());
  v_policy JSONB;
  v_capability TEXT;
  v_allowed BOOLEAN := FALSE;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_scope_type = 'platform' THEN
    v_scope_type := 'global';
    v_scope_id := NULL;
  ELSIF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  SELECT user_type INTO v_user_type
    FROM public.users
   WHERE id = v_user_id;

  SELECT policy INTO v_policy
    FROM public.resolve_access_control_policy_v1(v_scope_type, v_scope_id, FALSE)
    LIMIT 1;

  IF v_policy IS NULL THEN
    RETURN FALSE;
  END IF;

  v_capability := COALESCE(
    v_policy #>> ARRAY['resource_map', p_resource, p_action],
    p_resource || '.' || p_action
  );

  SELECT allowed INTO v_allowed
    FROM public.access_eval_capability_v1(
      v_policy,
      v_capability,
      v_scope_type,
      v_scope_id,
      v_user_id,
      v_user_type
    );

  RETURN COALESCE(v_allowed, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.user_capability_eval_v1(
  p_capability_key TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_user_type TEXT;
  v_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), public.current_user_scope_type(), 'global'));
  v_scope_id UUID := COALESCE(p_scope_id, public.current_user_scope_id());
  v_policy JSONB;
  v_row RECORD;
  v_allowed BOOLEAN := FALSE;
  v_reason TEXT := 'no_policy';
  v_roles TEXT[] := ARRAY[]::text[];
  v_caps TEXT[] := ARRAY[]::text[];
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  END IF;

  IF v_scope_type = 'platform' THEN
    v_scope_type := 'global';
    v_scope_id := NULL;
  ELSIF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  SELECT user_type INTO v_user_type
    FROM public.users
   WHERE id = v_user_id;

  SELECT * INTO v_row
    FROM public.resolve_access_control_policy_v1(v_scope_type, v_scope_id, FALSE)
    LIMIT 1;

  v_policy := v_row.policy;

  IF v_policy IS NOT NULL THEN
    SELECT allowed, reason, role_keys, capability_keys
      INTO v_allowed, v_reason, v_roles, v_caps
      FROM public.access_eval_capability_v1(
        v_policy,
        p_capability_key,
        v_scope_type,
        v_scope_id,
        v_user_id,
        v_user_type
      );
  END IF;

  RETURN jsonb_build_object(
    'allowed', COALESCE(v_allowed, FALSE),
    'reason', COALESCE(v_reason, 'unknown'),
    'capability_key', p_capability_key,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'role_keys', COALESCE(v_roles, ARRAY[]::text[]),
    'granted_capabilities', COALESCE(v_caps, ARRAY[]::text[]),
    'policy_source', jsonb_strip_nulls(jsonb_build_object(
      'settings_id', v_row.settings_id,
      'settings_version_id', v_row.settings_version_id,
      'policy_scope_type', v_row.scope_type,
      'policy_scope_id', v_row.scope_id,
      'scope_path', v_row.scope_path
    ))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_capability_v1(
  p_capability_key TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_eval JSONB;
BEGIN
  v_eval := public.user_capability_eval_v1(p_capability_key, p_scope_type, p_scope_id);
  IF COALESCE((v_eval->>'allowed')::boolean, FALSE) = FALSE THEN
    RAISE EXCEPTION 'Capability denied: %', p_capability_key
      USING ERRCODE = '42501',
            DETAIL = v_eval::text;
  END IF;
END;
$$;

-- Update user_can_write to rely on capability checks (no scope-only shortcuts).
CREATE OR REPLACE FUNCTION public.user_can_write()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.user_has_capability_v1('system.write');
$$;

COMMENT ON FUNCTION public.user_can_write()
  IS 'Returns TRUE when current user has system.write capability.';

REVOKE ALL ON FUNCTION public.current_user_role_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_access_control_policy_v1(TEXT, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_has_capability_v1(TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_has_resource_capability_v1(TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_capability_eval_v1(TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_capability_v1(TEXT, TEXT, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.current_user_role_key() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_access_control_policy_v1(TEXT, UUID, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_has_capability_v1(TEXT, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_has_resource_capability_v1(TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_capability_eval_v1(TEXT, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_capability_v1(TEXT, TEXT, UUID) TO authenticated, service_role;

COMMIT;
