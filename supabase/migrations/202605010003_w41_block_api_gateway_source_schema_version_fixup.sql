-- Spec-Issue: W41 closure of W40 local-Supabase E2E findings (F3)
-- Step: W41-F3
-- Migration: schema_version type-cast fixup for
--   202604280330_block_api_gateway_source_v1
--
-- W40 finding (P1):
--   docs/ops/evidence/2026-04-30/local-verify/migrate-soft.log
--     HARD-FAIL 202604280330_block_api_gateway_source_v1.sql:
--       column "schema_version" is of type integer but expression is of type text
--
-- Root cause:
--   The block_api_gateway_source_v1 migration declares a local variable
--     v_schema_version TEXT
--   and reads it from settings_versions (where schema_version is INTEGER),
--   then later issues
--     UPDATE public.settings_versions
--        SET schema_version = COALESCE(v_schema_version, '1')
--   which casts a TEXT default ('1') into the INTEGER column. This raises
--   SQLSTATE 42804 on a fresh DB and aborts the entire migration before
--   block_api_gateway_source_v1 RPC and its lookup seeds get created.
--
--   The migration also mutates an existing settings_versions row in place
--   (instead of retire-then-insert), which would later collide with the
--   unique current-row index. The W41 F3 fixup uses the CANONICAL pattern:
--   retire prior active access_control_policy row, then insert a new
--   approved version with api_gateway.read/write capabilities, plus seed
--   the missing decision_category lookups, plus declare the canonical
--   block_api_gateway_source_v1 RPC.
--
-- Append-only: this migration creates new objects only. It does NOT edit
-- any historical migration file.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605010003_w41_block_api_gateway_source_schema_version_fixup'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Lookup category seeds: api_gateway_source_lifecycle decision_category +
--    blocked / unblocked decision_outcomes (idempotent)
-- ---------------------------------------------------------------------------

DO $w41_f3_lookups$
DECLARE
  v_decision_category_def UUID;
  v_decision_outcome_def UUID;
BEGIN
  SELECT id INTO v_decision_category_def
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1;

  IF v_decision_category_def IS NULL THEN
    RAISE WARNING 'W41 F3: decision_category lookup_definition missing; skipping api_gateway_source_lifecycle seed';
  ELSE
    INSERT INTO public.lookup_values (lookup_definition_id, value, label, status, sort_order)
    VALUES (
      v_decision_category_def,
      'api_gateway_source_lifecycle',
      'API gateway source lifecycle (block/unblock)',
      'active',
      1020
    )
    ON CONFLICT (lookup_definition_id, value) DO NOTHING;
  END IF;

  SELECT id INTO v_decision_outcome_def
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1;

  IF v_decision_outcome_def IS NULL THEN
    RAISE WARNING 'W41 F3: decision_outcome lookup_definition missing; skipping blocked/unblocked seed';
  ELSE
    INSERT INTO public.lookup_values (lookup_definition_id, value, label, status, sort_order)
    VALUES
      (v_decision_outcome_def, 'blocked', 'Blocked', 'active', 2020),
      (v_decision_outcome_def, 'unblocked', 'Unblocked', 'active', 2021)
    ON CONFLICT (lookup_definition_id, value) DO NOTHING;
  END IF;
END
$w41_f3_lookups$;

-- ---------------------------------------------------------------------------
-- 2) Register api_gateway.read + api_gateway.write capabilities using the
--    CANONICAL retire-then-insert pattern (matches W41 F1 closure of B1
--    capability registry).
-- ---------------------------------------------------------------------------

DO $w41_f3_caps$
DECLARE
  v_existing_active RECORD;
  v_current JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_keys JSONB;
  v_target_caps JSONB := jsonb_build_array(
    jsonb_build_object('key', 'api_gateway.read',  'label', 'API gateway read',  'category', 'observability'),
    jsonb_build_object('key', 'api_gateway.write', 'label', 'API gateway write', 'category', 'observability')
  );
  v_cap JSONB;
  v_changed BOOLEAN := FALSE;
  v_next_version INT;
  v_sv_id UUID := gen_random_uuid();
  v_target_keys TEXT[] := ARRAY['api_gateway.read', 'api_gateway.write'];
  v_new_cap TEXT;
  v_role_idx INT;
BEGIN
  SELECT id, value, scope_hash
    INTO v_existing_active
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
     AND approved_at IS NOT NULL
     AND effective_until IS NULL
   ORDER BY version DESC
   LIMIT 1;

  IF v_existing_active.id IS NULL THEN
    RAISE NOTICE 'W41 F3: no active access_control_policy row; skipping capability registration';
    RETURN;
  END IF;

  v_current := v_existing_active.value;

  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  FOR v_cap IN SELECT * FROM jsonb_array_elements(v_target_caps) LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_caps) AS item
       WHERE item->>'key' = v_cap->>'key'
    ) THEN
      v_caps := v_caps || jsonb_build_array(v_cap);
      v_changed := TRUE;
    END IF;
  END LOOP;

  IF NOT v_changed THEN
    RAISE NOTICE 'W41 F3: api_gateway.read/write already registered; no-op';
    RETURN;
  END IF;

  -- Append target caps to ops_admin role's capability_keys (idempotent).
  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);
  FOR v_role_idx IN 0 .. jsonb_array_length(v_roles) - 1 LOOP
    v_role := v_roles->v_role_idx;
    IF v_role->>'key' = 'ops_admin' THEN
      v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      FOREACH v_new_cap IN ARRAY v_target_keys LOOP
        IF NOT (v_role_keys @> to_jsonb(v_new_cap)) THEN
          v_role_keys := v_role_keys || to_jsonb(v_new_cap);
        END IF;
      END LOOP;
      v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys);
      v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps);
  v_current := jsonb_set(v_current, '{roles}', v_roles);

  -- Retire prior active row BEFORE inserting (canonical pattern).
  UPDATE public.settings_versions
     SET effective_until = now()
   WHERE id = v_existing_active.id;

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  INSERT INTO public.settings_versions (
    id, category, scope_type, scope_id, scope_hash, version,
    value, schema_version, change_reason, approved_at, effective_from
  ) VALUES (
    v_sv_id,
    'access_control_policy',
    'global',
    NULL::uuid,
    COALESCE(v_existing_active.scope_hash, '00000000-0000-0000-0000-000000000000'::uuid),
    v_next_version,
    v_current,
    1, -- canonical INTEGER (W41 F3: prior migration cast TEXT here, raising 42804)
    'W41 F3 fixup: B5 register api_gateway.read/write capabilities (retire-then-insert)',
    now(),
    now()
  );

  -- Refresh settings cache row. Use explicit UPDATE-then-INSERT instead of
  -- ON CONFLICT to honor BOTH unique constraints
  -- (category, scope_type, scope_id) AND (category, scope_type, scope_hash).
  UPDATE public.settings
     SET settings_version_id = v_sv_id,
         cached_value = v_current,
         last_updated = now()
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  IF NOT FOUND THEN
    INSERT INTO public.settings (
      category, scope_type, scope_id, scope_hash,
      settings_version_id, cached_value, last_updated
    ) VALUES (
      'access_control_policy', 'global', NULL,
      COALESCE(v_existing_active.scope_hash, '00000000-0000-0000-0000-000000000000'::uuid),
      v_sv_id, v_current, now()
    );
  END IF;

  RAISE NOTICE 'W41 F3: registered api_gateway.read/write at access_control_policy v%', v_next_version;
END
$w41_f3_caps$;

-- ---------------------------------------------------------------------------
-- 3) block_api_gateway_source_v1 RPC (idempotent recreation; same body as
--    historical migration).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.block_api_gateway_source_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org_id UUID := public.current_user_org_id();
  v_source_id_text TEXT := NULLIF(btrim(COALESCE(p_args->>'source_id', '')), '');
  v_source_id UUID;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_source public.webhook_sources%ROWTYPE;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_metadata_input JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'block_api_gateway_source_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('api_gateway.write', 'tenant', v_caller_org_id);

  IF v_source_id_text IS NULL THEN
    RAISE EXCEPTION 'block_api_gateway_source_v1 requires source_id' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_source_id := v_source_id_text::UUID;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'block_api_gateway_source_v1 invalid source_id %', v_source_id_text USING ERRCODE = '22023';
  END;

  SELECT * INTO v_source FROM public.webhook_sources s WHERE s.id = v_source_id FOR UPDATE;

  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'block_api_gateway_source_v1 source % not found', v_source_id USING ERRCODE = '23503';
  END IF;

  IF NOT public.is_platform_user() AND v_source.organization_id <> v_caller_org_id THEN
    RAISE EXCEPTION 'block_api_gateway_source_v1 source % is outside current tenant scope', v_source_id
      USING ERRCODE = '42501';
  END IF;

  IF v_source.enabled = FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'source_id', v_source.id,
      'enabled', FALSE,
      'already_processed', TRUE,
      'correlation_id', NULL
    );
  END IF;

  UPDATE public.webhook_sources
     SET enabled = FALSE,
         updated_at = now()
   WHERE id = v_source.id;

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, correlation_id, payload
  )
  VALUES (
    v_source.organization_id,
    'api_gateway.source.blocked',
    'webhook_source',
    v_source.id,
    v_correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'source_id', v_source.id,
      'organization_id', v_source.organization_id,
      'source_identifier', v_source.source_identifier,
      'blocked_by_user_id', v_user_id,
      'reason', v_reason,
      'metadata', v_metadata_input
    ))
  );

  v_decision_log_id := public.log_decision(
    p_organization_id := v_source.organization_id,
    p_decision_category := 'api_gateway_source_lifecycle',
    p_resource_type := 'webhook_source',
    p_resource_id := v_source.id,
    p_decision_point := 'api_gateway.source.block',
    p_decision_outcome := 'blocked',
    p_performed_by_system := 'block_api_gateway_source_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'source_id', v_source.id,
      'previous_enabled', TRUE,
      'reason', v_reason,
      'metadata', v_metadata_input
    )),
    p_decision_reason := COALESCE(v_reason, 'api_gateway_source_block_no_reason')
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'source_id', v_source.id,
    'enabled', FALSE,
    'already_processed', FALSE,
    'correlation_id', v_correlation_id,
    'decision_log_id', v_decision_log_id
  );
END;
$function$;

COMMENT ON FUNCTION public.block_api_gateway_source_v1(JSONB) IS
  'Phase B (B5) canonical write RPC: block an API gateway source (webhook_sources.enabled=FALSE) with audit trail. Capability: api_gateway.write. Idempotent. (W41 F3 declared after settings registration fixup.)';

REVOKE ALL ON FUNCTION public.block_api_gateway_source_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.block_api_gateway_source_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605010003_w41_block_api_gateway_source_schema_version_fixup'));

COMMIT;
