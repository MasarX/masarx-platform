const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const { loadEnv } = require("../../../scripts/utils/load-env");
const {
  createOrganization,
  createClient,
  createUser,
  createShipment,
  setAuthContext,
} = require("../helpers/tenant-utils");
const {
  createWarehouseTransferManifest,
  createWarehouseTransferManifestApi,
} = require("../helpers/warehouse-transfer-utils");

loadEnv();

const hasDatabaseUrl = Boolean(String(process.env.DATABASE_URL || "").trim());
const pool = hasDatabaseUrl ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

describeIfDb("Warehouse transfer manifest create v1", () => {
  let client;

  beforeAll(async () => {
    const connection = await pool.connect();
    await connection.query("SELECT 1");
    connection.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
  });

  afterEach(async () => {
    if (client) {
      await client.query("ROLLBACK");
      client.release();
      client = null;
    }
  });

  async function setAuthenticatedTenantContext(organizationId, userId) {
    await setAuthContext(client, userId, {
      organization_id: organizationId,
      access_scope_type: "tenant",
    });
  }

  async function seedTransferCreateScope(label) {
    const labelSlug = String(label)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const suffix = `${labelSlug}-${randomUUID().slice(0, 8)}`;
    const organization = await createOrganization(client, `${label} Org`, {
      slug: `warehouse-transfer-create-${suffix}`,
    });
    const clientRecord = await createClient(client, organization.id, `${label} Client`, {
      slug: `warehouse-transfer-client-${suffix}`,
    });
    const userId = await createUser(
      client,
      organization.id,
      `warehouse-transfer-create-${suffix}@example.com`,
      {
        accessScopeType: "tenant",
        userType: "ops_admin",
      }
    );

    const fromBranchId = randomUUID();
    const toBranchId = randomUUID();
    await client.query(
      `INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'UTC', true)`,
      [fromBranchId, organization.id, `from-${suffix}`.slice(0, 32), `From ${label}`]
    );
    await client.query(
      `INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'UTC', true)`,
      [toBranchId, organization.id, `to-${suffix}`.slice(0, 32), `To ${label}`]
    );

    const shipmentA = await createShipment(client, {
      organizationId: organization.id,
      clientId: clientRecord.id,
      trackingNumber: `TR-${suffix}-A`.toUpperCase(),
      status: "created",
    });
    const shipmentB = await createShipment(client, {
      organizationId: organization.id,
      clientId: clientRecord.id,
      trackingNumber: `TR-${suffix}-B`.toUpperCase(),
      status: "created",
    });

    return {
      organizationId: organization.id,
      clientId: clientRecord.id,
      userId,
      fromBranchId,
      toBranchId,
      shipmentIds: [shipmentA.id, shipmentB.id],
    };
  }

  test("creates and reuses a draft transfer manifest via the canonical contract", async () => {
    const seed = await seedTransferCreateScope("Manifest Create");
    await setAuthenticatedTenantContext(seed.organizationId, seed.userId);

    const transferCode = `XFER-${randomUUID().slice(0, 8)}`.toUpperCase();
    const payload = {
      organization_id: seed.organizationId,
      transfer_code: transferCode,
      from_branch_id: seed.fromBranchId,
      to_branch_id: seed.toBranchId,
      shipment_ids: seed.shipmentIds,
      planned_dispatch_at: "2026-04-05T08:00:00Z",
      planned_receive_at: "2026-04-05T12:00:00Z",
      metadata: { source: "integration.manifest_create" },
    };

    const created = await createWarehouseTransferManifest(client, payload);
    expect(created?.status).toBe("transfer_manifest_created");
    expect(created?.created).toBe(true);
    expect(created?.operation).toBe("inserted");
    expect(created?.transfer_id).toBeTruthy();
    expect(created?.shipment_count).toBe(2);

    const reused = await createWarehouseTransferManifest(client, payload);
    expect(reused?.status).toBe("transfer_manifest_reused");
    expect(reused?.created).toBe(false);
    expect(reused?.operation).toBe("reused");
    expect(reused?.transfer_id).toBe(created.transfer_id);
    expect(reused?.shipment_count).toBe(2);

    const { rows: transferRows } = await client.query(
      `SELECT id::text AS id,
              organization_id::text AS organization_id,
              from_branch_id::text AS from_branch_id,
              to_branch_id::text AS to_branch_id,
              transfer_code,
              status,
              created_by_user_id::text AS created_by_user_id,
              planned_dispatch_at,
              planned_receive_at
         FROM warehouse_transfers
        WHERE id = $1::uuid`,
      [created.transfer_id]
    );
    expect(transferRows[0]).toMatchObject({
      id: created.transfer_id,
      organization_id: seed.organizationId,
      from_branch_id: seed.fromBranchId,
      to_branch_id: seed.toBranchId,
      transfer_code: transferCode,
      status: "draft",
      created_by_user_id: seed.userId,
    });
    expect(transferRows[0]?.planned_dispatch_at).toBeTruthy();
    expect(transferRows[0]?.planned_receive_at).toBeTruthy();

    const { rows: itemRows } = await client.query(
      `SELECT shipment_id::text AS shipment_id, client_id::text AS client_id
         FROM warehouse_transfer_items
        WHERE transfer_id = $1::uuid
        ORDER BY shipment_id`,
      [created.transfer_id]
    );
    expect(itemRows).toHaveLength(2);
    expect(itemRows.map((row) => row.shipment_id)).toEqual([...seed.shipmentIds].sort());
    expect(new Set(itemRows.map((row) => row.client_id))).toEqual(new Set([seed.clientId]));

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM warehouse_transfers
        WHERE organization_id = $1::uuid
          AND transfer_code = $2`,
      [seed.organizationId, transferCode]
    );
    expect(countRows[0]?.count).toBe(1);
  });

  test("exposes manifest create through the api schema wrapper for browser clients", async () => {
    const seed = await seedTransferCreateScope("Manifest Create API");
    await setAuthenticatedTenantContext(seed.organizationId, seed.userId);

    const result = await createWarehouseTransferManifestApi(client, {
      organization_id: seed.organizationId,
      transfer_code: `XFER-API-${randomUUID().slice(0, 8)}`.toUpperCase(),
      from_branch_id: seed.fromBranchId,
      to_branch_id: seed.toBranchId,
      shipment_ids: [seed.shipmentIds[0]],
      metadata: { source: "integration.api.manifest_create" },
    });

    expect(result?.status).toBe("transfer_manifest_created");
    expect(result?.created).toBe(true);
    expect(result?.transfer_id).toBeTruthy();
    expect(result?.warehouse_transfer_id).toBe(result?.transfer_id);
    expect(result?.shipment_count).toBe(1);

    const { rows } = await client.query(
      `SELECT transfer_code, status
         FROM warehouse_transfers
        WHERE id = $1::uuid`,
      [result.transfer_id]
    );
    expect(rows[0]?.transfer_code).toBe(result.transfer_code);
    expect(rows[0]?.status).toBe("draft");
  });
});
