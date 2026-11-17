#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { compileWaybillSpec, loadInputs } = require('./waybill-spec-compiler');

const argv = process.argv.slice(2);

const parseArgs = (list) => {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = list[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
};

const escapeSqlString = (s) => String(s).replace(/'/g, "''");

const toValuesSql = (rows, cols) => rows.map((r) => {
  const vals = cols.map((c) => {
    const v = r[c];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return v.toString();
    return `'${escapeSqlString(v)}'`;
  });
  return `(${vals.join(', ')})`;
}).join(',\n    ');

const buildMigrationSql = (compiled, mapping, opts = {}) => {
  const key = compiled.template_key;
  const version = compiled.version;
  const rc = compiled.renderer_config;
  const payload = {
    version: new Date().toISOString().slice(0, 10),
    templates: {
      [rc.label_type || 'shipping']: rc,
    },
  };

  const sectionRows = compiled.sections || [];
  const tokenRows = compiled.tokens || [];

  const sectionCols = [
    'section_key', 'x', 'y', 'width', 'height',
    'padding_top', 'padding_right', 'padding_bottom', 'padding_left', 'z_index',
  ];
  const sectionValues = toValuesSql(sectionRows, sectionCols);

  const tokenCols = ['token_key', 'token_type', 'value'];
  const tokenValues = tokenRows.map((t) => ({
    token_key: t.token_key,
    token_type: t.token_type,
    value: JSON.stringify(t.value),
  }));
  const tokenValuesSql = toValuesSql(tokenValues, tokenCols);

  const updateDefaults = !!mapping.update_defaults;
  const defaultsSchemaVersion = mapping.defaults_schema_version || 2;
  const defaultsChangeReason = mapping.defaults_change_reason || `Waybill compiled v${rc.version}`;

  const defaultsSql = updateDefaults ? `

  -- Upsert renderer defaults (global)
  WITH upsert_global AS (
    INSERT INTO settings_versions (
      id, category, scope_type, scope_id, scope_hash, version, value, schema_version,
      change_reason, approved_at, effective_from, effective_until
    )
    SELECT
      COALESCE(
        (SELECT id FROM settings_versions WHERE category = 'label_design' AND scope_type = 'global' AND scope_id IS NULL ORDER BY approved_at DESC LIMIT 1),
        '77770000-0000-0000-0000-000000000310'::uuid
      ),
      'label_design',
      'global',
      NULL,
      '00000000-0000-0000-0000-000000000000'::uuid,
      COALESCE(
        (SELECT max(version) + 1 FROM settings_versions WHERE category = 'label_design' AND scope_type = 'global' AND scope_id IS NULL),
        1
      ),
      v_payload,
      ${Number(defaultsSchemaVersion)},
      '${escapeSqlString(defaultsChangeReason)}',
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
    '66660000-0000-0000-0000-000000000310'::uuid,
    'label_design',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    upsert_global.id,
    upsert_global.value,
    now()
  FROM upsert_global
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
` : '';

  return `-- Migration: Seed ${key} v${rc.version} from compiled geometry
-- Purpose: Insert immutable renderer_config snapshot, seed sections/tokens, and keep ladder compliance.

BEGIN;

SET search_path TO public, pg_temp;

INSERT INTO organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 'Global', 'global-root')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_org CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
  v_payload JSONB := $json$
${JSON.stringify(payload, null, 2)}
$json$::jsonb;
  v_tpl JSONB := v_payload -> 'templates' -> '${rc.label_type || 'shipping'}';
  v_template_id UUID;
BEGIN
  INSERT INTO label_template_specs (
    organization_id, template_key, version, template_scope_type, template_scope_id, renderer_config, asset_refs
  )
  VALUES (
    v_org,
    '${escapeSqlString(key)}',
    ${version},
    'global',
    NULL,
    v_tpl,
    v_tpl -> 'assets'
  )
  ON CONFLICT (organization_id, template_key, version) DO NOTHING
  RETURNING id INTO v_template_id;

  IF v_template_id IS NULL THEN
    SELECT id INTO v_template_id
    FROM label_template_specs
    WHERE organization_id = v_org
      AND template_key = '${escapeSqlString(key)}'
      AND version = ${version}
    LIMIT 1;
  END IF;

  INSERT INTO label_sections (
    organization_id, template_id, section_key, x, y, width, height,
    padding_top, padding_right, padding_bottom, padding_left, z_index
  )
  SELECT v_org, v_template_id, s.section_key, s.x, s.y, s.width, s.height,
         s.padding_top, s.padding_right, s.padding_bottom, s.padding_left, s.z_index
  FROM (VALUES
    ${sectionValues}
  ) AS s(${sectionCols.join(', ')})
  ON CONFLICT (template_id, organization_id, section_key) DO NOTHING;

  INSERT INTO label_design_tokens (organization_id, template_id, token_key, token_type, value)
  SELECT v_org, v_template_id, t.token_key, t.token_type, t.value::jsonb
  FROM (VALUES
    ${tokenValuesSql}
  ) AS t(${tokenCols.join(', ')})
  ON CONFLICT (template_id, organization_id, token_key) DO NOTHING;
  ${defaultsSql}

END $$;

COMMIT;
`;
};

const main = () => {
  const args = parseArgs(argv);
  const geometryPath = args.geometry || args.g;
  const mappingPath = args.mapping || args.m;

  if (!geometryPath || !mappingPath) {
    console.error('Usage: emit-waybill-migration --geometry <WAYBILL_GEOMETRY.json> --mapping <mapping.json> [--out migration.sql]');
    process.exit(1);
  }

  const geoFile = path.resolve(process.cwd(), geometryPath);
  const mapFile = path.resolve(process.cwd(), mappingPath);
  const { geometry, mapping } = loadInputs(geoFile, mapFile);
  const compiled = compileWaybillSpec(geometry, mapping, { allowMissing: !!args['allow-missing'] });

  const sql = buildMigrationSql(compiled, mapping);
  if (args.out) {
    const outFile = path.resolve(process.cwd(), args.out);
    fs.writeFileSync(outFile, sql);
    console.log(`[emit-waybill-migration] wrote ${outFile}`);
  } else {
    process.stdout.write(sql);
  }
};

main();
