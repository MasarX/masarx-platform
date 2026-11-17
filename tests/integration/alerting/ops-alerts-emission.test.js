const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL required for ops alerts tests');
}

const pool = new Pool({ connectionString: DATABASE_URL });

describe('Ops alerts & provider health logs', () => {
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

  it('inserts ops_alerts with correlation and projects to partition', async () => {
    const correlationId = randomUUID();
    const decisionId = randomUUID();

    const { rows: orgRows } = await client.query('SELECT id FROM organizations LIMIT 1');
    expect(orgRows.length).toBe(1);
    const organizationId = orgRows[0].id;

    await client.query(
      `
        INSERT INTO ops_alerts (id, organization_id, alert_type, severity, message, correlation_id, decision_log_id, created_at)
        VALUES ($1::uuid, $2::uuid, 'webhook_ack_failure', 'critical', 'ack failed', $3::uuid, $4::uuid, now())
      `,
      [randomUUID(), organizationId, correlationId, decisionId]
    );

    const { rows } = await client.query(
      `SELECT alert_type, severity, correlation_id FROM ops_alerts WHERE correlation_id = $1::uuid LIMIT 1`,
      [correlationId]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].alert_type).toBe('webhook_ack_failure');
    expect(rows[0].severity).toBe('critical');
  });

  it('records provider health log with decision linkage', async () => {
    const providerId = randomUUID();

    const { rows: orgRows } = await client.query('SELECT id FROM organizations LIMIT 1');
    expect(orgRows.length).toBe(1);
    const organizationId = orgRows[0].id;

    await client.query(
      `INSERT INTO providers (id, organization_id, name, provider_type)
       VALUES ($1::uuid, $2::uuid, $3::text, 'http')`,
      [providerId, organizationId, `test-provider-${providerId.slice(0, 8)}`]
    );

    const circuitId = randomUUID();
    await client.query(
      `INSERT INTO circuit_breaker_state (id, provider_id, operation_name, state)
       VALUES ($1::uuid, $2::uuid, 'probe_operation', 'closed')`,
      [circuitId, providerId]
    );

    // Trigger provider health log emission via circuit breaker state transition.
    await client.query(
      `UPDATE circuit_breaker_state SET state = 'open', failure_count = failure_count + 1, updated_at = now()
       WHERE id = $1::uuid`,
      [circuitId]
    );

    const { rows } = await client.query(
      `SELECT organization_id, status, error_message, correlation_id
       FROM provider_health_logs
       WHERE provider_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT 1`,
      [providerId]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(organizationId);
    expect(rows[0].status).toBe('down');
    expect(rows[0].error_message).toBe('circuit breaker open');
    expect(typeof rows[0].correlation_id).toBe('string');
  });
});
