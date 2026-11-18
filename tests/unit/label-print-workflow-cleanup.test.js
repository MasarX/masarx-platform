const {
  cleanupLabelPrintWorkflowRows,
} = require('../integration/workflows/helpers/label-print-helpers');

const normalizedStatements = (query) =>
  query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());

describe('label print workflow cleanup', () => {
  test('quiesces tracked rows and deletes derived children in one transaction', async () => {
    const client = {
      query: jest.fn(async (sql) => ({
        rows: String(sql).includes('to_regclass') ? [{ exists: true }] : [],
      })),
    };

    await cleanupLabelPrintWorkflowRows(client, {
      workflowRunIds: ['00000000-0000-0000-0000-000000000001'],
      shipmentIds: ['00000000-0000-0000-0000-000000000002'],
      shipmentBoxIds: ['00000000-0000-0000-0000-000000000003'],
    });

    const statements = normalizedStatements(client.query);
    const completionLock = statements.findIndex((sql) =>
      sql.startsWith('SELECT pg_advisory_xact_lock'),
    );
    const workflowLock = statements.findIndex((sql) => sql.startsWith('SELECT id FROM workflow_runs'));
    const shipmentLock = statements.findIndex((sql) => sql.startsWith('SELECT id FROM shipments'));
    const jobItemsDelete = statements.findIndex((sql) => sql.startsWith('DELETE FROM label_job_items'));
    const jobsDelete = statements.findIndex((sql) => sql.startsWith('DELETE FROM label_jobs'));
    const runsDelete = statements.findIndex((sql) => sql.startsWith('DELETE FROM workflow_runs'));
    const actionsDelete = statements.findIndex((sql) => sql.startsWith('DELETE FROM shipment_actions'));
    const shipmentsDelete = statements.findIndex((sql) => sql.startsWith('DELETE FROM shipments'));

    expect(statements[0]).toBe('BEGIN');
    expect(completionLock).toBeGreaterThan(0);
    expect(statements[completionLock]).toContain("hashtext('label_jobs_workflow_step_nudge')");
    expect(statements[completionLock]).toContain('ORDER BY id');
    expect(workflowLock).toBeGreaterThan(completionLock);
    expect(shipmentLock).toBeGreaterThan(workflowLock);
    expect(jobItemsDelete).toBeGreaterThan(shipmentLock);
    expect(jobsDelete).toBeGreaterThan(jobItemsDelete);
    expect(runsDelete).toBeGreaterThan(jobsDelete);
    expect(actionsDelete).toBeGreaterThan(runsDelete);
    expect(shipmentsDelete).toBeGreaterThan(actionsDelete);
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements[jobItemsDelete]).toContain('wrs.workflow_run_id = ANY($1::uuid[])');
    expect(statements[jobItemsDelete]).toContain('lj.shipment_id = ANY($2::uuid[])');
  });

  test('skips the optional label job item table when it is absent', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    await cleanupLabelPrintWorkflowRows(client, {
      shipmentIds: ['00000000-0000-0000-0000-000000000002'],
    });

    const statements = normalizedStatements(client.query);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM label_job_items'))).toBe(false);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM label_jobs'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  });


  test('rolls back and preserves the cleanup failure', async () => {
    const failure = new Error('delete failed');
    const client = {
      query: jest.fn(async (sql) => {
        if (String(sql).includes('to_regclass')) return { rows: [{ exists: true }] };
        if (String(sql).startsWith('DELETE FROM label_job_items')) throw failure;
        return { rows: [] };
      }),
    };

    await expect(
      cleanupLabelPrintWorkflowRows(client, {
        workflowRunIds: ['00000000-0000-0000-0000-000000000001'],
      }),
    ).rejects.toBe(failure);

    expect(normalizedStatements(client.query).at(-1)).toBe('ROLLBACK');
  });
});
