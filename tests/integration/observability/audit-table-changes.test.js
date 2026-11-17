const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { DATABASE_URL } = require('../helpers/tenant-utils');

const pool = new Pool({ connectionString: DATABASE_URL });

describe('Audit table changes', () => {
  let client;

  beforeAll(async () => {
    const conn = await pool.connect();
    await conn.query('SELECT 1');
    conn.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('records actor + correlation_id from request headers (x-correlation-id)', async () => {
    const correlationId = randomUUID();

    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: 'integration-audit-user', role: 'authenticated' })
    ]);
    await client.query("SELECT set_config('request.correlation_id', '', true)");
    await client.query("SELECT set_config('request.headers', $1, true)", [
      JSON.stringify({ 'x-correlation-id': correlationId })
    ]);

    const targetTableName = `audit_trace_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await client.query(`CREATE TABLE "${targetTableName}" (id uuid PRIMARY KEY)`);
    await client.query(
      `
        INSERT INTO partitioning_config (
          table_name,
          partition_strategy,
          partition_key,
          partition_interval,
          partitions_ahead,
          retention_months,
          config
        )
        VALUES ($1::text, 'NONE', 'id', NULL, NULL, NULL, '{}'::jsonb)
      `,
      [targetTableName]
    );

    await client.query(
      `UPDATE partitioning_config
          SET config = coalesce(config, '{}'::jsonb) || jsonb_build_object('touched_by', 'audit-test')
        WHERE table_name = $1::text`,
      [targetTableName]
    );

    const { rows } = await client.query(
      `
        SELECT table_name, correlation_id, changed_by, row_old, row_new
          FROM audit_table_changes
         WHERE table_name = 'partitioning_config'
           AND op = 'UPDATE'
           AND correlation_id = $1::uuid
           AND coalesce(row_new->>'table_name', row_old->>'table_name') = $2::text
         ORDER BY created_at DESC
         LIMIT 1
      `,
      [correlationId, targetTableName]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].correlation_id).toBe(correlationId);
    expect(rows[0].changed_by).toBe('integration-audit-user');
    expect(rows[0].row_old).not.toBeNull();
    expect(rows[0].row_new).not.toBeNull();
  });

  it('propagates correlation_id from insert_webhook_inbox_record into subsequent audit rows', async () => {
    const correlationId = randomUUID();

    const { rows: orgRows } = await client.query('SELECT id FROM organizations LIMIT 1');
    expect(orgRows.length).toBe(1);
    const organizationId = orgRows[0].id;

    const mappingId = randomUUID();
    await client.query(
      `
        INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
        VALUES ($1::uuid, 'webhook_inbound', $2::text, '{}'::jsonb, 1, 'audit trace context test')
      `,
      [mappingId, `audit-trace-${mappingId.slice(0, 8)}`]
    );

    const sourceId = randomUUID();
    await client.query(
      `
        INSERT INTO webhook_sources (
          id,
          organization_id,
          source_identifier,
          name,
          provider_type,
          auth_token,
          mapping_config_id,
          enabled
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::text,
          'Audit Trace Source',
          'provider',
          $4::text,
          $5::uuid,
          TRUE
        )
      `,
      [sourceId, organizationId, `audit-trace-${sourceId.slice(0, 8)}`, `tok-${sourceId}`, mappingId]
    );

    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: 'integration-audit-user', role: 'authenticated' })
    ]);

    await client.query(
      `SELECT insert_webhook_inbox_record(
        gen_random_uuid(),
        $1::uuid,
        'provider',
        '{}'::jsonb,
        '{}'::jsonb,
        'pending',
        $2::uuid,
        NULL
      )`,
      [sourceId, correlationId]
    );

    const targetTableName = `audit_trace_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await client.query(`CREATE TABLE "${targetTableName}" (id uuid PRIMARY KEY)`);
    await client.query(
      `
        INSERT INTO partitioning_config (
          table_name,
          partition_strategy,
          partition_key,
          partition_interval,
          partitions_ahead,
          retention_months,
          config
        )
        VALUES ($1::text, 'NONE', 'id', NULL, NULL, NULL, '{}'::jsonb)
      `,
      [targetTableName]
    );

    await client.query(
      `UPDATE partitioning_config
          SET config = coalesce(config, '{}'::jsonb) || jsonb_build_object('touched_by', 'audit-test')
        WHERE table_name = $1::text`,
      [targetTableName]
    );

    const { rows } = await client.query(
      `
        SELECT table_name, correlation_id, changed_by
          FROM audit_table_changes
         WHERE table_name = 'partitioning_config'
           AND op = 'UPDATE'
           AND correlation_id = $1::uuid
           AND coalesce(row_new->>'table_name', row_old->>'table_name') = $2::text
         ORDER BY created_at DESC
         LIMIT 1
      `,
      [correlationId, targetTableName]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].correlation_id).toBe(correlationId);
    expect(rows[0].changed_by).toBe('integration-audit-user');
  });
});
