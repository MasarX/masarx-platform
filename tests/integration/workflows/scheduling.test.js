const { Pool } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

const hasDatabase = Boolean(process.env.DATABASE_URL);

const pool = hasDatabase
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    })
  : null;

/** Helper to fetch reminder step metadata once per suite */
async function loadReminderMetadata(client) {
  const { rows } = await client.query(
    `
      SELECT sequence_order, metadata
      FROM workflow_template_steps
      WHERE workflow_template_id = (
        SELECT id
        FROM workflow_templates
        WHERE name = 'three_day_whatsapp_reminder_v1'
        LIMIT 1
      )
      ORDER BY sequence_order
    `,
  );

  if (!rows.length) {
    throw new Error(
      "Expected workflow template 'three_day_whatsapp_reminder_v1' with step metadata to exist.",
    );
  }

  return rows.reduce((acc, row) => {
    acc[row.sequence_order] = row.metadata;
    return acc;
  }, {});
}

const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb('Workflow scheduling functions', () => {
  let client;
  let metadataBySequence;

  beforeAll(async () => {
    client = await pool.connect();
    metadataBySequence = await loadReminderMetadata(client);
  });

  afterAll(async () => {
    if (client) client.release();
    await pool.end();
  });

  test('quiet hours adjust immediate reminder to 08:00 Riyadh', async () => {
    const reference = '2025-10-17T02:00:00+00:00';
    const metadata = metadataBySequence[1];

    const { rows } = await client.query(
      `
        SELECT workflow_compute_run_at(
          $1::timestamptz,
          $2::jsonb,
          '{}'::jsonb,
          1,
          FALSE
        ) AS run_at
      `,
      [reference, JSON.stringify(metadata)],
    );

    expect(rows[0].run_at.toISOString()).toBe('2025-10-17T05:00:00.000Z');
  });

  test('subsequent reminders respect initial delays and quiet hours', async () => {
    const reference = '2025-10-17T02:00:00+00:00';
    const day1 = metadataBySequence[2];
    const day2 = metadataBySequence[3];

    const { rows: day1Rows } = await client.query(
      `
        SELECT workflow_compute_run_at(
          $1::timestamptz,
          $2::jsonb,
          '{}'::jsonb,
          1,
          FALSE
        ) AS run_at
      `,
      [reference, JSON.stringify(day1)],
    );

    const { rows: day2Rows } = await client.query(
      `
        SELECT workflow_compute_run_at(
          $1::timestamptz,
          $2::jsonb,
          '{}'::jsonb,
          1,
          FALSE
        ) AS run_at
      `,
      [reference, JSON.stringify(day2)],
    );

    expect(day1Rows[0].run_at.toISOString()).toBe('2025-10-18T05:00:00.000Z');
    expect(day2Rows[0].run_at.toISOString()).toBe('2025-10-19T05:00:00.000Z');
  });

  test('stop conditions halt reminders when reply flag set', async () => {
    const metadata = metadataBySequence[1];
    const replyContext = {
      communication: {
        reply_received: true,
      },
    };

    const { rows } = await client.query(
      `
        SELECT workflow_should_stop(
          $1::jsonb,
          $2::jsonb
        ) AS result
      `,
      [JSON.stringify(replyContext), JSON.stringify(metadata)],
    );

    const result = typeof rows[0].result === 'string' ? JSON.parse(rows[0].result) : rows[0].result;
    expect(result.stop).toBe(true);
    expect(result.reason).toBe('reply_received');
  });
});
