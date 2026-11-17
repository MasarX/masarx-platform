-- Migration: Settings provenance resolver + log_decision settings_resolution_id support
-- Purpose:
--   - Provide resolve_settings_row() returning the winning settings row + version across the ladder
--   - Extend log_decision() to optionally link decision_log.settings_resolution_id
-- Date: 2025-12-14

BEGIN;

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
BEGIN
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RETURN;
  END IF;

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
END;
$$;

COMMENT ON FUNCTION public.resolve_settings_row(TEXT, TEXT, UUID)
  IS 'Resolve a settings row (value + version) via ladder for the provided scope (Global/Tenant/Client/Sender/Source).';

CREATE OR REPLACE FUNCTION public.log_decision(
    p_organization_id UUID,
    p_decision_category TEXT,
    p_resource_type TEXT,
    p_resource_id UUID,
    p_decision_point TEXT,
    p_decision_outcome TEXT,
    p_performed_by_system TEXT,
    p_correlation_id UUID DEFAULT NULL,
    p_decision_inputs JSONB DEFAULT '{}'::jsonb,
    p_decision_reason TEXT DEFAULT NULL,
    p_settings_resolution_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_id UUID := gen_random_uuid();
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'log_decision requires organization_id (received NULL for resource_type=% resource_id=%)', p_resource_type, p_resource_id;
    END IF;

    INSERT INTO public.decision_log (
        id,
        organization_id,
        decision_category,
        resource_type,
        resource_id,
        decision_point,
        decision_outcome,
        decision_inputs,
        decision_reason,
        performed_by_system,
        correlation_id,
        settings_resolution_id,
        timestamp
    ) VALUES (
        v_id,
        p_organization_id,
        p_decision_category,
        p_resource_type,
        p_resource_id,
        p_decision_point,
        p_decision_outcome,
        COALESCE(p_decision_inputs, '{}'::jsonb),
        p_decision_reason,
        p_performed_by_system,
        p_correlation_id,
        p_settings_resolution_id,
        now()
    );

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT, UUID)
  IS 'Canonical helper to insert decision_log rows, optionally linking settings_resolution_log via settings_resolution_id.';

COMMIT;
