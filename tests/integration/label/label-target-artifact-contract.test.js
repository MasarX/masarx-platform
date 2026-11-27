const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { upsertSettings } = require('../../utils/policies');

loadEnv();

jest.setTimeout(120_000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

const TARGET_TEMPLATE_CONFIG = {
  version: 1,
  templates: {
    route: {
      template_key: 'standard_4x6',
      version: 1,
      provider_hint: 'internal_renderer',
    },
    container: {
      template_key: 'standard_4x6',
      version: 1,
      provider_hint: 'internal_renderer',
    },
    transfer: {
      template_key: 'standard_4x6',
      version: 1,
      provider_hint: 'internal_renderer',
    },
  },
};

function targetCode(prefix, id) {
  return `${prefix}-${id.slice(0, 8).toUpperCase()}`;
}

function branchCode(prefix, id) {
  return `${prefix}${id.slice(0, 8)}`;
}

describe('target-neutral label artifact contract', () => {
  let client;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedTargetNeutralLabelFixture() {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const routeBranchId = randomUUID();
    const transferFromBranchId = randomUUID();
    const transferToBranchId = randomUUID();
    const routeRunId = randomUUID();
    const handlingUnitId = randomUUID();
    const transferId = randomUUID();
    const templateSpecId = randomUUID();

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Target Artifact Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
      [organizationId, `target-artifact-org-${organizationId.slice(0, 8)}`],
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Target Artifact Client', $3, 'standard', 'active')`,
      [clientId, organizationId, `target-artifact-client-${clientId.slice(0, 8)}`],
    );

    await client.query(
      `INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
       VALUES
         ($1::uuid, $2::uuid, $3, 'Target Artifact Route Branch', 'Asia/Riyadh', TRUE),
         ($4::uuid, $2::uuid, $5, 'Target Artifact Transfer From', 'Asia/Riyadh', TRUE),
         ($6::uuid, $2::uuid, $7, 'Target Artifact Transfer To', 'Asia/Riyadh', TRUE)`,
      [
        routeBranchId,
        organizationId,
        branchCode('br', routeBranchId),
        transferFromBranchId,
        branchCode('tf', transferFromBranchId),
        transferToBranchId,
        branchCode('tt', transferToBranchId),
      ],
    );

    await client.query(
      `INSERT INTO route_runs (id, organization_id, branch_id, status, planned_date, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'planned', CURRENT_DATE, $4::jsonb)`,
      [
        routeRunId,
        organizationId,
        routeBranchId,
        JSON.stringify({ route_code: targetCode('RR', routeRunId) }),
      ],
    );

    await client.query(
      `INSERT INTO handling_units (id, organization_id, branch_id, unit_type, status, code)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'bag', 'open', $4::text)`,
      [handlingUnitId, organizationId, routeBranchId, targetCode('HU', handlingUnitId)],
    );

    await client.query(
      `INSERT INTO warehouse_transfers (id, organization_id, from_branch_id, to_branch_id, status, transfer_code)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'draft', $5::text)`,
      [
        transferId,
        organizationId,
        transferFromBranchId,
        transferToBranchId,
        targetCode('TR', transferId),
      ],
    );

    await client.query(
      `INSERT INTO label_template_specs (
         id,
         organization_id,
         template_key,
         version,
         template_scope_type,
         template_scope_id,
         renderer_config,
         asset_refs,
         created_by
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         'standard_4x6',
         1,
         'tenant',
         $2::uuid,
         jsonb_build_object(
           'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203, 'orientation', 'portrait'),
           'blocks', jsonb_build_array(
             jsonb_build_object('type', 'text', 'x', 24, 'y', 120, 'width', 220, 'height', 24, 'font', 'Helvetica-Bold', 'font_size', 16, 'value_path', 'target.code', 'fallback', 'TARGET'),
             jsonb_build_object('type', 'barcode', 'x', 24, 'y', 40, 'width', 220, 'height', 72, 'value_path', 'target.code')
           ),
           'barcode', jsonb_build_object('type', 'CODE128', 'value_path', 'target.code')
         ),
         '[]'::jsonb,
         NULL
       )`,
      [templateSpecId, organizationId],
    );

    await upsertSettings(
      'label_design',
      'tenant',
      organizationId,
      TARGET_TEMPLATE_CONFIG,
      'target-neutral artifact contract template',
      client,
    );

    return {
      organizationId,
      routeRunId,
      handlingUnitId,
      transferId,
    };
  }

  test('complete_label_job persists target-neutral outputs in label_artifacts without shipment-label pollution', async () => {
    const {
      organizationId,
      routeRunId,
      handlingUnitId,
      transferId,
    } = await seedTargetNeutralLabelFixture();
    const targets = [
      { inputType: 'route', normalizedType: 'route_run', targetId: routeRunId, fileName: 'route.pdf' },
      { inputType: 'container', normalizedType: 'handling_unit', targetId: handlingUnitId, fileName: 'container.pdf' },
      { inputType: 'transfer', normalizedType: 'warehouse_transfer', targetId: transferId, fileName: 'transfer.pdf' },
    ];

    const completedJobs = [];

    for (const target of targets) {
      const {
        rows: [{ job_id: jobId }],
      } = await client.query(
        `SELECT public.request_label_generation_target_v1(
           $1::text,
           $2::uuid,
           $3::text,
           NULL,
           'label_target_artifact_contract',
           NULL,
           'primary'
         ) AS job_id`,
        [target.inputType, target.targetId, target.inputType],
      );

      await client.query(
        `SELECT public.complete_label_job(
           $1::uuid,
           'succeeded',
           $2::text,
           2048,
           $3::jsonb,
           NULL
         )`,
        [
          jobId,
          `labels/target-neutral/${target.fileName}`,
          JSON.stringify({
            renderer: 'integration-test',
            target_type: target.normalizedType,
            target_id: target.targetId,
            timings: { total_ms: 12 },
          }),
        ],
      );

      completedJobs.push({ ...target, jobId });
    }

    const jobIds = completedJobs.map((job) => job.jobId);
    const {
      rows: artifactRows,
    } = await client.query(
      `SELECT
         id,
         target_type,
         target_id,
         target_box_id,
         source_label_job_id,
         file_url,
         file_size_bytes,
         print_count,
         metadata,
         renderer_metadata
       FROM public.label_artifacts
       WHERE source_label_job_id = ANY($1::uuid[])
       ORDER BY target_type ASC`,
      [jobIds],
    );

    expect(artifactRows).toHaveLength(3);
    expect(artifactRows.map((row) => row.target_type).sort()).toEqual([
      'handling_unit',
      'route_run',
      'warehouse_transfer',
    ]);

    for (const artifact of artifactRows) {
      const expected = completedJobs.find((job) => job.jobId === artifact.source_label_job_id);
      expect(expected).toBeTruthy();
      expect(artifact.target_id).toBe(expected.targetId);
      expect(artifact.target_box_id).toBeNull();
      expect(artifact.file_url).toBe(`labels/target-neutral/${expected.fileName}`);
      expect(artifact.file_size_bytes).toBe(2048);
      expect(artifact.print_count).toBe(1);
      expect(artifact.metadata?.target).toMatchObject({
        target_type: expected.normalizedType,
        target_id: expected.targetId,
      });
      expect(artifact.metadata?.target_metadata).toBeTruthy();
      expect(artifact.renderer_metadata?.renderer).toBe('integration-test');
    }

    const { rows: labelRows } = await client.query(
      `SELECT COUNT(*)::int AS label_count
       FROM public.labels
       WHERE id = ANY($1::uuid[])`,
      [artifactRows.map((row) => row.id)],
    );
    expect(labelRows[0].label_count).toBe(0);

    const { rows: jobRows } = await client.query(
      `SELECT id, shipment_id, shipment_box_id, status, label_id, output_file_url
       FROM public.label_jobs
       WHERE id = ANY($1::uuid[])`,
      [jobIds],
    );
    expect(jobRows).toHaveLength(3);
    for (const job of jobRows) {
      const artifact = artifactRows.find((row) => row.source_label_job_id === job.id);
      expect(job.shipment_id).toBeNull();
      expect(job.shipment_box_id).toBeNull();
      expect(job.status).toBe('succeeded');
      expect(job.label_id).toBe(artifact.id);
      expect(job.output_file_url).toBe(artifact.file_url);
    }

    await client.query(
      `SELECT public.complete_label_job(
         $1::uuid,
         'succeeded',
         'labels/target-neutral/replayed.pdf',
         4096,
         $2::jsonb,
         NULL
       )`,
      [completedJobs[0].jobId, JSON.stringify({ renderer: 'replay' })],
    );

    const { rows: replayRows } = await client.query(
      `SELECT COUNT(*)::int AS artifact_count,
              max(file_url) FILTER (WHERE source_label_job_id = $1::uuid) AS replayed_file_url
       FROM public.label_artifacts
       WHERE source_label_job_id = ANY($2::uuid[])`,
      [completedJobs[0].jobId, jobIds],
    );
    expect(replayRows[0].artifact_count).toBe(3);
    expect(replayRows[0].replayed_file_url).toBe('labels/target-neutral/route.pdf');
  });
});
