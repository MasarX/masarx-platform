const { randomUUID } = require("crypto");
const { Pool, Client } = require("pg");
const { loadEnv } = require("../../../scripts/utils/load-env");
const { applySetting, cleanupAutoOnboardingArtifacts } = require("../helpers/tenant-utils");
const { runIsolatedScheduleWorker } = require("../helpers/isolated-schedule-worker");

loadEnv();

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const WORKER_NAME = "workflow_schedule_triggers_worker";

describeIfDb("workflow schedule triggers: recurring shipment create", () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5000,
  });

  const createdShipments = [];
  const createdScheduleTriggers = [];
  const workflowRunIds = [];
  const insertedSettings = [];
  const createdUsers = [];

  let organizationId = null;
  let clientId = null;
  let senderId = null;
  let recurringTemplateId = null;
  let senderUserId = null;

  beforeAll(async () => {
    organizationId = randomUUID();
    clientId = randomUUID();
    senderId = randomUUID();
    senderUserId = randomUUID();

    const { rows: templateRows } = await pool.query(
      `SELECT id
         FROM workflow_templates
        WHERE name = 'recurring_shipment_create_v1'
        LIMIT 1`
    );
    recurringTemplateId = templateRows[0]?.id ?? null;
    if (!recurringTemplateId) {
      throw new Error("Expected workflow_templates.recurring_shipment_create_v1 to exist.");
    }

    await pool.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Recurring Shipment Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
      [organizationId, `recurring-shipment-org-${Date.now()}`]
    );

    await pool.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Recurring Shipment Client', $3, 'standard', 'active')`,
      [clientId, organizationId, `recurring-shipment-client-${Date.now()}`]
    );

    await pool.query(
      `INSERT INTO senders (id, client_id, name, status)
       VALUES ($1::uuid, $2::uuid, 'Recurring Shipment Sender', 'active')`,
      [senderId, clientId]
    );

    await pool.query(
      `INSERT INTO users (
         id,
         organization_id,
         email,
         full_name,
         user_type,
         access_scope_type,
         access_scope_id
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3,
         'Recurring Shipment Sender User',
         'sender_user',
         'sender',
         $4::uuid
       )`,
      [senderUserId, organizationId, `recurring-shipment-sender-${Date.now()}@example.com`, senderId]
    );
    createdUsers.push(senderUserId);

    const trackingPolicy = {
      version: 1,
      unique_scope: "client",
      alphabet: "BASE36",
      checksum: "iso7064_mod_37_36",
      prefix: { value: "RS", separator: "", max_len: 4 },
      sequence: { scope: "client", strategy: "pg_sequence", cache: 100, start: 1 },
      tokens: [{ type: "prefix" }, { type: "seq", len: 6 }, { type: "chk" }],
      sync_generate: true,
    };

    await pool.query(
      `DELETE FROM settings WHERE category = 'tracking_policy' AND scope_type = 'client' AND scope_id = $1::uuid`,
      [clientId]
    );
    await pool.query(
      `DELETE FROM settings_versions WHERE category = 'tracking_policy' AND scope_type = 'client' AND scope_id = $1::uuid`,
      [clientId]
    );
    const versionId = await applySetting(pool, {
      category: "tracking_policy",
      scopeType: "client",
      scopeId: clientId,
      value: trackingPolicy,
      version: 1,
      schemaVersion: 1,
      approvedAt: new Date().toISOString(),
    });
    insertedSettings.push({ scopeType: "client", scopeId: clientId, versionId });
  });

  afterAll(async () => {
    try {
      if (createdScheduleTriggers.length) {
        await pool.query(`DELETE FROM workflow_schedule_triggers WHERE id = ANY($1::uuid[])`, [
          createdScheduleTriggers,
        ]);
      }

      if (createdShipments.length) {
        await pool.query(`DELETE FROM shipments WHERE id = ANY($1::uuid[])`, [createdShipments]);
      }

      if (workflowRunIds.length) {
        await pool.query(`DELETE FROM workflow_run_steps WHERE workflow_run_id = ANY($1::uuid[])`, [
          workflowRunIds,
        ]);
        await pool.query(`DELETE FROM workflow_runs WHERE id = ANY($1::uuid[])`, [workflowRunIds]);
      }

      if (insertedSettings.length) {
        for (const entry of insertedSettings) {
          await pool.query(
            `DELETE FROM settings
              WHERE category = 'tracking_policy'
                AND scope_type = $1
                AND scope_id = $2::uuid`,
            [entry.scopeType, entry.scopeId]
          );
        }
        await pool.query(`DELETE FROM settings_versions WHERE id = ANY($1::uuid[])`, [
          insertedSettings.map((entry) => entry.versionId),
        ]);
      }

      if (createdUsers.length) {
        await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
      }

      if (senderId) {
        await pool.query(`DELETE FROM senders WHERE client_id = $1::uuid`, [clientId]);
      }

      if (clientId) {
        await pool.query(`DELETE FROM clients WHERE id = $1::uuid`, [clientId]);
      }

      if (organizationId) {
        await pool.query(`DELETE FROM decision_log WHERE organization_id = $1::uuid`, [organizationId]);
        await pool.query(`DELETE FROM settings_resolution_log WHERE organization_id = $1::uuid`, [
          organizationId,
        ]);
        await cleanupAutoOnboardingArtifacts(pool, organizationId);
        await pool.query(`DELETE FROM organizations WHERE id = $1::uuid`, [organizationId]);
      }
    } finally {
      await pool.end();
    }
  });

  async function progressRunToCompletion(runId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await pool.query(`SELECT public.progress_workflow_run($1::uuid)`, [runId]);
    }
  }

  async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  let cadenceContentionProven = false;
  async function runWorkerOnce({ forceWorkerName = null, isolatedTriggerId = null } = {}) {
    const isolatedPool = { connect: async () => {
      const client = await pool.connect();
      return {
        on: client.on.bind(client),
        removeListener: client.removeListener.bind(client),
        release: client.release.bind(client),
        query: async (command) => {
          const result = await client.query(command);
          if (!cadenceContentionProven && command.text ===
            'SELECT worker_name FROM public.cron_config WHERE worker_name = $1 FOR UPDATE NOWAIT') {
            const contender = new Client({ connectionString: process.env.DATABASE_URL,
              connectionTimeoutMillis: 5000, query_timeout: 5000 });
            try {
              await contender.connect();
              await contender.query('BEGIN');
              await contender.query("SET LOCAL lock_timeout = '100ms'");
              await expect(contender.query(
                'UPDATE public.cron_config SET last_run_at = last_run_at WHERE worker_name = $1',
                [WORKER_NAME])).rejects.toMatchObject({ code: '55P03' });
              cadenceContentionProven = true;
            } finally {
              try { await contender.query('ROLLBACK'); }
              finally { await contender.end(); }
            }
          }
          return result;
        },
      };
    } };
    return runIsolatedScheduleWorker(isolatedPool, {
      triggerId: isolatedTriggerId,
      forceWorkerName,
    });
  }

  async function runWorkerUntilTriggerProcessed(triggerId, maxAttempts = 24, options = {}) {
    const forceWorkerName = options.forceWorkerName ?? null;
    let latestRow = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const workerPayload = await runWorkerOnce({
        forceWorkerName,
        isolatedTriggerId: triggerId,
      });

      if (workerPayload.status === "throttled") {
        await sleep(Math.min(500 * (attempt + 1), 2000));
        continue;
      }

      expect(workerPayload.status).toBe("completed");

      const { rows: scheduleRows } = await pool.query(
        `SELECT last_run_id, last_error, next_run_at
           FROM workflow_schedule_triggers
          WHERE id = $1::uuid`,
        [triggerId]
      );
      latestRow = scheduleRows[0] ?? null;

      expect(latestRow).toBeTruthy();
      if (latestRow.last_error) {
        throw new Error(
          `workflow_schedule_triggers_worker failed for ${triggerId}: ${latestRow.last_error}`
        );
      }

      if (latestRow.last_run_id) {
        return latestRow;
      }

      await sleep(Math.min(250 * (attempt + 1), 1500));
    }

    throw new Error(
      `workflow_schedule_triggers_worker did not claim trigger ${triggerId} after ${maxAttempts} attempts`
    );
  }

  test("schedule worker starts recurring shipment create and materializes a shipment", async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const { rows: triggerRows } = await pool.query(
      `INSERT INTO workflow_schedule_triggers (
         organization_id,
         scope_type,
         scope_id,
         workflow_template_id,
         schedule,
         context_patch,
         enabled,
         next_run_at,
         notes
       )
       VALUES (
         $1::uuid,
         'client',
         $2::uuid,
         $3::uuid,
         jsonb_build_object('type', 'interval', 'interval_seconds', 3600, 'timezone', 'UTC'),
         jsonb_build_object('service_type', 'delivery'),
         TRUE,
         $4::timestamptz,
         'Recurring shipment integration'
       )
       RETURNING id`,
      [organizationId, clientId, recurringTemplateId, dueAt]
    );
    const triggerId = triggerRows[0].id;
    createdScheduleTriggers.push(triggerId);

    // An owned non-target sentinel stays byte-for-byte unchanged while the real worker runs.
    const { rows: sentinelRows } = await pool.query(
      `INSERT INTO workflow_schedule_triggers (
         organization_id, scope_type, scope_id, workflow_template_id,
         schedule, context_patch, enabled, next_run_at, notes
       )
       SELECT organization_id, scope_type, scope_id, workflow_template_id,
              schedule, context_patch, enabled, next_run_at, 'Owned isolation sentinel'
         FROM workflow_schedule_triggers WHERE id = $1::uuid
       RETURNING id`,
      [triggerId]
    );
    const sentinelId = sentinelRows[0].id;
    createdScheduleTriggers.push(sentinelId);
    const { rows: sentinelBefore } = await pool.query(
      `SELECT to_jsonb(t) AS row FROM workflow_schedule_triggers t WHERE id = $1::uuid`,
      [sentinelId]
    );
    expect(sentinelBefore).toHaveLength(1);

    const scheduleRow = await runWorkerUntilTriggerProcessed(triggerId, 24, {
      forceWorkerName: WORKER_NAME,
    });
    const lastRunId = scheduleRow.last_run_id;
    expect(cadenceContentionProven).toBe(true);
    workflowRunIds.push(lastRunId);
    const { rows: sentinelAfter } = await pool.query(
      `SELECT to_jsonb(t) AS row FROM workflow_schedule_triggers t WHERE id = $1::uuid`,
      [sentinelId]
    );
    const sentinelRunId = sentinelAfter[0]?.row?.last_run_id;
    if (sentinelRunId) workflowRunIds.push(sentinelRunId);
    expect(sentinelAfter).toEqual(sentinelBefore);

    await progressRunToCompletion(lastRunId);

    const { rows: runRows } = await pool.query(
      `SELECT context, idempotency_key
         FROM workflow_runs
        WHERE id = $1::uuid`,
      [lastRunId]
    );
    const context = runRows[0]?.context ?? {};
    expect(context.organization_id).toBe(organizationId);
    expect(context.client_id).toBe(clientId);
    expect(context.workflow_schedule_trigger_id).toBe(triggerId);
    expect(context.tracking_scope_type).toBe("client");
    expect(runRows[0]?.idempotency_key).toContain(triggerId);

    const { rows: stepRows } = await pool.query(
      `SELECT sequence_order, step_status, operation_result
         FROM workflow_run_steps
        WHERE workflow_run_id = $1::uuid
        ORDER BY sequence_order`,
      [lastRunId]
    );
    const createStep = stepRows.find((row) => row.sequence_order === 1);
    expect(createStep?.step_status).toBe("completed");
    expect(createStep?.operation_result?.shipment_id).toBeTruthy();
    expect(createStep?.operation_result?.tracking_number).toBeTruthy();

    createdShipments.push(createStep.operation_result.shipment_id);

    const { rows: shipmentRows } = await pool.query(
      `SELECT id, organization_id, client_id, tracking_number
         FROM shipments
        WHERE id = $1::uuid`,
      [createStep.operation_result.shipment_id]
    );
    expect(shipmentRows[0]?.organization_id).toBe(organizationId);
    expect(shipmentRows[0]?.client_id).toBe(clientId);
    expect(shipmentRows[0]?.tracking_number).toBe(createStep.operation_result.tracking_number);
  });

  test("retries reuse the same workflow run for the same schedule due slot", async () => {
    const dueAt = new Date(Date.now() - 120_000).toISOString();
    const { rows: triggerRows } = await pool.query(
      `INSERT INTO workflow_schedule_triggers (
         organization_id,
         scope_type,
         scope_id,
         workflow_template_id,
         schedule,
         context_patch,
         enabled,
         next_run_at,
         notes
       )
       VALUES (
         $1::uuid,
         'client',
         $2::uuid,
         $3::uuid,
         jsonb_build_object('type', 'interval', 'interval_seconds', 3600, 'timezone', 'UTC'),
         '{}'::jsonb,
         TRUE,
         $4::timestamptz,
         'Recurring shipment retry suppression'
       )
       RETURNING id`,
      [organizationId, clientId, recurringTemplateId, dueAt]
    );
    const triggerId = triggerRows[0].id;
    createdScheduleTriggers.push(triggerId);

    const firstScheduleRow = await runWorkerUntilTriggerProcessed(triggerId, 24, {
      forceWorkerName: WORKER_NAME,
    });
    const firstRunId = firstScheduleRow.last_run_id;
    workflowRunIds.push(firstRunId);

    await pool.query(
      `UPDATE workflow_schedule_triggers
          SET next_run_at = $2::timestamptz,
              last_run_at = NULL,
              last_run_id = NULL,
              last_error = NULL,
              last_error_at = NULL,
              updated_at = now()
        WHERE id = $1::uuid`,
      [triggerId, dueAt]
    );

    const secondScheduleRow = await runWorkerUntilTriggerProcessed(triggerId, 24, {
      forceWorkerName: WORKER_NAME,
    });
    expect(secondScheduleRow.last_run_id).toBe(firstRunId);

    const { rows: runRows } = await pool.query(
      `SELECT idempotency_key
         FROM workflow_runs
        WHERE id = $1::uuid`,
      [firstRunId]
    );
    const idempotencyKey = runRows[0]?.idempotency_key ?? null;
    expect(idempotencyKey).toBeTruthy();

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM workflow_runs
        WHERE workflow_template_id = $1::uuid
          AND idempotency_key = $2`,
      [recurringTemplateId, idempotencyKey]
    );
    expect(countRows[0].count).toBe(1);
  });

  test("ui_run_workflow_schedule_trigger_v1 denies users without workflows.write", async () => {
    const { rows: triggerRows } = await pool.query(
      `INSERT INTO workflow_schedule_triggers (
         organization_id,
         scope_type,
         scope_id,
         workflow_template_id,
         schedule,
         context_patch,
         enabled,
         next_run_at,
         notes
       )
       VALUES (
         $1::uuid,
         'client',
         $2::uuid,
         $3::uuid,
         jsonb_build_object('type', 'interval', 'interval_seconds', 3600, 'timezone', 'UTC'),
         '{}'::jsonb,
         TRUE,
         public.workflow_now(),
         'Recurring shipment unauthorized'
       )
       RETURNING id`,
      [organizationId, clientId, recurringTemplateId]
    );
    const triggerId = triggerRows[0].id;
    createdScheduleTriggers.push(triggerId);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [senderUserId]);
      await client.query("SET LOCAL ROLE authenticated");

      await expect(
        client.query(`SELECT public.ui_run_workflow_schedule_trigger_v1($1::uuid)`, [triggerId])
      ).rejects.toThrow(/Capability denied: workflows.write/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
