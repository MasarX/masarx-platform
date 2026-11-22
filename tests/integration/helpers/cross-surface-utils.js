const { randomBytes, randomUUID } = require('crypto');

function getTenantUtils() {
  return require('./tenant-utils');
}

function getDomainEventHelpers() {
  return require('./domain-event-waiter');
}

function getWorkflowHelpers() {
  return require('./workflow-test-utils');
}

function parseRpcResult(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid payload`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setServiceContext(client, organizationId, userId) {
  await client.query('SET LOCAL ROLE service_role');
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [String(userId)]);
  await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`);
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({
      sub: String(userId),
      role: 'service_role',
      organization_id: String(organizationId),
    }),
  ]);
}

async function fetchLookupValues(client, category) {
  const { rows } = await client.query(
    `SELECT lv.value, lv.label, lv.metadata, lv.sort_order
       FROM public.lookup_definitions ld
       JOIN public.lookup_values lv
         ON lv.lookup_definition_id = ld.id
      WHERE ld.category = $1
        AND COALESCE(lv.status, 'active') = 'active'
      ORDER BY lv.sort_order NULLS LAST, lv.value`,
    [category],
  );
  return rows;
}

async function fetchLookupValue(client, category, value) {
  const { rows } = await client.query(
    `SELECT lv.value, lv.label, lv.metadata
       FROM public.lookup_definitions ld
       JOIN public.lookup_values lv
         ON lv.lookup_definition_id = ld.id
      WHERE ld.category = $1
        AND lv.value = $2
        AND COALESCE(lv.status, 'active') = 'active'
      LIMIT 1`,
    [category, value],
  );
  const row = rows[0] ?? null;
  if (!row) {
    throw new Error(`lookup ${category}:${value} not found`);
  }
  return row;
}

async function runDomainEventsWorkerOnce(client) {
  const { processPendingDomainEvents } = getDomainEventHelpers();
  return processPendingDomainEvents(client);
}

async function waitForDomainEventWorkflowRun(client, domainEventId, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 50);
  const pollIntervalMs = Number(options.pollIntervalMs || 250);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await runDomainEventsWorkerOnce(client);
    const { rows } = await client.query(
      `SELECT workflow_run_id
         FROM public.domain_events
        WHERE id = $1::uuid`,
      [domainEventId],
    );
    const workflowRunId = rows[0]?.workflow_run_id ?? null;
    if (workflowRunId) {
      return workflowRunId;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`domain event ${domainEventId} did not attach a workflow run`);
}

async function progressWorkflowFully(client, workflowRunId, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 30);
  const initialPayload = options.initialPayload ?? null;
  let lastResult = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const payload = attempt === 0 && initialPayload ? initialPayload : {};
    const { rows } = await client.query(
      `SELECT public.progress_workflow_run($1::uuid, $2::jsonb) AS result`,
      [workflowRunId, JSON.stringify(payload)],
    );
    const result = rows[0]?.result ?? null;
    lastResult = result;
    if (!result?.step_id) break;
    if (result.status === 'failed') break;
    if (result.status === 'waiting') break;
  }

  return lastResult;
}

async function progressWorkflowUntilSettled(client, workflowRunId, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 50);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { rows } = await client.query(
      `SELECT public.progress_workflow_run($1::uuid) AS result`,
      [workflowRunId],
    );
    const result = rows[0]?.result ?? null;
    if (!result?.step_id) {
      return result;
    }
    if (result.status === 'failed') {
      throw new Error(`workflow run ${workflowRunId} failed while progressing route-stop side effects`);
    }
  }

  throw new Error(`workflow run ${workflowRunId} did not settle after ${maxAttempts} progress attempts`);
}

async function createCrossSurfaceActors(client, label) {
  const {
    createClient,
    createOrganization,
    createSender,
    createUser,
  } = getTenantUtils();
  const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const organization = await createOrganization(client, `${label} Org`, {
    slug: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${suffix}`,
  });
  const clientRecord = await createClient(client, organization.id, `${label} Client`, {
    slug: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-client-${suffix}`,
  });
  const senderId = await createSender(client, clientRecord.id, `${label} Sender`, {
    brandName: `${label} Sender`,
  });
  const operatorUserId = await createUser(
    client,
    organization.id,
    `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-ops-${suffix}@example.com`,
    { accessScopeType: 'tenant', userType: 'ops_admin', rbacTemplateKey: 'ops_admin' },
  );
  const driverUserId = await createUser(
    client,
    organization.id,
    `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-driver-${suffix}@example.com`,
    { accessScopeType: 'tenant', userType: 'driver', rbacTemplateKey: 'driver' },
  );
  const portalUserId = await createUser(
    client,
    organization.id,
    `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-portal-${suffix}@example.com`,
    { accessScopeType: 'tenant', userType: 'ops_admin', rbacTemplateKey: 'ops_admin' },
  );
  const { rows: branchRows } = await client.query(
    `INSERT INTO public.branches (organization_id, code, name, timezone, is_active)
     VALUES ($1::uuid, $2, $3, 'Asia/Riyadh', true)
     RETURNING id`,
    [organization.id, `cs-${suffix.slice(0, 8)}`, `${label} Branch`],
  );
  const { rows: vehicleRows } = await client.query(
    `INSERT INTO public.vehicles (organization_id, plate_number, status, is_active)
     VALUES ($1::uuid, $2, 'active', true)
     RETURNING id`,
    [organization.id, `CS-${suffix.slice(0, 8).toUpperCase()}`],
  );

  return {
    organizationId: organization.id,
    clientId: clientRecord.id,
    senderId,
    operatorUserId,
    driverUserId,
    portalUserId,
    branchId: branchRows[0]?.id ?? null,
    vehicleId: vehicleRows[0]?.id ?? null,
  };
}

async function createShipmentViaUi(client, input) {
  const { setAuthContext } = getTenantUtils();
  await setAuthContext(client, input.userId, {
    organization_id: input.organizationId,
  });

  const trackingNumber =
    input.trackingNumber
    || `CS-${Date.now()}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const clientReferenceNumber =
    input.clientReferenceNumber
    || `CS-REF-${Date.now()}-${randomBytes(2).toString('hex').toUpperCase()}`;

  const { rows } = await client.query(
    `SELECT public.ui_create_shipment_v1(
       $1::uuid,
       $2::uuid,
       $3::text,
       $4::text,
       $5::text,
       NULL,
       $6::text,
       $7::jsonb
     ) AS result`,
    [
      input.clientId,
      input.senderId,
      input.serviceType || 'delivery',
      trackingNumber,
      clientReferenceNumber,
      input.initialStatus || 'pending',
      JSON.stringify(input.metadata || {}),
    ],
  );

  const result = parseRpcResult(rows[0]?.result, 'ui_create_shipment_v1');
  return {
    shipmentId: result.shipment_id,
    workflowRunId: result.workflow_run_id ?? null,
    correlationId: result.correlation_id ?? null,
    trackingNumber,
    clientReferenceNumber,
    result,
  };
}

async function createShipmentViaTabularImport(client, input) {
  const { setAuthContext } = getTenantUtils();
  await setAuthContext(client, input.userId, {
    organization_id: input.organizationId,
    scope_type: 'tenant',
    scope_id: input.organizationId,
  });

  const trackingNumber =
    input.trackingNumber
    || `CS-IMPORT-${Date.now()}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const clientReferenceNumber =
    input.clientReferenceNumber
    || `CS-IMP-REF-${Date.now()}-${randomBytes(2).toString('hex').toUpperCase()}`;
  const recipientName = input.recipientName || 'Cross Surface Import Recipient';
  const recipientPhone = input.recipientPhone || `+9665${randomBytes(4).toString('hex').slice(0, 8)}`;
  const addressLine1 = input.addressLine1 || '742 Import Flow Street';
  const city = input.city || 'Riyadh';
  const province = input.province || 'Riyadh';
  const postalCode = input.postalCode || '11564';
  const country = input.country || 'SA';

  const { rows: prepareRows } = await client.query(
    `SELECT public.tabular_import_prepare_v1($1::jsonb) AS run`,
    [
      JSON.stringify({
        resource_key: 'shipments',
        source_format: 'csv',
        source_file_name: input.sourceFileName || `cross-surface-${Date.now()}.csv`,
        header_fingerprint:
          'tracking_number|client_reference_number|recipient_name|recipient_phone|address_line_1|city|postal_code|country',
        scope_context: {
          tenant: input.organizationId,
          client: input.clientId,
          sender: input.senderId,
        },
        headers: [
          'Tracking Number',
          'Client Reference Number',
          'Recipient Name',
          'Recipient Phone',
          'Address Line 1',
          'City',
          'Postal Code',
          'Country',
        ],
        rules: [
          { source_column: 'Tracking Number', target_field: 'tracking_number', enabled: true },
          {
            source_column: 'Client Reference Number',
            target_field: 'client_reference_number',
            enabled: true,
          },
          {
            target_field: 'service_type',
            value_mode: 'fixed',
            fixed_value: input.serviceType || 'delivery',
            enabled: true,
          },
          {
            target_field: 'status',
            value_mode: 'fixed',
            fixed_value: input.initialStatus || 'pending',
            enabled: true,
          },
          { source_column: 'Recipient Name', target_field: 'recipient.name', enabled: true },
          {
            source_column: 'Recipient Phone',
            target_field: 'recipient.phone_number',
            enabled: true,
          },
          {
            source_column: 'Address Line 1',
            target_field: 'destination_address.raw_input',
            enabled: true,
          },
          {
            source_column: 'Address Line 1',
            target_field: 'destination_address.normalized_line1',
            enabled: true,
          },
          { source_column: 'City', target_field: 'destination_address.city', enabled: true },
          {
            target_field: 'destination_address.province',
            value_mode: 'fixed',
            fixed_value: province,
            enabled: true,
          },
          {
            source_column: 'Postal Code',
            target_field: 'destination_address.postal_code',
            enabled: true,
          },
          { source_column: 'Country', target_field: 'destination_address.country', enabled: true },
        ],
        rows: [
          {
            'Tracking Number': trackingNumber,
            'Client Reference Number': clientReferenceNumber,
            'Recipient Name': recipientName,
            'Recipient Phone': recipientPhone,
            'Address Line 1': addressLine1,
            City: city,
            'Postal Code': postalCode,
            Country: country,
          },
        ],
      }),
    ],
  );

  const preparedRun = parseRpcResult(prepareRows[0]?.run, 'tabular_import_prepare_v1');
  if (Number(preparedRun?.blocked_count || 0) > 0) {
    throw new Error(`tabular_import_prepare_v1 blocked cross-surface shipment import for ${trackingNumber}`);
  }

  await setServiceContext(client, input.organizationId, input.userId);

  const { rows: processRows } = await client.query(
    `SELECT public.process_tabular_import_run_v1($1::uuid, $2::int) AS run`,
    [preparedRun.run_id, 50],
  );
  const processedRun = parseRpcResult(processRows[0]?.run, 'process_tabular_import_run_v1');
  if (processedRun?.status !== 'completed') {
    throw new Error(`process_tabular_import_run_v1 did not complete for ${trackingNumber}`);
  }

  const { rows: shipmentRows } = await client.query(
    `SELECT id, client_reference_number
       FROM public.shipments
      WHERE client_id = $1::uuid
        AND tracking_number = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.clientId, trackingNumber],
  );
  const shipmentId = shipmentRows[0]?.id ?? null;
  if (!shipmentId) {
    throw new Error(`tabular import did not materialize shipment ${trackingNumber}`);
  }

  const { rows: importRunRows } = await client.query(
    `SELECT report_id
       FROM public.tabular_import_runs
      WHERE id = $1::uuid`,
    [preparedRun.run_id],
  );

  return {
    shipmentId,
    workflowRunId: null,
    correlationId: null,
    trackingNumber,
    clientReferenceNumber: shipmentRows[0]?.client_reference_number || clientReferenceNumber,
    importRunId: preparedRun.run_id,
    reportId: importRunRows[0]?.report_id ?? null,
    result: processedRun,
  };
}

async function createShipmentViaWebhookIntake(client, input) {
  const { upsertWebhookPolicy } = require('../../utils/policies');
  await setServiceContext(client, input.organizationId, input.userId);

  const suffix = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const mappingId = randomUUID();
  const sourceId = randomUUID();
  const token = input.token || `token-cross-surface-webhook-${suffix}`;
  const sourceIdentifier = input.sourceIdentifier || `cross-surface-webhook-${suffix}`;
  const eventId = input.eventId || `evt-cross-surface-webhook-${suffix}`;

  const { rows: templateRows } = await client.query(
    `SELECT id
       FROM public.workflow_templates
      WHERE name = $1
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC NULLS LAST
      LIMIT 1`,
    [input.followupTemplateName || 'async_provider_dispatch_v1'],
  );
  const followupTemplateId = templateRows[0]?.id ?? null;
  if (!followupTemplateId) {
    throw new Error('async_provider_dispatch_v1 workflow template is required for webhook shipment creation proof');
  }

  await client.query(
    `INSERT INTO public.mapping_configs (
       id,
       mapping_type,
       mapping_key,
       mapping_config,
       mapping_version,
       notes
     )
     VALUES (
       $1::uuid,
       'webhook_inbound',
       $2::text,
       $3::jsonb,
       1,
       'cross-surface webhook shipment creation proof'
     )`,
    [
      mappingId,
      `${sourceIdentifier}::shipment.created`,
      JSON.stringify({
        description: 'Cross-surface webhook shipment creation proof mapping',
        external_id_path: 'event.id',
        context_patch: {},
      }),
    ],
  );

  await client.query(
    `INSERT INTO public.webhook_sources (
       id,
       organization_id,
       source_identifier,
       name,
       provider_type,
       auth_token,
       mapping_config_id,
       sender_id,
       rate_limit_per_hour,
       enabled
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3::text,
       $4::text,
       'provider',
       $5::text,
       $6::uuid,
       $7::uuid,
       1000,
       TRUE
     )`,
    [
      sourceId,
      input.organizationId,
      sourceIdentifier,
      input.sourceName || 'Cross Surface Webhook Source',
      token,
      mappingId,
      input.senderId,
    ],
  );

  await upsertWebhookPolicy(
    'source',
    sourceId,
    {
      version: 1,
      ack: {
        mode: 'accepted_async',
        default_headers: {
          'cache-control': 'no-store',
        },
      },
      validation: {
        idempotency: {
          header: 'Idempotency-Key',
          body_path: 'event.id',
          required: true,
        },
      },
      workflow: {
        intent: 'shipment.create',
        template_id: followupTemplateId,
        launch_mode: 'in_background',
        context_patch: {
          service_type: input.serviceType || 'delivery',
          initial_status: input.initialStatus || 'pending',
          source_origin: 'webhook',
        },
      },
      logging: {
        decision_point: 'workflow_intake_ack',
      },
    },
    'cross-surface webhook shipment creation proof',
    client,
  );

  const payload = {
    event: {
      id: eventId,
      type: 'shipment.created',
    },
    shipment: {
      client_reference_number:
        input.clientReferenceNumber
        || `CS-WH-REF-${Date.now()}-${randomBytes(2).toString('hex').toUpperCase()}`,
      service_type: input.serviceType || 'delivery',
      source: 'integration.cross-surface-delivery',
      source_origin: 'webhook',
    },
  };
  const headers = {
    'content-type': 'application/json',
    'idempotency-key': eventId,
  };
  const rawBody = JSON.stringify(payload);

  const { rows } = await client.query(
    `SELECT public.workflow_intake_webhook(
       $1::text,
       $2::jsonb,
       $3::text,
       $4::jsonb
     ) AS response`,
    [token, JSON.stringify(headers), rawBody, JSON.stringify(payload)],
  );
  const response = parseRpcResult(rows[0]?.response, 'workflow_intake_webhook');
  if (Number(response.status) >= 400) {
    throw new Error(`workflow_intake_webhook failed: ${JSON.stringify(response)}`);
  }

  const plannedResource = response.body?.resource || {};
  const plannedShipmentId = plannedResource.id ?? null;
  const plannedTrackingNumber = plannedResource.tracking_number ?? null;
  const followupWorkflowRunId = response.followup_workflow_run_id || response.body?.followup_workflow_run_id || null;
  if (!followupWorkflowRunId) {
    throw new Error(`workflow_intake_webhook did not return a follow-up workflow run: ${JSON.stringify(response)}`);
  }
  if (!plannedShipmentId || !plannedTrackingNumber) {
    throw new Error(`workflow_intake_webhook did not return a planned shipment resource: ${JSON.stringify(response)}`);
  }

  let shipmentRow = null;
  let lastProgressResult = null;
  for (let attempt = 0; attempt < Number(input.maxProgressAttempts || 8); attempt += 1) {
    const { rows: shipmentRows } = await client.query(
      `SELECT id, tracking_number, metadata
         FROM public.shipments
        WHERE id = $1::uuid
           OR tracking_upper = upper($2::text)
        ORDER BY created_at DESC
        LIMIT 1`,
      [plannedShipmentId, plannedTrackingNumber],
    );
    shipmentRow = shipmentRows[0] ?? null;
    if (shipmentRow?.id) break;

    const { rows: progressRows } = await client.query(
      `SELECT public.progress_workflow_run($1::uuid) AS result`,
      [followupWorkflowRunId],
    );
    lastProgressResult = progressRows[0]?.result ?? null;
    if (lastProgressResult?.status === 'failed') {
      throw new Error(
        `webhook follow-up workflow ${followupWorkflowRunId} failed before shipment creation: ${JSON.stringify(lastProgressResult)}`,
      );
    }
  }

  if (!shipmentRow?.id) {
    throw new Error(
      `webhook follow-up workflow ${followupWorkflowRunId} did not materialize shipment ${plannedShipmentId}; last progress result ${JSON.stringify(lastProgressResult)}`,
    );
  }

  return {
    shipmentId: shipmentRow.id,
    workflowRunId: followupWorkflowRunId,
    intakeWorkflowRunId: response.workflow_run_id || response.body?.workflow_run_id || null,
    webhookId: response.webhook_id || null,
    correlationId: response.correlation_id || response.body?.correlation_id || null,
    trackingNumber: shipmentRow.tracking_number,
    plannedShipmentId,
    plannedTrackingNumber,
    response,
    result: shipmentRow,
  };
}

async function seedRouteRunWorkflowForShipment(client, input) {
  const { startWorkflowRun } = getWorkflowHelpers();
  await setServiceContext(client, input.organizationId, input.userId);
  const { workflowRunId } = await startWorkflowRun(client, 'dispatch_route_run_v1', {
    organization_id: input.organizationId,
    stops: [
      {
        client_id: input.clientId,
        shipment_id: input.shipmentId,
        stop_kind: input.stopKind || 'delivery',
        sequence_order: 1,
      },
    ],
  });

  await progressWorkflowFully(client, workflowRunId, { maxAttempts: 4 });

  const { rows } = await client.query(
    `SELECT
       rs.id AS route_stop_id,
       rs.route_run_id,
       t.id AS task_id
      FROM public.route_stops rs
      JOIN public.tasks t
        ON t.resource_type = 'route_stop'
       AND t.resource_id = rs.id
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
     WHERE rs.organization_id = $1::uuid
       AND rs.shipment_id = $2::uuid
       AND rs.client_id = $3::uuid
       AND tt.key = 'route_stop_execute'
     ORDER BY rs.created_at DESC, t.created_at DESC
     LIMIT 1`,
    [input.organizationId, input.shipmentId, input.clientId],
  );

  const row = rows[0] ?? null;
  if (!row?.route_run_id || !row?.route_stop_id || !row?.task_id) {
    throw new Error(`dispatch_route_run_v1 did not materialize the route stop task for ${input.shipmentId}`);
  }

  return {
    workflowRunId,
    routeRunId: row.route_run_id,
    routeStopId: row.route_stop_id,
    routeStopTaskId: row.task_id,
  };
}

async function assignRouteRunToDriver(client, input) {
  const { setAuthContext } = getTenantUtils();
  await setAuthContext(client, input.userId, {
    organization_id: input.organizationId,
  });
  const { rows } = await client.query(
    `SELECT api.ui_execute_route_run_assign_v1(
       $1::text,
       $2::text,
       $3::text[],
       $4::text,
       $5::integer,
       $6::jsonb
     ) AS payload`,
    [
      'routes.assign',
      'routes',
      [String(input.routeRunId)],
      String(input.routeRunId),
      1,
      JSON.stringify({
        driver_user_id: input.driverUserId,
        vehicle_id: input.vehicleId,
        idempotency_key: input.idempotencyKey || `cross-surface-assign-${randomUUID()}`,
      }),
    ],
  );
  return parseRpcResult(rows[0]?.payload, 'api.ui_execute_route_run_assign_v1');
}

async function markRouteRunInProgress(client, input) {
  await setServiceContext(client, input.organizationId, input.userId);
  const metadataPatch = input.metadata || {};
  const { rows } = await client.query(
    `UPDATE public.route_runs
        SET status = $2,
            started_at = COALESCE(started_at, now()),
            metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || $3::jsonb),
            updated_at = now()
      WHERE id = $1::uuid
      RETURNING id`,
    [input.routeRunId, input.status, JSON.stringify(metadataPatch)],
  );
  if (!rows[0]?.id) {
    throw new Error(`route run ${input.routeRunId} could not be moved to ${input.status}`);
  }
  return {
    routeRunId: rows[0].id,
    status: input.status,
  };
}

async function openDriverShiftSession(client, input) {
  const { setAuthContext } = getTenantUtils();
  await setAuthContext(client, input.userId, {
    organization_id: input.organizationId,
  });
  const { rows } = await client.query(
    `SELECT *
       FROM public.open_ops_session_v1($1::jsonb)`,
    [
      JSON.stringify({
        session_type: input.sessionType || 'driver_shift',
        branch_id: input.branchId ?? null,
        idempotency_key: input.idempotencyKey || `cross-surface-shift-${randomUUID()}`,
        metadata: input.metadata || {},
      }),
    ],
  );
  const opsSessionId = rows[0]?.ops_session_id ?? null;
  if (!opsSessionId) {
    throw new Error('open_ops_session_v1 did not return an ops_session_id');
  }
  return opsSessionId;
}

async function registerMobileArtifact(client, input) {
  const { setAuthContext } = getTenantUtils();
  await setAuthContext(client, input.userId, {
    organization_id: input.organizationId,
  });

  const artifactKind = input.artifactKind || 'photo';
  const extension = artifactKind === 'signature' ? 'svg' : 'jpg';
  const mimeType = artifactKind === 'signature' ? 'image/svg+xml' : 'image/jpeg';
  const sizeBytes = artifactKind === 'signature' ? 512 : 2048;

  const { rows } = await client.query(
    `SELECT artifact_id, created
       FROM public.register_mobile_artifact_v1($1::jsonb)`,
    [
      JSON.stringify({
        organization_id: input.organizationId,
        storage_bucket: input.storageBucket || 'fieldops-evidence',
        storage_key:
          input.storageKey
          || `${input.organizationId}/${input.taskId}/${artifactKind}-${randomBytes(6).toString('hex')}.${extension}`,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        metadata: {
          artifact_kind: artifactKind,
          ...(input.metadata || {}),
        },
      }),
    ],
  );

  const artifactId = rows[0]?.artifact_id ?? null;
  if (!artifactId) {
    throw new Error(`register_mobile_artifact_v1 did not return an artifact id for ${artifactKind}`);
  }
  return artifactId;
}

async function completeRouteStopTask(client, input) {
  const { setAuthContext } = getTenantUtils();
  await setAuthContext(client, input.userId, {
    organization_id: input.organizationId,
  });
  const { rows: taskEventRows } = await client.query(
    `SELECT task_id, task_event_id
       FROM public.transition_task_v1(
        $1::uuid,
        'completed',
        $2::text,
        $3::jsonb,
        $4::text
     )`,
    [
      input.taskId,
      input.outcomeReason,
      JSON.stringify(input.payload || {}),
      input.idempotencyKey || `cross-surface-complete-${randomUUID()}`,
    ],
  );
  const taskEventId = taskEventRows[0]?.task_event_id ?? null;
  if (!taskEventId) {
    throw new Error(`route stop ${input.routeStopId} completion did not return a task_event_id`);
  }

  const { rows: eventRows } = await client.query(
    `SELECT id
       FROM public.domain_events
      WHERE organization_id = $1::uuid
         AND event_type = 'task.completed.route_stop_execute'
         AND (payload->>'task_event_id') = $2
         AND resource_type = 'route_stop'
         AND resource_id = $3::uuid
       ORDER BY created_at DESC
       LIMIT 1`,
    [input.organizationId, String(taskEventId), input.routeStopId],
  );

  const domainEventId = eventRows[0]?.id ?? null;
  if (!domainEventId) {
    throw new Error(
      `route stop ${input.routeStopId} did not emit task.completed.route_stop_execute for task_event ${taskEventId}`,
    );
  }

  // Worker wake/progression is system-owned; switch back to service context
  // after the user-authenticated task transition has emitted the domain event.
  await setServiceContext(client, input.organizationId, input.userId);

  const finalizeWorkflowId = await waitForDomainEventWorkflowRun(client, domainEventId, {
    maxAttempts: input.maxAttempts || 50,
  });
  await progressWorkflowUntilSettled(client, finalizeWorkflowId, {
    maxAttempts: input.progressMaxAttempts || 50,
  });

  return {
    domainEventId,
    finalizeWorkflowId,
    taskEventId,
  };
}

async function transitionTaskAsUser(client, input) {
  const { setAuthContext } = getTenantUtils();
  await setAuthContext(client, input.userId, {
    organization_id: input.organizationId,
  });
  const { rows } = await client.query(
    `SELECT *
       FROM public.transition_task_v1(
       $1::uuid,
       $2::text,
       $3::text,
       $4::jsonb,
       $5::text
     )`,
    [
      input.taskId,
      input.toStatus,
      input.statusReason ?? null,
      JSON.stringify(input.payload || {}),
      input.idempotencyKey || `cross-surface-transition-${randomUUID()}`,
    ],
  );
  return parseRpcResult(rows[0], 'public.transition_task_v1');
}

async function listUiResource(client, input) {
  const { setAuthContext } = getTenantUtils();
  await setAuthContext(client, input.userId, {
    organization_id: input.organizationId,
  });
  const { rows } = await client.query(
    `SELECT public.ui_list_resource_v1(
       $1::text,
       $2::jsonb,
       $3::integer,
       $4::integer,
       $5::jsonb
     ) AS payload`,
    [
      input.resourceKey,
      JSON.stringify(input.filters || {}),
      input.limit ?? 25,
      input.offset ?? 0,
      input.sort ? JSON.stringify(input.sort) : null,
    ],
  );
  return rows[0]?.payload ?? null;
}

function getUiResourceItems(payload) {
  return Array.isArray(payload?.items) ? payload.items : [];
}

async function getShipmentTimeline(client, input) {
  const { setAuthContext } = getTenantUtils();
  await setAuthContext(client, input.userId, {
    organization_id: input.organizationId,
  });
  const { rows } = await client.query(
    `SELECT public.ui_get_shipment_timeline_v1($1::uuid) AS timeline`,
    [input.shipmentId],
  );
  return rows[0]?.timeline ?? null;
}

async function listShipmentPodAssets(client, input) {
  const { setAuthContext } = getTenantUtils();
  await setAuthContext(client, input.userId, {
    organization_id: input.organizationId,
  });
  const { rows } = await client.query(
    `SELECT * FROM public.ui_list_shipment_pod_assets_v1($1::uuid)`,
    [input.shipmentId],
  );
  return rows;
}

async function callMarketplaceRpcAsUser(client, input) {
  const { setAuthContext } = getTenantUtils();
  await setAuthContext(client, input.userId, {
    organization_id: input.organizationId,
  });
  const { rows } = await client.query(input.sql, input.params || []);
  return parseRpcResult(rows[0]?.result, input.label);
}

module.exports = {
  callMarketplaceRpcAsUser,
  completeRouteStopTask,
  createCrossSurfaceActors,
  createShipmentViaTabularImport,
  createShipmentViaUi,
  createShipmentViaWebhookIntake,
  fetchLookupValue,
  fetchLookupValues,
  getShipmentTimeline,
  getUiResourceItems,
  listShipmentPodAssets,
  listUiResource,
  openDriverShiftSession,
  parseRpcResult,
  progressWorkflowFully,
  registerMobileArtifact,
  runDomainEventsWorkerOnce,
  seedRouteRunWorkflowForShipment,
  setServiceContext,
  transitionTaskAsUser,
  waitForDomainEventWorkflowRun,
  assignRouteRunToDriver,
  markRouteRunInProgress,
};
