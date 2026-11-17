-- Plan: PLAN-202601-ladder-phase6-remaining-ladder-hardcoding-ssot / Step: S04
-- Migration: Settings upsert SSOT helpers (no scope hardcoding)
--
-- Purpose:
--   - Introduce a generic, SECURITY DEFINER settings write helper to eliminate
--     bespoke category-specific upsert duplication.
--   - Refactor legacy policy upsert helpers to delegate to the generic helper.
--   - Enforce scope validation via scope registries (no hardcoded scope lists).
--
-- Notes:
--   - Depends on ladder SSOT tables: scope_type_registry + scope_type_aliases.
--   - Does not change read-side resolution; uses existing resolve_settings_merged.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Generic settings upsert helper (value is fully specified by caller).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_settings_value_v1(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_value JSONB,
  p_schema_version INT,
  p_change_reason TEXT
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  settings_version_number INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_category TEXT := NULLIF(TRIM(p_category), '');
  v_scope_type TEXT;
  v_scope_id UUID := p_scope_id;
  v_entity_table REGCLASS;
  v_root TEXT := public.get_root_scope_type_key_v1();
  v_allowed_scopes JSONB;
  v_existing settings%ROWTYPE;
  v_next_version INT;
  v_sv_id UUID := gen_random_uuid();
BEGIN
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires category';
  END IF;
  IF NULLIF(TRIM(p_scope_type), '') IS NULL THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires scope_type';
  END IF;
  IF p_value IS NULL THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires value';
  END IF;
  IF p_schema_version IS NULL OR p_schema_version < 1 THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires schema_version >= 1';
  END IF;

  v_scope_type := public.normalize_scope_type_v1(p_scope_type, FALSE);
  SELECT r.entity_table
    INTO v_entity_table
    FROM public.scope_type_registry r
   WHERE r.scope_type = v_scope_type
     AND r.is_enabled = TRUE
   LIMIT 1;

  -- Validate scope_id requiredness (entity_table NULL => id-less scope).
  IF v_scope_type = v_root OR v_entity_table IS NULL THEN
    IF v_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'upsert_settings_value_v1 scope_type=% requires NULL scope_id', v_scope_type;
    END IF;
  ELSE
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'upsert_settings_value_v1 scope_type=% requires non-NULL scope_id', v_scope_type;
    END IF;
  END IF;

  -- Category governance (optional): restrict which scopes may exist for a category.
  SELECT scr.allowed_scopes
    INTO v_allowed_scopes
    FROM public.settings_category_registry scr
   WHERE scr.category = v_category
   LIMIT 1;

  IF v_allowed_scopes IS NOT NULL AND jsonb_typeof(v_allowed_scopes) = 'array' THEN
    IF NOT (v_allowed_scopes ? v_scope_type) THEN
      RAISE EXCEPTION 'Scope "%" is not allowed for category "%"', v_scope_type, v_category
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Close the previous current row for this category/scope (append-only settings_versions).
  UPDATE public.settings_versions
     SET effective_until = clock_timestamp()
   WHERE category = v_category
     AND scope_type = v_scope_type
     AND (scope_id IS NOT DISTINCT FROM v_scope_id)
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  -- Compute next version number for this category/scope.
  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = v_category
     AND scope_type = v_scope_type
     AND (scope_id IS NOT DISTINCT FROM v_scope_id);

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  ) VALUES (
    v_sv_id,
    v_category,
    v_scope_type,
    v_scope_id,
    v_next_version,
    p_value,
    p_schema_version,
    COALESCE(NULLIF(TRIM(p_change_reason), ''), 'upsert via upsert_settings_value_v1'),
    clock_timestamp(),
    clock_timestamp()
  );

  SELECT *
    INTO v_existing
    FROM public.settings s
   WHERE s.category = v_category
     AND s.scope_type = v_scope_type
     AND (s.scope_id IS NOT DISTINCT FROM v_scope_id)
   LIMIT 1;

  IF v_existing.id IS NULL THEN
    settings_id := gen_random_uuid();
    INSERT INTO public.settings (
      id,
      category,
      scope_type,
      scope_id,
      settings_version_id,
      cached_value,
      last_updated
    ) VALUES (
      settings_id,
      v_category,
      v_scope_type,
      v_scope_id,
      v_sv_id,
      p_value,
      clock_timestamp()
    );
  ELSE
    settings_id := v_existing.id;
    UPDATE public.settings
       SET settings_version_id = v_sv_id,
           cached_value = p_value,
           last_updated = clock_timestamp()
     WHERE id = v_existing.id;
  END IF;

  settings_version_id := v_sv_id;
  settings_version_number := v_next_version;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_settings_value_v1(TEXT, TEXT, UUID, JSONB, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_settings_value_v1(TEXT, TEXT, UUID, JSONB, INT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- webhook_ingest_policy upsert: keep the public signature but delegate writes
-- to upsert_settings_value_v1, avoiding hardcoded scope ladders.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_webhook_ingest_policy(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_policy JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_root TEXT := public.get_root_scope_type_key_v1();
  v_scope_type TEXT;
  v_scope_id UUID := p_scope_id;
  v_entity_table REGCLASS;
  v_schema_version INT;
  v_base JSONB;
  v_policy_patch JSONB;
  v_policy JSONB;
  v_validation JSONB;
  v_idempotency JSONB;
  v_hmac JSONB;
  v_result RECORD;
BEGIN
  IF NULLIF(TRIM(p_scope_type), '') IS NULL THEN
    RAISE EXCEPTION 'upsert_webhook_ingest_policy requires scope_type';
  END IF;

  v_scope_type := public.normalize_scope_type_v1(p_scope_type, FALSE);
  SELECT r.entity_table
    INTO v_entity_table
    FROM public.scope_type_registry r
   WHERE r.scope_type = v_scope_type
     AND r.is_enabled = TRUE
   LIMIT 1;

  -- Validate scope_id requiredness (entity_table NULL => id-less scope).
  IF v_scope_type = v_root OR v_entity_table IS NULL THEN
    IF v_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'upsert_webhook_ingest_policy scope_type=% requires NULL scope_id', v_scope_type;
    END IF;
  ELSE
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'upsert_webhook_ingest_policy scope_type=% requires non-NULL scope_id', v_scope_type;
    END IF;
  END IF;

  SELECT version
    INTO v_schema_version
    FROM public.schema_registry
   WHERE category = 'webhook_ingest_policy'
     AND is_active = TRUE
   ORDER BY version DESC
   LIMIT 1;

  IF v_schema_version IS NULL THEN
    RAISE EXCEPTION 'schema_registry missing active schema for webhook_ingest_policy';
  END IF;

  -- Prefer the currently-resolved policy as a base so required defaults (e.g. ack)
  -- are sourced from configuration, not hardcoded here.
  v_base := COALESCE(public.resolve_settings_merged('webhook_ingest_policy', v_scope_type, v_scope_id), '{}'::jsonb);

  -- Normalize incoming policy patch:
  --  - Strip legacy top-level "response" key (ack lives under "ack").
  --  - Strip unknown validation keys to match the canonical schema.
  v_policy_patch := jsonb_strip_nulls(COALESCE(p_policy, '{}'::jsonb) - 'response');

  IF v_policy_patch ? 'validation' THEN
    v_validation := v_policy_patch->'validation';
    v_idempotency := v_validation->'idempotency';
    v_hmac := v_validation->'hmac';

    v_validation := jsonb_strip_nulls(jsonb_build_object(
      'idempotency', CASE
        WHEN jsonb_typeof(v_idempotency) <> 'object' THEN NULL
        ELSE jsonb_strip_nulls(jsonb_build_object(
          'header', v_idempotency->'header',
          'body_path', v_idempotency->'body_path',
          'dedupe_window_seconds', v_idempotency->'dedupe_window_seconds'
        ))
      END,
      'hmac', CASE
        WHEN jsonb_typeof(v_hmac) <> 'object' THEN NULL
        ELSE jsonb_strip_nulls(jsonb_build_object(
          'enabled', v_hmac->'enabled',
          'algorithm', v_hmac->'algorithm',
          'header', v_hmac->'header',
          'auth_config_id', v_hmac->'auth_config_id',
          'timestamp_header', v_hmac->'timestamp_header',
          'tolerance_seconds', v_hmac->'tolerance_seconds',
          'signature_encoding', v_hmac->'signature_encoding'
        ))
      END,
      'json_schema_id', v_validation->'json_schema_id'
    ));

    IF v_validation IS NULL OR v_validation = '{}'::jsonb THEN
      v_policy_patch := v_policy_patch - 'validation';
    ELSE
      v_policy_patch := jsonb_set(v_policy_patch, '{validation}', v_validation, TRUE);
    END IF;
  END IF;

  v_policy := public.deep_merge_jsonb(v_base, v_policy_patch);

  -- Required fields must come from configuration (base) or from the patch.
  IF NOT (v_policy ? 'version') THEN
    RAISE EXCEPTION 'webhook_ingest_policy missing required key: version (seed defaults or include it in patch)';
  END IF;
  IF NOT (v_policy ? 'ack') OR jsonb_typeof(v_policy->'ack') <> 'object' OR NOT ((v_policy->'ack') ? 'mode') THEN
    RAISE EXCEPTION 'webhook_ingest_policy missing required ack.mode (seed defaults or include it in patch)';
  END IF;

  SELECT *
    INTO v_result
    FROM public.upsert_settings_value_v1(
      p_category := 'webhook_ingest_policy',
      p_scope_type := v_scope_type,
      p_scope_id := v_scope_id,
      p_value := v_policy,
      p_schema_version := v_schema_version,
      p_change_reason := format('upsert webhook_ingest_policy (%s)', v_scope_type)
    );

  RETURN v_result.settings_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_webhook_ingest_policy(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_webhook_ingest_policy(TEXT, UUID, JSONB) TO service_role;

-- -----------------------------------------------------------------------------
-- Domain-event policy helper: keep signature for compatibility, but delegate.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_tenant_domain_event_policy(
  p_organization_id UUID,
  p_events JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_events JSONB;
  v_value JSONB;
  v_schema_version INT;
  v_tenant_scope_type TEXT;
  v_result RECORD;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id required';
  END IF;

  SELECT version
    INTO v_schema_version
    FROM public.schema_registry
   WHERE category = 'domain_event_policy'
     AND is_active = TRUE
   ORDER BY version DESC
   LIMIT 1;

  IF v_schema_version IS NULL THEN
    RAISE EXCEPTION 'schema_registry missing active schema for domain_event_policy';
  END IF;

  v_events := CASE
    WHEN p_events ? 'events' THEN p_events->'events'
    ELSE COALESCE(p_events, '{}'::jsonb)
  END;
  v_value := jsonb_build_object('events', v_events);

  SELECT r.scope_type
    INTO v_tenant_scope_type
    FROM public.scope_type_registry r
   WHERE r.entity_table = 'organizations'::regclass
     AND r.is_enabled = TRUE
   ORDER BY COALESCE(r.ladder_rank, 0) ASC, r.scope_type ASC
   LIMIT 1;

  IF v_tenant_scope_type IS NULL THEN
    RAISE EXCEPTION 'scope_type_registry missing active tenant scope_type' USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_result
    FROM public.upsert_settings_value_v1(
      p_category := 'domain_event_policy',
      p_scope_type := v_tenant_scope_type,
      p_scope_id := p_organization_id,
      p_value := v_value,
      p_schema_version := v_schema_version,
      p_change_reason := 'upsert tenant domain_event_policy'
    );

  RETURN v_result.settings_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_tenant_domain_event_policy(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_tenant_domain_event_policy(UUID, JSONB) TO service_role;

COMMIT;
