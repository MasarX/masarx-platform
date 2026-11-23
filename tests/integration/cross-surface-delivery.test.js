const { Pool } = require('pg');
const { randomBytes, randomUUID } = require('crypto');

const { loadEnv } = require('../../scripts/utils/load-env');
const { requireEnv } = require('../utils/test-env');
const {
  assignRouteRunToDriver,
  completeRouteStopTask,
  createCrossSurfaceActors,
  createShipmentViaTabularImport,
  createShipmentViaUi,
  createShipmentViaWebhookIntake,
  fetchLookupValues,
  getShipmentTimeline,
  listShipmentPodAssets,
  listUiResource,
  markRouteRunInProgress,
  openDriverShiftSession,
  registerMobileArtifact,
  seedRouteRunWorkflowForShipment,
  setServiceContext,
  transitionTaskAsUser,
} = require('./helpers/cross-surface-utils');

loadEnv();

jest.setTimeout(120_000);

const DATABASE_URL = String(
  process.env.DATABASE_URL
  || process.env.DATABASE_URL_DIRECT
  || process.env.DATABASE_URL_POOLER
  || process.env.PG_CONN_STRING
  || '',
).trim();

async function completeAndVerifyDeliveryPath(client, input) {
  const attemptOutcomes = await fetchLookupValues(client, 'attempt_outcome');
  const routeRunStatuses = await fetchLookupValues(client, 'route_run_status');
  const routeStopKinds = await fetchLookupValues(client, 'route_stop_kind');
  const completionKinds = await fetchLookupValues(client, 'delivery_completion_kind');
  const handoverModes = await fetchLookupValues(client, 'delivery_handover_mode');

  const deliveredOutcome = attemptOutcomes.find((entry) => entry.value === 'delivered');
  const inProgressRouteStatus = routeRunStatuses.find((entry) => entry.value === 'in_progress');
  const completedRouteStatus = routeRunStatuses.find((entry) => entry.value === 'completed');
  const deliveryStopKind = routeStopKinds.find((entry) => entry.value === 'delivery');
  const fullCompletionKind = completionKinds.find((entry) => entry.value === 'full');
  const namedRecipientMode = handoverModes.find((entry) => entry.value === 'named_recipient');

  expect(deliveredOutcome?.value).toBeTruthy();
  expect(inProgressRouteStatus?.value).toBeTruthy();
  expect(completedRouteStatus?.value).toBeTruthy();
  expect(deliveryStopKind?.value).toBeTruthy();
  expect(fullCompletionKind?.value).toBeTruthy();
  expect(namedRecipientMode?.value).toBeTruthy();

  const routeExecution = await seedRouteRunWorkflowForShipment(client, {
    organizationId: input.actors.organizationId,
    clientId: input.actors.clientId,
    shipmentId: input.shipment.shipmentId,
    userId: input.actors.operatorUserId,
    stopKind: deliveryStopKind.value,
  });

  const assignment = await assignRouteRunToDriver(client, {
    organizationId: input.actors.organizationId,
    userId: input.actors.operatorUserId,
    routeRunId: routeExecution.routeRunId,
    driverUserId: input.actors.driverUserId,
    vehicleId: input.actors.vehicleId,
  });
  expect(assignment?.status).toBe('assigned');

  const driverShiftId = await openDriverShiftSession(client, {
    organizationId: input.actors.organizationId,
    userId: input.actors.driverUserId,
    branchId: input.actors.branchId,
    metadata: {
      source: 'integration.cross-surface-delivery',
      source_origin: input.sourceOrigin,
    },
  });

  const routeStart = await markRouteRunInProgress(client, {
    organizationId: input.actors.organizationId,
    userId: input.actors.driverUserId,
    routeRunId: routeExecution.routeRunId,
    status: inProgressRouteStatus.value,
    metadata: {
      title: input.title,
      reference: input.shipment.trackingNumber,
      place: 'Riyadh',
    },
  });
  expect(routeStart?.status).toBe(inProgressRouteStatus.value);

  await transitionTaskAsUser(client, {
    organizationId: input.actors.organizationId,
    userId: input.actors.driverUserId,
    taskId: routeExecution.routeStopTaskId,
    toStatus: 'in_progress',
    statusReason: 'en_route',
    payload: {
      ops_session_id: driverShiftId,
      source: 'integration.cross-surface-delivery',
      source_origin: input.sourceOrigin,
    },
  });

  await transitionTaskAsUser(client, {
    organizationId: input.actors.organizationId,
    userId: input.actors.driverUserId,
    taskId: routeExecution.routeStopTaskId,
    toStatus: 'in_progress',
    statusReason: 'arrived',
    payload: {
      ops_session_id: driverShiftId,
      source: 'integration.cross-surface-delivery',
      source_origin: input.sourceOrigin,
    },
  });

  const signatureArtifactId = await registerMobileArtifact(client, {
    organizationId: input.actors.organizationId,
    userId: input.actors.driverUserId,
    taskId: routeExecution.routeStopTaskId,
    artifactKind: 'signature',
    metadata: {
      source: 'integration.cross-surface-delivery',
      source_origin: input.sourceOrigin,
    },
  });
  const photoArtifactId = await registerMobileArtifact(client, {
    organizationId: input.actors.organizationId,
    userId: input.actors.driverUserId,
    taskId: routeExecution.routeStopTaskId,
    artifactKind: 'photo',
    metadata: {
      source: 'integration.cross-surface-delivery',
      source_origin: input.sourceOrigin,
    },
  });

  const deliveryCompletion = await completeRouteStopTask(client, {
    organizationId: input.actors.organizationId,
    userId: input.actors.driverUserId,
    taskId: routeExecution.routeStopTaskId,
    routeStopId: routeExecution.routeStopId,
    outcomeReason: deliveredOutcome.value,
    payload: {
      ops_session_id: driverShiftId,
      handover_mode: namedRecipientMode.value,
      recipient_name: input.recipientName,
      recipient_class: 'customer',
      otp_code: input.otpCode,
      recipient_identity_kind: 'national_id',
      recipient_identity_last4: input.identityLast4,
      completion_notes: `${input.title} completed through cross-surface contract coverage.`,
      signature_artifact_id: signatureArtifactId,
      artifact_ids: [signatureArtifactId, photoArtifactId],
      pod: {
        captured_at: new Date().toISOString(),
        geostamp: {
          latitude: 24.7136,
          longitude: 46.6753,
          accuracy_m: 9,
        },
        signature_artifact_id: signatureArtifactId,
        artifact_ids: [signatureArtifactId, photoArtifactId],
        otp_code: input.otpCode,
        recipient_identity_kind: 'national_id',
        recipient_identity_last4: input.identityLast4,
      },
      source: 'integration.cross-surface-delivery',
      source_origin: input.sourceOrigin,
      run: randomBytes(8).toString('hex'),
    },
  });

  expect(String(deliveryCompletion.finalizeWorkflowId || '')).toMatch(/^[0-9a-f-]{36}$/i);

  await setServiceContext(client, input.actors.organizationId, input.actors.operatorUserId);

  const { rows: routeRunRows } = await client.query(
    `SELECT status
       FROM public.route_runs
      WHERE id = $1::uuid`,
    [routeExecution.routeRunId],
  );
  expect(routeRunRows[0]?.status).toBe(completedRouteStatus.value);

  const { rows: shipmentRows } = await client.query(
    `SELECT status, metadata
       FROM public.shipments
      WHERE id = $1::uuid
        AND client_id = $2::uuid
      LIMIT 1`,
    [input.shipment.shipmentId, input.actors.clientId],
  );
  expect(shipmentRows[0]?.status).toBe(deliveredOutcome.value);
  expect(shipmentRows[0]?.metadata?.workflow_run_id).toBe(input.shipment.workflowRunId);

  const { rows: shipmentActionRows } = await client.query(
    `SELECT action_type, performed_by_user_id, action_data
       FROM public.shipment_actions
      WHERE shipment_id = $1::uuid
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.shipment.shipmentId],
  );
  expect(shipmentActionRows[0]?.action_type).toBe('status_change');
  expect(shipmentActionRows[0]?.performed_by_user_id).toBe(input.actors.driverUserId);
  expect(
    shipmentActionRows[0]?.action_data?.delivery_completion?.completion_kind,
  ).toBe(fullCompletionKind.value);

  const portalShipmentList = await listUiResource(client, {
    organizationId: input.actors.organizationId,
    userId: input.actors.portalUserId,
    resourceKey: 'shipments',
    filters: { identifier: input.shipment.trackingNumber },
    limit: 10,
  });
  const portalItems = Array.isArray(portalShipmentList?.items) ? portalShipmentList.items : [];
  expect(portalItems.some((item) => item?.id === input.shipment.shipmentId)).toBe(true);

  const timeline = await getShipmentTimeline(client, {
    organizationId: input.actors.organizationId,
    userId: input.actors.portalUserId,
    shipmentId: input.shipment.shipmentId,
  });
  const timelineEvents = Array.isArray(timeline?.timeline_events) ? timeline.timeline_events : [];
  expect(timeline?.shipment_id).toBe(input.shipment.shipmentId);
  expect(
    timelineEvents.some(
      (event) =>
        event?.event_source === 'shipment_action'
        && event?.event_type === 'status_change'
        && event?.status === deliveredOutcome.value,
    ),
  ).toBe(true);

  const podAssets = await listShipmentPodAssets(client, {
    organizationId: input.actors.organizationId,
    userId: input.actors.portalUserId,
    shipmentId: input.shipment.shipmentId,
  });
  expect(podAssets.map((entry) => entry.artifact_id)).toEqual(
    expect.arrayContaining([signatureArtifactId, photoArtifactId]),
  );

  const isolationList = await listUiResource(client, {
    organizationId: input.isolationActors.organizationId,
    userId: input.isolationActors.portalUserId,
    resourceKey: 'shipments',
    filters: { identifier: input.shipment.trackingNumber },
    limit: 10,
  });
  expect(Number(isolationList?.total || 0)).toBe(0);

  return {
    deliveryCompletion,
    photoArtifactId,
    routeExecution,
    signatureArtifactId,
  };
}

describe('cross-surface delivery flow', () => {
  const missingCore = requireEnv(
    ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
    'cross-surface-delivery',
  );
  const missing = missingCore || (!DATABASE_URL ? 'DATABASE_URL|DATABASE_URL_DIRECT|DATABASE_URL_POOLER|PG_CONN_STRING' : null);
  if (missing) {
    throw new Error('Cross-surface integration requires ' + missing);
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  let client = null;

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

  test('shipment intake, assigned driver manifest and Portal timeline agree on one shipment', async () => {
    const { createUser, setAuthContext } = require('./helpers/tenant-utils');
    const owner = await createCrossSurfaceActors(client, 'Delivery Fixture');
    const foreign = await createCrossSurfaceActors(client, 'Other Delivery Fixture');
    const provisionPortalReader = (actors) => createUser(
      client,
      actors.organizationId,
      [`reader-${randomUUID()}`, ['example', 'invalid'].join('.')].join('@'),
      { accessScopeType: 'client', accessScopeId: actors.clientId, userType: 'client_admin' },
    );
    const ownerReader = await provisionPortalReader(owner);
    const foreignReader = await provisionPortalReader(foreign);
    const shipment = await createShipmentViaUi(client, { ...owner, userId: owner.operatorUserId });
    const foreignShipment = await createShipmentViaUi(client, { ...foreign, userId: foreign.operatorUserId });
    expect(shipment.result.status).toBe('shipment_created');
    expect(foreignShipment.result.status).toBe('shipment_created');

    const route = await seedRouteRunWorkflowForShipment(client, {
      ...owner, shipmentId: shipment.shipmentId, userId: owner.operatorUserId,
    });
    expect(route.routeStopTaskId).toBeTruthy();
    const assigned = await assignRouteRunToDriver(client, { ...owner, ...route, userId: owner.operatorUserId });
    expect(assigned.status).toBe('assigned');

    await openDriverShiftSession(client, { ...owner, userId: owner.driverUserId });
    const { rows: [readback] } = await client.query(
      'SELECT api.ui_route_run_execution_manifest_v1($1::uuid) AS manifest',
      [route.routeRunId],
    );
    expect(readback.manifest).toMatchObject({
      route_run_id: route.routeRunId,
      route_assignment: { driver_user_id: owner.driverUserId },
    });
    expect(readback.manifest.stops).toEqual(expect.arrayContaining([
      expect.objectContaining({
        route_stop_id: route.routeStopId,
        shipment_id: shipment.shipmentId,
        task: expect.objectContaining({ task_id: route.routeStopTaskId, assigned_to: owner.driverUserId }),
      }),
    ]));

    const timeline = (shipmentId) => client.query(
      'SELECT api.ui_get_shipment_timeline_v1($1::uuid) AS timeline',
      [shipmentId],
    );
    await setAuthContext(client, ownerReader);
    expect((await timeline(shipment.shipmentId)).rows[0].timeline.shipment_id).toBe(shipment.shipmentId);
    await setAuthContext(client, foreignReader);
    expect((await timeline(foreignShipment.shipmentId)).rows[0].timeline.shipment_id)
      .toBe(foreignShipment.shipmentId);
    await expect(timeline(shipment.shipmentId)).rejects.toThrow(/not found or inaccessible/i);
  });

  test('console shipment creation, driver delivery completion, and portal verification stay aligned', async () => {
    const attemptOutcomes = await fetchLookupValues(client, 'attempt_outcome');
    const routeRunStatuses = await fetchLookupValues(client, 'route_run_status');
    const routeStopKinds = await fetchLookupValues(client, 'route_stop_kind');
    const completionKinds = await fetchLookupValues(client, 'delivery_completion_kind');
    const handoverModes = await fetchLookupValues(client, 'delivery_handover_mode');

    const deliveredOutcome = attemptOutcomes.find((entry) => entry.value === 'delivered');
    const inProgressRouteStatus = routeRunStatuses.find((entry) => entry.value === 'in_progress');
    const plannedRouteStatus = routeRunStatuses.find((entry) => entry.value === 'planned');
    const completedRouteStatus = routeRunStatuses.find((entry) => entry.value === 'completed');
    const deliveryStopKind = routeStopKinds.find((entry) => entry.value === 'delivery');
    const fullCompletionKind = completionKinds.find((entry) => entry.value === 'full');
    const namedRecipientMode = handoverModes.find((entry) => entry.value === 'named_recipient');

    expect(deliveredOutcome?.value).toBeTruthy();
    expect(inProgressRouteStatus?.value).toBeTruthy();
    expect(plannedRouteStatus?.value).toBeTruthy();
    expect(completedRouteStatus?.value).toBeTruthy();
    expect(deliveryStopKind?.value).toBeTruthy();
    expect(fullCompletionKind?.value).toBeTruthy();
    expect(namedRecipientMode?.value).toBeTruthy();

    const actors = await createCrossSurfaceActors(client, 'Cross Surface Delivery');
    const isolationActors = await createCrossSurfaceActors(client, 'Cross Surface Delivery Isolation');

    const shipment = await createShipmentViaUi(client, {
      organizationId: actors.organizationId,
      clientId: actors.clientId,
      senderId: actors.senderId,
      userId: actors.operatorUserId,
      metadata: {
        source: 'integration.cross-surface-delivery',
        surface: 'console',
      },
    });

    expect(String(shipment.shipmentId || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(String(shipment.workflowRunId || '')).toMatch(/^[0-9a-f-]{36}$/i);

    const routeExecution = await seedRouteRunWorkflowForShipment(client, {
      organizationId: actors.organizationId,
      clientId: actors.clientId,
      shipmentId: shipment.shipmentId,
      userId: actors.operatorUserId,
      stopKind: deliveryStopKind.value,
    });

    expect(String(routeExecution.routeRunId || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(String(routeExecution.routeStopId || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(String(routeExecution.routeStopTaskId || '')).toMatch(/^[0-9a-f-]{36}$/i);

    const assignment = await assignRouteRunToDriver(client, {
      organizationId: actors.organizationId,
      userId: actors.operatorUserId,
      routeRunId: routeExecution.routeRunId,
      driverUserId: actors.driverUserId,
      vehicleId: actors.vehicleId,
    });
    expect(assignment?.status).toBe('assigned');

    const driverShiftId = await openDriverShiftSession(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      branchId: actors.branchId,
      metadata: {
        source: 'integration.cross-surface-delivery',
        surface: 'fieldops',
      },
    });
    expect(String(driverShiftId || '')).toMatch(/^[0-9a-f-]{36}$/i);

    const routeStart = await markRouteRunInProgress(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      routeRunId: routeExecution.routeRunId,
      status: inProgressRouteStatus.value,
      metadata: {
        title: 'Cross Surface Delivery',
        reference: 'Assigned route',
        place: 'Riyadh',
      },
    });
    expect(routeStart?.status).toBe(inProgressRouteStatus.value);

    await transitionTaskAsUser(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      taskId: routeExecution.routeStopTaskId,
      toStatus: 'in_progress',
      statusReason: 'en_route',
      payload: {
        ops_session_id: driverShiftId,
        source: 'integration.cross-surface-delivery',
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
        source: 'integration.cross-surface-delivery',
      },
    });

    const signatureArtifactId = await registerMobileArtifact(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      taskId: routeExecution.routeStopTaskId,
      artifactKind: 'signature',
      metadata: {
        source: 'integration.cross-surface-delivery',
      },
    });
    const photoArtifactId = await registerMobileArtifact(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      taskId: routeExecution.routeStopTaskId,
      artifactKind: 'photo',
      metadata: {
        source: 'integration.cross-surface-delivery',
      },
    });

    const deliveryCompletion = await completeRouteStopTask(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      taskId: routeExecution.routeStopTaskId,
      routeStopId: routeExecution.routeStopId,
      outcomeReason: deliveredOutcome.value,
      payload: {
        ops_session_id: driverShiftId,
        handover_mode: namedRecipientMode.value,
        recipient_name: 'Cross Surface QA',
        recipient_class: 'customer',
        otp_code: '1234',
        recipient_identity_kind: 'national_id',
        recipient_identity_last4: '6789',
        completion_notes: 'Delivered through cross-surface contract coverage.',
        signature_artifact_id: signatureArtifactId,
        artifact_ids: [signatureArtifactId, photoArtifactId],
        pod: {
          captured_at: new Date().toISOString(),
          geostamp: {
            latitude: 24.7136,
            longitude: 46.6753,
            accuracy_m: 9,
          },
          signature_artifact_id: signatureArtifactId,
          artifact_ids: [signatureArtifactId, photoArtifactId],
          otp_code: '1234',
          recipient_identity_kind: 'national_id',
          recipient_identity_last4: '6789',
        },
        source: 'integration.cross-surface-delivery',
        run: randomBytes(8).toString('hex'),
      },
    });

    expect(String(deliveryCompletion.domainEventId || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(String(deliveryCompletion.finalizeWorkflowId || '')).toMatch(/^[0-9a-f-]{36}$/i);

    await setServiceContext(client, actors.organizationId, actors.operatorUserId);

    const { rows: routeRunRows } = await client.query(
      `SELECT status
         FROM public.route_runs
        WHERE id = $1::uuid`,
      [routeExecution.routeRunId],
    );
    expect(routeRunRows[0]?.status).toBe(completedRouteStatus.value);

    const { rows: shipmentRows } = await client.query(
      `SELECT status
         FROM public.shipments
        WHERE id = $1::uuid
          AND client_id = $2::uuid
        LIMIT 1`,
      [shipment.shipmentId, actors.clientId],
    );
    expect(shipmentRows[0]?.status).toBe(deliveredOutcome.value);

    const { rows: shipmentActionRows } = await client.query(
      `SELECT
         id,
         action_type,
         performed_by_user_id,
         pod_otp_confirmed,
         pod_otp_last4,
         pod_identity_kind,
         pod_identity_last4,
         action_data
        FROM public.shipment_actions
       WHERE shipment_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT 1`,
      [shipment.shipmentId],
    );
    expect(shipmentActionRows).toHaveLength(1);
    expect(shipmentActionRows[0]?.action_type).toBe('status_change');
    expect(shipmentActionRows[0]?.performed_by_user_id).toBe(actors.driverUserId);
    expect(shipmentActionRows[0]?.pod_otp_confirmed).toBe(true);
    expect(shipmentActionRows[0]?.pod_otp_last4).toBe('1234');
    expect(shipmentActionRows[0]?.pod_identity_kind).toBe('national_id');
    expect(shipmentActionRows[0]?.pod_identity_last4).toBe('6789');
    expect(
      shipmentActionRows[0]?.action_data?.delivery_completion?.completion_kind,
    ).toBe(fullCompletionKind.value);
    expect(
      shipmentActionRows[0]?.action_data?.task_event_payload?.handover_mode,
    ).toBe(namedRecipientMode.value);

    const { rows: createDecisionRows } = await client.query(
      `SELECT step_status, decision_log_id
         FROM public.workflow_run_steps
        WHERE workflow_run_id = $1::uuid
        ORDER BY sequence_order
        LIMIT 1`,
      [shipment.workflowRunId],
    );
    expect(createDecisionRows[0]?.step_status).toBe('completed');
    expect(createDecisionRows[0]?.decision_log_id).toBeTruthy();

    const { rows: finalizeDecisionRows } = await client.query(
      `SELECT step_status, decision_log_id
         FROM public.workflow_run_steps
        WHERE workflow_run_id = $1::uuid
        ORDER BY sequence_order DESC
        LIMIT 1`,
      [deliveryCompletion.finalizeWorkflowId],
    );
    expect(finalizeDecisionRows[0]?.step_status).toBe('completed');
    expect(finalizeDecisionRows[0]?.decision_log_id).toBeTruthy();

    const { rows: decisionCountRows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM public.decision_log
        WHERE organization_id = $1::uuid
          AND (
            correlation_id = $2::uuid
            OR id = $3::uuid
            OR id = $4::uuid
          )`,
      [
        actors.organizationId,
        shipment.correlationId,
        createDecisionRows[0]?.decision_log_id,
        finalizeDecisionRows[0]?.decision_log_id,
      ],
    );
    expect(Number(decisionCountRows[0]?.count || 0)).toBeGreaterThanOrEqual(2);

    const portalShipmentList = await listUiResource(client, {
      organizationId: actors.organizationId,
      userId: actors.portalUserId,
      resourceKey: 'shipments',
      filters: { identifier: shipment.trackingNumber },
      limit: 10,
    });
    const portalItems = Array.isArray(portalShipmentList?.items) ? portalShipmentList.items : [];
    expect(Number(portalShipmentList?.total || 0)).toBeGreaterThanOrEqual(1);
    expect(portalItems.some((item) => item?.id === shipment.shipmentId)).toBe(true);

    const timeline = await getShipmentTimeline(client, {
      organizationId: actors.organizationId,
      userId: actors.portalUserId,
      shipmentId: shipment.shipmentId,
    });
    const timelineEvents = Array.isArray(timeline?.timeline_events) ? timeline.timeline_events : [];
    expect(timeline?.shipment_id).toBe(shipment.shipmentId);
    expect(
      timelineEvents.some(
        (event) =>
          event?.event_source === 'shipment_action'
          && event?.event_type === 'status_change'
          && event?.status === deliveredOutcome.value,
      ),
    ).toBe(true);
    expect(
      timelineEvents.some(
        (event) =>
          event?.event_source === 'decision_log'
          && ['route_stop_finalize', 'workflow_completion'].includes(
            String(event?.metadata?.decision_point || ''),
          ),
      ),
    ).toBe(true);

    const podAssets = await listShipmentPodAssets(client, {
      organizationId: actors.organizationId,
      userId: actors.portalUserId,
      shipmentId: shipment.shipmentId,
    });
    expect(podAssets.map((entry) => entry.artifact_id)).toEqual(
      expect.arrayContaining([signatureArtifactId, photoArtifactId]),
    );

    const isolationList = await listUiResource(client, {
      organizationId: isolationActors.organizationId,
      userId: isolationActors.portalUserId,
      resourceKey: 'shipments',
      filters: { identifier: shipment.trackingNumber },
      limit: 10,
    });
    expect(Number(isolationList?.total || 0)).toBe(0);

    await expect(
      getShipmentTimeline(client, {
        organizationId: isolationActors.organizationId,
        userId: isolationActors.portalUserId,
        shipmentId: shipment.shipmentId,
      }),
    ).rejects.toThrow(/not found or inaccessible/i);
  });

  test('import-created shipment can use the same delivery completion and visibility path', async () => {
    const attemptOutcomes = await fetchLookupValues(client, 'attempt_outcome');
    const routeRunStatuses = await fetchLookupValues(client, 'route_run_status');
    const routeStopKinds = await fetchLookupValues(client, 'route_stop_kind');
    const completionKinds = await fetchLookupValues(client, 'delivery_completion_kind');
    const handoverModes = await fetchLookupValues(client, 'delivery_handover_mode');

    const deliveredOutcome = attemptOutcomes.find((entry) => entry.value === 'delivered');
    const inProgressRouteStatus = routeRunStatuses.find((entry) => entry.value === 'in_progress');
    const completedRouteStatus = routeRunStatuses.find((entry) => entry.value === 'completed');
    const deliveryStopKind = routeStopKinds.find((entry) => entry.value === 'delivery');
    const fullCompletionKind = completionKinds.find((entry) => entry.value === 'full');
    const namedRecipientMode = handoverModes.find((entry) => entry.value === 'named_recipient');

    expect(deliveredOutcome?.value).toBeTruthy();
    expect(inProgressRouteStatus?.value).toBeTruthy();
    expect(completedRouteStatus?.value).toBeTruthy();
    expect(deliveryStopKind?.value).toBeTruthy();
    expect(fullCompletionKind?.value).toBeTruthy();
    expect(namedRecipientMode?.value).toBeTruthy();

    const actors = await createCrossSurfaceActors(client, 'Cross Surface Import Delivery');
    const isolationActors = await createCrossSurfaceActors(client, 'Cross Surface Import Isolation');

    const shipment = await createShipmentViaTabularImport(client, {
      organizationId: actors.organizationId,
      clientId: actors.clientId,
      senderId: actors.senderId,
      userId: actors.operatorUserId,
      metadata: {
        source: 'integration.cross-surface-delivery',
        source_origin: 'tabular_import',
      },
    });

    expect(String(shipment.shipmentId || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(String(shipment.workflowRunId || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(shipment.result?.metadata?.created_by).toBe('workflow');

    const routeExecution = await seedRouteRunWorkflowForShipment(client, {
      organizationId: actors.organizationId,
      clientId: actors.clientId,
      shipmentId: shipment.shipmentId,
      userId: actors.operatorUserId,
      stopKind: deliveryStopKind.value,
    });

    const assignment = await assignRouteRunToDriver(client, {
      organizationId: actors.organizationId,
      userId: actors.operatorUserId,
      routeRunId: routeExecution.routeRunId,
      driverUserId: actors.driverUserId,
      vehicleId: actors.vehicleId,
    });
    expect(assignment?.status).toBe('assigned');

    const driverShiftId = await openDriverShiftSession(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      branchId: actors.branchId,
      metadata: {
        source: 'integration.cross-surface-delivery',
        source_origin: 'tabular_import',
      },
    });

    const routeStart = await markRouteRunInProgress(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      routeRunId: routeExecution.routeRunId,
      status: inProgressRouteStatus.value,
      metadata: {
        title: 'Cross Surface Import Delivery',
        reference: shipment.trackingNumber,
        place: 'Riyadh',
      },
    });
    expect(routeStart?.status).toBe(inProgressRouteStatus.value);

    await transitionTaskAsUser(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      taskId: routeExecution.routeStopTaskId,
      toStatus: 'in_progress',
      statusReason: 'en_route',
      payload: {
        ops_session_id: driverShiftId,
        source: 'integration.cross-surface-delivery',
        source_origin: 'tabular_import',
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
        source: 'integration.cross-surface-delivery',
        source_origin: 'tabular_import',
      },
    });

    const signatureArtifactId = await registerMobileArtifact(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      taskId: routeExecution.routeStopTaskId,
      artifactKind: 'signature',
      metadata: {
        source: 'integration.cross-surface-delivery',
        source_origin: 'tabular_import',
      },
    });
    const photoArtifactId = await registerMobileArtifact(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      taskId: routeExecution.routeStopTaskId,
      artifactKind: 'photo',
      metadata: {
        source: 'integration.cross-surface-delivery',
        source_origin: 'tabular_import',
      },
    });

    const deliveryCompletion = await completeRouteStopTask(client, {
      organizationId: actors.organizationId,
      userId: actors.driverUserId,
      taskId: routeExecution.routeStopTaskId,
      routeStopId: routeExecution.routeStopId,
      outcomeReason: deliveredOutcome.value,
      payload: {
        ops_session_id: driverShiftId,
        handover_mode: namedRecipientMode.value,
        recipient_name: 'Import Delivery QA',
        recipient_class: 'customer',
        otp_code: '4321',
        recipient_identity_kind: 'national_id',
        recipient_identity_last4: '9876',
        completion_notes: 'Delivered from import-created same-entity coverage.',
        signature_artifact_id: signatureArtifactId,
        artifact_ids: [signatureArtifactId, photoArtifactId],
        pod: {
          captured_at: new Date().toISOString(),
          geostamp: {
            latitude: 24.7136,
            longitude: 46.6753,
            accuracy_m: 9,
          },
          signature_artifact_id: signatureArtifactId,
          artifact_ids: [signatureArtifactId, photoArtifactId],
          otp_code: '4321',
          recipient_identity_kind: 'national_id',
          recipient_identity_last4: '9876',
        },
        source: 'integration.cross-surface-delivery',
        source_origin: 'tabular_import',
        run: randomBytes(8).toString('hex'),
      },
    });

    expect(String(deliveryCompletion.finalizeWorkflowId || '')).toMatch(/^[0-9a-f-]{36}$/i);

    await setServiceContext(client, actors.organizationId, actors.operatorUserId);

    const { rows: routeRunRows } = await client.query(
      `SELECT status
         FROM public.route_runs
        WHERE id = $1::uuid`,
      [routeExecution.routeRunId],
    );
    expect(routeRunRows[0]?.status).toBe(completedRouteStatus.value);

    const { rows: shipmentRows } = await client.query(
      `SELECT status, metadata
         FROM public.shipments
        WHERE id = $1::uuid
          AND client_id = $2::uuid
        LIMIT 1`,
      [shipment.shipmentId, actors.clientId],
    );
    expect(shipmentRows[0]?.status).toBe(deliveredOutcome.value);
    expect(shipmentRows[0]?.metadata?.workflow_run_id).toBe(shipment.workflowRunId);

    const { rows: shipmentActionRows } = await client.query(
      `SELECT action_type, performed_by_user_id, action_data
         FROM public.shipment_actions
        WHERE shipment_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      [shipment.shipmentId],
    );
    expect(shipmentActionRows[0]?.action_type).toBe('status_change');
    expect(shipmentActionRows[0]?.performed_by_user_id).toBe(actors.driverUserId);
    expect(
      shipmentActionRows[0]?.action_data?.delivery_completion?.completion_kind,
    ).toBe(fullCompletionKind.value);

    const portalShipmentList = await listUiResource(client, {
      organizationId: actors.organizationId,
      userId: actors.portalUserId,
      resourceKey: 'shipments',
      filters: { identifier: shipment.trackingNumber },
      limit: 10,
    });
    const portalItems = Array.isArray(portalShipmentList?.items) ? portalShipmentList.items : [];
    expect(portalItems.some((item) => item?.id === shipment.shipmentId)).toBe(true);

    const timeline = await getShipmentTimeline(client, {
      organizationId: actors.organizationId,
      userId: actors.portalUserId,
      shipmentId: shipment.shipmentId,
    });
    const timelineEvents = Array.isArray(timeline?.timeline_events) ? timeline.timeline_events : [];
    expect(timeline?.shipment_id).toBe(shipment.shipmentId);
    expect(
      timelineEvents.some(
        (event) =>
          event?.event_source === 'shipment_action'
          && event?.event_type === 'status_change'
          && event?.status === deliveredOutcome.value,
      ),
    ).toBe(true);

    const isolationList = await listUiResource(client, {
      organizationId: isolationActors.organizationId,
      userId: isolationActors.portalUserId,
      resourceKey: 'shipments',
      filters: { identifier: shipment.trackingNumber },
      limit: 10,
    });
    expect(Number(isolationList?.total || 0)).toBe(0);
  });

  test('webhook-created shipment can use the same delivery completion and visibility path', async () => {
    const actors = await createCrossSurfaceActors(client, 'Cross Surface Webhook Delivery');
    const isolationActors = await createCrossSurfaceActors(client, 'Cross Surface Webhook Isolation');

    const shipment = await createShipmentViaWebhookIntake(client, {
      organizationId: actors.organizationId,
      clientId: actors.clientId,
      senderId: actors.senderId,
      userId: actors.operatorUserId,
    });

    expect(String(shipment.shipmentId || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(String(shipment.workflowRunId || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(String(shipment.intakeWorkflowRunId || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(String(shipment.webhookId || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(shipment.response?.canonical_intent).toBe('shipment.create');
    expect(shipment.plannedShipmentId).toBe(shipment.shipmentId);
    expect(shipment.plannedTrackingNumber).toBe(shipment.trackingNumber);

    await setServiceContext(client, actors.organizationId, actors.operatorUserId);

    const { rows: webhookRows } = await client.query(
      `SELECT
         event_type,
         workflow_run_id,
         idempotency_key,
         policy_scope_type,
         transformed_payload
        FROM public.webhook_inbox
       WHERE id = $1::uuid`,
      [shipment.webhookId],
    );
    expect(webhookRows[0]?.event_type).toBe('shipment.created');
    expect(webhookRows[0]?.workflow_run_id).toBe(shipment.intakeWorkflowRunId);
    expect(webhookRows[0]?.idempotency_key).toMatch(/^evt-cross-surface-webhook-/);
    expect(webhookRows[0]?.policy_scope_type).toBe('source');
    expect(webhookRows[0]?.transformed_payload?.shipment?.source_origin).toBe('webhook');

    const { rows: workflowRows } = await client.query(
      `SELECT metadata, context
         FROM public.workflow_runs
        WHERE id = $1::uuid`,
      [shipment.workflowRunId],
    );
    expect(workflowRows[0]?.metadata?.started_by_run_id).toBe(shipment.intakeWorkflowRunId);
    expect(workflowRows[0]?.context?.webhook_id).toBe(shipment.webhookId);
    expect(workflowRows[0]?.context?.planned_shipment_id).toBe(shipment.shipmentId);

    const { rows: shipmentRows } = await client.query(
      `SELECT metadata
         FROM public.shipments
        WHERE id = $1::uuid
        LIMIT 1`,
      [shipment.shipmentId],
    );
    expect(shipmentRows[0]?.metadata?.created_by).toBe('workflow');
    expect(shipmentRows[0]?.metadata?.workflow_run_id).toBe(shipment.workflowRunId);
    expect(shipmentRows[0]?.metadata?.source_webhook_id).toBe(shipment.webhookId);

    const { rows: createStepRows } = await client.query(
      `SELECT step_status, decision_log_id
         FROM public.workflow_run_steps
        WHERE workflow_run_id = $1::uuid
          AND handler_key = 'shipment_create'
        LIMIT 1`,
      [shipment.workflowRunId],
    );
    expect(createStepRows[0]?.step_status).toBe('completed');
    expect(createStepRows[0]?.decision_log_id).toBeTruthy();

    await completeAndVerifyDeliveryPath(client, {
      actors,
      isolationActors,
      shipment,
      sourceOrigin: 'webhook',
      title: 'Cross Surface Webhook Delivery',
      recipientName: 'Webhook Delivery QA',
      otpCode: '2468',
      identityLast4: '1357',
    });
  });
});
