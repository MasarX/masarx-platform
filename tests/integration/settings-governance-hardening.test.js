const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { upsertSettings } = require('../utils/policies');

loadEnv();

describe('Settings governance hardening', () => {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
  });

  afterAll(async () => {
    await pool.end();
  });

  test('enforces per-category allowed scopes at write-time', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      const orgId = randomUUID();
      const clientId = randomUUID();

      await client.query(
        `INSERT INTO organizations (id, name, slug)
         VALUES ($1::uuid, 'Scope Guard Org', $2)`,
        [orgId, `scope-guard-org-${orgId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO clients (id, organization_id, name, slug)
         VALUES ($1::uuid, $2::uuid, 'Scope Guard Client', $3)`,
        [clientId, orgId, `scope-guard-client-${clientId.slice(0, 8)}`],
      );

      const category = `scope_guard_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      await client.query(
        `INSERT INTO public.settings_category_registry (
           category,
           description,
           requires_schema,
           requires_global_default,
           side_effecting,
           safe_missing_behavior,
           allowed_scopes
         ) VALUES (
           $1::text,
           'Test-only category for allowed scope enforcement',
           TRUE,
           FALSE,
           FALSE,
           'return_null',
           '["global"]'::jsonb
         )
         ON CONFLICT (category) DO UPDATE
           SET allowed_scopes = EXCLUDED.allowed_scopes,
               updated_at = now()`,
        [category],
      );

      await client.query(
        `INSERT INTO public.schema_registry (
           category,
           version,
           schema,
           description,
           examples,
           is_active
         ) VALUES (
           $1::text,
           1,
           $2::jsonb,
           'Test-only schema for scope enforcement',
           jsonb_build_array($3::jsonb),
           TRUE
         )
         ON CONFLICT (category, version) DO UPDATE
           SET schema = EXCLUDED.schema,
               examples = EXCLUDED.examples,
               is_active = TRUE`,
        [
          category,
          JSON.stringify({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            additionalProperties: true,
          }),
          JSON.stringify({}),
        ],
      );

      await upsertSettings(
        category,
        'global',
        null,
        { ok: true },
        'governance test global',
        client,
      );

      // Scope guard is implemented via a DEFERRABLE constraint trigger, so the
      // violation is raised at COMMIT (not at INSERT time) when running inside
      // an explicit transaction.
      await upsertSettings(
        category,
        'client',
        clientId,
        { ok: true },
        'governance test client',
        client,
      );

      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {}
      client.release();
    }
  });

  test('logs missing settings when safe_missing_behavior=skip', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      const orgId = randomUUID();
      await client.query(
        `INSERT INTO organizations (id, name, slug)
         VALUES ($1::uuid, 'Missing Log Org', $2)`,
        [orgId, `missing-log-org-${orgId.slice(0, 8)}`],
      );

      const category = `missing_skip_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      await client.query(
        `INSERT INTO public.settings_category_registry (
           category,
           description,
           requires_schema,
           requires_global_default,
           side_effecting,
           safe_missing_behavior
         ) VALUES (
           $1::text,
           'Test-only category for safe missing logging',
           FALSE,
           FALSE,
           FALSE,
           'skip'
         )
         ON CONFLICT (category) DO UPDATE
           SET safe_missing_behavior = EXCLUDED.safe_missing_behavior,
               updated_at = now()`,
        [category],
      );

      const resolved = await client.query(
        `SELECT *
           FROM public.resolve_settings_row($1::text, 'tenant', $2::uuid)`,
        [category, orgId],
      );
      expect(resolved.rowCount).toBe(0);

      await client.query('SET LOCAL ROLE service_role');
      const { rows: logRows } = await client.query(
        `SELECT category, winning_scope_type
           FROM public.settings_resolution_log
          WHERE organization_id = $1::uuid
            AND category = $2::text
          ORDER BY resolved_at DESC
          LIMIT 1`,
        [orgId, category],
      );
      expect(logRows).toHaveLength(1);
      expect(logRows[0].winning_scope_type).toBe('missing');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('hard-fails when safe_missing_behavior=hard_fail and global default is missing', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      const category = `missing_hard_fail_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      await client.query(
        `INSERT INTO public.settings_category_registry (
           category,
           description,
           requires_schema,
           requires_global_default,
           side_effecting,
           safe_missing_behavior
         ) VALUES (
           $1::text,
           'Test-only category for safe missing hard fail',
           FALSE,
           FALSE,
           FALSE,
           'hard_fail'
         )
         ON CONFLICT (category) DO UPDATE
           SET safe_missing_behavior = EXCLUDED.safe_missing_behavior,
               updated_at = now()`,
        [category],
      );

      await expect(
        client.query(`SELECT public.resolve_settings($1::text, 'global', NULL)`, [
          category,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('canonical settings upserts close future-dated current rows monotonically', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      const initial = await client.query(
        `SELECT *
           FROM public.upsert_settings_value_v1(
             'webhook_ingest_policy',
             'global',
             NULL,
             $1::jsonb,
             1,
             'uc234 monotonic closeout seed'
           )`,
        [JSON.stringify({ allow_provider_mirror: false })],
      );

      const initialVersionId = initial.rows[0]?.settings_version_id;
      expect(initialVersionId).toBeTruthy();

      await client.query(
        `UPDATE public.settings_versions
            SET effective_from = clock_timestamp() + INTERVAL '1 minute',
                effective_until = NULL
          WHERE id = $1::uuid`,
        [initialVersionId],
      );

      const followUp = await client.query(
        `SELECT *
           FROM public.upsert_settings_value_v1(
             'webhook_ingest_policy',
             'global',
             NULL,
             $1::jsonb,
             1,
             'uc234 monotonic closeout verify'
           )`,
        [JSON.stringify({ allow_provider_mirror: true })],
      );

      const followUpVersionId = followUp.rows[0]?.settings_version_id;
      expect(followUpVersionId).toBeTruthy();
      expect(followUpVersionId).not.toBe(initialVersionId);

      const { rows } = await client.query(
        `SELECT id,
                value,
                effective_from,
                effective_until,
                effective_until > effective_from AS closes_monotonically
           FROM public.settings_versions
          WHERE id = ANY($1::uuid[])
          ORDER BY effective_from ASC`,
        [[initialVersionId, followUpVersionId]],
      );

      expect(rows).toHaveLength(2);

      const closedRow = rows.find((row) => row.id === initialVersionId);
      const currentRow = rows.find((row) => row.id === followUpVersionId);

      expect(closedRow).toBeDefined();
      expect(currentRow).toBeDefined();
      expect(closedRow.closes_monotonically).toBe(true);
      expect(currentRow.effective_until).toBeNull();
      expect(currentRow.value).toMatchObject({ allow_provider_mirror: true });

      const activeRowCount = await client.query(
        `SELECT COUNT(*)::int AS active_count
           FROM public.settings_versions
          WHERE category = 'webhook_ingest_policy'
            AND scope_type = 'global'
            AND effective_until IS NULL
            AND approved_at IS NOT NULL`,
      );

      expect(activeRowCount.rows[0]?.active_count).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
