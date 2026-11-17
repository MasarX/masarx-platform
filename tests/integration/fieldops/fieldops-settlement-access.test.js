const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { createOrganization, createUser, setAuthContext } = require('../helpers/tenant-utils');

loadEnv();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('FieldOps settlement access contract', () => {
  let client;

  beforeAll(async () => {
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
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

  async function listSettlements(userId) {
    await setAuthContext(client, userId);
    const { rows } = await client.query(
      `SELECT public.ui_list_resource_v1('settlements', '{}'::jsonb, 50, 0) AS payload`
    );
    return rows[0]?.payload ?? null;
  }

  async function canReadSettlement(userId, organizationId, settlementBatchId, subjectType, subjectId) {
    await setAuthContext(client, userId);
    const { rows } = await client.query(
      `SELECT public.can_read_settlement_batch_v1(
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::uuid
        ) AS allowed`,
      [organizationId, settlementBatchId, subjectType, subjectId]
    );
    return rows[0]?.allowed ?? false;
  }

  async function assignTemplateRole(organizationId, userId, templateKey) {
    const { rows } = await client.query(
      `SELECT template_key, role_id
         FROM public.provision_rbac_roles_from_templates_v1($1::uuid, ARRAY[$2::text], $3::uuid)`,
      [organizationId, templateKey, userId]
    );

    const roleId = rows[0]?.role_id ?? null;
    if (!roleId) {
      throw new Error(`Failed to provision RBAC role template ${templateKey}`);
    }

    await client.query(
      `INSERT INTO public.rbac_user_role_assignments (
          organization_id,
          user_id,
          role_id,
          assigned_by_user_id,
          metadata
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $2::uuid,
          jsonb_build_object('source', 'fieldops-settlement-access-test', 'template_key', $4::text)
        )
        ON CONFLICT DO NOTHING`,
      [organizationId, userId, roleId, templateKey]
    );
  }

  test('ui settlements resource only exposes batches to finance users, the subject driver, or assigned settlement workers', async () => {
    const { id: organizationId } = await createOrganization(client, 'FieldOps Settlement Access Org');
    const opsAdminId = await createUser(
      client,
      organizationId,
      `fieldops-ops-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'ops_admin', provisionRbac: false }
    );
    const subjectDriverId = await createUser(
      client,
      organizationId,
      `fieldops-driver-a-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver', provisionRbac: false }
    );
    const otherDriverId = await createUser(
      client,
      organizationId,
      `fieldops-driver-b-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver', provisionRbac: false }
    );
    const settlementWorkerId = await createUser(
      client,
      organizationId,
      `fieldops-warehouse-${randomUUID().slice(0, 8)}@example.com`,
      {
        accessScopeType: 'tenant',
        userType: 'dispatcher',
        provisionRbac: false,
      }
    );

    await assignTemplateRole(organizationId, opsAdminId, 'ops_admin');
    await assignTemplateRole(organizationId, subjectDriverId, 'driver');
    await assignTemplateRole(organizationId, otherDriverId, 'driver');
    await assignTemplateRole(organizationId, settlementWorkerId, 'fleet_manager');

    const { rows: taskTypeRows } = await client.query(
      `INSERT INTO public.task_types (
          organization_id,
          key,
          name,
          enabled,
          default_priority,
          default_queue_key
        )
        VALUES (
          $1::uuid,
          'cod_cashier_count_access_test',
          'COD Cashier Count Access Test',
          TRUE,
          60,
          'cashier'
        )
        RETURNING id`,
      [organizationId]
    );
    const taskTypeId = taskTypeRows[0]?.id;

    const settlementBatchId = randomUUID();
    await client.query(
      `INSERT INTO public.settlement_batches (
          id,
          organization_id,
          kind,
          scope_type,
          subject_type,
          subject_id,
          status,
          metadata
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          'cod',
          'driver_shift',
          'driver',
          $3::uuid,
          'open',
          jsonb_build_object(
            'title', 'Driver COD settlement batch',
            'expected_amount', 120,
            'currency', 'SAR'
          )
        )`,
      [settlementBatchId, organizationId, subjectDriverId]
    );

    await client.query(
      `INSERT INTO public.tasks (
          id,
          organization_id,
          task_type_id,
          resource_type,
          resource_id,
          status,
          priority,
          queue_key,
          assigned_to,
          assigned_at,
          metadata
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'settlement_batch',
          $4::uuid,
          'assigned',
          60,
          'cashier',
          $5::uuid,
          now(),
          jsonb_build_object('task_label', 'Cashier count settlement')
        )`,
      [randomUUID(), organizationId, taskTypeId, settlementBatchId, settlementWorkerId]
    );

    expect(
      await canReadSettlement(
        subjectDriverId,
        organizationId,
        settlementBatchId,
        'driver',
        subjectDriverId
      )
    ).toBe(true);
    expect(
      await canReadSettlement(
        otherDriverId,
        organizationId,
        settlementBatchId,
        'driver',
        subjectDriverId
      )
    ).toBe(false);
    expect(
      await canReadSettlement(
        settlementWorkerId,
        organizationId,
        settlementBatchId,
        'driver',
        subjectDriverId
      )
    ).toBe(true);
    expect(
      await canReadSettlement(
        opsAdminId,
        organizationId,
        settlementBatchId,
        'driver',
        subjectDriverId
      )
    ).toBe(true);

    const driverPayload = await listSettlements(subjectDriverId);
    expect(driverPayload?.resource).toBe('settlements');
    expect(driverPayload?.items?.map((item) => item.id)).toEqual([settlementBatchId]);

    const opsPayload = await listSettlements(opsAdminId);
    expect(opsPayload?.items?.map((item) => item.id)).toEqual([settlementBatchId]);
  });
});
