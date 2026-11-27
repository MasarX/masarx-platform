const { Pool } = require('pg');
const { loadEnv } = require('../../scripts/utils/load-env');
const {
  createWorkflowContext,
  clearWorkflowEngineContext,
  cleanupWorkflowForLabelJobs
} = require('./helpers/tenant-utils');
loadEnv();

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be defined for label decision tests');
}

const pool = new Pool({ connectionString: DATABASE_URL });

const fetchOne = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
};

const ensureTestShipment = async () => {
  const fallbackClient = await fetchOne(
    'select id as client_id, organization_id from clients order by created_at limit 1'
  );
  if (!fallbackClient) {
    throw new Error('No clients available to seed test shipment for label decisions');
  }

  const tracking = `LBLTEST-${Date.now().toString(36).toUpperCase()}`;
  const { rows } = await pool.query(
    `insert into shipments (
       organization_id,
       client_id,
       service_type,
       tracking_number,
       status,
       box_count,
       created_at,
       updated_at
     )
     values (
       $1::uuid,
       $2::uuid,
       'delivery',
       $3::text,
       'pending',
       1,
       now(),
       now()
     )
     returning id, organization_id, client_id, tracking_number`,
    [fallbackClient.organization_id, fallbackClient.client_id, tracking]
  );
  return rows[0];
};

const waitForDecision = async (resourceId) => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const row = await fetchOne(
      "select decision_outcome from decision_log\n       where resource_type = 'label_job'\n         and resource_id = $1\n         and decision_category = 'label_job'\n       order by timestamp desc limit 1",
      [resourceId]
    );
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
};

describe('Label decision logging', () => {
  test('label generation logs enqueue and completion decisions', async () => {
    const shipment = await ensureTestShipment();
    expect(shipment).toBeTruthy();

    const client = await pool.connect();
    let workflowContext = null;
    let insertedBoxId = null;
    let jobId = null;
    let fileUrl = null;

    try {
      const existingBox = await fetchOne('select id from shipment_boxes where shipment_id = $1 limit 1', [
        shipment.id
      ]);
      if (!existingBox) {
        const boxNumber = 1;
        const insertBox = await pool.query(
          `insert into shipment_boxes (
             id, shipment_id, organization_id, client_id, box_number, barcode, created_at
           )
           values (
             gen_random_uuid(),
             $1,
             $2,
             $3,
             $4,
             $5,
             now()
           )
           returning id`,
          [
            shipment.id,
            shipment.organization_id,
            shipment.client_id,
            boxNumber,
            `${shipment.tracking_number}:${boxNumber}`
          ]
        );
        insertedBoxId = insertBox.rows[0].id;
      }

      await pool.query(
        `UPDATE labels
            SET active_version_id = NULL
          WHERE shipment_id = $1`,
        [shipment.id]
      );
      await pool.query(
        `UPDATE label_jobs
            SET source_label_version_id = NULL
          WHERE source_label_version_id IN (
            SELECT id
              FROM label_versions
             WHERE shipment_id = $1
          )`,
        [shipment.id]
      );
      await pool.query('delete from label_versions where shipment_id = $1', [shipment.id]);
      await pool.query('delete from label_jobs where shipment_id = $1', [shipment.id]);
      await pool.query('delete from labels where shipment_id = $1', [shipment.id]);
      workflowContext = await createWorkflowContext(client, {
        templateName: 'sys_label_generation_v1',
        context: { organization_id: shipment.organization_id, client_id: shipment.client_id },
        local: false,
      });

      const { rows } = await client.query(
        'select request_label_generation($1, $2, NULL, NULL, NULL, $3) as job_id',
        [shipment.id, 'shipping', 'primary']
      );
      jobId = rows[0].job_id;
      expect(jobId).toBeTruthy();

      const enqueueDecision = await waitForDecision(jobId);
      expect(enqueueDecision).toBeTruthy();
      expect(['enqueued', 'reused']).toContain(enqueueDecision.decision_outcome);

      fileUrl = `${jobId}-test.pdf`;
      await client.query(
        'select complete_label_job($1, $2, $3, $4, $5::jsonb, NULL)',
        [
          jobId,
          'succeeded',
          fileUrl,
          512,
          JSON.stringify({ renderer: 'test-suite' })
        ]
      );

      const completionDecision = await waitForDecision(jobId);
      expect(completionDecision).toBeTruthy();
      expect(completionDecision.decision_outcome).toBe('render_succeeded');
    } finally {
      try {
        await cleanupWorkflowForLabelJobs(client, {
          jobIds: jobId ? [jobId] : [],
          workflowRunIds: workflowContext?.runId ? [workflowContext.runId] : []
        });
      } catch (_) {}

      if (jobId) {
        try {
          await client.query("delete from shipment_actions where action_data->>'label_job_id' = $1", [jobId]);
        } catch (_) {}
        try {
          await client.query("delete from decision_log where resource_type = 'label_job' and resource_id = $1", [jobId]);
        } catch (_) {}
      }

      if (fileUrl) {
        try {
          await client.query('delete from labels where file_url = $1', [fileUrl]);
        } catch (_) {}
      }

      if (insertedBoxId) {
        try {
          await client.query('delete from shipment_boxes where id = $1', [insertedBoxId]);
        } catch (_) {}
      }

      try {
        await client.query('delete from shipments where id = $1', [shipment.id]);
      } catch (_) {}

      try {
        await clearWorkflowEngineContext(client, { local: false });
      } catch (_) {}
      client.release();
    }
  });
});
afterAll(async () => {
  await pool.end();
});
