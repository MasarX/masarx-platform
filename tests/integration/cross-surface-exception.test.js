const { Pool } = require('pg');
const { randomBytes, randomUUID } = require('crypto');

const { loadEnv } = require('../../scripts/utils/load-env');
const { requireEnv } = require('../utils/test-env');
const {
  assignRouteRunToDriver,
  completeRouteStopTask,
  createCrossSurfaceActors,
  createShipmentViaUi,
  fetchLookupValues,
  listUiResource,
  openDriverShiftSession,
  seedRouteRunWorkflowForShipment,
  transitionTaskAsUser,
} = require('./helpers/cross-surface-utils');

function getTenantUtils() {
  return require('./helpers/tenant-utils');
}

loadEnv();

jest.setTimeout(120_000);

const DATABASE_URL = String(
  process.env.DATABASE_URL
  || process.env.DATABASE_URL_DIRECT
  || process.env.DATABASE_URL_POOLER
  || process.env.PG_CONN_STRING
  || '',
).trim();

describe('cross-surface dispatch exception flow', () => {
  const missingCore = requireEnv(
    ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
    'cross-surface-exception',
  );
  const missing = missingCore || (!DATABASE_URL ? 'DATABASE_URL|DATABASE_URL_DIRECT|DATABASE_URL_POOLER|PG_CONN_STRING' : null);
  if (missing) {
    throw new Error('Cross-surface integration requires ' + missing);
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  let client = null;

  async function getTaskSnapshot(organizationId, resourceType, resourceId, taskTypeKey) {
    const { rows } = await client.query(
      `SELECT
         t.id AS task_id,
         t.status,
         t.status_reason,
         t.assigned_to,
         t.metadata
        FROM public.tasks t
        JOIN public.task_types tt
          ON tt.id = t.task_type_id
       WHERE t.organization_id = $1::uuid
         AND t.resource_type = $2
         AND t.resource_id = $3::uuid
         AND tt.key = $4
       ORDER BY t.created_at DESC
       LIMIT 1`,
      [organizationId, resourceType, resourceId, taskTypeKey],
    );
    return rows[0] ?? null;
  }

  beforeAll(async () => {
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    client.release();
    client = null;
  });

  afterAll(async () => {
    await pool.end();
  });

  test('driver failure, console claim/review, and reattempt orchestration stay projection-complete', async () => {
    const exceptionReasons = await fetchLookupValues(client, 'dispatch_exception_reason');
    const ndrActions = await fetchLookupValues(client, 'ndr_action');
    const routeStopKinds = await fetchLookupValues(client, 'route_stop_kind');
    const shipmentStatuses = await fetchLookupValues(client, 'shipment_status');
    const noAnswerReason = exceptionReasons.find((entry) => entry.value === 'no_answer');
    const reattemptAction = ndrActions.find((entry) => entry.value === 'reattempt');
    const deliveryStopKind = routeStopKinds.find((entry) => entry.value === 'delivery');
    const pendingShipmentStatus = shipmentStatuses.find((entry) => entry.value === 'pending');

    expect(noAnswerReason?.value).toBeTruthy();
    expect(reattemptAction?.value).toBeTruthy();
    expect(deliveryStopKind?.value).toBeTruthy();
    expect(pendingShipmentStatus?.value).toBeTruthy();
    expect(String(noAnswerReason?.metadata?.default_action_type || '').trim()).toBeTruthy();
    expect(String(noAnswerReason?.metadata?.default_action_category || '').trim()).toBeTruthy();
    expect(String(noAnswerReason?.metadata?.default_shipment_status || '').trim()).toBeTruthy();

    const actors = await createCrossSurfaceActors(client, 'Cross Surface Exception');
    const isolationActors = await createCrossSurfaceActors(client, 'Cross Surface Exception Isolation');
    const { createUser, setAuthContext } = getTenantUtils();
    const claimantUserId = await createUser(
      client,
      actors.organizationId,
      `cross-surface-claim-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`,
      { accessScopeType: 'tenant', userType: 'ops_admin', rbacTemplateKey: 'ops_admin' },
    );

    const shipment = await createShipmentViaUi(client, {
      organizationId: actors.organizationId,
      clientId: actors.clientId,
      senderId: actors.senderId,
      userId: actors.operatorUserId,
      metadata: {
        source: 'integration.cross-surface-exception',
        surface: 'console',
      },
    });

    const routeExecution = await seedRouteRunWorkflowForShipment(client, {
      organizationId: actors.organizationId,
      clientId: actors.clientId,
      shipmentId: shipment.shipmentId,
      userId: actors.operatorUserId,
      stopKind: deliveryStopKind.value,
    });

    await assignRouteRunToDriver(client, {
      organizationId: actors.organizationId,
      userId: actors.operatorUserId,
      routeRunId: routeExecution.routeRunId,
      driverUserId: actors.driverUserId,
      vehicleId: actors.vehicleId,
    });

    const driverShiftId = await openDriverShiftSession(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      branchId: actors.branchId,
      metadata: {
        source: 'integration.cross-surface-exception',
        surface: 'fieldops',
      },
    });

    await transitionTaskAsUser(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      taskId: routeExecution.routeStopTaskId,
      toStatus: 'in_progress',
      statusReason: 'en_route',
      payload: {
        ops_session_id: driverShiftId,
        source: 'integration.cross-surface-exception',
      },
    });

    await transitionTaskAsUser(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      taskId: routeExecution.routeStopTaskId,
      toStatus: 'in_progress',
      statusReason: 'arrived',
      payload: {
        ops_session_id: driverShiftId,
        source: 'integration.cross-surface-exception',
      },
    });

    const finalization = await completeRouteStopTask(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      taskId: routeExecution.routeStopTaskId,
      routeStopId: routeExecution.routeStopId,
      outcomeReason: noAnswerReason.value,
      payload: {
        ops_session_id: driverShiftId,
        exception_notes: 'Customer did not answer repeated delivery calls.',
        allowed_ndr_actions: [reattemptAction.value],
        source: 'integration.cross-surface-exception',
        run: randomUUID(),
      },
    });

    expect(String(finalization.finalizeWorkflowId || '')).toMatch(/^[0-9a-f-]{36}$/i);

    const reviewTask = await getTaskSnapshot(
      actors.organizationId,
      'shipment',
      shipment.shipmentId,
      'dispatch_exception_review',
    );
    expect(reviewTask?.task_id).toBeTruthy();
    expect(reviewTask?.status_reason).toBe(noAnswerReason.value);
    expect(reviewTask?.metadata?.route_stop_id).toBe(routeExecution.routeStopId);
    expect(reviewTask?.metadata?.dispatch_exception_reason).toBe(noAnswerReason.value);
    expect(reviewTask?.metadata?.allowed_ndr_actions).toEqual([reattemptAction.value]);
    expect(reviewTask?.metadata?.shipment_action_id).toBeTruthy();

    await client.query(
      `UPDATE public.tasks
          SET assigned_to = NULL,
              assigned_at = NULL,
              updated_at = now()
        WHERE id = $1::uuid`,
      [reviewTask.task_id],
    );

    await setAuthContext(client, claimantUserId, {
      organization_id: actors.organizationId,
    });
    const { rows: claimRows } = await client.query(
      `SELECT api.ui_execute_task_claim_v1(
         $1::text,
         $2::text,
         ARRAY[$3::text],
         $3::text,
         1,
         $4::jsonb
       ) AS payload`,
      [
        'unassigned_exceptions.claim',
        'unassigned_exceptions',
        String(reviewTask.task_id),
        JSON.stringify({
          notes: 'Claimed from cross-surface console review coverage',
        }),
      ],
    );
    const claimPayload = claimRows[0]?.payload ?? null;
    expect(claimPayload?.status).toBe('task_claimed');
    expect(Number(claimPayload?.claimed_count || 0)).toBe(1);

    await setAuthContext(client, claimantUserId, {
      organization_id: actors.organizationId,
    });
    const { rows: resolutionRows } = await client.query(
      `SELECT api.ui_execute_dispatch_exception_resolution_v1(
         $1::text,
         $2::text,
         ARRAY[$3::text],
         $3::text,
         1,
         $4::jsonb
       ) AS result`,
      [
        'dispatch_exception_review.complete',
        'dispatch_exception_review',
        String(reviewTask.task_id),
        JSON.stringify({
          resolution_action: reattemptAction.value,
          resolution_notes: 'Immediate reattempt approved from cross-surface coverage.',
        }),
      ],
    );
    const resolutionResult = resolutionRows[0]?.result ?? null;
    expect(resolutionResult?.status).toBe('completed');
    expect(Number(resolutionResult?.completed_count || 0)).toBe(1);
    expect(resolutionResult?.items?.[0]?.preview?.decision_status).toBe('ready');

    const refreshedReviewTask = await getTaskSnapshot(
      actors.organizationId,
      'shipment',
      shipment.shipmentId,
      'dispatch_exception_review',
    );
    expect(refreshedReviewTask?.metadata?.resolution_status).toBe('completed');
    expect(refreshedReviewTask?.metadata?.resolution_task_id).toBeTruthy();

    const reattemptTask = await getTaskSnapshot(
      actors.organizationId,
      'shipment',
      shipment.shipmentId,
      'dispatch_reattempt_delivery',
    );
    expect(reattemptTask?.task_id).toBeTruthy();
    expect(reattemptTask?.status).toBe('completed');
    expect(reattemptTask?.metadata?.parent_review_task_id).toBe(reviewTask.task_id);

    const { rows: shipmentRows } = await client.query(
      `SELECT status
         FROM public.shipments
        WHERE id = $1::uuid
          AND client_id = $2::uuid
        LIMIT 1`,
      [shipment.shipmentId, actors.clientId],
    );
    expect(shipmentRows[0]?.status).toBe(pendingShipmentStatus.value);

    const { rows: shipmentActionRows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM public.shipment_actions
        WHERE shipment_id = $1::uuid`,
      [shipment.shipmentId],
    );
    expect(Number(shipmentActionRows[0]?.count || 0)).toBeGreaterThanOrEqual(1);

    const reattemptRouteExecution = await seedRouteRunWorkflowForShipment(client, {
      organizationId: actors.organizationId,
      clientId: actors.clientId,
      shipmentId: shipment.shipmentId,
      userId: actors.operatorUserId,
      stopKind: deliveryStopKind.value,
    });

    await assignRouteRunToDriver(client, {
      organizationId: actors.organizationId,
      userId: actors.operatorUserId,
      routeRunId: reattemptRouteExecution.routeRunId,
      driverUserId: actors.driverUserId,
      vehicleId: actors.vehicleId,
    });

    await setAuthContext(client, actors.driverUserId, {
      organization_id: actors.organizationId,
    });
    const { rows: reattemptManifestRows } = await client.query(
      `SELECT api.ui_route_run_execution_manifest_v1($1::uuid) AS manifest`,
      [reattemptRouteExecution.routeRunId],
    );
    const reattemptManifest = reattemptManifestRows[0]?.manifest;
    const reattemptStop = (reattemptManifest?.stops || []).find(
      (stop) => stop?.shipment_id === shipment.shipmentId,
    );
    expect(reattemptManifest?.route_run_id).toBe(reattemptRouteExecution.routeRunId);
    expect(reattemptManifest?.route_assignment?.driver_user_id).toBe(actors.driverUserId);
    expect(reattemptStop?.route_stop_id).toBe(reattemptRouteExecution.routeStopId);
    expect(reattemptStop?.shipment_tracking_number).toBe(shipment.trackingNumber);
    expect(reattemptStop?.task?.assigned_to).toBe(actors.driverUserId);

    const portalShipmentList = await listUiResource(client, {
      organizationId: actors.organizationId,
      userId: actors.portalUserId,
      resourceKey: 'shipments',
      filters: { identifier: shipment.trackingNumber },
      limit: 10,
    });
    expect(Number(portalShipmentList?.total || 0)).toBeGreaterThanOrEqual(1);

    const isolationShipmentList = await listUiResource(client, {
      organizationId: isolationActors.organizationId,
      userId: isolationActors.portalUserId,
      resourceKey: 'shipments',
      filters: { identifier: shipment.trackingNumber },
      limit: 10,
    });
    expect(Number(isolationShipmentList?.total || 0)).toBe(0);
  });
});
