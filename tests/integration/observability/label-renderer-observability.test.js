const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error('[tests] DATABASE_URL required');
}

const pool = new Pool({ connectionString: DATABASE_URL });

describe('Label renderer observability', () => {
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

  it('projects label_rendering decision into observability_events_v', async () => {
    const correlationId = randomUUID();
    const decisionId = randomUUID();
    const jobId = randomUUID();

    const { rows: orgRows } = await client.query('SELECT id FROM organizations LIMIT 1');
    expect(orgRows.length).toBe(1);
    const organizationId = orgRows[0].id;

    await client.query(
      `
        INSERT INTO decision_log (
          id,
          organization_id,
          decision_category,
          resource_type,
          resource_id,
          decision_point,
          decision_outcome,
          decision_inputs,
          decision_reason,
          performed_by_system,
          correlation_id,
          timestamp
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          'label_rendering',
          'label_job',
          $3::uuid,
          'renderer',
          'succeeded',
          jsonb_build_object('duration_ms', 123),
          'render ok',
          'label-renderer',
          $4::uuid,
          now()
        )
      `,
      [decisionId, organizationId, jobId, correlationId]
    );

    const { rows: obsRows } = await client.query(
      `
        SELECT event_source, event_type, resource_type, resource_id, status, correlation_id
          FROM observability_events_v
         WHERE event_source = 'decision_log'
           AND event_type = 'label_rendering'
           AND resource_id = $1::uuid
         ORDER BY event_time DESC
         LIMIT 1
      `,
      [jobId]
    );

    expect(obsRows).toHaveLength(1);
    expect(obsRows[0]).toEqual({
      event_source: 'decision_log',
      event_type: 'label_rendering',
      resource_type: 'label_job',
      resource_id: jobId,
      status: 'succeeded',
      correlation_id: correlationId
    });
  });
});
