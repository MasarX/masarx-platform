const Ajv = require('ajv');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const ajv07 = new Ajv({
  strict: false,
  allErrors: true,
  allowUnionTypes: true,
  // DB reads return fresh versioned schemas; do not register their stable $id globally.
  addUsedSchema: false,
});
const ajv2020 = new Ajv2020({
  strict: false,
  allErrors: true,
  allowUnionTypes: true,
  // DB reads return fresh versioned schemas; do not register their stable $id globally.
  addUsedSchema: false,
});
addFormats(ajv07);
addFormats(ajv2020);

async function hasTable(db, { schema, table }) {
  const res = await db.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = $1
        AND table_name = $2
      LIMIT 1`,
    [schema, table],
  );
  return res.rowCount > 0;
}

async function resolveScopeTypeMeta(db, scopeType) {
  const raw = String(scopeType || '').trim().toLowerCase();
  if (!raw) throw new Error('scope_type is required');

  const hasRegistry = await hasTable(db, { schema: 'public', table: 'scope_type_registry' });
  if (!hasRegistry) {
    throw new Error(
      'scope_type_registry is missing. Apply ladder SSOT migrations before running settings upsert.',
    );
  }

  const hasAliases = await hasTable(db, { schema: 'public', table: 'scope_type_aliases' });
  const query = hasAliases
    ? `
        SELECT r.scope_type, r.entity_table
          FROM public.scope_type_registry r
         WHERE r.scope_type = $1
           AND r.is_enabled = TRUE
        UNION ALL
        SELECT r.scope_type, r.entity_table
          FROM public.scope_type_aliases a
          JOIN public.scope_type_registry r
            ON r.scope_type = a.scope_type
         WHERE a.alias = $1
           AND r.is_enabled = TRUE
         LIMIT 1`
    : `
        SELECT r.scope_type, r.entity_table
          FROM public.scope_type_registry r
         WHERE r.scope_type = $1
           AND r.is_enabled = TRUE
         LIMIT 1`;

  const res = await db.query(query, [raw]);
  if (res.rowCount === 0) {
    throw new Error(`Unknown scope_type: ${raw}`);
  }

  const row = res.rows[0];
  const normalizedScopeType = String(row.scope_type || '').trim();
  if (!normalizedScopeType) {
    throw new Error(`Invalid scope_type registry row for input: ${raw}`);
  }

  return {
    scopeType: normalizedScopeType,
    scopeIdRequired: row.entity_table != null,
  };
}

function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (patch === null) return null;
  if (Array.isArray(patch)) return patch.slice();
  if (typeof patch !== 'object') return patch;

  const baseObj =
    base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  const out = { ...baseObj };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(baseObj[key], value);
  }
  return out;
}

function isDraft2020(schema) {
  const meta = schema && typeof schema.$schema === 'string' ? schema.$schema : '';
  return meta.includes('draft/2020-12');
}

function ajvValidate(schema, value) {
  const validate = (isDraft2020(schema) ? ajv2020 : ajv07).compile(schema);
  const ok = validate(value);
  if (ok) return;
  const msg = (validate.errors || [])
    .map((e) => `${e.instancePath || '/'} ${e.message}`)
    .join('; ');
  throw new Error(`Schema validation failed: ${msg}`);
}

async function fetchActiveSchema(db, category) {
  const schemaRow = await db.query(
    `SELECT version, schema
       FROM public.schema_registry
      WHERE category = $1
        AND is_active = TRUE
      ORDER BY version DESC
      LIMIT 1`,
    [category],
  );
  if (schemaRow.rowCount === 0) {
    throw new Error(`schema_registry missing for category: ${category}`);
  }
  return {
    schemaVersion: schemaRow.rows[0].version,
    schema: schemaRow.rows[0].schema,
  };
}

async function upsertSettings({
  db,
  category,
  scopeType,
  scopeId = null,
  value,
  patch,
  changeReason,
}) {
  if (!db) throw new Error('db client is required');
  const trimmedCategory = String(category || '').trim();
  if (!trimmedCategory) throw new Error('category is required');

  const rawScopeType = String(scopeType || '').trim();
  const normalizedScopeId = scopeId ? String(scopeId).trim() : null;

  const scopeMeta = await resolveScopeTypeMeta(db, rawScopeType);
  const normalizedScopeType = scopeMeta.scopeType;

  if (scopeMeta.scopeIdRequired) {
    if (!normalizedScopeId) {
      throw new Error(`scope_id is required for scope_type ${normalizedScopeType}`);
    }
  } else if (normalizedScopeId) {
    throw new Error(`scope_id must be NULL for scope_type ${normalizedScopeType}`);
  }

  if ((value == null) === (patch == null)) {
    throw new Error('Provide exactly one of: value OR patch');
  }

  const { schemaVersion, schema } = await fetchActiveSchema(db, trimmedCategory);

  const existingSettings = await db.query(
    `SELECT s.settings_version_id,
            s.cached_value,
            sv.version AS settings_version_number
       FROM public.settings s
       JOIN public.settings_versions sv
         ON sv.id = s.settings_version_id
        AND sv.scope_hash = s.scope_hash
      WHERE s.category = $1
        AND s.scope_type = $2
        AND s.scope_id IS NOT DISTINCT FROM $3::uuid
      LIMIT 1`,
    [trimmedCategory, normalizedScopeType, normalizedScopeId],
  );

  const baseValue = existingSettings.rowCount
    ? existingSettings.rows[0].cached_value || {}
    : {};
  const nextValue = value != null ? value : deepMerge(baseValue, patch);
  ajvValidate(schema, nextValue);

  const effectiveReason =
    String(changeReason || '').trim() ||
    `upsert via scripts/utils/settings-upsert.js`;

  let upserted;
  const labelProvider = trimmedCategory === 'label_provider';
  try {
    upserted = await db.query(
      labelProvider
        ? `SELECT settings_id, settings_version_id, settings_version_number
             FROM public.upsert_label_provider_settings_v1($1::text,$2::uuid,$3::jsonb,$4::text)`
        : `SELECT settings_id,
              settings_version_id,
              settings_version_number
         FROM public.upsert_settings_value_v1(
           $1::text,
           $2::text,
           $3::uuid,
           $4::jsonb,
           $5::int,
           $6::text
         )`,
      labelProvider
        ? [normalizedScopeType, normalizedScopeId, JSON.stringify(nextValue), effectiveReason]
        : [
        trimmedCategory,
        normalizedScopeType,
        normalizedScopeId,
        JSON.stringify(nextValue),
        schemaVersion,
        effectiveReason,
      ],
    );
  } catch (err) {
    if (err && err.code === '42883') {
      throw new Error('upsert_settings_value_v1 is missing; apply migrations before running settings upsert.');
    }
    throw err;
  }

  if (!upserted || upserted.rowCount !== 1) {
    throw new Error(`upsert_settings_value_v1 returned ${upserted ? upserted.rowCount : 'null'} rows (expected 1)`);
  }

  const settingsVersionId = upserted.rows[0].settings_version_id;
  const settingsVersionNumber =
    parseInt(String(upserted.rows[0].settings_version_number || ''), 10) || 0;
  let storedValue = nextValue;
  if (labelProvider) {
    const stored = await db.query('SELECT value FROM public.settings_versions WHERE id = $1::uuid', [settingsVersionId]);
    if (stored.rowCount !== 1) throw new Error('Stored label provider settings version is unavailable');
    storedValue = stored.rows[0].value;
  }

  return {
    settingsVersionId,
    settingsVersionNumber,
    schemaVersion,
    value: storedValue,
  };
}

module.exports = {
  upsertSettings,
  deepMerge,
};
