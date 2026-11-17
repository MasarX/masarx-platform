-- Plan: PLAN-202603-marketplace-network-v1 / Step: S04
-- Migration: Marketplace network foundation v1
-- Date: 2026-03-07
-- Purpose:
--   - Add the canonical MasarX Network marketplace domain.
--   - Keep the model row-driven through settings categories, schemas, and registry rows.
--   - Add RLS-first SSOT tables for onboarding, demand, offers, awards, contracts,
--     work packages, disputes, reputation, and immutable marketplace events.
--   - Expose typed lifecycle RPCs that reuse the existing workflow/task/settings patterns.
/* objectives:allow RLS_MISSING Justification: Table creation is split from RLS policy + RPC wiring in the immediate follow-up marketplace migration to stay within Windows patch-length/tooling limits while preserving the same migration series. */

/* objectives:allow POLICY_MISSING Justification: marketplace foundation tables are created here and their canonical RLS policies are added in the immediate follow-on migration 202603071110_marketplace_network_registry_rls_v1.sql. */

BEGIN;
SELECT pg_advisory_lock(hashtext('202603071100_marketplace_network_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings categories + schema registry
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES
  (
    'marketplace_policy',
    'MasarX Network marketplace core operating policy.',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant","client","sender","resource"]'::jsonb,
    NULL
  ),
  (
    'marketplace_request_policy',
    'Request creation, publish, award, and lifecycle defaults for marketplace demand.',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant","client","sender","resource"]'::jsonb,
    NULL
  ),
  (
    'marketplace_visibility_policy',
    'Network visibility and private-pool release policy for marketplace demand.',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant","client","sender","resource"]'::jsonb,
    NULL
  ),
  (
    'marketplace_execution_policy',
    'Work-package and execution materialization policy for awarded marketplace work.',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant","client","sender","resource"]'::jsonb,
    NULL
  ),
  (
    'marketplace_settlement_policy',
    'Commercial settlement policy for marketplace awards, fees, holdbacks, and payouts.',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant","client","sender","resource"]'::jsonb,
    NULL
  ),
  (
    'marketplace_reputation_policy',
    'Reputation scoring, eligibility thresholds, and weighting policy for marketplace participants.',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant","client","sender","resource"]'::jsonb,
    NULL
  ),
  (
    'marketplace_tracking_display_policy',
    'Recipient-facing branding and provider identity disclosure policy for marketplace execution.',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant","client","sender","resource"]'::jsonb,
    NULL
  ),
  (
    'marketplace_compliance_policy',
    'Marketplace onboarding, verification, anti-abuse, and compliance policy.',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant"]'::jsonb,
    NULL
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  resource_scope_rel = EXCLUDED.resource_scope_rel,
  updated_at = now();

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES
  (
    'marketplace_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'enabled', jsonb_build_object('type', 'boolean'),
        'curated_network', jsonb_build_object('type', 'boolean'),
        'default_visibility_mode', jsonb_build_object('type', 'string'),
        'default_pricing_mode', jsonb_build_object('type', 'string'),
        'default_negotiation_mode', jsonb_build_object('type', 'string'),
        'default_ownership_mode', jsonb_build_object('type', 'string'),
        'default_settlement_mode', jsonb_build_object('type', 'string'),
        'default_tracking_display_mode', jsonb_build_object('type', 'string'),
        'request_release_order', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object('type', 'string')
        ),
        'provider_tenant_opt_in_requires_review', jsonb_build_object('type', 'boolean'),
        'freelancer_multi_tenant_enabled', jsonb_build_object('type', 'boolean'),
        'private_pool', jsonb_build_object(
          'type', 'object',
          'additionalProperties', TRUE,
          'properties', jsonb_build_object(
            'enabled', jsonb_build_object('type', 'boolean')
          )
        ),
        'ai', jsonb_build_object(
          'type', 'object',
          'additionalProperties', TRUE,
          'properties', jsonb_build_object(
            'advisory_only', jsonb_build_object('type', 'boolean')
          )
        )
      )
    ),
    'Core marketplace operating policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'curated_network', TRUE,
        'default_visibility_mode', 'private_pool_first',
        'default_pricing_mode', 'quote',
        'default_negotiation_mode', 'counter',
        'default_ownership_mode', 'origin_tenant',
        'default_settlement_mode', 'manual_recorded',
        'default_tracking_display_mode', 'origin_brand_only',
        'request_release_order', jsonb_build_array('private_pool', 'curated_network'),
        'provider_tenant_opt_in_requires_review', FALSE,
        'freelancer_multi_tenant_enabled', TRUE,
        'private_pool', jsonb_build_object('enabled', TRUE),
        'ai', jsonb_build_object('advisory_only', TRUE)
      )
    ),
    TRUE
  ),
  (
    'marketplace_request_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'enabled', jsonb_build_object('type', 'boolean'),
        'allowed_request_kinds', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object('type', 'string')
        ),
        'request_defaults', jsonb_build_object(
          'type', 'object',
          'additionalProperties', TRUE,
          'properties', jsonb_build_object(
            'status', jsonb_build_object('type', 'string'),
            'auto_publish', jsonb_build_object('type', 'boolean'),
            'expire_hours', jsonb_build_object('type', 'integer', 'minimum', 1)
          )
        )
      )
    ),
    'Marketplace request lifecycle defaults.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'allowed_request_kinds', jsonb_build_array('driver_shift_market', 'capacity_block'),
        'request_defaults', jsonb_build_object(
          'status', 'draft',
          'auto_publish', FALSE,
          'expire_hours', 24
        )
      )
    ),
    TRUE
  ),
  (
    'marketplace_visibility_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE
    ),
    'Marketplace visibility policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'private_pool_first', TRUE,
        'allow_curated_network_release', TRUE,
        'allow_public_release', FALSE
      )
    ),
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE,
  updated_at = now();

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES
  (
    'marketplace_execution_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE
    ),
    'Marketplace work-package execution policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'work_package', jsonb_build_object(
          'auto_materialize', FALSE,
          'default_materializer_key', 'manual_bridge'
        )
      )
    ),
    TRUE
  ),
  (
    'marketplace_settlement_policy',
    1,
    jsonb_build_object('$schema', 'http://json-schema.org/draft-07/schema#', 'type', 'object', 'additionalProperties', TRUE),
    'Marketplace settlement and payout policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'record_payables', TRUE,
        'automated_payouts_enabled', FALSE,
        'holdback_percent', 0
      )
    ),
    TRUE
  ),
  (
    'marketplace_reputation_policy',
    1,
    jsonb_build_object('$schema', 'http://json-schema.org/draft-07/schema#', 'type', 'object', 'additionalProperties', TRUE),
    'Marketplace reputation policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'weights', jsonb_build_object('completion', 20, 'cancellation', -25, 'dispute', -30, 'documents', 15, 'feedback', 20),
        'minimum_network_score', 50
      )
    ),
    TRUE
  ),
  (
    'marketplace_tracking_display_policy',
    1,
    jsonb_build_object('$schema', 'http://json-schema.org/draft-07/schema#', 'type', 'object', 'additionalProperties', TRUE),
    'Marketplace tracking and branding disclosure policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'display_mode', 'origin_brand_only',
        'masked_contact_required', TRUE,
        'provider_identity_visible_to_recipient', FALSE
      )
    ),
    TRUE
  ),
  (
    'marketplace_compliance_policy',
    1,
    jsonb_build_object('$schema', 'http://json-schema.org/draft-07/schema#', 'type', 'object', 'additionalProperties', TRUE),
    'Marketplace onboarding and anti-abuse policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'turnstile', jsonb_build_object('required', TRUE),
        'rate_limit', jsonb_build_object('window_seconds', 60, 'max_requests', 10),
        'dedupe', jsonb_build_object('window_seconds', 86400),
        'email_domains', jsonb_build_object('allowlist', jsonb_build_array(), 'blocklist', jsonb_build_array()),
        'onboarding', jsonb_build_object(
          'freelancer_driver', jsonb_build_object(
            'public_enabled', TRUE,
            'approval_mode', 'required',
            'initial_user_type', 'driver',
            'initial_role_key', 'driver'
          ),
          'provider_tenant', jsonb_build_object('approval_mode', 'auto')
        ),
        'task', jsonb_build_object(
          'organization_slug', 'global-root',
          'task_type_key', 'marketplace_participant_review',
          'queue_key', 'marketplace',
          'priority', 45,
          'sla_minutes', 120
        )
      )
    ),
    TRUE
  ),
  (
    'marketplace_onboarding_form',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', FALSE,
      'required', jsonb_build_array('full_name', 'organization_name', 'email'),
      'properties', jsonb_build_object(
        'full_name', jsonb_build_object('type', 'string', 'title', 'Full name'),
        'organization_name', jsonb_build_object('type', 'string', 'title', 'Display or organization name'),
        'email', jsonb_build_object('type', 'string', 'title', 'Email', 'format', 'email'),
        'phone', jsonb_build_object('type', 'string', 'title', 'Phone'),
        'website_url', jsonb_build_object('type', 'string', 'title', 'Website', 'format', 'uri'),
        'experience_summary', jsonb_build_object('type', 'string', 'title', 'Experience summary'),
        'capabilities_requested', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'verification_documents', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'object', 'additionalProperties', TRUE))
      )
    ),
    'Schema-driven onboarding form contract for marketplace participant signup.',
    jsonb_build_array(
      jsonb_build_object(
        'full_name', 'Driver Name',
        'organization_name', 'Driver Name',
        'email', 'driver@example.com',
        'capabilities_requested', jsonb_build_array('fragile')
      )
    ),
    TRUE
  ),
  (
    'marketplace_offer_terms',
    1,
    jsonb_build_object('$schema', 'http://json-schema.org/draft-07/schema#', 'type', 'object', 'additionalProperties', TRUE),
    'Generic marketplace offer terms schema.',
    jsonb_build_array(jsonb_build_object('currency', 'SAR', 'amount', 150, 'rate_basis', 'block')),
    TRUE
  ),
  (
    'marketplace_contract_terms',
    1,
    jsonb_build_object('$schema', 'http://json-schema.org/draft-07/schema#', 'type', 'object', 'additionalProperties', TRUE),
    'Marketplace contract terms schema.',
    jsonb_build_array(jsonb_build_object('service_level', 'same_day', 'proof_requirements', jsonb_build_array('photo', 'signature'))),
    TRUE
  ),
  (
    'marketplace_verification_requirements',
    1,
    jsonb_build_object('$schema', 'http://json-schema.org/draft-07/schema#', 'type', 'object', 'additionalProperties', TRUE),
    'Marketplace verification requirements schema.',
    jsonb_build_array(jsonb_build_object('documents', jsonb_build_array('national_id', 'driver_license'))),
    TRUE
  ),
  (
    'marketplace_work_package_summary',
    1,
    jsonb_build_object('$schema', 'http://json-schema.org/draft-07/schema#', 'type', 'object', 'additionalProperties', TRUE),
    'Marketplace work-package projection schema.',
    jsonb_build_array(jsonb_build_object('shipment_estimate', 20)),
    TRUE
  ),
  (
    'marketplace_request_payload_driver_shift_market',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('city', 'starts_at', 'ends_at', 'vehicle_type'),
      'properties', jsonb_build_object(
        'city', jsonb_build_object('type', 'string', 'title', 'City'),
        'starts_at', jsonb_build_object('type', 'string', 'format', 'date-time', 'title', 'Shift starts at'),
        'ends_at', jsonb_build_object('type', 'string', 'format', 'date-time', 'title', 'Shift ends at'),
        'vehicle_type', jsonb_build_object('type', 'string', 'title', 'Vehicle type'),
        'shipment_estimate', jsonb_build_object('type', 'integer', 'minimum', 1, 'title', 'Estimated shipments'),
        'required_capabilities', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'notes', jsonb_build_object('type', 'string')
      )
    ),
    'Request payload for freelancer driver shift demand.',
    jsonb_build_array(jsonb_build_object('city', 'Riyadh', 'vehicle_type', 'motorbike')),
    TRUE
  ),
  (
    'marketplace_request_payload_capacity_block',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('city', 'service_date', 'shipment_capacity'),
      'properties', jsonb_build_object(
        'city', jsonb_build_object('type', 'string', 'title', 'City'),
        'service_date', jsonb_build_object('type', 'string', 'format', 'date', 'title', 'Service date'),
        'shipment_capacity', jsonb_build_object('type', 'integer', 'minimum', 1, 'title', 'Shipment capacity'),
        'required_capabilities', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'notes', jsonb_build_object('type', 'string')
      )
    ),
    'Request payload for tenant capacity block exchange.',
    jsonb_build_array(jsonb_build_object('city', 'Jeddah', 'shipment_capacity', 100)),
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
  v_category TEXT;
  v_value JSONB;
BEGIN
  FOREACH v_category IN ARRAY ARRAY[
    'marketplace_policy',
    'marketplace_request_policy',
    'marketplace_visibility_policy',
    'marketplace_execution_policy',
    'marketplace_settlement_policy',
    'marketplace_reputation_policy',
    'marketplace_tracking_display_policy',
    'marketplace_compliance_policy'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = v_category
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
    ) THEN
      CONTINUE;
    END IF;

    SELECT examples->0
      INTO v_value
      FROM public.schema_registry
     WHERE category = v_category
       AND version = 1
     LIMIT 1;

    PERFORM public.upsert_settings_value_v1(
      v_category,
      'global',
      NULL,
      COALESCE(v_value, '{}'::jsonb),
      1,
      format('seed %s global default', v_category)
    );
  END LOOP;
END;
$seed$;

-------------------------------------------------------------------------------
-- 2) Tables
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.marketplace_registry_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  registry_type TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_registry_entries_unique UNIQUE (registry_type, entry_key)
);

CREATE TABLE IF NOT EXISTS public.marketplace_request_kinds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT NULL,
  participant_type_supply_key TEXT NOT NULL,
  payload_schema_category TEXT NULL,
  offer_schema_category TEXT NOT NULL DEFAULT 'marketplace_offer_terms',
  contract_schema_category TEXT NOT NULL DEFAULT 'marketplace_contract_terms',
  verification_schema_category TEXT NOT NULL DEFAULT 'marketplace_verification_requirements',
  default_materializer_key TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  ui_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  lifecycle_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.marketplace_participant_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  participant_type_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  listing_status TEXT NOT NULL DEFAULT 'private',
  compliance_state TEXT NOT NULL DEFAULT 'pending',
  display_name TEXT NOT NULL,
  legal_name TEXT NULL,
  contact_email TEXT NULL,
  contact_phone TEXT NULL,
  locale TEXT NULL,
  timezone TEXT NULL,
  rating_overall NUMERIC(10,2) NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  network_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at TIMESTAMPTZ NULL,
  suspended_at TIMESTAMPTZ NULL,
  CONSTRAINT marketplace_participant_profiles_status_ck CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  CONSTRAINT marketplace_participant_profiles_listing_status_ck CHECK (listing_status IN ('private', 'curated_network', 'public')),
  CONSTRAINT marketplace_participant_profiles_compliance_state_ck CHECK (compliance_state IN ('pending', 'approved', 'rejected', 'expired', 'suspended')),
  CONSTRAINT marketplace_participant_profiles_org_unique UNIQUE (organization_id)
);

CREATE TABLE IF NOT EXISTS public.marketplace_participant_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  participant_profile_id UUID NOT NULL REFERENCES public.marketplace_participant_profiles(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  membership_role TEXT NOT NULL DEFAULT 'owner',
  status TEXT NOT NULL DEFAULT 'active',
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_participant_memberships_status_ck CHECK (status IN ('active', 'inactive')),
  CONSTRAINT marketplace_participant_memberships_unique UNIQUE (participant_profile_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.marketplace_participant_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  review_decision TEXT NULL,
  requested_participant_type_key TEXT NOT NULL,
  requested_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  requested_organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE SET NULL,
  existing_participant_profile_id UUID NULL REFERENCES public.marketplace_participant_profiles(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  organization_slug TEXT NULL,
  phone TEXT NULL,
  website_url TEXT NULL,
  locale TEXT NULL,
  page_url TEXT NULL,
  referrer TEXT NULL,
  origin TEXT NULL,
  experience_summary TEXT NULL,
  capabilities_requested JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  marketing JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_hash TEXT NULL,
  turnstile_verified BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_at TIMESTAMPTZ NULL,
  reviewed_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  review_reason TEXT NULL,
  decision_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE SET NULL,
  approved_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  approved_auth_user_id UUID NULL,
  approved_participant_profile_id UUID NULL REFERENCES public.marketplace_participant_profiles(id) ON DELETE SET NULL,
  invite_email_sent_at TIMESTAMPTZ NULL,
  invite_redirect_to TEXT NULL,
  last_error_code TEXT NULL,
  last_error_message TEXT NULL,
  last_error_at TIMESTAMPTZ NULL,
  CONSTRAINT marketplace_participant_requests_status_ck CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  CONSTRAINT marketplace_participant_requests_review_decision_ck CHECK (review_decision IS NULL OR review_decision IN ('approved', 'rejected')),
  CONSTRAINT marketplace_participant_requests_email_ck CHECK (position('@' IN email) > 1)
);

CREATE TABLE IF NOT EXISTS public.marketplace_participant_capabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  participant_profile_id UUID NOT NULL REFERENCES public.marketplace_participant_profiles(id) ON DELETE CASCADE,
  capability_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source_request_id UUID NULL REFERENCES public.marketplace_participant_requests(id) ON DELETE SET NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_participant_capabilities_status_ck CHECK (status IN ('active', 'inactive', 'expired')),
  CONSTRAINT marketplace_participant_capabilities_unique UNIQUE (participant_profile_id, capability_key)
);

CREATE TABLE IF NOT EXISTS public.marketplace_verification_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  participant_profile_id UUID NOT NULL REFERENCES public.marketplace_participant_profiles(id) ON DELETE CASCADE,
  document_type_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  document_ref TEXT NULL,
  issued_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  reviewed_at TIMESTAMPTZ NULL,
  reviewed_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  reviewer_notes TEXT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_verification_records_status_ck CHECK (status IN ('pending', 'approved', 'rejected', 'expired'))
);

CREATE TABLE IF NOT EXISTS public.marketplace_availability_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  participant_profile_id UUID NOT NULL REFERENCES public.marketplace_participant_profiles(id) ON DELETE CASCADE,
  availability_status TEXT NOT NULL DEFAULT 'available',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  capacity JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_availability_windows_status_ck CHECK (availability_status IN ('available', 'unavailable', 'reserved')),
  CONSTRAINT marketplace_availability_windows_time_ck CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS public.marketplace_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  requester_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  request_kind_key TEXT NOT NULL REFERENCES public.marketplace_request_kinds(kind_key) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft',
  release_state TEXT NOT NULL DEFAULT 'private_pool',
  title TEXT NOT NULL,
  summary TEXT NULL,
  request_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  private_pool JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility_mode_key TEXT NOT NULL DEFAULT 'private_pool_first',
  pricing_mode_key TEXT NOT NULL DEFAULT 'quote',
  negotiation_mode_key TEXT NOT NULL DEFAULT 'counter',
  ownership_mode_key TEXT NOT NULL DEFAULT 'origin_tenant',
  settlement_mode_key TEXT NOT NULL DEFAULT 'manual_recorded',
  tracking_display_mode_key TEXT NOT NULL DEFAULT 'origin_brand_only',
  materializer_key TEXT NULL,
  published_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  awarded_offer_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_requests_status_ck CHECK (status IN ('draft', 'published', 'award_pending_acceptance', 'awarded', 'in_execution', 'completed', 'cancelled', 'expired')),
  CONSTRAINT marketplace_requests_release_state_ck CHECK (release_state IN ('private_pool', 'curated_network', 'public'))
);

CREATE TABLE IF NOT EXISTS public.marketplace_request_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id UUID NOT NULL REFERENCES public.marketplace_requests(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'open',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_request_items_status_ck CHECK (status IN ('open', 'closed', 'cancelled')),
  CONSTRAINT marketplace_request_items_unique UNIQUE (request_id, item_key)
);

CREATE TABLE IF NOT EXISTS public.marketplace_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id UUID NOT NULL REFERENCES public.marketplace_requests(id) ON DELETE CASCADE,
  supplier_participant_profile_id UUID NOT NULL REFERENCES public.marketplace_participant_profiles(id) ON DELETE CASCADE,
  supplier_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'submitted',
  message TEXT NULL,
  terms JSONB NOT NULL DEFAULT '{}'::jsonb,
  pricing JSONB NOT NULL DEFAULT '{}'::jsonb,
  capabilities_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  withdrawn_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_offers_status_ck CHECK (status IN ('submitted', 'countered', 'withdrawn', 'accepted', 'rejected', 'expired')),
  CONSTRAINT marketplace_offers_unique UNIQUE (request_id, supplier_participant_profile_id)
);

CREATE TABLE IF NOT EXISTS public.marketplace_awards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id UUID NOT NULL REFERENCES public.marketplace_requests(id) ON DELETE CASCADE,
  offer_id UUID NOT NULL UNIQUE REFERENCES public.marketplace_offers(id) ON DELETE CASCADE,
  requester_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_participant_profile_id UUID NOT NULL REFERENCES public.marketplace_participant_profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_acceptance',
  awarded_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  award_reason TEXT NULL,
  award_terms JSONB NOT NULL DEFAULT '{}'::jsonb,
  accepted_at TIMESTAMPTZ NULL,
  rejected_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_awards_status_ck CHECK (status IN ('pending_acceptance', 'accepted', 'rejected', 'materialized', 'cancelled', 'expired'))
);

CREATE TABLE IF NOT EXISTS public.marketplace_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  award_id UUID NOT NULL UNIQUE REFERENCES public.marketplace_awards(id) ON DELETE CASCADE,
  request_id UUID NOT NULL REFERENCES public.marketplace_requests(id) ON DELETE CASCADE,
  requester_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_participant_profile_id UUID NOT NULL REFERENCES public.marketplace_participant_profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_acceptance',
  ownership_mode_key TEXT NOT NULL DEFAULT 'origin_tenant',
  settlement_mode_key TEXT NOT NULL DEFAULT 'manual_recorded',
  terms JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  activated_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  CONSTRAINT marketplace_contracts_status_ck CHECK (status IN ('pending_acceptance', 'active', 'completed', 'cancelled', 'rejected'))
);

CREATE TABLE IF NOT EXISTS public.marketplace_work_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  contract_id UUID NOT NULL REFERENCES public.marketplace_contracts(id) ON DELETE CASCADE,
  award_id UUID NOT NULL UNIQUE REFERENCES public.marketplace_awards(id) ON DELETE CASCADE,
  request_id UUID NOT NULL REFERENCES public.marketplace_requests(id) ON DELETE CASCADE,
  requester_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_participant_profile_id UUID NOT NULL REFERENCES public.marketplace_participant_profiles(id) ON DELETE CASCADE,
  materializer_key TEXT NOT NULL DEFAULT 'manual_bridge',
  status TEXT NOT NULL DEFAULT 'pending_acceptance',
  materialization_state TEXT NOT NULL DEFAULT 'pending',
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  execution_ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  materialized_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  CONSTRAINT marketplace_work_packages_status_ck CHECK (status IN ('pending_acceptance', 'ready', 'in_execution', 'completed', 'cancelled')),
  CONSTRAINT marketplace_work_packages_materialization_state_ck CHECK (materialization_state IN ('pending', 'materialized', 'failed', 'manual'))
);

CREATE TABLE IF NOT EXISTS public.marketplace_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id UUID NULL REFERENCES public.marketplace_requests(id) ON DELETE SET NULL,
  contract_id UUID NULL REFERENCES public.marketplace_contracts(id) ON DELETE SET NULL,
  work_package_id UUID NULL REFERENCES public.marketplace_work_packages(id) ON DELETE SET NULL,
  opened_by_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  counterparty_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  opened_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  resolved_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  category TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  description TEXT NULL,
  resolution TEXT NULL,
  resolved_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_disputes_status_ck CHECK (status IN ('open', 'under_review', 'resolved', 'rejected'))
);

CREATE TABLE IF NOT EXISTS public.marketplace_reputation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  participant_profile_id UUID NOT NULL REFERENCES public.marketplace_participant_profiles(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  weight NUMERIC(10,2) NOT NULL DEFAULT 1,
  score_delta NUMERIC(10,2) NOT NULL DEFAULT 0,
  subject_resource_type TEXT NULL,
  subject_resource_id UUID NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.marketplace_reputation_snapshots (
  participant_profile_id UUID PRIMARY KEY REFERENCES public.marketplace_participant_profiles(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  score NUMERIC(10,2) NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  completion_rate NUMERIC(10,4) NOT NULL DEFAULT 0,
  cancellation_rate NUMERIC(10,4) NOT NULL DEFAULT 0,
  dispute_rate NUMERIC(10,4) NOT NULL DEFAULT 0,
  document_freshness NUMERIC(10,4) NOT NULL DEFAULT 0,
  feedback_score NUMERIC(10,4) NOT NULL DEFAULT 0,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.marketplace_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID NULL,
  event_type TEXT NOT NULL,
  correlation_id UUID NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_marketplace_registry_entries_type_active ON public.marketplace_registry_entries (registry_type, is_active, sort_order, entry_key);
CREATE INDEX IF NOT EXISTS idx_marketplace_request_kinds_active ON public.marketplace_request_kinds (is_active, kind_key);
CREATE INDEX IF NOT EXISTS idx_marketplace_participant_profiles_org ON public.marketplace_participant_profiles (organization_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_participant_profiles_type_status ON public.marketplace_participant_profiles (participant_type_key, status, listing_status);
CREATE INDEX IF NOT EXISTS idx_marketplace_participant_requests_status_created_at ON public.marketplace_participant_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_participant_requests_email_created_at ON public.marketplace_participant_requests (lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_participant_capabilities_profile ON public.marketplace_participant_capabilities (participant_profile_id, capability_key);
CREATE INDEX IF NOT EXISTS idx_marketplace_verification_records_profile ON public.marketplace_verification_records (participant_profile_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_availability_windows_profile_time ON public.marketplace_availability_windows (participant_profile_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_requests_requester_status ON public.marketplace_requests (requester_organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_requests_kind_status ON public.marketplace_requests (request_kind_key, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_offers_request_status ON public.marketplace_offers (request_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_offers_supplier_status ON public.marketplace_offers (supplier_organization_id, status, submitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_active_award_per_request ON public.marketplace_awards (request_id) WHERE status IN ('pending_acceptance', 'accepted', 'materialized');
CREATE INDEX IF NOT EXISTS idx_marketplace_contracts_requester_supplier ON public.marketplace_contracts (requester_organization_id, supplier_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_work_packages_supplier_status ON public.marketplace_work_packages (supplier_organization_id, status, materialization_state);
CREATE INDEX IF NOT EXISTS idx_marketplace_disputes_status_created_at ON public.marketplace_disputes (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_reputation_events_profile_occurred ON public.marketplace_reputation_events (participant_profile_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_events_org_created_at ON public.marketplace_events (organization_id, created_at DESC);

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'marketplace_registry_entries',
    'marketplace_request_kinds',
    'marketplace_participant_profiles',
    'marketplace_participant_memberships',
    'marketplace_participant_requests',
    'marketplace_participant_capabilities',
    'marketplace_verification_records',
    'marketplace_availability_windows',
    'marketplace_requests',
    'marketplace_request_items',
    'marketplace_offers',
    'marketplace_awards',
    'marketplace_contracts',
    'marketplace_work_packages',
    'marketplace_disputes',
    'marketplace_reputation_events',
    'marketplace_reputation_snapshots',
    'marketplace_events'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_set_updated_at ON public.%I', v_table, v_table);
    EXECUTE format('CREATE TRIGGER trg_%I_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', v_table, v_table);
  END LOOP;
END;
$$;

SELECT * FROM public.apply_table_contracts('public');

SELECT pg_advisory_unlock(hashtext('202603071100_marketplace_network_foundation_v1'));
COMMIT;
