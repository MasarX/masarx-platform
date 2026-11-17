-- Plan: PLAN-202512-system-defaults-prod-ready / Step: S04
-- Migration: Settings governance hardening (allowed scopes + safe missing behavior)
-- Purpose:
--   - Enforce per-category allowed scopes (settings_category_registry.allowed_scopes) at write-time.
--   - Apply safe_missing_behavior for missing global defaults (hard_fail) in resolve_settings().
--   - Emit settings_resolution_log rows for missing-but-allowed (skip/skip_with_ack/hard_fail) resolutions in resolve_settings_row().
-- Notes:
--   - All enforcement is row-driven via settings_category_registry (SSOT).
--   - Logging must never crash business logic; inserts are guarded.
BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Enforce per-category allowed scopes (SSOT)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_settings_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  scope_valid BOOLEAN := false;
  v_allowed_scopes JSONB;
BEGIN
  -- Category governance (optional): restrict which scopes may exist for a category.
  -- The FK from settings/settings_versions -> settings_category_registry ensures the row exists,
  -- but guard defensively for older environments during rolling upgrades.
  SELECT scr.allowed_scopes
    INTO v_allowed_scopes
    FROM public.settings_category_registry scr
   WHERE scr.category = NEW.category
   LIMIT 1;

  IF v_allowed_scopes IS NOT NULL AND jsonb_typeof(v_allowed_scopes) = 'array' THEN
    IF NOT (v_allowed_scopes ? NEW.scope_type) THEN
      RAISE EXCEPTION 'Scope "%" is not allowed for category "%"', NEW.scope_type, NEW.category
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Scope correctness: validate the referenced entity exists (or NULL for global).
  IF NEW.scope_type = 'global' THEN
    IF NEW.scope_id IS NULL THEN
      scope_valid := true;
    END IF;
  ELSIF NEW.scope_type = 'tenant' THEN
    SELECT TRUE INTO scope_valid FROM public.organizations WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'client' THEN
    SELECT TRUE INTO scope_valid FROM public.clients WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'sender' THEN
    SELECT TRUE INTO scope_valid FROM public.senders WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'resource' THEN
    SELECT TRUE INTO scope_valid FROM public.providers WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'source' THEN
    SELECT TRUE INTO scope_valid FROM public.webhook_sources WHERE id = NEW.scope_id;
  ELSE
    RAISE EXCEPTION 'Unsupported scope_type %', NEW.scope_type USING ERRCODE = '23514';
  END IF;

  IF NOT scope_valid THEN
    RAISE EXCEPTION 'Invalid scope %/% for % record %', NEW.scope_type, NEW.scope_id, TG_TABLE_NAME, NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'settings' THEN
    PERFORM 1
    FROM public.settings_versions sv
    WHERE sv.id = NEW.settings_version_id
      AND sv.scope_type = NEW.scope_type
      AND sv.scope_hash = NEW.scope_hash;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'settings row % references version % with mismatched scope', NEW.id, NEW.settings_version_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.validate_settings_scope()
  SET search_path = public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 2) Safe missing behavior for resolve_settings (global missing)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_settings(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_scope_type TEXT := p_scope_type;
  v_value JSONB;
  v_client_id UUID;
  v_org_id UUID;
  v_sender_id UUID;
  v_safe_missing TEXT := NULL;
BEGIN
  IF p_category IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT scr.safe_missing_behavior
    INTO v_safe_missing
    FROM public.settings_category_registry scr
   WHERE scr.category = p_category
   LIMIT 1;

  IF v_scope_type IS NULL OR v_scope_type = '' THEN
    v_scope_type := 'global';
  ELSIF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_scope_type = 'global' THEN
    SELECT cached_value
      INTO v_value
      FROM public.settings
     WHERE category = p_category
       AND scope_type = 'global'
       AND scope_id IS NULL
     ORDER BY last_updated DESC
     LIMIT 1;

    IF v_value IS NULL AND v_safe_missing = 'hard_fail' THEN
      RAISE EXCEPTION 'Missing required global settings for category: %', p_category USING ERRCODE = '23514';
    END IF;

    RETURN v_value;
  END IF;

  SELECT cached_value
    INTO v_value
    FROM public.settings
   WHERE category = p_category
     AND scope_type = v_scope_type
     AND scope_id IS NOT DISTINCT FROM p_scope_id
   ORDER BY last_updated DESC
   LIMIT 1;

  IF v_value IS NOT NULL THEN
    RETURN v_value;
  END IF;

  IF v_scope_type = 'resource' THEN
    RETURN public.resolve_settings(p_category, 'global'::text, NULL);
  ELSIF v_scope_type = 'source' THEN
    SELECT sender_id, organization_id
      INTO v_sender_id, v_org_id
      FROM public.webhook_sources
     WHERE id = p_scope_id;

    IF v_sender_id IS NOT NULL THEN
      v_value := public.resolve_settings(p_category, 'sender'::text, v_sender_id);
      IF v_value IS NOT NULL THEN
        RETURN v_value;
      END IF;

      SELECT client_id INTO v_client_id FROM public.senders WHERE id = v_sender_id;
      IF v_client_id IS NOT NULL THEN
        v_value := public.resolve_settings(p_category, 'client'::text, v_client_id);
        IF v_value IS NOT NULL THEN
          RETURN v_value;
        END IF;
      END IF;
    END IF;

    IF v_org_id IS NOT NULL THEN
      v_value := public.resolve_settings(p_category, 'tenant'::text, v_org_id);
      IF v_value IS NOT NULL THEN
        RETURN v_value;
      END IF;
    END IF;

    RETURN public.resolve_settings(p_category, 'global'::text, NULL);
  ELSIF v_scope_type = 'sender' THEN
    SELECT client_id INTO v_client_id FROM public.senders WHERE id = p_scope_id;
    IF v_client_id IS NOT NULL THEN
      v_value := public.resolve_settings(p_category, 'client'::text, v_client_id);
      IF v_value IS NOT NULL THEN
        RETURN v_value;
      END IF;
    END IF;

    SELECT c.organization_id INTO v_org_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = p_scope_id;

    IF v_org_id IS NOT NULL THEN
      v_value := public.resolve_settings(p_category, 'tenant'::text, v_org_id);
      IF v_value IS NOT NULL THEN
        RETURN v_value;
      END IF;
    END IF;

    RETURN public.resolve_settings(p_category, 'global'::text, NULL);
  ELSIF v_scope_type = 'client' THEN
    SELECT organization_id INTO v_org_id FROM public.clients WHERE id = p_scope_id;
    IF v_org_id IS NOT NULL THEN
      v_value := public.resolve_settings(p_category, 'tenant'::text, v_org_id);
      IF v_value IS NOT NULL THEN
        RETURN v_value;
      END IF;
    END IF;

    RETURN public.resolve_settings(p_category, 'global'::text, NULL);
  ELSIF v_scope_type = 'tenant' THEN
    RETURN public.resolve_settings(p_category, 'global'::text, NULL);
  ELSE
    RETURN public.resolve_settings(p_category, 'global'::text, NULL);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) Safe missing behavior + SSOT logging for resolve_settings_row (missing)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_settings_row(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_sender_id UUID;
  v_client_id UUID;
  v_org_id UUID;
  v_scope_path JSONB := '[]'::jsonb;
  v_safe_missing TEXT := NULL;
  v_log_org_id UUID := NULL;
BEGIN
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RETURN;
  END IF;

  SELECT scr.safe_missing_behavior
    INTO v_safe_missing
    FROM public.settings_category_registry scr
   WHERE scr.category = p_category
   LIMIT 1;

  IF p_scope_type IS NULL OR p_scope_type = '' THEN
    p_scope_type := 'global';
  ELSIF p_scope_type = 'organization' THEN
    p_scope_type := 'tenant';
  END IF;

  -- Determine ladder chain
  IF p_scope_type = 'source' THEN
    SELECT sender_id, organization_id
      INTO v_sender_id, v_org_id
      FROM public.webhook_sources
     WHERE id = p_scope_id;
    IF v_sender_id IS NOT NULL THEN
      SELECT client_id INTO v_client_id FROM public.senders WHERE id = v_sender_id;
    END IF;
  ELSIF p_scope_type = 'sender' THEN
    v_sender_id := p_scope_id;
    SELECT client_id INTO v_client_id FROM public.senders WHERE id = p_scope_id;
    IF v_client_id IS NOT NULL THEN
      SELECT organization_id INTO v_org_id FROM public.clients WHERE id = v_client_id;
    END IF;
  ELSIF p_scope_type = 'client' THEN
    v_client_id := p_scope_id;
    SELECT organization_id INTO v_org_id FROM public.clients WHERE id = p_scope_id;
  ELSIF p_scope_type = 'tenant' THEN
    v_org_id := p_scope_id;
  END IF;

  -- Build evaluated scope path (highest precedence -> lowest).
  IF p_scope_type = 'source' AND p_scope_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type','source','scope_id',p_scope_id));
  ELSIF p_scope_type = 'sender' AND v_sender_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type','sender','scope_id',v_sender_id));
  ELSIF p_scope_type = 'client' AND v_client_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type','client','scope_id',v_client_id));
  ELSIF p_scope_type = 'tenant' AND v_org_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type','tenant','scope_id',v_org_id));
  ELSIF p_scope_type = 'resource' AND p_scope_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type','resource','scope_id',p_scope_id));
  END IF;
  IF p_scope_type = 'source' AND v_sender_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type','sender','scope_id',v_sender_id));
  END IF;
  IF (p_scope_type IN ('source','sender')) AND v_client_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type','client','scope_id',v_client_id));
  END IF;
  IF p_scope_type IN ('source','sender','client') AND v_org_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type','tenant','scope_id',v_org_id));
  END IF;
  v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type','global','scope_id',NULL));

  -- Resolve by ladder precedence (highest scope first).
  IF p_scope_type = 'global' THEN
    RETURN QUERY
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, v_scope_path
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = p_category
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     ORDER BY s.last_updated DESC NULLS LAST
     LIMIT 1;

    IF NOT FOUND AND v_safe_missing = 'hard_fail' THEN
      RAISE EXCEPTION 'Missing required global settings for category: %', p_category USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT ranked.id, ranked.settings_version_id, ranked.scope_type, ranked.scope_id, ranked.cached_value, ranked.version, v_scope_path
  FROM (
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 1 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = p_category
       AND s.scope_type = p_scope_type
       AND (
         (p_scope_type = 'global' AND s.scope_id IS NULL)
         OR s.scope_id = p_scope_id
       )

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 2 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE p_scope_type = 'source'
       AND s.category = p_category
       AND s.scope_type = 'sender'
       AND v_sender_id IS NOT NULL
       AND s.scope_id = v_sender_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 3 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE p_scope_type IN ('source','sender')
       AND s.category = p_category
       AND s.scope_type = 'client'
       AND v_client_id IS NOT NULL
       AND s.scope_id = v_client_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 4 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE p_scope_type IN ('source','sender','client')
       AND s.category = p_category
       AND s.scope_type = 'tenant'
       AND v_org_id IS NOT NULL
       AND s.scope_id = v_org_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 5 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = p_category
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ) ranked
  ORDER BY ranked.priority, ranked.id
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  -- Missing: apply safe_missing_behavior for registered categories (SSOT).
  IF v_safe_missing IS NULL OR v_safe_missing = 'return_null' THEN
    RETURN;
  END IF;

  -- Attempt to record provenance for missing settings (non-blocking).
  IF p_scope_type = 'tenant' THEN
    v_log_org_id := p_scope_id;
  ELSIF p_scope_type = 'client' THEN
    SELECT organization_id INTO v_log_org_id FROM public.clients WHERE id = p_scope_id;
  ELSIF p_scope_type = 'sender' THEN
    SELECT c.organization_id
      INTO v_log_org_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = p_scope_id;
  ELSIF p_scope_type = 'source' THEN
    SELECT organization_id INTO v_log_org_id FROM public.webhook_sources WHERE id = p_scope_id;
  ELSIF p_scope_type = 'resource' THEN
    SELECT organization_id INTO v_log_org_id FROM public.providers WHERE id = p_scope_id;
  END IF;

  IF v_log_org_id IS NOT NULL THEN
    BEGIN
      PERFORM public.log_settings_resolution(
        p_organization_id := v_log_org_id,
        p_category := p_category,
        p_winning_scope_type := 'missing',
        p_winning_scope_id := NULL,
        p_winning_settings_id := NULL,
        p_winning_settings_version_id := NULL,
        p_winning_version := NULL,
        p_scope_path := v_scope_path,
        p_inputs := jsonb_build_object(
          'requested_scope_type', p_scope_type,
          'requested_scope_id', p_scope_id,
          'safe_missing_behavior', v_safe_missing
        ),
        p_merge_notes := NULL
      );
    EXCEPTION
      WHEN others THEN
        NULL;
    END;
  END IF;

  IF v_safe_missing = 'hard_fail' THEN
    RAISE EXCEPTION 'Missing required settings for category: %', p_category USING ERRCODE = '23514';
  END IF;

  RETURN;
END;
$$;

COMMIT;

