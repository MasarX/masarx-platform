-- Migration: MasarX label defaults + brand-neutral template key (waybill_v1)
-- Purpose:
--   - Seed a brand-neutral template_key `waybill_v1` by copying the latest global MasarX template spec (v185) and
--     updating brand-facing fields + asset path to `brand/logo.png`.
--   - Update global renderer_defaults + label_design to target `waybill_v1` while keeping ladder-driven resolution.
-- Notes:
--   - `label_template_specs` is treated as immutable (insert-only). This migration INSERTs a new key instead of UPDATE.
-- Date: 2026-01-18

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Insert global waybill_v1 template spec (copy from masarx_waybill_v1 v185)
-------------------------------------------------------------------------------
DO $$
DECLARE
  v_global CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
  v_src_template_id UUID;
  v_dst_template_id UUID;
  v_src_tpl JSONB;
  v_dst_tpl JSONB;
  v_assets JSONB;
  v_blocks JSONB;
  v_new_assets JSONB;
  v_new_blocks JSONB;
BEGIN
  SELECT id, renderer_config
  INTO v_src_template_id, v_src_tpl
  FROM public.label_template_specs
  WHERE organization_id = v_global
    AND template_key = 'masarx_waybill_v1'
    AND version = 185
  LIMIT 1;

  IF v_src_template_id IS NULL OR v_src_tpl IS NULL THEN
    RAISE EXCEPTION 'Missing global template spec: label_template_specs(organization_id=%, template_key=masarx_waybill_v1, version=185)', v_global;
  END IF;

  SELECT id
  INTO v_dst_template_id
  FROM public.label_template_specs
  WHERE organization_id = v_global
    AND template_key = 'waybill_v1'
    AND version = 185
  LIMIT 1;

  IF v_dst_template_id IS NULL THEN
    v_dst_tpl := v_src_tpl;

    -- Update key + brand-facing metadata (internal key stays brand-neutral)
    v_dst_tpl := jsonb_set(v_dst_tpl, '{template_key}', to_jsonb('waybill_v1'::text), true);
    v_dst_tpl := jsonb_set(v_dst_tpl, '{metadata,brand_name}', to_jsonb('MasarX'::text), true);
    v_dst_tpl := jsonb_set(v_dst_tpl, '{metadata,fallback_title}', to_jsonb('MasarX Waybill'::text), true);
    v_dst_tpl := jsonb_set(
      v_dst_tpl,
      '{metadata,description}',
      to_jsonb('MasarX 4x6 waybill v1.8.5 tuned from Figma SSOT geometry'::text),
      true
    );

    -- Assets: migrate `masarx/*` paths to brand-neutral `brand/*`.
    v_assets := COALESCE(v_dst_tpl->'assets', '[]'::jsonb);
    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN (a ? 'path') AND (a->>'path') ~* '^masarx/'
            THEN jsonb_set(a, '{path}', to_jsonb(regexp_replace(a->>'path', '^masarx/', 'brand/')), true)
          ELSE a
        END
      ),
      '[]'::jsonb
    )
    INTO v_new_assets
    FROM jsonb_array_elements(v_assets) AS a;
    v_dst_tpl := jsonb_set(v_dst_tpl, '{assets}', v_new_assets, true);

    -- Blocks: migrate any brand fallback strings.
    v_blocks := COALESCE(v_dst_tpl->'blocks', '[]'::jsonb);
    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN (b ? 'fallback') AND b->>'fallback' = 'MasarX'
            THEN jsonb_set(b, '{fallback}', to_jsonb('MasarX'::text), true)
          ELSE b
        END
      ),
      '[]'::jsonb
    )
    INTO v_new_blocks
    FROM jsonb_array_elements(v_blocks) AS b;
    v_dst_tpl := jsonb_set(v_dst_tpl, '{blocks}', v_new_blocks, true);

    INSERT INTO public.label_template_specs (
      organization_id,
      template_key,
      version,
      template_scope_type,
      template_scope_id,
      renderer_config,
      asset_refs
    )
    VALUES (
      v_global,
      'waybill_v1',
      185,
      'global',
      NULL,
      v_dst_tpl,
      v_dst_tpl -> 'assets'
    )
    ON CONFLICT (organization_id, template_key, version) DO NOTHING;

    SELECT id
    INTO v_dst_template_id
    FROM public.label_template_specs
    WHERE organization_id = v_global
      AND template_key = 'waybill_v1'
      AND version = 185
    LIMIT 1;
  END IF;

  IF v_dst_template_id IS NULL THEN
    RAISE EXCEPTION 'Failed to create global template spec: label_template_specs(organization_id=%, template_key=waybill_v1, version=185)', v_global;
  END IF;

  -- Copy sections/tokens from the source template_id to the new template_id (designer parity).
  INSERT INTO public.label_sections (
    organization_id,
    template_id,
    section_key,
    x,
    y,
    width,
    height,
    padding_top,
    padding_right,
    padding_bottom,
    padding_left,
    z_index
  )
  SELECT
    v_global,
    v_dst_template_id,
    s.section_key,
    s.x,
    s.y,
    s.width,
    s.height,
    s.padding_top,
    s.padding_right,
    s.padding_bottom,
    s.padding_left,
    s.z_index
  FROM public.label_sections s
  WHERE s.organization_id = v_global
    AND s.template_id = v_src_template_id
  ON CONFLICT (template_id, organization_id, section_key) DO NOTHING;

  INSERT INTO public.label_design_tokens (
    organization_id,
    template_id,
    token_key,
    token_type,
    value
  )
  SELECT
    v_global,
    v_dst_template_id,
    t.token_key,
    t.token_type,
    t.value
  FROM public.label_design_tokens t
  WHERE t.organization_id = v_global
    AND t.template_id = v_src_template_id
  ON CONFLICT (template_id, organization_id, token_key) DO NOTHING;
END $$;

-------------------------------------------------------------------------------
-- 2) Update label_design defaults (global + tenant upgrades) to target waybill_v1
-------------------------------------------------------------------------------
DO $$
DECLARE
  v_global CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
  v_tpl JSONB;
  v_payload JSONB;
  v_schema_version INT;
BEGIN
  SELECT version
  INTO v_schema_version
  FROM public.schema_registry
  WHERE category = 'label_design'
    AND is_active = TRUE
  ORDER BY version DESC
  LIMIT 1;

  IF v_schema_version IS NULL THEN
    RAISE EXCEPTION 'Missing active schema_registry version for label_design';
  END IF;

  SELECT renderer_config
  INTO v_tpl
  FROM public.label_template_specs
  WHERE organization_id = v_global
    AND template_key = 'waybill_v1'
    AND version = 185
  LIMIT 1;

  IF v_tpl IS NULL THEN
    RAISE EXCEPTION 'Missing global template spec: label_template_specs(organization_id=%, template_key=waybill_v1, version=185)', v_global;
  END IF;

  v_payload := jsonb_build_object(
    'version', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD'),
    'templates', jsonb_build_object(
      'shipping', v_tpl
    )
  );

  -- Global default label_design
  WITH upsert_global AS (
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
      approved_at,
      effective_from,
      effective_until
    )
    SELECT
      COALESCE(
        (
          SELECT id
          FROM public.settings_versions
          WHERE category = 'label_design'
            AND scope_type = 'global'
            AND scope_id IS NULL
          ORDER BY approved_at DESC
          LIMIT 1
        ),
        uuid_from_hash('label_design:global:waybill_v1')
      ) AS id,
      'label_design',
      'global',
      NULL,
      v_global,
      COALESCE(
        (
          SELECT max(version) + 1
          FROM public.settings_versions
          WHERE category = 'label_design'
            AND scope_type = 'global'
            AND scope_id IS NULL
        ),
        1
      ) AS version,
      v_payload,
      v_schema_version,
      'Update default label_design to waybill_v1 (MasarX rename)',
      now(),
      now(),
      NULL
    ON CONFLICT (id, scope_hash) DO UPDATE
    SET value = EXCLUDED.value,
        schema_version = EXCLUDED.schema_version,
        change_reason = EXCLUDED.change_reason,
        approved_at = EXCLUDED.approved_at,
        effective_from = EXCLUDED.effective_from,
        effective_until = EXCLUDED.effective_until
    RETURNING id, value
  )
  INSERT INTO public.settings (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  SELECT
    uuid_from_hash('label_design:global:current'),
    'label_design',
    'global',
    NULL,
    v_global,
    upsert_global.id,
    upsert_global.value,
    now()
  FROM upsert_global
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;

  -- Tenant overrides (upgrade only those already using MasarX waybill)
  WITH tenant_targets AS (
    SELECT DISTINCT scope_id
    FROM public.settings
    WHERE category = 'label_design'
      AND scope_type = 'tenant'
      AND (cached_value -> 'templates' -> 'shipping' ->> 'template_key') = 'masarx_waybill_v1'
  ),
  tenant_versions AS (
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
      approved_at,
      effective_from,
      effective_until
    )
    SELECT
      COALESCE(
        (
          SELECT id
          FROM public.settings_versions
          WHERE category = 'label_design'
            AND scope_type = 'tenant'
            AND scope_id = t.scope_id
          ORDER BY approved_at DESC
          LIMIT 1
        ),
        uuid_from_hash(format('label_design:tenant:%s:waybill_v1', t.scope_id))
      ) AS id,
      'label_design',
      'tenant',
      t.scope_id,
      t.scope_id,
      COALESCE(
        (
          SELECT max(version) + 1
          FROM public.settings_versions
          WHERE category = 'label_design'
            AND scope_type = 'tenant'
            AND scope_id = t.scope_id
        ),
        1
      ) AS version,
      v_payload,
      v_schema_version,
      'Tenant label template upgrade to waybill_v1 (MasarX rename)',
      now(),
      now(),
      NULL
    FROM tenant_targets t
    ON CONFLICT (id, scope_hash) DO UPDATE
    SET value = EXCLUDED.value,
        schema_version = EXCLUDED.schema_version,
        change_reason = EXCLUDED.change_reason,
        approved_at = EXCLUDED.approved_at,
        effective_from = EXCLUDED.effective_from,
        effective_until = EXCLUDED.effective_until
    RETURNING id, scope_id, value
  )
  INSERT INTO public.settings (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  SELECT
    uuid_from_hash(format('label_design:tenant:%s:current', t.scope_id)),
    'label_design',
    'tenant',
    t.scope_id,
    t.scope_id,
    t.id,
    t.value,
    now()
  FROM tenant_versions t
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END $$;

-------------------------------------------------------------------------------
-- 3) Update renderer_defaults (global) for MasarX + waybill_v1
-------------------------------------------------------------------------------
DO $$
DECLARE
  v_scope_hash CONSTANT UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_current JSONB;
  v_patched JSONB;
  v_schema_version INT;
BEGIN
  SELECT version
  INTO v_schema_version
  FROM public.schema_registry
  WHERE category = 'renderer_defaults'
    AND is_active = TRUE
  ORDER BY version DESC
  LIMIT 1;

  IF v_schema_version IS NULL THEN
    RAISE EXCEPTION 'Missing active schema_registry version for renderer_defaults';
  END IF;

  UPDATE public.schema_registry
  SET examples = jsonb_build_array(jsonb_build_object(
    'version', 1,
    'fallback_title', 'MasarX Waybill',
    'brand_name', 'MasarX',
    'primary_color', '#2D3F90',
    'template_key', 'waybill_v1'
  ))
  WHERE category = 'renderer_defaults'
    AND version = v_schema_version;

  SELECT id, settings_version_id
  INTO v_settings_id, v_settings_version_id
  FROM public.settings
  WHERE category = 'renderer_defaults'
    AND scope_type = 'global'
    AND scope_hash = v_scope_hash
  LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    SELECT id
    INTO v_settings_version_id
    FROM public.settings_versions
    WHERE category = 'renderer_defaults'
      AND scope_type = 'global'
      AND scope_hash = v_scope_hash
      AND scope_id IS NULL
    ORDER BY approved_at DESC NULLS LAST, effective_from DESC, created_at DESC
    LIMIT 1;
  END IF;

  IF v_settings_version_id IS NULL THEN
    v_settings_version_id := gen_random_uuid();
    v_patched := jsonb_build_object(
      'version', 1,
      'fallback_title', 'MasarX Waybill',
      'brand_name', 'MasarX',
      'primary_color', '#2D3F90',
      'template_key', 'waybill_v1'
    );

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
      approved_at,
      effective_from,
      effective_until
    )
    VALUES (
      v_settings_version_id,
      'renderer_defaults',
      'global',
      NULL,
      v_scope_hash,
      1,
      v_patched,
      v_schema_version,
      'Seed renderer_defaults for MasarX rename (waybill_v1)',
      now(),
      now(),
      NULL
    );
  ELSE
    SELECT value
    INTO v_current
    FROM public.settings_versions
    WHERE id = v_settings_version_id
      AND scope_hash = v_scope_hash;

    v_current := COALESCE(v_current, '{}'::jsonb);
    v_patched := jsonb_strip_nulls(v_current || jsonb_build_object(
      'version', 1,
      'fallback_title', 'MasarX Waybill',
      'brand_name', 'MasarX',
      'template_key', 'waybill_v1',
      'primary_color', COALESCE(v_current->>'primary_color', '#2D3F90')
    ));

    UPDATE public.settings_versions
    SET value = v_patched,
        schema_version = v_schema_version,
        change_reason = 'Update renderer_defaults for MasarX rename (waybill_v1)',
        approved_at = now(),
        effective_from = now(),
        effective_until = NULL
    WHERE id = v_settings_version_id
      AND scope_hash = v_scope_hash;
  END IF;

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    'renderer_defaults',
    'global',
    NULL,
    v_scope_hash,
    v_settings_version_id,
    v_patched,
    now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END $$;

COMMIT;

