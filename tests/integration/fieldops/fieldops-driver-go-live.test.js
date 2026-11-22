const { Pool } = require('pg');
const { createUser, DATABASE_URL, setAuthContext } = require('../helpers/tenant-utils');
const {
  assignRouteRunToDriver,
  createCrossSurfaceActors,
  createShipmentViaUi,
  openDriverShiftSession,
  seedRouteRunWorkflowForShipment,
} = require('../helpers/cross-surface-utils');

const pool = new Pool({ connectionString: DATABASE_URL });

async function assignSyntheticRoute(client, actors) {
  const userId = actors.operatorUserId;
  const shipment = await createShipmentViaUi(client, { ...actors, userId });
  expect(shipment.result.status).toBe('shipment_created');
  const route = await seedRouteRunWorkflowForShipment(client, {
    ...actors, userId, shipmentId: shipment.shipmentId,
  });
  const assignment = await assignRouteRunToDriver(client, { ...actors, ...route, userId });
  expect(assignment.status).toBe('assigned');
  return route;
}

async function readManifest(client, routeRunId) {
  const { rows: [row] } = await client.query(
    'SELECT api.ui_route_run_execution_manifest_v1($1::uuid) AS manifest', [routeRunId],
  );
  return row.manifest;
}

async function expectSameTenantManifestDenial(client, routeRunId) {
  await client.query('SAVEPOINT driver_manifest_denial');
  try {
    await expect(readManifest(client, routeRunId)).rejects.toMatchObject({
      code: '42501',
      message: `route_run ${routeRunId} is not visible to the current actor`,
    });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT driver_manifest_denial');
    await client.query('RELEASE SAVEPOINT driver_manifest_denial');
  }
}

afterAll(() => pool.end());

test('drivers can read their assigned stop and are denied unassigned routes in either tenant', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await createCrossSurfaceActors(client, 'Driver Shift Fixture');
    const foreign = await createCrossSurfaceActors(client, 'Foreign Shift Fixture');
    const driverOptions = { userType: 'driver', rbacTemplateKey: 'driver' };
    const otherDriverId = await createUser(
      client, owner.organizationId, `other-driver-${owner.organizationId}@example.com`, driverOptions,
    );
    const offShiftDriverId = await createUser(
      client, owner.organizationId, `off-shift-driver-${owner.organizationId}@example.com`, driverOptions,
    );
    const ownRoute = await assignSyntheticRoute(client, owner);
    const foreignRoute = await assignSyntheticRoute(client, foreign);

    const shift = await openDriverShiftSession(client, { ...owner, userId: owner.driverUserId });
    expect(shift).toBeTruthy();
    const manifest = await readManifest(client, ownRoute.routeRunId);
    expect(manifest.stops).toEqual(expect.arrayContaining([
      expect.objectContaining({
        task: expect.objectContaining({ task_id: ownRoute.routeStopTaskId, assigned_to: owner.driverUserId }),
      }),
    ]));

    const otherShift = await openDriverShiftSession(client, { ...owner, userId: otherDriverId });
    expect(otherShift).toBeTruthy();
    await expectSameTenantManifestDenial(client, ownRoute.routeRunId);

    await setAuthContext(client, offShiftDriverId, { organization_id: owner.organizationId });
    await expectSameTenantManifestDenial(client, ownRoute.routeRunId);

    const foreignShift = await openDriverShiftSession(client, { ...foreign, userId: foreign.driverUserId });
    expect(foreignShift).toBeTruthy();
    expect((await readManifest(client, foreignRoute.routeRunId)).route_run_id).toBe(foreignRoute.routeRunId);
    await expect(readManifest(client, ownRoute.routeRunId)).rejects.toMatchObject({ code: '42501' });
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}, 120_000);
