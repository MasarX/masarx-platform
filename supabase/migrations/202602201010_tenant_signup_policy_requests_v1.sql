-- Plan: PLAN-202602-tenant-signup-approval-onboarding-defaults / Step: S04
-- Migration: Tenant signup policy + request queue + service review RPCs v1
-- Date: 2026-02-20
-- Purpose:
--   - Add row-driven tenant signup policy category.
--   - Create SSOT queue table public.tenant_signup_requests with strict RLS.
--   - Add service/auth RPCs for intake, reviewer assertion, error recording, and review apply provisioning.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602201010_tenant_signup_policy_requests_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings category + schema registry (global-only, fail-closed)
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
  'tenant_signup_policy',
  'Public tenant signup policy (approval workflow, anti-abuse, notifications, onboarding defaults).',
  TRUE,
  TRUE,
  TRUE,
  'hard_fail',
  '["global"]'::jsonb
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
  'tenant_signup_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'approval_mode', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('required', 'auto')),
      'turnstile', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'required', jsonb_build_object('type', 'boolean')
        )
      ),
      'rate_limit', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'window_seconds', jsonb_build_object('type', 'integer', 'minimum', 1),
          'max_requests', jsonb_build_object('type', 'integer', 'minimum', 0)
        )
      ),
      'dedupe', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'window_seconds', jsonb_build_object('type', 'integer', 'minimum', 0)
        )
      ),
      'email_domains', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'allowlist', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
          'blocklist', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string'))
        )
      ),
      'notifications', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'reviewer_in_app', jsonb_build_object('type', 'boolean'),
          'reviewer_email', jsonb_build_object('type', 'boolean'),
          'requester_approved_email', jsonb_build_object('type', 'boolean'),
          'requester_rejected_email', jsonb_build_object('type', 'boolean')
        )
      ),
      'onboarding', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'provision_on_approval', jsonb_build_object('type', 'boolean'),
          'initial_user_type', jsonb_build_object('type', 'string'),
          'initial_role_key', jsonb_build_object('type', jsonb_build_array('string', 'null')),
          'invite_redirect_to', jsonb_build_object('type', jsonb_build_array('string', 'null'))
        )
      ),
      'task', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'organization_slug', jsonb_build_object('type', 'string'),
          'task_type_key', jsonb_build_object('type', 'string'),
          'queue_key', jsonb_build_object('type', jsonb_build_array('string', 'null')),
          'priority', jsonb_build_object('type', jsonb_build_array('integer', 'null')),
          'sla_minutes', jsonb_build_object('type', jsonb_build_array('integer', 'null'))
        )
      )
    )
  ),
  'Policy for public tenant signup intake + approval routing + onboarding provisioning.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'approval_mode', 'required',
      'turnstile', jsonb_build_object('required', TRUE),
      'rate_limit', jsonb_build_object('window_seconds', 60, 'max_requests', 10),
      'dedupe', jsonb_build_object('window_seconds', 86400),
      'email_domains', jsonb_build_object('allowlist', jsonb_build_array(), 'blocklist', jsonb_build_array()),
      'notifications', jsonb_build_object(
        'reviewer_in_app', TRUE,
        'reviewer_email', FALSE,
        'requester_approved_email', TRUE,
        'requester_rejected_email', FALSE
      ),
      'onboarding', jsonb_build_object(
        'provision_on_approval', TRUE,
        'initial_user_type', 'ops_admin',
        'initial_role_key', 'ops_admin',
        'invite_redirect_to', NULL
      ),
      'task', jsonb_build_object(
        'organization_slug', 'global-root',
        'task_type_key', 'tenant_signup_review',
        'queue_key', 'tenant_signup',
        'priority', 40,
        'sla_minutes', 60
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
  is_active = TRUE,
  updated_at = now();

-------------------------------------------------------------------------------
-- 2) Seed global default if missing
-------------------------------------------------------------------------------

DO $seed$
DECLARE
  v_existing RECORD;
  v_value JSONB;
BEGIN
  SELECT *
    INTO v_existing
    FROM public.settings
   WHERE category = 'tenant_signup_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
   LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT (examples->0)
    INTO v_value
    FROM public.schema_registry
   WHERE category = 'tenant_signup_policy'
     AND version = 1
   LIMIT 1;

  v_value := COALESCE(v_value, jsonb_build_object('version', 1, 'enabled', TRUE, 'approval_mode', 'required'));

  PERFORM public.upsert_settings_value_v1(
    'tenant_signup_policy',
    'global',
    NULL,
    v_value,
    1,
    'seed tenant_signup_policy global default'
  );
END;
$seed$;

-------------------------------------------------------------------------------
-- 3) SSOT table: tenant_signup_requests
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tenant_signup_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  status TEXT NOT NULL DEFAULT 'pending',
  review_decision TEXT NULL,

  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  organization_slug TEXT NULL,
  website_url TEXT NULL,
  phone TEXT NULL,
  notes TEXT NULL,
  locale TEXT NULL,

  page_url TEXT NULL,
  referrer TEXT NULL,
  origin TEXT NULL,

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
  invite_email_sent_at TIMESTAMPTZ NULL,
  invite_redirect_to TEXT NULL,

  last_error_code TEXT NULL,
  last_error_message TEXT NULL,
  last_error_at TIMESTAMPTZ NULL,

  CONSTRAINT tenant_signup_requests_status_ck CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT tenant_signup_requests_review_decision_ck CHECK (
    review_decision IS NULL OR review_decision IN ('approved', 'rejected')
  ),
  CONSTRAINT tenant_signup_requests_email_ck CHECK (position('@' IN email) > 1)
);

CREATE INDEX IF NOT EXISTS idx_tenant_signup_requests_created_at
  ON public.tenant_signup_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_signup_requests_status_created_at
  ON public.tenant_signup_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_signup_requests_email_created_at
  ON public.tenant_signup_requests (lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_signup_requests_ip_hash_created_at
  ON public.tenant_signup_requests (ip_hash, created_at DESC)
  WHERE ip_hash IS NOT NULL;

DROP TRIGGER IF EXISTS trg_tenant_signup_requests_set_updated_at ON public.tenant_signup_requests;
CREATE TRIGGER trg_tenant_signup_requests_set_updated_at
  BEFORE UPDATE ON public.tenant_signup_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.tenant_signup_requests IS
  'SSOT queue for public tenant signup intake requests and approval lifecycle.';

ALTER TABLE public.tenant_signup_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tenant_signup_requests FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_signup_requests FROM anon;
REVOKE ALL ON TABLE public.tenant_signup_requests FROM authenticated;

GRANT SELECT ON TABLE public.tenant_signup_requests TO authenticated;
GRANT ALL ON TABLE public.tenant_signup_requests TO service_role;

DROP POLICY IF EXISTS tenant_signup_requests_service_policy ON public.tenant_signup_requests;
CREATE POLICY tenant_signup_requests_service_policy
  ON public.tenant_signup_requests
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS tenant_signup_requests_read_policy ON public.tenant_signup_requests;
CREATE POLICY tenant_signup_requests_read_policy
  ON public.tenant_signup_requests
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('tenant_signup_requests', 'read')
    AND public.is_platform_user()
  );

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES (
  'public',
  'tenant_signup_requests',
  TRUE,
  TRUE,
  TRUE,
  'Tenant signup intake queue with approval lifecycle + audit fields.'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes;

SELECT * FROM public.apply_table_contracts('public');

-------------------------------------------------------------------------------
-- 4) Helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tenant_signup_policy_bool_v1(
  p_policy JSONB,
  p_path TEXT[],
  p_default BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_text TEXT;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object' THEN
    RETURN p_default;
  END IF;

  v_text := p_policy #>> p_path;
  IF v_text IS NULL OR btrim(v_text) = '' THEN
    RETURN p_default;
  END IF;

  BEGIN
    RETURN v_text::BOOLEAN;
  EXCEPTION
    WHEN others THEN
      RETURN p_default;
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_signup_policy_int_v1(
  p_policy JSONB,
  p_path TEXT[],
  p_default INTEGER,
  p_min INTEGER DEFAULT NULL,
  p_max INTEGER DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_text TEXT;
  v_out INTEGER;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object' THEN
    RETURN p_default;
  END IF;

  v_text := p_policy #>> p_path;
  IF v_text IS NULL OR btrim(v_text) = '' THEN
    RETURN p_default;
  END IF;

  BEGIN
    v_out := v_text::INTEGER;
  EXCEPTION
    WHEN others THEN
      RETURN p_default;
  END;

  IF p_min IS NOT NULL AND v_out < p_min THEN
    v_out := p_min;
  END IF;

  IF p_max IS NOT NULL AND v_out > p_max THEN
    v_out := p_max;
  END IF;

  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_signup_jsonb_text_array_v1(
  p_value JSONB
)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT COALESCE(
    array_agg(lower(btrim(value))) FILTER (WHERE btrim(value) <> ''),
    ARRAY[]::TEXT[]
  )
  FROM jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(p_value) = 'array' THEN p_value
      ELSE '[]'::jsonb
    END
  ) AS e(value);
$function$;

CREATE OR REPLACE FUNCTION public.tenant_signup_slugify_v1(
  p_value TEXT,
  p_fallback TEXT DEFAULT 'organization'
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_slug TEXT;
BEGIN
  v_slug := lower(regexp_replace(COALESCE(p_value, ''), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := regexp_replace(v_slug, '(^-+|-+$)', '', 'g');

  IF v_slug IS NULL OR v_slug = '' THEN
    v_slug := lower(regexp_replace(COALESCE(NULLIF(p_fallback, ''), 'organization'), '[^a-zA-Z0-9]+', '-', 'g'));
    v_slug := regexp_replace(v_slug, '(^-+|-+$)', '', 'g');
  END IF;

  IF v_slug IS NULL OR v_slug = '' THEN
    v_slug := 'organization';
  END IF;

  RETURN left(v_slug, 58);
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_signup_next_org_slug_v1(
  p_preferred_slug TEXT,
  p_org_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_base TEXT;
  v_candidate TEXT;
  v_suffix INTEGER := 0;
BEGIN
  v_base := public.tenant_signup_slugify_v1(
    COALESCE(NULLIF(btrim(COALESCE(p_preferred_slug, '')), ''), NULLIF(btrim(COALESCE(p_org_name, '')), '')),
    'organization'
  );

  v_candidate := v_base;
  WHILE EXISTS (
    SELECT 1
    FROM public.organizations o
    WHERE o.slug = v_candidate
    LIMIT 1
  ) LOOP
    v_suffix := v_suffix + 1;
    v_candidate := format(
      '%s-%s',
      left(v_base, GREATEST(1, 58 - length(v_suffix::TEXT) - 1)),
      v_suffix::TEXT
    );
  END LOOP;

  RETURN v_candidate;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_signup_policy_v1()
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
    'approval_mode', 'required',
    'turnstile', jsonb_build_object('required', TRUE),
    'rate_limit', jsonb_build_object('window_seconds', 60, 'max_requests', 10),
    'dedupe', jsonb_build_object('window_seconds', 86400),
    'email_domains', jsonb_build_object('allowlist', jsonb_build_array(), 'blocklist', jsonb_build_array()),
    'notifications', jsonb_build_object(
      'reviewer_in_app', TRUE,
      'reviewer_email', FALSE,
      'requester_approved_email', TRUE,
      'requester_rejected_email', FALSE
    ),
    'onboarding', jsonb_build_object(
      'provision_on_approval', TRUE,
      'initial_user_type', 'ops_admin',
      'initial_role_key', 'ops_admin',
      'invite_redirect_to', NULL
    ),
    'task', jsonb_build_object(
      'organization_slug', 'global-root',
      'task_type_key', 'tenant_signup_review',
      'queue_key', 'tenant_signup',
      'priority', 40,
      'sla_minutes', 60
    )
  );
  v_resolved JSONB;
BEGIN
  v_resolved := public.resolve_settings('tenant_signup_policy', 'global', NULL);
  IF v_resolved IS NULL OR jsonb_typeof(v_resolved) <> 'object' THEN
    RETURN v_default;
  END IF;

  RETURN public.jsonb_deep_merge(v_default, v_resolved);
END;
$function$;

-------------------------------------------------------------------------------
-- 5) Intake RPC (service-only; policy-driven)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tenant_signup_request_create_v1(
  p_email TEXT,
  p_full_name TEXT,
  p_organization_name TEXT,
  p_organization_slug TEXT DEFAULT NULL,
  p_website_url TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_locale TEXT DEFAULT NULL,
  p_page_url TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_origin TEXT DEFAULT NULL,
  p_marketing JSONB DEFAULT '{}'::jsonb,
  p_ip_hash TEXT DEFAULT NULL,
  p_turnstile_verified BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_turnstile_required BOOLEAN;
  v_window_seconds INT;
  v_max_requests INT;
  v_dedupe_seconds INT;

  v_now TIMESTAMPTZ := now();
  v_id UUID := gen_random_uuid();

  v_email TEXT := lower(btrim(COALESCE(p_email, '')));
  v_full_name TEXT := btrim(COALESCE(p_full_name, ''));
  v_org_name TEXT := btrim(COALESCE(p_organization_name, ''));
  v_org_slug TEXT := NULLIF(btrim(COALESCE(p_organization_slug, '')), '');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(p_ip_hash, '')), '');

  v_email_domain TEXT := lower(split_part(v_email, '@', 2));
  v_allow_domains TEXT[] := ARRAY[]::TEXT[];
  v_block_domains TEXT[] := ARRAY[]::TEXT[];

  v_approval_mode TEXT := 'required';
  v_auto_approve BOOLEAN := FALSE;

  v_recent_count INT := 0;
  v_existing RECORD;

  v_task_enabled BOOLEAN;
  v_task_org_slug TEXT;
  v_task_type_key TEXT;
  v_task_queue TEXT;
  v_task_priority INT;
  v_task_sla_minutes INT;
  v_task_org_id UUID;
  v_task_id UUID := NULL;
  v_workflow_run_id UUID := NULL;

  v_invite_redirect_to TEXT;
BEGIN
  v_policy := public.tenant_signup_policy_v1();

  v_enabled := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['enabled'], FALSE);
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'disabled'));
  END IF;

  v_turnstile_required := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['turnstile', 'required'], TRUE);
  IF v_turnstile_required AND NOT COALESCE(p_turnstile_verified, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'turnstile_required'));
  END IF;

  IF v_email = '' OR position('@' IN v_email) < 2 OR position('.' IN v_email_domain) < 2 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_email'));
  END IF;

  IF v_full_name = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'full_name_required'));
  END IF;

  IF v_org_name = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'organization_required'));
  END IF;

  v_allow_domains := public.tenant_signup_jsonb_text_array_v1(v_policy #> ARRAY['email_domains', 'allowlist']);
  v_block_domains := public.tenant_signup_jsonb_text_array_v1(v_policy #> ARRAY['email_domains', 'blocklist']);

  IF array_length(v_allow_domains, 1) IS NOT NULL
     AND NOT (v_email_domain = ANY(v_allow_domains)) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'domain_not_allowed'));
  END IF;

  IF array_length(v_block_domains, 1) IS NOT NULL
     AND v_email_domain = ANY(v_block_domains) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'domain_blocked'));
  END IF;

  v_window_seconds := public.tenant_signup_policy_int_v1(v_policy, ARRAY['rate_limit', 'window_seconds'], 60, 1, 86400);
  v_max_requests := public.tenant_signup_policy_int_v1(v_policy, ARRAY['rate_limit', 'max_requests'], 10, 0, 100000);

  IF v_ip_hash IS NOT NULL AND v_max_requests > 0 THEN
    SELECT COUNT(*)
      INTO v_recent_count
      FROM public.tenant_signup_requests r
     WHERE r.ip_hash = v_ip_hash
       AND r.created_at >= (v_now - (v_window_seconds || ' seconds')::interval);

    IF v_recent_count >= v_max_requests THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
    END IF;
  END IF;

  v_dedupe_seconds := public.tenant_signup_policy_int_v1(v_policy, ARRAY['dedupe', 'window_seconds'], 86400, 0, 2592000);
  IF v_dedupe_seconds > 0 THEN
    SELECT r.id, r.status, r.created_at
      INTO v_existing
      FROM public.tenant_signup_requests r
     WHERE lower(r.email) = v_email
       AND r.created_at >= (v_now - (v_dedupe_seconds || ' seconds')::interval)
     ORDER BY r.created_at DESC
     LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      v_approval_mode := lower(COALESCE(NULLIF(v_policy->>'approval_mode', ''), 'required'));
      IF v_approval_mode NOT IN ('required', 'auto') THEN
        v_approval_mode := 'required';
      END IF;

      RETURN jsonb_build_object(
        'ok', TRUE,
        'id', v_existing.id,
        'status', COALESCE(v_existing.status, 'pending'),
        'deduped', TRUE,
        'approval_mode', v_approval_mode,
        'auto_approve', (v_approval_mode = 'auto')
      );
    END IF;
  END IF;

  v_approval_mode := lower(COALESCE(NULLIF(v_policy->>'approval_mode', ''), 'required'));
  IF v_approval_mode NOT IN ('required', 'auto') THEN
    v_approval_mode := 'required';
  END IF;
  v_auto_approve := (v_approval_mode = 'auto');

  v_invite_redirect_to := NULLIF(btrim(COALESCE(v_policy #>> ARRAY['onboarding', 'invite_redirect_to'], '')), '');

  INSERT INTO public.tenant_signup_requests (
    id,
    created_at,
    updated_at,
    status,
    email,
    full_name,
    organization_name,
    organization_slug,
    website_url,
    phone,
    notes,
    locale,
    page_url,
    referrer,
    origin,
    marketing,
    metadata,
    ip_hash,
    turnstile_verified
  ) VALUES (
    v_id,
    v_now,
    v_now,
    'pending',
    v_email,
    v_full_name,
    v_org_name,
    v_org_slug,
    NULLIF(btrim(COALESCE(p_website_url, '')), ''),
    NULLIF(btrim(COALESCE(p_phone, '')), ''),
    NULLIF(btrim(COALESCE(p_notes, '')), ''),
    NULLIF(btrim(COALESCE(p_locale, '')), ''),
    NULLIF(btrim(COALESCE(p_page_url, '')), ''),
    NULLIF(btrim(COALESCE(p_referrer, '')), ''),
    NULLIF(btrim(COALESCE(p_origin, '')), ''),
    COALESCE(p_marketing, '{}'::jsonb),
    jsonb_build_object(
      'approval_mode', v_approval_mode,
      'created_via', 'tenant_signup_request_create_v1'
    ),
    v_ip_hash,
    COALESCE(p_turnstile_verified, FALSE)
  );

  v_task_enabled := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['notifications', 'reviewer_in_app'], TRUE);

  IF v_task_enabled THEN
    BEGIN
      v_task_org_slug := NULLIF(btrim(COALESCE(v_policy #>> ARRAY['task', 'organization_slug'], '')), '');
      IF v_task_org_slug IS NULL THEN
        v_task_org_slug := 'global-root';
      END IF;

      SELECT o.id
        INTO v_task_org_id
        FROM public.organizations o
       WHERE o.slug = v_task_org_slug
       LIMIT 1;

      IF v_task_org_id IS NOT NULL THEN
        v_task_type_key := lower(COALESCE(NULLIF(btrim(v_policy #>> ARRAY['task', 'task_type_key']), ''), 'tenant_signup_review'));
        v_task_queue := NULLIF(btrim(COALESCE(v_policy #>> ARRAY['task', 'queue_key'], '')), '');
        v_task_priority := public.tenant_signup_policy_int_v1(v_policy, ARRAY['task', 'priority'], 40, 0, 1000);
        v_task_sla_minutes := public.tenant_signup_policy_int_v1(v_policy, ARRAY['task', 'sla_minutes'], 60, 1, 10080);

        SELECT t.task_id, t.workflow_run_id
          INTO v_task_id, v_workflow_run_id
          FROM public.create_task_system_v1(
            jsonb_strip_nulls(
              jsonb_build_object(
                'task_type_key', v_task_type_key,
                'context', jsonb_build_object('organization_id', v_task_org_id),
                'resource_type', 'tenant_signup_request',
                'resource_id', v_id,
                'queue_key', v_task_queue,
                'priority', v_task_priority,
                'sla_minutes', v_task_sla_minutes,
                'idempotency_key', format('tenant_signup_review:%s', v_id),
                'metadata', jsonb_build_object(
                  'request_id', v_id,
                  'email', v_email,
                  'full_name', v_full_name,
                  'organization_name', v_org_name
                ),
                'actor_system', 'tenant-signup-intake'
              )
            )
          ) AS t
         LIMIT 1;
      END IF;
    EXCEPTION
      WHEN others THEN
        UPDATE public.tenant_signup_requests
           SET last_error_code = 'task_enqueue_failed',
               last_error_message = left(SQLERRM, 800),
               last_error_at = now(),
               decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
                 || jsonb_build_object('task_enqueue_error', left(SQLERRM, 800))
         WHERE id = v_id;
    END;
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'id', v_id,
      'status', 'pending',
      'approval_mode', v_approval_mode,
      'auto_approve', v_auto_approve,
      'invite_redirect_to', v_invite_redirect_to,
      'task_id', v_task_id,
      'workflow_run_id', v_workflow_run_id
    )
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 6) Reviewer assertion + service review apply
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tenant_signup_assert_reviewer_v1()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_signup_review requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_scope_type := public.current_user_scope_type();
  IF v_scope_type IS DISTINCT FROM 'platform' THEN
    RAISE EXCEPTION 'tenant_signup_review requires platform scope'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('tenant_signup_requests.review', 'global', NULL);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'user_id', v_user_id,
    'scope_type', v_scope_type
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_signup_request_record_error_v1(
  p_request_id UUID,
  p_error_code TEXT,
  p_error_message TEXT,
  p_error_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');
  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'service_role_required')
    );
  END IF;

  UPDATE public.tenant_signup_requests
     SET last_error_code = NULLIF(btrim(COALESCE(p_error_code, '')), ''),
         last_error_message = NULLIF(left(btrim(COALESCE(p_error_message, '')), 800), ''),
         last_error_at = now(),
         decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
           || jsonb_build_object('error_context', COALESCE(p_error_context, '{}'::jsonb))
   WHERE id = p_request_id
     AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'request_not_pending')
    );
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'id', p_request_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_signup_review_apply_v1(
  p_request_id UUID,
  p_decision TEXT,
  p_reviewer_user_id UUID DEFAULT NULL,
  p_decision_reason TEXT DEFAULT NULL,
  p_invited_auth_user_id UUID DEFAULT NULL,
  p_invite_email_sent BOOLEAN DEFAULT FALSE,
  p_invite_redirect_to TEXT DEFAULT NULL,
  p_decision_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_decision TEXT := lower(btrim(COALESCE(p_decision, '')));

  v_policy JSONB;
  v_req public.tenant_signup_requests%ROWTYPE;

  v_provision_on_approval BOOLEAN := TRUE;
  v_user_type TEXT := 'ops_admin';
  v_role_key TEXT := 'ops_admin';

  v_org_id UUID := NULL;
  v_user_id UUID := NULL;
  v_role_id UUID := NULL;

  v_invite_redirect_to TEXT := NULL;
  v_org_slug TEXT := NULL;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');
  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'service_role_required')
    );
  END IF;

  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_id_required'));
  END IF;

  IF v_decision IN ('approve') THEN
    v_decision := 'approved';
  ELSIF v_decision IN ('reject') THEN
    v_decision := 'rejected';
  END IF;

  IF v_decision NOT IN ('approved', 'rejected') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_decision'));
  END IF;

  SELECT *
    INTO v_req
    FROM public.tenant_signup_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_req.status <> 'pending' THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok', TRUE,
        'id', v_req.id,
        'status', v_req.status,
        'already_processed', TRUE,
        'approved_organization_id', v_req.approved_organization_id,
        'approved_user_id', v_req.approved_user_id
      )
    );
  END IF;

  IF v_decision = 'rejected' THEN
    UPDATE public.tenant_signup_requests
       SET status = 'rejected',
           review_decision = 'rejected',
           reviewed_at = now(),
           reviewed_by = COALESCE(p_reviewer_user_id, reviewed_by),
           review_reason = NULLIF(btrim(COALESCE(p_decision_reason, '')), ''),
           decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
             || COALESCE(p_decision_metadata, '{}'::jsonb)
             || jsonb_build_object('decision', 'rejected', 'review_applied_at', now()),
           updated_at = now()
     WHERE id = v_req.id;

    RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'status', 'rejected');
  END IF;

  IF p_invited_auth_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invited_auth_user_required'));
  END IF;

  v_policy := public.tenant_signup_policy_v1();
  v_provision_on_approval := public.tenant_signup_policy_bool_v1(
    v_policy,
    ARRAY['onboarding', 'provision_on_approval'],
    TRUE
  );

  v_user_type := lower(COALESCE(NULLIF(btrim(v_policy #>> ARRAY['onboarding', 'initial_user_type']), ''), 'ops_admin'));
  v_role_key := lower(COALESCE(NULLIF(btrim(v_policy #>> ARRAY['onboarding', 'initial_role_key']), ''), v_user_type));

  v_invite_redirect_to := COALESCE(
    NULLIF(btrim(COALESCE(p_invite_redirect_to, '')), ''),
    NULLIF(btrim(COALESCE(v_policy #>> ARRAY['onboarding', 'invite_redirect_to'], '')), '')
  );

  BEGIN
    IF v_provision_on_approval THEN
      v_org_slug := public.tenant_signup_next_org_slug_v1(v_req.organization_slug, v_req.organization_name);

      INSERT INTO public.organizations (
        name,
        slug
      ) VALUES (
        v_req.organization_name,
        v_org_slug
      )
      RETURNING id INTO v_org_id;

      INSERT INTO public.users (
        id,
        organization_id,
        email,
        full_name,
        user_type,
        status,
        access_scope_type,
        access_scope_id
      ) VALUES (
        p_invited_auth_user_id,
        v_org_id,
        v_req.email,
        COALESCE(NULLIF(v_req.full_name, ''), v_req.email),
        v_user_type,
        'active',
        'tenant',
        NULL
      )
      ON CONFLICT (id) DO UPDATE
      SET
        organization_id = EXCLUDED.organization_id,
        email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        user_type = EXCLUDED.user_type,
        status = EXCLUDED.status,
        access_scope_type = EXCLUDED.access_scope_type,
        access_scope_id = EXCLUDED.access_scope_id
      RETURNING id INTO v_user_id;

      PERFORM public.provision_rbac_roles_from_templates_v1(
        v_org_id,
        ARRAY[v_role_key],
        NULL
      );

      SELECT r.id
        INTO v_role_id
        FROM public.rbac_roles r
       WHERE r.organization_id = v_org_id
         AND r.key = v_role_key
       LIMIT 1;

      IF v_role_id IS NOT NULL THEN
        INSERT INTO public.rbac_user_role_assignments (
          organization_id,
          user_id,
          role_id,
          assigned_by_user_id,
          metadata
        ) VALUES (
          v_org_id,
          v_user_id,
          v_role_id,
          NULL,
          jsonb_build_object(
            'source', 'tenant_signup_review_apply_v1',
            'request_id', v_req.id
          )
        )
        ON CONFLICT (organization_id, user_id, role_id) WHERE revoked_at IS NULL
        DO UPDATE SET
          metadata = public.rbac_user_role_assignments.metadata || EXCLUDED.metadata,
          updated_at = now();
      END IF;
    END IF;
  EXCEPTION
    WHEN others THEN
      PERFORM public.tenant_signup_request_record_error_v1(
        v_req.id,
        'provision_failed',
        SQLERRM,
        jsonb_build_object('sqlstate', SQLSTATE, 'decision', v_decision)
      );
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object('code', 'provision_failed', 'message', SQLERRM, 'sqlstate', SQLSTATE)
      );
  END;

  IF v_user_id IS NULL THEN
    v_user_id := p_invited_auth_user_id;
  END IF;

  UPDATE public.tenant_signup_requests
     SET status = 'approved',
         review_decision = 'approved',
         reviewed_at = now(),
         reviewed_by = COALESCE(p_reviewer_user_id, reviewed_by),
         review_reason = NULLIF(btrim(COALESCE(p_decision_reason, '')), ''),
         decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
           || COALESCE(p_decision_metadata, '{}'::jsonb)
           || jsonb_build_object('decision', 'approved', 'review_applied_at', now()),
         approved_organization_id = v_org_id,
         approved_user_id = v_user_id,
         approved_auth_user_id = p_invited_auth_user_id,
         invite_email_sent_at = CASE
           WHEN COALESCE(p_invite_email_sent, FALSE) THEN now()
           ELSE invite_email_sent_at
         END,
         invite_redirect_to = v_invite_redirect_to,
         last_error_code = NULL,
         last_error_message = NULL,
         last_error_at = NULL,
         updated_at = now()
   WHERE id = v_req.id;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'id', v_req.id,
      'status', 'approved',
      'organization_id', v_org_id,
      'user_id', v_user_id,
      'organization_slug', v_org_slug,
      'invite_redirect_to', v_invite_redirect_to
    )
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 7) Least-privilege grants
-------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.tenant_signup_policy_bool_v1(JSONB, TEXT[], BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_policy_int_v1(JSONB, TEXT[], INTEGER, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_jsonb_text_array_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_slugify_v1(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_next_org_slug_v1(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_policy_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_assert_reviewer_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_request_record_error_v1(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1(UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.tenant_signup_policy_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_signup_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_signup_assert_reviewer_v1() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_signup_request_record_error_v1(UUID, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_signup_review_apply_v1(UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202602201010_tenant_signup_policy_requests_v1'));
COMMIT;
