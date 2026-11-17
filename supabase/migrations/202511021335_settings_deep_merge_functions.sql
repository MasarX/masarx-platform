-- Migration: Settings Deep Merge Helpers and Merged Resolver
-- Purpose: Provide deep merge (objects) and array merge strategies (replace/append/prepend)
--          and expose resolve_settings_merged() that merges across Globalâ†’Tenantâ†’Clientâ†’Senderâ†’Source.
-- Date: 2025-11-02 13:35 UTC

BEGIN;

-------------------------------------------------------------------------------
-- deep_merge_jsonb(parent, child): object merge + array strategies
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.deep_merge_jsonb(
    p_parent JSONB,
    p_child JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSONB := COALESCE(p_parent, '{}'::jsonb);
  k TEXT;
  v_child JSONB;
  v_parent JSONB;
  strategy TEXT;
BEGIN
  IF p_child IS NULL OR jsonb_typeof(p_child) <> 'object' THEN
    RETURN COALESCE(p_child, result);
  END IF;

  FOR k IN SELECT t.key FROM jsonb_object_keys(p_child) AS t(key) LOOP
    IF right(k, 16) = '__merge_strategy' THEN
      CONTINUE;
    END IF;

    v_child := p_child -> k;
    v_parent := COALESCE(result -> k, 'null'::jsonb);

    IF jsonb_typeof(v_child) = 'object' AND jsonb_typeof(v_parent) = 'object' THEN
      result := result - k || jsonb_build_object(k, public.deep_merge_jsonb(v_parent, v_child));
    ELSIF jsonb_typeof(v_child) = 'array' THEN
      strategy := COALESCE(p_child ->> (k || '__merge_strategy'), 'replace');
      IF jsonb_typeof(v_parent) = 'array' THEN
        IF strategy = 'append' THEN
          result := result - k || jsonb_build_object(k, v_parent || v_child);
        ELSIF strategy = 'prepend' THEN
          result := result - k || jsonb_build_object(k, v_child || v_parent);
        ELSE
          result := result - k || jsonb_build_object(k, v_child);
        END IF;
      ELSE
        result := result - k || jsonb_build_object(k, v_child);
      END IF;
    ELSE
      result := result - k || jsonb_build_object(k, v_child);
    END IF;
  END LOOP;

  RETURN result;
END;
$$;

ALTER FUNCTION public.deep_merge_jsonb(JSONB, JSONB)
  SET search_path = public, extensions, pg_temp;

COMMENT ON FUNCTION public.deep_merge_jsonb(JSONB, JSONB)
  IS 'Deep merge two JSONB objects with array merge strategies via field__merge_strategy (replace|append|prepend).';

-------------------------------------------------------------------------------
-- resolve_settings_merged: merge across ladder
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_settings_merged(
    p_category TEXT,
    p_scope_type TEXT,
    p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_sender_id UUID;
  v_client_id UUID;
  v_org_id UUID;
  v_value JSONB := '{}'::jsonb;
  v_row JSONB;
BEGIN
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RETURN NULL;
  END IF;

  IF p_scope_type IS NULL OR p_scope_type = '' THEN
    p_scope_type := 'global';
  ELSIF p_scope_type = 'organization' THEN
    p_scope_type := 'tenant';
  END IF;

  -- Determine chain
  IF p_scope_type = 'source' THEN
    SELECT sender_id, organization_id INTO v_sender_id, v_org_id FROM public.webhook_sources WHERE id = p_scope_id;
    IF v_sender_id IS NOT NULL THEN SELECT client_id INTO v_client_id FROM public.senders WHERE id = v_sender_id; END IF;
  ELSIF p_scope_type = 'sender' THEN
    v_sender_id := p_scope_id;
    SELECT client_id INTO v_client_id FROM public.senders WHERE id = p_scope_id;
    IF v_client_id IS NOT NULL THEN SELECT organization_id INTO v_org_id FROM public.clients WHERE id = v_client_id; END IF;
  ELSIF p_scope_type = 'client' THEN
    v_client_id := p_scope_id;
    SELECT organization_id INTO v_org_id FROM public.clients WHERE id = p_scope_id;
  ELSIF p_scope_type = 'tenant' THEN
    v_org_id := p_scope_id;
  END IF;

  -- Merge order: global -> tenant -> client -> sender -> source
  -- global
  SELECT cached_value INTO v_row
  FROM public.settings
  WHERE category = p_category AND scope_type = 'global' AND scope_id IS NULL
  ORDER BY last_updated DESC
  LIMIT 1;
  IF v_row IS NOT NULL THEN v_value := public.deep_merge_jsonb(v_value, v_row); END IF;

  IF v_org_id IS NOT NULL THEN
    SELECT cached_value INTO v_row
    FROM public.settings
    WHERE category = p_category AND scope_type = 'tenant' AND scope_id = v_org_id
    ORDER BY last_updated DESC
    LIMIT 1;
    IF v_row IS NOT NULL THEN v_value := public.deep_merge_jsonb(v_value, v_row); END IF;
  END IF;

  IF v_client_id IS NOT NULL THEN
    SELECT cached_value INTO v_row
    FROM public.settings
    WHERE category = p_category AND scope_type = 'client' AND scope_id = v_client_id
    ORDER BY last_updated DESC
    LIMIT 1;
    IF v_row IS NOT NULL THEN v_value := public.deep_merge_jsonb(v_value, v_row); END IF;
  END IF;

  IF v_sender_id IS NOT NULL THEN
    SELECT cached_value INTO v_row
    FROM public.settings
    WHERE category = p_category AND scope_type = 'sender' AND scope_id = v_sender_id
    ORDER BY last_updated DESC
    LIMIT 1;
    IF v_row IS NOT NULL THEN v_value := public.deep_merge_jsonb(v_value, v_row); END IF;
  END IF;

  IF p_scope_type = 'source' AND p_scope_id IS NOT NULL THEN
    SELECT cached_value INTO v_row
    FROM public.settings
    WHERE category = p_category AND scope_type = 'source' AND scope_id = p_scope_id
    ORDER BY last_updated DESC
    LIMIT 1;
    IF v_row IS NOT NULL THEN v_value := public.deep_merge_jsonb(v_value, v_row); END IF;
  END IF;

  RETURN v_value;
END;
$$;

ALTER FUNCTION public.resolve_settings_merged(TEXT, TEXT, UUID)
  SET search_path = public, extensions, pg_temp;

COMMENT ON FUNCTION public.resolve_settings_merged(TEXT, TEXT, UUID)
  IS 'Resolve settings by merging across ladder (Globalâ†’Tenantâ†’Clientâ†’Senderâ†’Source) with deep/array merge strategies.';

COMMIT;

