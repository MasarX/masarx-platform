-- Migration: Default tenant scope_id to current org when omitted
BEGIN;
SELECT pg_advisory_lock(hashtext('202601090846_settings_scope_tenant_default'));
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
    v_scope_id := COALESCE(v_scope_id, public.current_user_org_id());
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

SELECT pg_advisory_unlock(hashtext('202601090846_settings_scope_tenant_default'));
COMMIT;
