-- Migration: Settings scope context helper (settings requests + UI previews)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601061100_settings_scope_context_helper'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_settings_scope_context_v1(
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
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), 'global'));
  v_scope_id UUID := p_scope_id;
  v_org_id UUID;
  v_client_id UUID;
  v_sender_id UUID;
BEGIN
  IF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_scope_type IN ('global', 'resource') AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'resolve_settings_scope_context_v1 scope_type=% requires platform user', v_scope_type
      USING ERRCODE = '42501';
  END IF;

  IF v_scope_type = 'global' THEN
    IF v_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'global scope must not include scope_id';
    END IF;
    v_org_id := public.current_user_org_id();
  ELSIF v_scope_type = 'tenant' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'tenant scope requires scope_id';
    END IF;
    v_org_id := v_scope_id;
  ELSIF v_scope_type = 'client' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'client scope requires scope_id';
    END IF;
    v_client_id := v_scope_id;
    SELECT c.organization_id INTO v_org_id FROM public.clients c WHERE c.id = v_scope_id;
  ELSIF v_scope_type = 'sender' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'sender scope requires scope_id';
    END IF;
    v_sender_id := v_scope_id;
    SELECT c.organization_id, s.client_id
      INTO v_org_id, v_client_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_scope_id;
  ELSIF v_scope_type = 'source' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'source scope requires scope_id';
    END IF;
    SELECT ws.organization_id, ws.sender_id
      INTO v_org_id, v_sender_id
      FROM public.webhook_sources ws
     WHERE ws.id = v_scope_id;
    IF v_sender_id IS NOT NULL THEN
      SELECT s.client_id INTO v_client_id FROM public.senders s WHERE s.id = v_sender_id;
    END IF;
  ELSIF v_scope_type = 'resource' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'resource scope requires scope_id';
    END IF;
    v_org_id := public.current_user_org_id();
  ELSE
    RAISE EXCEPTION 'Unsupported scope_type %', p_scope_type USING ERRCODE = '23514';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'resolve_settings_scope_context_v1 could not resolve organization_id for scope %/%', v_scope_type, v_scope_id;
  END IF;

  IF NOT public.is_platform_user() AND v_org_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'resolve_settings_scope_context_v1 cannot target another organization'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT v_scope_type, v_scope_id, v_org_id, v_client_id, v_sender_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_settings_change_v1(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_value JSONB,
  p_change_reason TEXT DEFAULT NULL,
  p_effective_from TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
  settings_version_id UUID,
  domain_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_scope_hash UUID;
  v_next_version INT;
  v_schema_version INT;
  v_org_id UUID;
  v_client_id UUID;
  v_sender_id UUID;
  v_request_capability TEXT;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'request_settings_change_v1 requires an authenticated user';
  END IF;

  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RAISE EXCEPTION 'request_settings_change_v1 requires category';
  END IF;
  IF p_value IS NULL THEN
    RAISE EXCEPTION 'request_settings_change_v1 requires value';
  END IF;

  SELECT scope_type, scope_id, organization_id, client_id, sender_id
    INTO v_scope_type, v_scope_id, v_org_id, v_client_id, v_sender_id
    FROM public.resolve_settings_scope_context_v1(p_scope_type, p_scope_id)
    LIMIT 1;

  v_scope_hash := COALESCE(v_scope_id, '00000000-0000-0000-0000-000000000000'::uuid);

  SELECT request_capability
    INTO v_request_capability
    FROM public.settings_category_registry
   WHERE category = p_category
   LIMIT 1;

  IF v_request_capability IS NOT NULL AND btrim(v_request_capability) <> '' THEN
    IF NOT public.user_has_capability_v1(v_request_capability, v_scope_type, v_scope_id) THEN
      RAISE EXCEPTION 'request_settings_change_v1 requires capability %', v_request_capability
        USING ERRCODE = '42501';
    END IF;
  ELSIF NOT public.user_can_write() THEN
    RAISE EXCEPTION 'request_settings_change_v1 requires tenant/platform write scope';
  END IF;

  SELECT sr.version INTO v_schema_version
    FROM public.schema_registry sr
   WHERE sr.category = p_category
     AND sr.is_active = TRUE
   ORDER BY sr.version DESC
   LIMIT 1;

  IF v_schema_version IS NULL THEN
    RAISE EXCEPTION 'schema_registry missing active entry for category=%', p_category;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(format('settings_versions:%s:%s:%s', p_category, v_scope_type, v_scope_hash::text)));

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions sv
   WHERE sv.category = p_category
     AND sv.scope_type = v_scope_type
     AND sv.scope_hash = v_scope_hash;

  settings_version_id := gen_random_uuid();

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    requested_by,
    approved_by,
    approved_at,
    effective_from,
    effective_until
  ) VALUES (
    settings_version_id,
    p_category,
    v_scope_type,
    v_scope_id,
    v_scope_hash,
    v_next_version,
    p_value,
    v_schema_version,
    COALESCE(p_change_reason, 'requested via request_settings_change_v1'),
    v_user_id,
    NULL,
    NULL,
    COALESCE(p_effective_from, now()),
    NULL
  );

  domain_event_id := public.enqueue_domain_event(
    p_organization_id := v_org_id,
    p_event_type := 'settings_change.requested',
    p_resource_type := 'settings_version',
    p_resource_id := settings_version_id,
    p_payload := jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'settings_version_id', settings_version_id,
      'category', p_category,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'reason', p_change_reason
    )),
    p_correlation_id := NULL
  );

  PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'settings',
      p_resource_type := 'settings_version',
      p_resource_id := settings_version_id,
      p_decision_point := 'request',
      p_decision_outcome := 'enqueued',
      p_performed_by_system := 'request_settings_change_v1',
      p_correlation_id := domain_event_id,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'category', p_category,
        'scope_type', v_scope_type,
        'scope_id', v_scope_id,
        'workflow_event_type', 'settings_change.requested'
      )),
      p_decision_reason := p_change_reason
  );

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.request_settings_change_v1(TEXT, TEXT, UUID, JSONB, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_settings_change_v1(TEXT, TEXT, UUID, JSONB, TEXT, TIMESTAMPTZ) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601061100_settings_scope_context_helper'));
COMMIT;
