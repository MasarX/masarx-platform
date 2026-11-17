-- Migration: MasarX waybill template v1.8.5 (185)
-- Purpose: Seed MasarX system default (v1.8.5) into global and tenant label_design settings.
-- Notes:
--   - Uses the global template catalog (label_template_specs) as SSOT for the compiled renderer_config.
--   - Keeps schema_version = 2 and updates only MasarX template rows (scope tenant/global).

BEGIN;

SET search_path TO public, pg_temp;

DO $$
DECLARE
  v_global CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
  v_tpl JSONB;
  v_payload JSONB;
BEGIN
  SELECT renderer_config
  INTO v_tpl
  FROM label_template_specs
  WHERE organization_id = v_global
    AND template_key = 'masarx_waybill_v1'
    AND version = 185
  LIMIT 1;

  IF v_tpl IS NULL THEN
    RAISE EXCEPTION 'Missing global template spec: label_template_specs(organization_id=%, template_key=masarx_waybill_v1, version=185)', v_global;
  END IF;

  v_payload := jsonb_build_object(
    'version', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD'),
    'templates', jsonb_build_object(
      'shipping', v_tpl
    )
  );

  -- Global default label_design
  WITH upsert_global AS (
    INSERT INTO settings_versions (
      id, category, scope_type, scope_id, scope_hash, version, value, schema_version,
      change_reason, approved_at, effective_from, effective_until
    )
    SELECT
      COALESCE(
        (
          SELECT id
          FROM settings_versions
          WHERE category = 'label_design'
            AND scope_type = 'global'
            AND scope_id IS NULL
          ORDER BY approved_at DESC
          LIMIT 1
        ),
        uuid_from_hash('label_design:global:masarx_waybill_v1')
      ) AS id,
      'label_design',
      'global',
      NULL,
      v_global,
      COALESCE(
        (
          SELECT max(version) + 1
          FROM settings_versions
          WHERE category = 'label_design'
            AND scope_type = 'global'
            AND scope_id IS NULL
        ),
        1
      ) AS version,
      v_payload,
      2,
      'Update MasarX waybill to v1.8.5 (185) (Figma SSOT)',
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
  INSERT INTO settings (
    id, category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated
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
    FROM settings
    WHERE category = 'label_design'
      AND scope_type = 'tenant'
      AND (cached_value -> 'templates' -> 'shipping' ->> 'template_key') = 'masarx_waybill_v1'
  ),
  tenant_versions AS (
    INSERT INTO settings_versions (
      id, category, scope_type, scope_id, scope_hash, version, value, schema_version,
      change_reason, approved_at, effective_from, effective_until
    )
    SELECT
      COALESCE(
        (
          SELECT id
          FROM settings_versions
          WHERE category = 'label_design'
            AND scope_type = 'tenant'
            AND scope_id = t.scope_id
          ORDER BY approved_at DESC
          LIMIT 1
        ),
        uuid_from_hash(format('label_design:tenant:%s:masarx_waybill_v1', t.scope_id))
      ) AS id,
      'label_design',
      'tenant',
      t.scope_id,
      t.scope_id,
      COALESCE(
        (
          SELECT max(version) + 1
          FROM settings_versions
          WHERE category = 'label_design'
            AND scope_type = 'tenant'
            AND scope_id = t.scope_id
        ),
        1
      ) AS version,
      v_payload,
      2,
      'Tenant label template upgrade to MasarX waybill v1.8.5 (185)',
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
  INSERT INTO settings (
    id, category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated
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

COMMIT;

