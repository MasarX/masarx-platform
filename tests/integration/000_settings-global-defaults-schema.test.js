const { Pool } = require('pg');
const Ajv = require('ajv');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { loadEnv } = require('../../scripts/utils/load-env');

loadEnv();

describe('Settings global defaults schema', () => {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
  });

  afterAll(async () => {
    await pool.end();
  });

  test(
    'every default-required category has a valid global default',
    async () => {
      const client = await pool.connect();
      try {
        const { rows: categoryRows } = await client.query(
          `SELECT category
             FROM public.settings_category_registry
            WHERE requires_global_default = TRUE
            ORDER BY category`,
        );
        const categories = categoryRows.map((r) => r.category);

        const { rows: schemaRows } = await client.query(
          `SELECT category, version, schema
             FROM public.schema_registry`,
        );
        const schemaByKey = new Map(
          schemaRows.map((row) => [`${row.category}::${row.version}`, row.schema]),
        );

        const { rows: defaultRows } = await client.query(
          `SELECT
             s.category,
             s.cached_value,
             sv.schema_version
           FROM public.settings s
           JOIN public.settings_versions sv
             ON sv.id = s.settings_version_id
            AND sv.scope_hash = s.scope_hash
          WHERE s.scope_type = 'global'
            AND s.scope_id IS NULL
            AND s.category = ANY($1::text[])
          ORDER BY s.category`,
          [categories],
        );
        const defaultsByCategory = new Map(
          defaultRows.map((row) => [row.category, row]),
        );

        const ajv07 = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
        const ajv2020 = new Ajv2020({
          strict: false,
          allErrors: true,
          allowUnionTypes: true,
        });
        addFormats(ajv07);
        addFormats(ajv2020);
        const validatorCache = new Map();

        function isDraft2020(schema) {
          const meta = schema && typeof schema.$schema === 'string' ? schema.$schema : '';
          return meta.includes('draft/2020-12');
        }

        function getValidator(category, schemaVersion) {
          const key = `${category}::${schemaVersion}`;
          const schema = schemaByKey.get(key);
          if (!schema) return null;
          const cacheKey = `${isDraft2020(schema) ? '2020' : '07'}::${key}`;
          if (validatorCache.has(cacheKey)) return validatorCache.get(cacheKey);
          const validate = (isDraft2020(schema) ? ajv2020 : ajv07).compile(schema);
          validatorCache.set(cacheKey, validate);
          return validate;
        }

        const failures = [];
        for (const category of categories) {
          const row = defaultsByCategory.get(category);
          if (!row) {
            failures.push({ category, error: 'missing global settings row' });
            continue;
          }

          const schemaVersion = row.schema_version;
          if (schemaVersion == null) {
            failures.push({ category, error: 'missing schema_version' });
            continue;
          }

          const validate = getValidator(category, schemaVersion);
          if (!validate) {
            failures.push({
              category,
              error: `schema_registry missing for version=${schemaVersion}`,
            });
            continue;
          }

          const ok = validate(row.cached_value);
          if (!ok) {
            const message = (validate.errors || [])
              .map((e) => `${e.instancePath || '/'} ${e.message}`)
              .join('; ');
            failures.push({ category, error: message || 'schema validation failed' });
          }
        }

        expect(failures).toEqual([]);
      } finally {
        client.release();
      }
    },
    120000,
  );
});
