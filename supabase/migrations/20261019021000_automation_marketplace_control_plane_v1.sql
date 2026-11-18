-- Preserve the effective marketplace control plane on current schema; no deployed history replay.
BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('20261019021000_automation_marketplace_control_plane_v1'));

-- Vault is Supabase-owned infrastructure, not an application migration's installation authority.
DO $vault_preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto') THEN
    RAISE EXCEPTION 'Automation marketplace requires the platform-provisioned pgcrypto extension'
      USING ERRCODE='42501', HINT='Enable pgcrypto through the platform before replaying application migrations.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='supabase_vault') THEN
    RAISE EXCEPTION 'Automation marketplace requires the platform-provisioned supabase_vault extension'
      USING ERRCODE='42501', HINT='Enable Supabase Vault through the platform before replaying application migrations.';
  END IF;
END;
$vault_preflight$;

-- Marketplace credentials are selected only by explicit authorized binding, never provider fallback.
-- The durable marker survives connection deletion/provider changes; legacy rows remain unmarked.
ALTER TABLE public.provider_auth_configs ADD COLUMN marketplace_explicit_only BOOLEAN NOT NULL DEFAULT FALSE;

-------------------------------------------------------------------------------
-- 1) Lookup categories + values
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('automation_asset_kind', 'Automation marketplace asset kinds.', 'operations', 'tier_1', FALSE),
  ('automation_asset_visibility', 'Automation marketplace visibility modes.', 'operations', 'tier_1', FALSE),
  ('automation_asset_publication_status', 'Automation marketplace publication lifecycle status.', 'operations', 'tier_1', FALSE),
  ('automation_asset_review_status', 'Automation marketplace review decisions.', 'operations', 'tier_1', FALSE),
  ('automation_asset_install_status', 'Automation marketplace install lifecycle status.', 'operations', 'tier_1', FALSE),
  ('automation_asset_source_snapshot_type', 'Automation marketplace source snapshot types.', 'operations', 'tier_1', FALSE),
  ('integration_connection_auth_type', 'Installer-owned integration connection auth types.', 'operations', 'tier_1', FALSE),
  ('integration_connection_status', 'Installer-owned integration connection lifecycle status.', 'operations', 'tier_1', FALSE),
  ('integration_secret_storage_mode', 'How connection secrets are stored.', 'operations', 'tier_1', FALSE)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
JOIN (
  VALUES
    ('automation_asset_kind', 'integration_plugin', 'Integration Plugin', 'External connector/config package.', 10, FALSE, '{}'),
    ('automation_asset_kind', 'workflow_template', 'Workflow Template', 'Automation logic/orchestration asset.', 20, TRUE, '{}'),

    ('automation_asset_visibility', 'private', 'Private', 'Visible only within the owner scope.', 10, TRUE, '{}'),
    ('automation_asset_visibility', 'tenant_shared', 'Tenant Shared', 'Visible/installable within the owner tenant hierarchy only.', 20, FALSE, '{}'),
    ('automation_asset_visibility', 'marketplace_public', 'Marketplace Public', 'Public marketplace listing after review approval.', 30, FALSE, '{}'),

    ('automation_asset_publication_status', 'draft', 'Draft', 'Draft listing or listing version.', 10, TRUE, '{}'),
    ('automation_asset_publication_status', 'submitted', 'Submitted', 'Submitted for review/publication.', 20, FALSE, '{}'),
    ('automation_asset_publication_status', 'approved', 'Approved', 'Approved for marketplace use.', 30, FALSE, '{}'),
    ('automation_asset_publication_status', 'rejected', 'Rejected', 'Rejected during review.', 40, FALSE, '{}'),
    ('automation_asset_publication_status', 'deprecated', 'Deprecated', 'Still installable but superseded.', 50, FALSE, '{}'),
    ('automation_asset_publication_status', 'delisted', 'Delisted', 'Removed from active search/install.', 60, FALSE, '{}'),

    ('automation_asset_review_status', 'pending', 'Pending', 'Awaiting reviewer decision.', 10, TRUE, '{}'),
    ('automation_asset_review_status', 'approved', 'Approved', 'Reviewer approved the listing version.', 20, FALSE, '{}'),
    ('automation_asset_review_status', 'rejected', 'Rejected', 'Reviewer rejected the listing version.', 30, FALSE, '{}'),

    ('automation_asset_install_status', 'pending', 'Pending', 'Install is being prepared.', 10, TRUE, '{}'),
    ('automation_asset_install_status', 'installed', 'Installed', 'Install completed and local copy exists.', 20, FALSE, '{}'),
    ('automation_asset_install_status', 'forked', 'Forked', 'Install diverged from upstream listing.', 30, FALSE, '{}'),
    ('automation_asset_install_status', 'revoked', 'Revoked', 'Install no longer active/usable.', 40, FALSE, '{}'),

    ('automation_asset_source_snapshot_type', 'workflow_template_revision', 'Workflow Template Revision', 'Immutable workflow template revision snapshot.', 10, FALSE, '{}'),
    ('automation_asset_source_snapshot_type', 'integration_plugin_version', 'Integration Plugin Version', 'Immutable integration plugin version snapshot.', 20, TRUE, '{}'),

    ('integration_connection_auth_type', 'api_key', 'API Key', 'API key based outbound auth.', 10, TRUE, '{}'),
    ('integration_connection_auth_type', 'bearer_token', 'Bearer Token', 'Bearer token outbound auth.', 20, FALSE, '{}'),
    ('integration_connection_auth_type', 'basic_auth', 'Basic Auth', 'Basic auth username/password.', 30, FALSE, '{}'),
    ('integration_connection_auth_type', 'hmac_shared_secret', 'HMAC Shared Secret', 'Shared secret used for request signing or verification.', 40, FALSE, '{}'),
    ('integration_connection_auth_type', 'oauth2_authorization_code_pkce', 'OAuth2 PKCE', 'OAuth 2.0 authorization code with PKCE.', 50, FALSE, '{}'),

    ('integration_connection_status', 'draft', 'Draft', 'Connection saved but not validated.', 10, TRUE, '{}'),
    ('integration_connection_status', 'ready', 'Ready', 'Connection valid and available for use.', 20, FALSE, '{}'),
    ('integration_connection_status', 'test_failed', 'Test Failed', 'Connection test failed.', 30, FALSE, '{}'),
    ('integration_connection_status', 'rotate_required', 'Rotate Required', 'Credential rotation required before use.', 40, FALSE, '{}'),
    ('integration_connection_status', 'reauth_required', 'Reauth Required', 'OAuth reauthentication required.', 50, FALSE, '{}'),
    ('integration_connection_status', 'disabled', 'Disabled', 'Connection disabled but retained.', 60, FALSE, '{}'),
    ('integration_connection_status', 'revoked', 'Revoked', 'Connection revoked and should not be used.', 70, FALSE, '{}'),

    ('integration_secret_storage_mode', 'vault', 'Vault', 'Secret is stored in Supabase Vault.', 10, TRUE, '{}'),
    ('integration_secret_storage_mode', 'hash_only', 'Hash Only', 'Verifier-only secret is stored as a one-way hash.', 20, FALSE, '{}')
) AS v(category, value, label, description, sort_order, is_default, metadata)
  ON ld.category = v.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  metadata = EXCLUDED.metadata,
  updated_at = now();

-------------------------------------------------------------------------------
-- 2) Settings category + schema registry + default policy
-------------------------------------------------------------------------------

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
  'automation_marketplace_policy',
  'Automation marketplace publication/install/connection/secret policy (row-driven).',
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

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES
  (
    'automation_marketplace_policy',
    1,
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "title": "Automation Marketplace Policy",
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "version": { "type": "integer", "minimum": 1 },
        "publication": {
          "type": ["object", "null"],
          "additionalProperties": true,
          "properties": {
            "public_review_required": { "type": ["boolean", "null"] },
            "allow_sender_public_publish": { "type": ["boolean", "null"] },
            "allowed_visibility_modes": {
              "type": ["array", "null"],
              "items": { "type": "string" }
            }
          }
        },
        "install": {
          "type": ["object", "null"],
          "additionalProperties": true,
          "properties": {
            "allowed_target_scope_types": {
              "type": ["array", "null"],
              "items": { "type": "string" }
            },
            "copy_on_install_only": { "type": ["boolean", "null"] },
            "manual_upgrade_only": { "type": ["boolean", "null"] }
          }
        },
        "connections": {
          "type": ["object", "null"],
          "additionalProperties": true,
          "properties": {
            "reuse_mode": { "type": ["string", "null"] },
            "allow_cross_scope_reuse": { "type": ["boolean", "null"] },
            "require_test_before_activation": { "type": ["boolean", "null"] }
          }
        },
        "secrets": {
          "type": ["object", "null"],
          "additionalProperties": true,
          "properties": {
            "view_mode": { "type": ["string", "null"] },
            "allow_privileged_reveal": { "type": ["boolean", "null"] },
            "vault_required": { "type": ["boolean", "null"] }
          }
        },
        "inbound_auth": {
          "type": ["object", "null"],
          "additionalProperties": true,
          "properties": {
            "store_verifier_secrets_as_hash": { "type": ["boolean", "null"] },
            "rotation_grace_seconds": { "type": ["integer", "null"], "minimum": 0 }
          }
        },
        "oauth": {
          "type": ["object", "null"],
          "additionalProperties": true,
          "properties": {
            "providers": {
              "type": "object", "default": {}, "additionalProperties": {
                "type": "object", "additionalProperties": false,
                "required": ["provider_key","authorization_url","token_url","client_id","scopes","redirect_uri","console_origin"],
                "properties": {
                  "provider_key": {"type":"string","minLength":1},
                  "authorization_url": {"type":"string","pattern":"^https://"},
                  "token_url": {"type":"string","pattern":"^https://"},
                  "client_id": {"type":"string","minLength":1},
                  "scopes": {"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},
                  "redirect_uri": {"type":"string","pattern":"^https://"},
                  "console_origin": {"type":"string","pattern":"^https://"}
                }
              }
            },
            "pkce_required": { "type": ["boolean", "null"] },
            "exact_redirect_uri_match": { "type": ["boolean", "null"] },
            "minimize_scopes": { "type": ["boolean", "null"] },
            "refresh_rotation_required_when_supported": { "type": ["boolean", "null"] }
          }
        },
        "runtime": {
          "type": ["object", "null"],
          "additionalProperties": true,
          "properties": {
            "inject_secrets_at_dispatch_only": { "type": ["boolean", "null"] },
            "forbid_secrets_in_logs": { "type": ["boolean", "null"] },
            "forbid_secrets_in_exports": { "type": ["boolean", "null"] }
          }
        }
      }
    }'::jsonb,
    'Automation marketplace policy resolved via the settings ladder.',
    '[
      {
        "version": 1,
        "publication": {
          "public_review_required": true,
          "allow_sender_public_publish": false,
          "allowed_visibility_modes": ["private", "tenant_shared", "marketplace_public"]
        },
        "install": {
          "allowed_target_scope_types": ["tenant", "client", "sender"],
          "copy_on_install_only": true,
          "manual_upgrade_only": true
        },
        "connections": {
          "reuse_mode": "scope_local",
          "allow_cross_scope_reuse": false,
          "require_test_before_activation": true
        },
        "secrets": {
          "view_mode": "show_once_then_mask",
          "allow_privileged_reveal": false,
          "vault_required": true
        },
        "inbound_auth": {
          "store_verifier_secrets_as_hash": true,
          "rotation_grace_seconds": 86400
        },
        "oauth": {
          "providers": {},
          "pkce_required": true,
          "exact_redirect_uri_match": true,
          "minimize_scopes": true,
          "refresh_rotation_required_when_supported": true
        },
        "runtime": {
          "inject_secrets_at_dispatch_only": true,
          "forbid_secrets_in_logs": true,
          "forbid_secrets_in_exports": true
        }
      }
    ]'::jsonb,
    TRUE
  ),
  (
    'automation_marketplace_manifest',
    1,
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "title": "Automation Marketplace Manifest",
      "type": "object",
      "additionalProperties": true,
      "required": [
        "display",
        "docs",
        "variable_schema",
        "connection_requirements",
        "dependency_requirements",
        "capability_requirements",
        "install_constraints",
        "egress_profile",
        "compatibility",
        "artifact_hash"
      ],
      "properties": {
        "display": { "type": "object" },
        "docs": { "type": "object" },
        "variable_schema": { "type": "object" },
        "connection_requirements": { "type": "object" },
        "dependency_requirements": { "type": "object" },
        "capability_requirements": { "type": ["array", "object"] },
        "install_constraints": { "type": "object" },
        "egress_profile": { "type": "object" },
        "compatibility": { "type": "object" },
        "artifact_hash": { "type": "string" }
      }
    }'::jsonb,
    'Automation marketplace manifest contract used during publish/review/install validation.',
    '[
      {
        "display": { "title": "Shipment OTP Workflow" },
        "docs": { "summary": "Sends OTPs when shipment events arrive." },
        "variable_schema": {
          "shipment_status": { "type": "string" }
        },
        "connection_requirements": {
          "otp_provider": { "auth_types": ["api_key", "bearer_token"] }
        },
        "dependency_requirements": {},
        "capability_requirements": ["workflow_runs.write"],
        "install_constraints": {
          "allowed_target_scope_types": ["tenant", "client", "sender"],
          "allowed_scope_fields": ["scope_id", "scope_type"]
        },
        "egress_profile": { "https_only": true },
        "compatibility": { "min_app_version": 1 },
        "artifact_hash": "placeholder"
      }
    ]'::jsonb,
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE,
  updated_at = now();

DO $seed$
DECLARE
  v_example JSONB;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'automation_marketplace_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ) THEN
    SELECT examples->0 INTO v_example
    FROM public.schema_registry
    WHERE category = 'automation_marketplace_policy'
      AND version = 1
    LIMIT 1;

    PERFORM public.upsert_settings_value_v1(
      'automation_marketplace_policy',
      'global',
      NULL,
      COALESCE(v_example, '{}'::jsonb),
      1,
      'seed automation marketplace policy global default'
    );
  END IF;
END;
$seed$;

-------------------------------------------------------------------------------
-- 3) Helper functions
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.automation_marketplace_user_can_access_org_v1(p_organization_id UUID,p_visibility TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
 SELECT public.request_role_is_service_v1() OR public.is_platform_user()
  OR (public.current_user_org_id() IS NOT NULL AND p_organization_id=public.current_user_org_id());
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_scope_belongs_org_v1(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_organization_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN public.resolve_organization_id_for_scope_v1(p_scope_type, p_scope_id) IS NOT DISTINCT FROM p_organization_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_current_scope_can_manage_target_v1(p_scope_type TEXT,p_scope_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE target_type TEXT:=public.normalize_scope_type_v1(p_scope_type,TRUE); actor_type TEXT:=public.current_user_scope_type();
 actor_id UUID:=public.current_user_scope_id(); org UUID:=public.current_user_org_id();
BEGIN
 IF public.request_role_is_service_v1() THEN RETURN TRUE; END IF;
 IF auth.uid() IS NULL THEN RETURN FALSE; END IF;
 IF target_type=public.get_root_scope_type_key_v1() THEN RETURN public.is_platform_user() AND p_scope_id IS NULL; END IF;
 IF p_scope_id IS NULL OR public.resolve_organization_id_for_scope_v1(target_type,p_scope_id) IS NULL THEN RETURN FALSE; END IF;
 IF public.is_platform_user() THEN RETURN TRUE; END IF;
 IF org IS NULL THEN RETURN FALSE; END IF;
 IF public.resolve_organization_id_for_scope_v1(target_type,p_scope_id) IS DISTINCT FROM org THEN RETURN FALSE; END IF;
 IF actor_type='tenant' THEN RETURN TRUE; END IF;
 IF actor_type=target_type AND actor_id=p_scope_id THEN RETURN TRUE; END IF;
 IF actor_type='client' AND target_type='sender' THEN
  RETURN EXISTS(SELECT 1 FROM public.senders WHERE id=p_scope_id AND client_id=actor_id);
 END IF;
 RETURN FALSE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_secret_hint_v1(p_secret TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_clean TEXT := COALESCE(p_secret, '');
  v_len INTEGER;
BEGIN
  v_len := char_length(v_clean);
  IF v_len <= 0 THEN
    RETURN NULL;
  END IF;
  IF v_len <= 4 THEN
    RETURN repeat('*', v_len);
  END IF;
  RETURN repeat('*', GREATEST(v_len - 4, 4)) || right(v_clean, 4);
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_secret_hash_v1(p_secret TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO public,extensions,pg_temp
AS $function$
  SELECT CASE
    WHEN p_secret IS NULL OR btrim(p_secret) = '' THEN NULL
    ELSE encode(digest(p_secret,'sha256'),'hex')
  END
$function$;

REVOKE ALL ON FUNCTION public.automation_marketplace_user_can_access_org_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.automation_marketplace_scope_belongs_org_v1(TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.automation_marketplace_current_scope_can_manage_target_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.automation_marketplace_secret_hint_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.automation_marketplace_secret_hash_v1(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.automation_marketplace_user_can_access_org_v1(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.automation_marketplace_scope_belongs_org_v1(TEXT, UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.automation_marketplace_current_scope_can_manage_target_v1(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.automation_marketplace_secret_hint_v1(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.automation_marketplace_secret_hash_v1(TEXT) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) Tables
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workflow_template_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_template_id UUID NOT NULL REFERENCES public.workflow_templates(id) ON DELETE CASCADE,
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id UUID NULL,
  revision_no INTEGER NOT NULL,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_hash TEXT NOT NULL,
  notes TEXT NULL,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workflow_template_revisions_revision_no_ck CHECK (revision_no > 0),
  CONSTRAINT workflow_template_revisions_scope_type_nonempty_ck CHECK (btrim(scope_type) <> ''),
  CONSTRAINT workflow_template_revisions_artifact_hash_nonempty_ck CHECK (btrim(artifact_hash) <> ''),
  CONSTRAINT workflow_template_revisions_unique UNIQUE (workflow_template_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_workflow_template_revisions_template_revision
  ON public.workflow_template_revisions (workflow_template_id, revision_no DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_template_revisions_org_created
  ON public.workflow_template_revisions (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.automation_asset_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_scope_type TEXT NOT NULL,
  owner_scope_id UUID NULL,
  asset_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  publication_status TEXT NOT NULL DEFAULT 'draft',
  latest_listing_version_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT automation_asset_listings_owner_scope_type_nonempty_ck CHECK (btrim(owner_scope_type) <> ''),
  CONSTRAINT automation_asset_listings_asset_kind_nonempty_ck CHECK (btrim(asset_kind) <> ''),
  CONSTRAINT automation_asset_listings_title_nonempty_ck CHECK (btrim(title) <> ''),
  CONSTRAINT automation_asset_listings_visibility_nonempty_ck CHECK (btrim(visibility) <> ''),
  CONSTRAINT automation_asset_listings_publication_status_nonempty_ck CHECK (btrim(publication_status) <> ''),
  CONSTRAINT automation_asset_listings_unique_title UNIQUE (owner_scope_type, owner_scope_id, asset_kind, title)
);

CREATE INDEX IF NOT EXISTS idx_automation_asset_listings_org_visibility
  ON public.automation_asset_listings (organization_id, visibility, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_asset_listings_owner
  ON public.automation_asset_listings (owner_scope_type, owner_scope_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.automation_asset_listing_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES public.automation_asset_listings(id) ON DELETE CASCADE,
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  asset_kind TEXT NOT NULL,
  listing_version_no INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  publication_status TEXT NOT NULL DEFAULT 'draft',
  source_snapshot_type TEXT NOT NULL,
  source_snapshot_id UUID NOT NULL,
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  snapshot_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  docs JSONB NOT NULL DEFAULT '{}'::jsonb,
  compatibility JSONB NOT NULL DEFAULT '{}'::jsonb,
  egress_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_hash TEXT NOT NULL,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NULL,
  approved_at TIMESTAMPTZ NULL,
  approved_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT automation_asset_listing_versions_kind_nonempty_ck CHECK (btrim(asset_kind) <> ''),
  CONSTRAINT automation_asset_listing_versions_visibility_nonempty_ck CHECK (btrim(visibility) <> ''),
  CONSTRAINT automation_asset_listing_versions_publication_status_nonempty_ck CHECK (btrim(publication_status) <> ''),
  CONSTRAINT automation_asset_listing_versions_snapshot_type_nonempty_ck CHECK (btrim(source_snapshot_type) <> ''),
  CONSTRAINT automation_asset_listing_versions_artifact_hash_nonempty_ck CHECK (btrim(artifact_hash) <> ''),
  CONSTRAINT automation_asset_listing_versions_version_no_ck CHECK (listing_version_no > 0),
  CONSTRAINT automation_asset_listing_versions_unique UNIQUE (listing_id, listing_version_no)
);

CREATE INDEX IF NOT EXISTS idx_automation_asset_listing_versions_listing_version
  ON public.automation_asset_listing_versions (listing_id, listing_version_no DESC);
CREATE INDEX IF NOT EXISTS idx_automation_asset_listing_versions_org_status
  ON public.automation_asset_listing_versions (organization_id, publication_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_asset_listing_versions_snapshot
  ON public.automation_asset_listing_versions (source_snapshot_type, source_snapshot_id);

ALTER TABLE public.automation_asset_listings
  DROP CONSTRAINT IF EXISTS automation_asset_listings_latest_listing_version_fkey;
ALTER TABLE public.automation_asset_listings
  ADD CONSTRAINT automation_asset_listings_latest_listing_version_fkey
  FOREIGN KEY (latest_listing_version_id) REFERENCES public.automation_asset_listing_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.automation_asset_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_version_id UUID NOT NULL REFERENCES public.automation_asset_listing_versions(id) ON DELETE CASCADE,
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  review_status TEXT NOT NULL DEFAULT 'pending',
  submission_notes TEXT NULL,
  reviewer_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  decision_notes TEXT NULL,
  automated_checks JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT automation_asset_reviews_review_status_nonempty_ck CHECK (btrim(review_status) <> '')
);

CREATE INDEX IF NOT EXISTS idx_automation_asset_reviews_listing
  ON public.automation_asset_reviews (listing_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_asset_reviews_org_status
  ON public.automation_asset_reviews (organization_id, review_status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.automation_asset_installs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES public.automation_asset_listings(id) ON DELETE CASCADE,
  installed_from_listing_version_id UUID NOT NULL REFERENCES public.automation_asset_listing_versions(id) ON DELETE RESTRICT,
  current_listing_version_id UUID NOT NULL REFERENCES public.automation_asset_listing_versions(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  asset_kind TEXT NOT NULL,
  target_scope_type TEXT NOT NULL,
  target_scope_id UUID NOT NULL,
  install_status TEXT NOT NULL DEFAULT 'pending',
  installed_resource_type TEXT NOT NULL,
  installed_resource_id UUID NOT NULL,
  forked_at TIMESTAMPTZ NULL,
  upgrade_available BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_at TIMESTAMPTZ NULL,
  CONSTRAINT automation_asset_installs_kind_nonempty_ck CHECK (btrim(asset_kind) <> ''),
  CONSTRAINT automation_asset_installs_target_scope_type_nonempty_ck CHECK (btrim(target_scope_type) <> ''),
  CONSTRAINT automation_asset_installs_status_nonempty_ck CHECK (btrim(install_status) <> ''),
  CONSTRAINT automation_asset_installs_resource_type_nonempty_ck CHECK (btrim(installed_resource_type) <> ''),
  CONSTRAINT automation_asset_installs_unique UNIQUE (listing_id, target_scope_type, target_scope_id, installed_resource_id)
);

CREATE INDEX IF NOT EXISTS idx_automation_asset_installs_org_status
  ON public.automation_asset_installs (organization_id, install_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_asset_installs_target
  ON public.automation_asset_installs (target_scope_type, target_scope_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.automation_asset_install_variables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id UUID NOT NULL REFERENCES public.automation_asset_installs(id) ON DELETE CASCADE,
  variable_key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT 'null'::jsonb,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT automation_asset_install_variables_key_nonempty_ck CHECK (btrim(variable_key) <> ''),
  CONSTRAINT automation_asset_install_variables_unique UNIQUE (install_id, variable_key)
);

CREATE TABLE IF NOT EXISTS public.integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_scope_type TEXT NOT NULL,
  owner_scope_id UUID NOT NULL,
  provider_id UUID NULL REFERENCES public.providers(id) ON DELETE SET NULL,
  provider_key TEXT NOT NULL,
  name TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  secret_storage_mode TEXT NOT NULL DEFAULT 'vault',
  credentials_vault_id UUID NULL REFERENCES vault.secrets(id),
  verifier_secret_hash TEXT NULL,
  credential_generation BIGINT NOT NULL DEFAULT 0 CHECK (credential_generation >= 0),
  secret_hint TEXT NULL,
  runtime_auth_config_id UUID NULL REFERENCES public.provider_auth_configs(id) ON DELETE SET NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  oauth_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NULL,
  last_tested_at TIMESTAMPTZ NULL,
  last_tested_credential_generation BIGINT NULL CHECK (last_tested_credential_generation >= 0),
  last_used_at TIMESTAMPTZ NULL,
  last_rotated_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_connections_owner_scope_type_nonempty_ck CHECK (btrim(owner_scope_type) <> ''),
  CONSTRAINT integration_connections_provider_key_nonempty_ck CHECK (btrim(provider_key) <> ''),
  CONSTRAINT integration_connections_name_nonempty_ck CHECK (btrim(name) <> ''),
  CONSTRAINT integration_connections_auth_type_nonempty_ck CHECK (btrim(auth_type) <> ''),
  CONSTRAINT integration_connections_status_nonempty_ck CHECK (btrim(status) <> ''),
  CONSTRAINT integration_connections_secret_storage_mode_nonempty_ck CHECK (btrim(secret_storage_mode) <> ''),
  CONSTRAINT integration_connections_secret_source_present_ck CHECK (
    (secret_storage_mode = 'vault' AND credentials_vault_id IS NOT NULL)
    OR (secret_storage_mode = 'hash_only' AND verifier_secret_hash IS NOT NULL)
    OR (credentials_vault_id IS NULL AND verifier_secret_hash IS NULL)
  ),
  CONSTRAINT integration_connections_unique UNIQUE (owner_scope_type, owner_scope_id, provider_key, name)
);

CREATE INDEX IF NOT EXISTS idx_integration_connections_org_status
  ON public.integration_connections (organization_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_connections_owner
  ON public.integration_connections (owner_scope_type, owner_scope_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_connections_provider
  ON public.integration_connections (provider_key, provider_id);

CREATE TABLE IF NOT EXISTS public.automation_asset_install_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id UUID NOT NULL REFERENCES public.automation_asset_installs(id) ON DELETE CASCADE,
  binding_key TEXT NOT NULL,
  binding_type TEXT NOT NULL DEFAULT 'connection',
  connection_id UUID NULL REFERENCES public.integration_connections(id) ON DELETE SET NULL,
  runtime_resource_type TEXT NULL,
  runtime_resource_id UUID NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT automation_asset_install_bindings_key_nonempty_ck CHECK (btrim(binding_key) <> ''),
  CONSTRAINT automation_asset_install_bindings_type_nonempty_ck CHECK (btrim(binding_type) <> ''),
  CONSTRAINT automation_asset_install_bindings_runtime_type_nonempty_ck CHECK (
    runtime_resource_type IS NULL OR btrim(runtime_resource_type) <> ''
  ),
  CONSTRAINT automation_asset_install_bindings_unique UNIQUE (install_id, binding_key)
);

CREATE INDEX IF NOT EXISTS idx_automation_asset_install_bindings_connection
  ON public.automation_asset_install_bindings (connection_id);

-- FK checks and parent-row changes need full indexes with the referencing column first.
CREATE INDEX idx_marketplace_workflow_revisions_created_by ON public.workflow_template_revisions (created_by);
CREATE INDEX idx_marketplace_listings_latest_version ON public.automation_asset_listings (latest_listing_version_id);
CREATE INDEX idx_marketplace_listings_created_by ON public.automation_asset_listings (created_by);
CREATE INDEX idx_marketplace_listings_updated_by ON public.automation_asset_listings (updated_by);
CREATE INDEX idx_marketplace_listing_versions_created_by ON public.automation_asset_listing_versions (created_by);
CREATE INDEX idx_marketplace_listing_versions_approved_by ON public.automation_asset_listing_versions (approved_by);
CREATE INDEX idx_marketplace_reviews_reviewer ON public.automation_asset_reviews (reviewer_user_id);
CREATE INDEX idx_marketplace_reviews_created_by ON public.automation_asset_reviews (created_by);
CREATE INDEX idx_marketplace_installs_source_version ON public.automation_asset_installs (installed_from_listing_version_id);
CREATE INDEX idx_marketplace_installs_current_version ON public.automation_asset_installs (current_listing_version_id);
CREATE INDEX idx_marketplace_installs_created_by ON public.automation_asset_installs (created_by);
CREATE INDEX idx_marketplace_installs_updated_by ON public.automation_asset_installs (updated_by);
CREATE INDEX idx_marketplace_install_variables_created_by ON public.automation_asset_install_variables (created_by);
CREATE INDEX idx_marketplace_connections_provider ON public.integration_connections (provider_id);
CREATE INDEX idx_marketplace_connections_vault ON public.integration_connections (credentials_vault_id);
CREATE INDEX idx_marketplace_connections_runtime_auth ON public.integration_connections (runtime_auth_config_id);
CREATE INDEX idx_marketplace_connections_created_by ON public.integration_connections (created_by);
CREATE INDEX idx_marketplace_connections_updated_by ON public.integration_connections (updated_by);
CREATE INDEX idx_marketplace_install_bindings_created_by ON public.automation_asset_install_bindings (created_by);

COMMENT ON TABLE public.workflow_template_revisions IS
  'Immutable workflow template snapshots used by the automation marketplace publish/install pipeline.';
COMMENT ON TABLE public.automation_asset_listings IS
  'Marketplace listing roots (owner scope + asset identity + visibility/publication metadata).';
COMMENT ON TABLE public.automation_asset_listing_versions IS
  'Immutable listing versions containing source snapshot refs, manifest, docs, compatibility, and artifact hash.';
COMMENT ON TABLE public.automation_asset_reviews IS
  'Review queue and decisions for marketplace-public listing versions.';
COMMENT ON TABLE public.automation_asset_installs IS
  'Copy-on-install records linking listing versions to local tenant/client/sender copies.';
COMMENT ON TABLE public.automation_asset_install_variables IS
  'Installer-owned non-secret variable values captured during install.';
COMMENT ON TABLE public.automation_asset_install_bindings IS
  'Installer-owned bindings between installs and local connections/runtime resources.';
COMMENT ON TABLE public.integration_connections IS
  'Installer-owned connection records. Shared assets reference requirements; installs bind local connections only.';

DROP TRIGGER IF EXISTS trg_automation_asset_listings_set_updated_at ON public.automation_asset_listings;
CREATE TRIGGER trg_automation_asset_listings_set_updated_at
  BEFORE UPDATE ON public.automation_asset_listings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_automation_asset_listing_versions_set_updated_at ON public.automation_asset_listing_versions;
CREATE TRIGGER trg_automation_asset_listing_versions_set_updated_at
  BEFORE UPDATE ON public.automation_asset_listing_versions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_automation_asset_reviews_set_updated_at ON public.automation_asset_reviews;
CREATE TRIGGER trg_automation_asset_reviews_set_updated_at
  BEFORE UPDATE ON public.automation_asset_reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_automation_asset_installs_set_updated_at ON public.automation_asset_installs;
CREATE TRIGGER trg_automation_asset_installs_set_updated_at
  BEFORE UPDATE ON public.automation_asset_installs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_automation_asset_install_variables_set_updated_at ON public.automation_asset_install_variables;
CREATE TRIGGER trg_automation_asset_install_variables_set_updated_at
  BEFORE UPDATE ON public.automation_asset_install_variables
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_automation_asset_install_bindings_set_updated_at ON public.automation_asset_install_bindings;
CREATE TRIGGER trg_automation_asset_install_bindings_set_updated_at
  BEFORE UPDATE ON public.automation_asset_install_bindings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_integration_connections_set_updated_at ON public.integration_connections;
CREATE TRIGGER trg_integration_connections_set_updated_at
  BEFORE UPDATE ON public.integration_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 5) Consistency triggers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.workflow_template_revisions_enforce_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_template public.workflow_templates%ROWTYPE;
  v_template_scope_type TEXT;
  v_template_scope_id UUID;
  v_org UUID;
BEGIN
  SELECT * INTO v_template
  FROM public.workflow_templates
  WHERE id = NEW.workflow_template_id
  LIMIT 1;

  IF v_template.id IS NULL THEN
    RAISE EXCEPTION 'workflow_template_revisions: template % not found', NEW.workflow_template_id USING ERRCODE = '23503';
  END IF;

  v_template_scope_type := public.normalize_scope_type_v1(v_template.scope_type, TRUE);
  IF lower(COALESCE(v_template.scope_type, '')) = 'platform' THEN
    v_template_scope_type := 'global';
  END IF;

  IF v_template_scope_type = 'global' THEN
    v_template_scope_id := NULL;
    v_org := COALESCE(public.current_user_org_id(), NEW.organization_id);
  ELSE
    v_template_scope_id := v_template.scope_id;
    v_org := public.resolve_organization_id_for_scope_v1(v_template_scope_type, v_template_scope_id);
  END IF;

  IF NEW.scope_type IS DISTINCT FROM v_template_scope_type THEN
    RAISE EXCEPTION 'workflow_template_revisions: scope_type mismatch';
  END IF;
  IF NEW.scope_id IS DISTINCT FROM v_template_scope_id THEN
    RAISE EXCEPTION 'workflow_template_revisions: scope_id mismatch';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'workflow_template_revisions: organization mismatch';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_asset_listings_enforce_scope_org_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(NEW.owner_scope_type, TRUE);
  v_org UUID;
BEGIN
  IF lower(COALESCE(NEW.owner_scope_type, '')) = 'platform' THEN
    v_scope_type := 'global';
  END IF;

  IF v_scope_type = 'global' THEN
    IF NEW.owner_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'automation_asset_listings: global owner scope cannot include scope_id';
    END IF;
    RETURN NEW;
  END IF;

  v_org := public.resolve_organization_id_for_scope_v1(v_scope_type, NEW.owner_scope_id);

  IF NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'automation_asset_listings: organization mismatch for owner scope %/%', NEW.owner_scope_type, NEW.owner_scope_id;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_asset_listing_versions_validate_source_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_listing public.automation_asset_listings%ROWTYPE;
  v_source_org UUID;
  v_snapshot JSONB;
BEGIN
  SELECT * INTO v_listing
  FROM public.automation_asset_listings
  WHERE id = NEW.listing_id
  LIMIT 1;

  IF v_listing.id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_listing_versions: listing % not found', NEW.listing_id USING ERRCODE = '23503';
  END IF;

  IF NEW.asset_kind IS DISTINCT FROM v_listing.asset_kind THEN
    RAISE EXCEPTION 'automation_asset_listing_versions: asset kind mismatch';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_listing.organization_id THEN
    RAISE EXCEPTION 'automation_asset_listing_versions: organization mismatch';
  END IF;

  -- A new draft/review version must not change the live approved listing root.
  -- Visibility belongs to each immutable version until a successful publish/approval.

  IF NEW.source_snapshot_type = 'workflow_template_revision' THEN
    SELECT organization_id, snapshot
      INTO v_source_org, v_snapshot
      FROM public.workflow_template_revisions
     WHERE id = NEW.source_snapshot_id
     LIMIT 1;

    IF v_source_org IS NULL AND v_snapshot IS NULL THEN
      RAISE EXCEPTION 'automation_asset_listing_versions: workflow revision % not found', NEW.source_snapshot_id USING ERRCODE = '23503';
    END IF;

    IF NEW.asset_kind IS DISTINCT FROM 'workflow_template' THEN
      RAISE EXCEPTION 'automation_asset_listing_versions: workflow revisions require workflow_template asset kind';
    END IF;
  ELSIF NEW.source_snapshot_type = 'integration_plugin_version' THEN
    SELECT organization_id,
           jsonb_build_object(
             'plugin_version', to_jsonb(v.*),
             'plugin', (
               SELECT to_jsonb(p.*)
               FROM public.integration_plugins p
               WHERE p.id = v.plugin_id
             )
           )
      INTO v_source_org, v_snapshot
      FROM public.integration_plugin_versions v
     WHERE v.id = NEW.source_snapshot_id
     LIMIT 1;

    IF v_source_org IS NULL AND v_snapshot IS NULL THEN
      RAISE EXCEPTION 'automation_asset_listing_versions: integration plugin version % not found', NEW.source_snapshot_id USING ERRCODE = '23503';
    END IF;

    IF NEW.asset_kind IS DISTINCT FROM 'integration_plugin' THEN
      RAISE EXCEPTION 'automation_asset_listing_versions: integration plugin versions require integration_plugin asset kind';
    END IF;
  ELSE
    RAISE EXCEPTION 'automation_asset_listing_versions: unsupported source snapshot type %', NEW.source_snapshot_type;
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_source_org THEN
    RAISE EXCEPTION 'automation_asset_listing_versions: source organization mismatch';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_asset_installs_enforce_scope_org_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_target_org UUID;
  v_listing public.automation_asset_listings%ROWTYPE;
  v_current_version public.automation_asset_listing_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_listing
  FROM public.automation_asset_listings
  WHERE id = NEW.listing_id
  LIMIT 1;

  IF v_listing.id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_installs: listing % not found', NEW.listing_id USING ERRCODE = '23503';
  END IF;

  SELECT * INTO v_current_version
  FROM public.automation_asset_listing_versions
  WHERE id = NEW.current_listing_version_id
  LIMIT 1;

  IF v_current_version.id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_installs: listing version % not found', NEW.current_listing_version_id USING ERRCODE = '23503';
  END IF;

  v_target_org := public.resolve_organization_id_for_scope_v1(NEW.target_scope_type, NEW.target_scope_id);

  IF v_target_org IS NULL OR NEW.organization_id IS DISTINCT FROM v_target_org THEN
    RAISE EXCEPTION 'automation_asset_installs: organization mismatch for target scope %/%', NEW.target_scope_type, NEW.target_scope_id;
  END IF;

  IF NEW.asset_kind IS DISTINCT FROM v_listing.asset_kind OR NEW.asset_kind IS DISTINCT FROM v_current_version.asset_kind THEN
    RAISE EXCEPTION 'automation_asset_installs: asset kind mismatch';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_connections_enforce_scope_org_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org UUID;
BEGIN
  v_org := public.resolve_organization_id_for_scope_v1(NEW.owner_scope_type, NEW.owner_scope_id);

  IF v_org IS NULL OR NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'integration_connections: organization mismatch for owner scope %/%', NEW.owner_scope_type, NEW.owner_scope_id;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_asset_install_bindings_enforce_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_install_org UUID;
  v_connection_org UUID;
BEGIN
  SELECT organization_id INTO v_install_org
  FROM public.automation_asset_installs
  WHERE id = NEW.install_id
  LIMIT 1;

  IF v_install_org IS NULL THEN
    RAISE EXCEPTION 'automation_asset_install_bindings: install % not found', NEW.install_id USING ERRCODE = '23503';
  END IF;

  IF NEW.connection_id IS NOT NULL THEN
    SELECT organization_id INTO v_connection_org
    FROM public.integration_connections
    WHERE id = NEW.connection_id
    LIMIT 1;

    IF v_connection_org IS NULL THEN
      RAISE EXCEPTION 'automation_asset_install_bindings: connection % not found', NEW.connection_id USING ERRCODE = '23503';
    END IF;

    IF v_connection_org IS DISTINCT FROM v_install_org THEN
      RAISE EXCEPTION 'automation_asset_install_bindings: connection org mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_workflow_template_revisions_enforce_match ON public.workflow_template_revisions;
CREATE TRIGGER trg_workflow_template_revisions_enforce_match
  BEFORE INSERT OR UPDATE ON public.workflow_template_revisions
  FOR EACH ROW EXECUTE FUNCTION public.workflow_template_revisions_enforce_match_v1();

DROP TRIGGER IF EXISTS trg_automation_asset_listings_enforce_scope_org ON public.automation_asset_listings;
CREATE TRIGGER trg_automation_asset_listings_enforce_scope_org
  BEFORE INSERT OR UPDATE ON public.automation_asset_listings
  FOR EACH ROW EXECUTE FUNCTION public.automation_asset_listings_enforce_scope_org_v1();

DROP TRIGGER IF EXISTS trg_automation_asset_listing_versions_validate_source ON public.automation_asset_listing_versions;
CREATE TRIGGER trg_automation_asset_listing_versions_validate_source
  BEFORE INSERT OR UPDATE ON public.automation_asset_listing_versions
  FOR EACH ROW EXECUTE FUNCTION public.automation_asset_listing_versions_validate_source_v1();

DROP TRIGGER IF EXISTS trg_automation_asset_installs_enforce_scope_org ON public.automation_asset_installs;
CREATE TRIGGER trg_automation_asset_installs_enforce_scope_org
  BEFORE INSERT OR UPDATE ON public.automation_asset_installs
  FOR EACH ROW EXECUTE FUNCTION public.automation_asset_installs_enforce_scope_org_v1();

DROP TRIGGER IF EXISTS trg_integration_connections_enforce_scope_org ON public.integration_connections;
CREATE TRIGGER trg_integration_connections_enforce_scope_org
  BEFORE INSERT OR UPDATE ON public.integration_connections
  FOR EACH ROW EXECUTE FUNCTION public.integration_connections_enforce_scope_org_v1();

DROP TRIGGER IF EXISTS trg_automation_asset_install_bindings_enforce ON public.automation_asset_install_bindings;
CREATE TRIGGER trg_automation_asset_install_bindings_enforce
  BEFORE INSERT OR UPDATE ON public.automation_asset_install_bindings
  FOR EACH ROW EXECUTE FUNCTION public.automation_asset_install_bindings_enforce_v1();

-------------------------------------------------------------------------------
-- 6) Lookup contracts
-------------------------------------------------------------------------------

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'workflow_template_revisions', 'scope_type', 'scope_type'),
  ('public', 'automation_asset_listings', 'owner_scope_type', 'scope_type'),
  ('public', 'automation_asset_listings', 'asset_kind', 'automation_asset_kind'),
  ('public', 'automation_asset_listings', 'visibility', 'automation_asset_visibility'),
  ('public', 'automation_asset_listings', 'publication_status', 'automation_asset_publication_status'),
  ('public', 'automation_asset_listing_versions', 'asset_kind', 'automation_asset_kind'),
  ('public', 'automation_asset_listing_versions', 'visibility', 'automation_asset_visibility'),
  ('public', 'automation_asset_listing_versions', 'publication_status', 'automation_asset_publication_status'),
  ('public', 'automation_asset_listing_versions', 'source_snapshot_type', 'automation_asset_source_snapshot_type'),
  ('public', 'automation_asset_reviews', 'review_status', 'automation_asset_review_status'),
  ('public', 'automation_asset_installs', 'asset_kind', 'automation_asset_kind'),
  ('public', 'automation_asset_installs', 'target_scope_type', 'scope_type'),
  ('public', 'automation_asset_installs', 'install_status', 'automation_asset_install_status'),
  ('public', 'integration_connections', 'owner_scope_type', 'scope_type'),
  ('public', 'integration_connections', 'auth_type', 'integration_connection_auth_type'),
  ('public', 'integration_connections', 'status', 'integration_connection_status'),
  ('public', 'integration_connections', 'secret_storage_mode', 'integration_secret_storage_mode')
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

-------------------------------------------------------------------------------


-- Scope authorization is explicit in privileged RPCs; row_security=on is not an authorization check.
CREATE FUNCTION public.automation_marketplace_assert_scope_v1(p_scope_type TEXT,p_scope_id UUID,p_organization_id UUID DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE target_type TEXT:=public.normalize_scope_type_v1(p_scope_type,TRUE); target_org UUID;
BEGIN
 IF NOT COALESCE(public.automation_marketplace_current_scope_can_manage_target_v1(target_type,p_scope_id),FALSE) THEN
  RAISE EXCEPTION 'Automation marketplace scope denied' USING ERRCODE='42501';
 END IF;
 IF target_type=public.get_root_scope_type_key_v1() THEN
  IF p_scope_id IS NOT NULL THEN RAISE EXCEPTION 'Global scope must not have an id' USING ERRCODE='23514'; END IF;
 ELSE
  target_org:=public.resolve_organization_id_for_scope_v1(target_type,p_scope_id);
  IF target_org IS NULL OR (p_organization_id IS NOT NULL AND target_org IS DISTINCT FROM p_organization_id) THEN
   RAISE EXCEPTION 'Automation marketplace organization mismatch' USING ERRCODE='42501';
  END IF;
 END IF;
END;
$function$;

CREATE FUNCTION public.automation_marketplace_can_read_asset_v1(p_org UUID,p_type TEXT,p_id UUID,p_visibility TEXT,p_status TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
 SELECT COALESCE(public.automation_marketplace_current_scope_can_manage_target_v1(p_type,p_id),FALSE)
  OR (p_status='approved' AND (p_visibility='marketplace_public'
   OR (p_visibility='tenant_shared' AND p_org=public.current_user_org_id())));
$function$;

CREATE FUNCTION public.automation_marketplace_assert_secret_free_v1(p_payload JSONB)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path TO public,extensions,pg_temp AS $function$
DECLARE payload TEXT; entry RECORD; selector RECORD; auth_definition JSONB; basic_match TEXT[]; decoded_basic TEXT;
BEGIN
 IF jsonb_typeof(p_payload)='object' THEN
  FOR entry IN SELECT * FROM jsonb_each(p_payload) LOOP
   IF entry.key='auth' AND jsonb_typeof(entry.value)='object' AND entry.value ? 'fields' THEN
    auth_definition:=entry.value;
    IF jsonb_typeof(auth_definition->'fields')<>'object' THEN
     RAISE EXCEPTION 'Native auth fields must be credential selectors' USING ERRCODE='23514';
    END IF;
    FOR selector IN SELECT * FROM jsonb_each(auth_definition->'fields') LOOP
     IF jsonb_typeof(selector.value)<>'string' OR (selector.value #>> '{}') !~ '^[A-Za-z_][A-Za-z0-9_.-]*$' THEN
      RAISE EXCEPTION 'Native auth fields must be credential selectors' USING ERRCODE='23514';
     END IF;
    END LOOP;
    PERFORM public.automation_marketplace_assert_secret_free_v1(auth_definition-'fields');
   ELSE
    IF jsonb_typeof(entry.value)='string' THEN
     IF entry.key IN ('auth_config_id','latest_auth_config_id') AND (entry.value #>> '{}') !~ '^\{\{conn\.[A-Za-z0-9_-]+\.auth_config_id\}\}$' THEN
      RAISE EXCEPTION 'Shared credential references must use a declared connection auth_config_id' USING ERRCODE='23514';
     END IF;
     payload:=regexp_replace(jsonb_build_object(entry.key,entry.value)::text,'\{\{(var|conn|secret|scope)\.[A-Za-z0-9_.-]+\}\}','','g');
     IF payload ~* '"(authorization|proxy[_-]?authorization|x-api-key|api[_-]?key|password|private[_-]?key|client[_-]?secret|secret|token|access[_-]?token|refresh[_-]?token|credentials|credentials_vault_id|verifier_secret_hash|auth_config_id|latest_auth_config_id)"[[:space:]]*:[[:space:]]*"[^"]+"' THEN
      RAISE EXCEPTION 'Shared assets must not contain credentials or publisher credential references; use connection requirements' USING ERRCODE='23514';
     END IF;
    END IF;
    PERFORM public.automation_marketplace_assert_secret_free_v1(entry.value);
   END IF;
  END LOOP;
  RETURN;
 ELSIF jsonb_typeof(p_payload)='array' THEN
  FOR entry IN SELECT value FROM jsonb_array_elements(p_payload) LOOP
   PERFORM public.automation_marketplace_assert_secret_free_v1(entry.value);
  END LOOP;
  RETURN;
 END IF;
 payload:=regexp_replace(CASE WHEN jsonb_typeof(p_payload)='string' THEN p_payload #>> '{}' ELSE COALESCE(p_payload,'null')::text END,'\{\{(var|conn|secret|scope)\.[A-Za-z0-9_.-]+\}\}','','g');
 IF payload ~* '"(authorization|proxy[_-]?authorization|x-api-key|api[_-]?key|password|private[_-]?key|client[_-]?secret|secret|token|access[_-]?token|refresh[_-]?token|credentials|credentials_vault_id|verifier_secret_hash|auth_config_id|latest_auth_config_id)"[[:space:]]*:[[:space:]]*"[^"]+"'
  OR payload ~* '\mBearer[[:space:]]+[^[:space:]"{}]+'
  OR payload ~* '[?&](api[_-]?key|token|secret|access[_-]?token|refresh[_-]?token)=[^&[:space:]"{}]+' THEN
  RAISE EXCEPTION 'Shared assets must not contain credentials or publisher credential references; use connection requirements' USING ERRCODE='23514';
 END IF;
 FOR basic_match IN SELECT regexp_matches(payload,'\mBasic[[:space:]]+([A-Za-z0-9+/]+={0,2})','gi') LOOP
  BEGIN
   decoded_basic:=convert_from(decode(basic_match[1],'base64'),'UTF8');
  EXCEPTION WHEN invalid_parameter_value OR character_not_in_repertoire OR untranslatable_character THEN
   decoded_basic:=NULL;
  END;
  IF position(':' IN decoded_basic)>0 THEN
   RAISE EXCEPTION 'Shared assets must not contain credentials or publisher credential references; use connection requirements' USING ERRCODE='23514';
  END IF;
 END LOOP;
END;
$function$;

CREATE FUNCTION public.automation_marketplace_immutable_snapshot_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path TO public,extensions,pg_temp AS $function$
BEGIN
 IF TG_TABLE_NAME='workflow_template_revisions' THEN
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Workflow revisions are immutable' USING ERRCODE='23514'; END IF;
 ELSIF (to_jsonb(NEW)-ARRAY['visibility','publication_status','submitted_at','approved_at','approved_by','updated_at'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['visibility','publication_status','submitted_at','approved_at','approved_by','updated_at']) THEN
  RAISE EXCEPTION 'Marketplace version snapshots are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_marketplace_workflow_snapshot_immutable BEFORE UPDATE ON public.workflow_template_revisions
 FOR EACH ROW EXECUTE FUNCTION public.automation_marketplace_immutable_snapshot_v1();
CREATE TRIGGER trg_marketplace_listing_snapshot_immutable BEFORE UPDATE ON public.automation_asset_listing_versions
 FOR EACH ROW EXECUTE FUNCTION public.automation_marketplace_immutable_snapshot_v1();

CREATE FUNCTION public.automation_marketplace_connection_provider_guard_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
BEGIN
 IF NEW.provider_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.providers p
  WHERE p.id=NEW.provider_id AND p.organization_id=NEW.organization_id AND p.enabled) THEN
  RAISE EXCEPTION 'Connection provider organization mismatch or disabled provider' USING ERRCODE='42501';
 END IF;
 IF NEW.runtime_auth_config_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.provider_auth_configs a
  WHERE a.id=NEW.runtime_auth_config_id AND a.provider_id=NEW.provider_id) THEN
  RAISE EXCEPTION 'Connection runtime credential provider mismatch' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_marketplace_connection_provider_guard BEFORE INSERT OR UPDATE ON public.integration_connections
 FOR EACH ROW EXECUTE FUNCTION public.automation_marketplace_connection_provider_guard_v1();


-- Lifecycle writes are RPC-only for both browser and service clients.
ALTER TABLE public.workflow_template_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workflow_template_revisions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.workflow_template_revisions TO authenticated,service_role;
CREATE POLICY workflow_template_revisions_service_read ON public.workflow_template_revisions FOR SELECT TO service_role USING(TRUE);
ALTER TABLE public.automation_asset_listings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_asset_listings FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.automation_asset_listings TO authenticated,service_role;
CREATE POLICY automation_asset_listings_service_read ON public.automation_asset_listings FOR SELECT TO service_role USING(TRUE);
ALTER TABLE public.automation_asset_listing_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_asset_listing_versions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.automation_asset_listing_versions TO authenticated,service_role;
CREATE POLICY automation_asset_listing_versions_service_read ON public.automation_asset_listing_versions FOR SELECT TO service_role USING(TRUE);
ALTER TABLE public.automation_asset_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_asset_reviews FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.automation_asset_reviews TO authenticated,service_role;
CREATE POLICY automation_asset_reviews_service_read ON public.automation_asset_reviews FOR SELECT TO service_role USING(TRUE);
ALTER TABLE public.automation_asset_installs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_asset_installs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.automation_asset_installs TO authenticated,service_role;
CREATE POLICY automation_asset_installs_service_read ON public.automation_asset_installs FOR SELECT TO service_role USING(TRUE);
ALTER TABLE public.automation_asset_install_variables ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_asset_install_variables FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.automation_asset_install_variables TO authenticated,service_role;
CREATE POLICY automation_asset_install_variables_service_read ON public.automation_asset_install_variables FOR SELECT TO service_role USING(TRUE);
ALTER TABLE public.automation_asset_install_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_asset_install_bindings FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.automation_asset_install_bindings TO authenticated,service_role;
CREATE POLICY automation_asset_install_bindings_service_read ON public.automation_asset_install_bindings FOR SELECT TO service_role USING(TRUE);
ALTER TABLE public.integration_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.integration_connections FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT(id,organization_id,owner_scope_type,owner_scope_id,provider_id,provider_key,name,auth_type,status,secret_storage_mode,secret_hint,runtime_auth_config_id,config,oauth_metadata,metadata,expires_at,last_tested_at,last_tested_credential_generation,last_used_at,last_rotated_at,revoked_at,created_by,updated_by,created_at,updated_at,credential_generation) ON public.integration_connections TO authenticated;
GRANT SELECT ON public.integration_connections TO service_role;
CREATE POLICY integration_connections_service_all ON public.integration_connections FOR ALL TO service_role USING(TRUE) WITH CHECK(TRUE);
CREATE POLICY workflow_template_revisions_select ON public.workflow_template_revisions FOR SELECT TO authenticated
 USING(public.user_has_capability_v1('automation_marketplace.read') AND public.automation_marketplace_current_scope_can_manage_target_v1(scope_type,scope_id));
CREATE POLICY automation_asset_listings_select ON public.automation_asset_listings FOR SELECT TO authenticated USING(public.user_has_capability_v1('automation_marketplace.read') AND public.automation_marketplace_can_read_asset_v1(organization_id,owner_scope_type,owner_scope_id,visibility,publication_status));
CREATE POLICY automation_asset_listing_versions_select ON public.automation_asset_listing_versions FOR SELECT TO authenticated
 USING(public.user_has_capability_v1('automation_marketplace.read') AND EXISTS(SELECT 1 FROM public.automation_asset_listings l WHERE l.id=listing_id
 AND public.automation_marketplace_can_read_asset_v1(automation_asset_listing_versions.organization_id,l.owner_scope_type,l.owner_scope_id,automation_asset_listing_versions.visibility,automation_asset_listing_versions.publication_status)));
CREATE POLICY automation_asset_reviews_select ON public.automation_asset_reviews FOR SELECT TO authenticated
 USING((public.user_has_capability_v1('automation_marketplace.read') AND EXISTS(SELECT 1 FROM public.automation_asset_listing_versions v JOIN public.automation_asset_listings l ON l.id=v.listing_id
 WHERE v.id=listing_version_id AND public.automation_marketplace_current_scope_can_manage_target_v1(l.owner_scope_type,l.owner_scope_id)))
 OR (public.is_platform_user() AND public.user_has_capability_v1('automation_marketplace.review','global',NULL)));
CREATE POLICY automation_asset_installs_select ON public.automation_asset_installs FOR SELECT TO authenticated
 USING(public.user_has_capability_v1('automation_marketplace.read') AND public.automation_marketplace_current_scope_can_manage_target_v1(target_scope_type,target_scope_id));
CREATE POLICY automation_asset_install_variables_select ON public.automation_asset_install_variables FOR SELECT TO authenticated
 USING(public.user_has_capability_v1('automation_marketplace.read') AND EXISTS(SELECT 1 FROM public.automation_asset_installs i WHERE i.id=install_id
 AND public.automation_marketplace_current_scope_can_manage_target_v1(i.target_scope_type,i.target_scope_id)));
CREATE POLICY automation_asset_install_bindings_select ON public.automation_asset_install_bindings FOR SELECT TO authenticated
 USING(public.user_has_capability_v1('automation_marketplace.read') AND EXISTS(SELECT 1 FROM public.automation_asset_installs i WHERE i.id=install_id
 AND public.automation_marketplace_current_scope_can_manage_target_v1(i.target_scope_type,i.target_scope_id)));
CREATE POLICY integration_connections_select ON public.integration_connections FOR SELECT TO authenticated
 USING(public.user_has_capability_v1('automation_marketplace.manage_connections')
 AND public.automation_marketplace_current_scope_can_manage_target_v1(owner_scope_type,owner_scope_id));
REVOKE ALL ON FUNCTION public.automation_marketplace_assert_scope_v1(TEXT,UUID,UUID),
 public.automation_marketplace_can_read_asset_v1(UUID,TEXT,UUID,TEXT,TEXT),
 public.automation_marketplace_assert_secret_free_v1(JSONB),public.automation_marketplace_immutable_snapshot_v1(),
 public.automation_marketplace_connection_provider_guard_v1() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.automation_marketplace_assert_scope_v1(TEXT,UUID,UUID),
 public.automation_marketplace_can_read_asset_v1(UUID,TEXT,UUID,TEXT,TEXT),
 public.automation_marketplace_assert_secret_free_v1(JSONB) TO authenticated,service_role;

INSERT INTO public.table_contracts(table_schema,table_name,created_at_required,updated_at_required,audit_enabled,notes)
VALUES
 ('public','workflow_template_revisions',TRUE,FALSE,TRUE,'Immutable revisions retain creation, actor and hash audit; no mutable updated_at.'),
 ('public','automation_asset_listings',TRUE,TRUE,TRUE,'Audit listing identity, scope and publication transitions.'),
 ('public','automation_asset_listing_versions',TRUE,TRUE,TRUE,'Audit immutable version identity/hash and governed publication transitions.'),
 ('public','automation_asset_reviews',TRUE,TRUE,TRUE,'Audit review lifecycle without copying submission or evidence payloads.'),
 ('public','automation_asset_installs',TRUE,TRUE,TRUE,'Audit copy lifecycle and current-version pointers.'),
 ('public','automation_asset_install_variables',TRUE,TRUE,TRUE,'Audit variable ownership and key changes without copying values.'),
 ('public','integration_connections',TRUE,TRUE,TRUE,'Audit connection lifecycle without credential references or configuration payloads.'),
 ('public','automation_asset_install_bindings',TRUE,TRUE,TRUE,'Audit binding identity and runtime references without configuration payloads.')
ON CONFLICT(table_schema,table_name) DO UPDATE SET created_at_required=EXCLUDED.created_at_required,
 updated_at_required=EXCLUDED.updated_at_required,audit_enabled=EXCLUDED.audit_enabled,notes=EXCLUDED.notes;

-- Install redaction before attachment; existing allowlists/tokens must never become broader.
INSERT INTO public.audit_redaction_rules(table_schema,table_name,mode,columns)
VALUES
 ('public','workflow_template_revisions','denylist',ARRAY['snapshot','notes']),
 ('public','automation_asset_listings','denylist',ARRAY['title','summary','metadata']),
 ('public','automation_asset_listing_versions','denylist',ARRAY['manifest','snapshot_payload','docs','compatibility','egress_profile']),
 ('public','automation_asset_reviews','denylist',ARRAY['submission_notes','decision_notes','automated_checks','evidence']),
 ('public','automation_asset_installs','denylist',ARRAY['metadata']),
 ('public','automation_asset_install_variables','denylist',ARRAY['value']),
 ('public','integration_connections','denylist',ARRAY['credentials_vault_id','verifier_secret_hash','secret_hint','runtime_auth_config_id','config','oauth_metadata','metadata']),
 ('public','automation_asset_install_bindings','denylist',ARRAY['config'])
ON CONFLICT(table_schema,table_name) DO UPDATE SET columns=CASE
 WHEN audit_redaction_rules.mode='allowlist' THEN ARRAY(
  SELECT field.column_name FROM unnest(audit_redaction_rules.columns) AS field(column_name)
   WHERE NOT field.column_name=ANY(EXCLUDED.columns))
 ELSE ARRAY(
  SELECT DISTINCT field.column_name FROM unnest(audit_redaction_rules.columns || EXCLUDED.columns) AS field(column_name)
   ORDER BY field.column_name)
 END,updated_at=now();
SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

COMMIT;
