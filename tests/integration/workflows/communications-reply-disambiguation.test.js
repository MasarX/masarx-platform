const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const {
  createDialog360AuthConfig,
  ensureDialog360ProviderDefaults,
  ensureDialog360ReplyMappingConfig,
  ensureDialog360Provider,
  resolveDialog360ReplyWebhookSource,
} = require('../helpers/dialog360ReplyFixtures');
const { ensureIntegrationFixturesPresent } = require('../helpers/integration-fixtures');

describe('Communications reply disambiguation (Dialog360)', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const buildReplyPayload = ({ recipient, messageId, text }) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'test_waba',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [
                {
                  wa_id: recipient,
                  profile: { name: 'E2E User' },
                },
              ],
              messages: [
                {
                  id: messageId,
                  from: recipient,
                  text: { body: text },
                  type: 'text',
                  timestamp: `${Math.floor(Date.now() / 1000)}`,
                },
              ],
              metadata: {
                phone_number_id: '176835862185450',
                display_phone_number: '4930609859535',
              },
              messaging_product: 'whatsapp',
            },
          },
        ],
      },
    ],
  });

  const progressWorkflowUntil = async (
    client,
    runId,
    loadState,
    isReady,
    { maxAttempts = 30, delayMs = 120 } = {},
  ) => {
    let lastState = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await client.query(`SELECT progress_workflow_run($1::uuid)`, [runId]);
      lastState = await loadState();
      if (isReady(lastState)) {
        return lastState;
      }
      if (delayMs > 0) {
        // Allow async queue workers to persist decision/session state between progress ticks.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return lastState;
  };

  const assertQueuedDecision = (decisionInputs, label) => {
    if (decisionInputs?.queued === true) return;
    throw new Error(
      `[${label}] expected decision_inputs.queued=true, got: ${JSON.stringify(decisionInputs)}`,
    );
  };

  afterAll(async () => {
    await pool.end();
  });

  beforeAll(async () => {
    await ensureIntegrationFixturesPresent();
  });

  test(
    'prompts for tracking when multiple shipments exist, then resolves on next reply',
    async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const sourceRow = await resolveDialog360ReplyWebhookSource(client);
        const webhookSourceId = sourceRow?.id;
        const senderId = sourceRow?.sender_id;
        const organizationId = sourceRow?.organization_id;
        const clientId = sourceRow?.client_id;
        expect(webhookSourceId).toBeTruthy();
        expect(senderId).toBeTruthy();
        expect(organizationId).toBeTruthy();
        expect(clientId).toBeTruthy();

        const mappingConfigId = await ensureDialog360ReplyMappingConfig(client, webhookSourceId);
        expect(mappingConfigId).toBeTruthy();

        const providerId = await ensureDialog360Provider(client, organizationId);
        expect(providerId).toBeTruthy();

        const authConfigId = await createDialog360AuthConfig(client, providerId, {
          description: 'integration comms reply disambiguation api_key',
        });
        expect(authConfigId).toBeTruthy();

        const recipientPhone = `9665${Math.floor(Math.random() * 90000000 + 10000000)}`;
        const { rows: recipientRows } = await client.query(
          `
          INSERT INTO recipients (organization_id, client_id, name, phone_number, preferred_language)
          VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'en')
          ON CONFLICT (client_id, phone_number_normalized) WHERE phone_number_normalized IS NOT NULL
          DO UPDATE SET updated_at = now()
          RETURNING id
          `,
          [organizationId, clientId, 'E2E User', recipientPhone]
        );
        const recipientId = recipientRows[0]?.id;
        expect(recipientId).toBeTruthy();
        await ensureDialog360ProviderDefaults(client, providerId, {
          defaultRecipient: recipientPhone,
        });

        const tracking1 = `QA-${randomUUID().slice(0, 8)}`;
        const tracking2 = `QA-${randomUUID().slice(0, 8)}`;
        await client.query(
          `
          INSERT INTO shipments (
            organization_id,
            client_id,
            sender_id,
            recipient_id,
            service_type,
            tracking_number,
            box_count,
            status,
            promised_delivery_date,
            created_at,
            updated_at
          )
          VALUES
            ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'delivery', $5::text, 1, 'in_transit', (now() + interval '3 days')::date, now(), now()),
            ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'delivery', $6::text, 1, 'out_for_delivery', (now() + interval '1 day')::date, now(), now())
          `,
          [organizationId, clientId, senderId, recipientId, tracking1, tracking2]
        );

        // Ensure a deterministic source-scoped reply policy exists for this test.
        await client.query(
          `
          WITH expired AS (
            UPDATE settings_versions
               SET effective_until = now()
             WHERE category = 'comms_reply_policy'
               AND scope_type = 'source'
               AND scope_id = $1::uuid
               AND effective_until IS NULL
               AND approved_at IS NOT NULL
            RETURNING 1
          ),
          barrier AS (
            SELECT 1 AS ok FROM expired
            UNION ALL SELECT 1 AS ok
            LIMIT 1
          ),
          next_version AS (
            SELECT COALESCE(MAX(version), 0) + 1 AS v
            FROM settings_versions
            WHERE category = 'comms_reply_policy'
              AND scope_type = 'source'
              AND scope_id = $1::uuid
          ),
          inserted AS (
            INSERT INTO settings_versions (
              category,
              scope_type,
              scope_id,
              version,
              value,
              schema_version,
              change_reason,
              approved_at,
              effective_from
            )
            SELECT
              'comms_reply_policy',
              'source',
              $1::uuid,
              next_version.v,
              $2::jsonb,
              1,
              'integration test seed: dialog360 reply policy (disambiguation)',
              now(),
              now()
            FROM next_version, barrier
            RETURNING id, value
          )
          INSERT INTO settings (
            category,
            scope_type,
            scope_id,
            settings_version_id,
            cached_value,
            last_updated
          )
          SELECT
            'comms_reply_policy',
            'source',
            $1::uuid,
            inserted.id,
            inserted.value,
            now()
          FROM inserted
          ON CONFLICT (category, scope_type, scope_hash)
          DO UPDATE SET
            settings_version_id = EXCLUDED.settings_version_id,
            cached_value = EXCLUDED.cached_value,
            last_updated = EXCLUDED.last_updated
          `,
          [
            webhookSourceId,
            JSON.stringify({
              auth_config_id: authConfigId,
              dry_run: false,
              dispatch: {
                mode: 'queue',
                timeout_seconds: 10,
                poll_max_seconds: 0,
                poll_interval_ms: 200,
                lease_seconds: 30,
                pending_reschedule_seconds: 30,
              },
              reply_rate_limit: { enabled: true, window_seconds: 60, max_replies: 50 },
              intents: {
                status: {
                  keywords: ['status'],
                  template: 'Shipment {tracking_number}: status {status}. ETA {eta}.',
                  not_found_template: 'Sorry, no shipment found for {recipient}.',
                  requires_shipment: true,
                  multiple_shipments: {
                    template:
                      'Multiple shipments found. Reply with the tracking number (or a number):\n{shipment_options}',
                    invalid_selection_template:
                      'Please reply with a tracking number (or a number):\n{shipment_options}',
                    ttl_seconds: 900,
                    max_options: 5,
                  },
                },
                fallback: {
                  template: 'Thanks for your message.',
                },
              },
            }),
          ]
        );

        // 1) First inbound: ask for status -> expect disambiguation session created.
        const webhookId1 = randomUUID();
        const payload1 = buildReplyPayload({
          recipient: recipientPhone,
          messageId: `wamid.${randomUUID()}`,
          text: 'status',
        });
        await client.query(
          `
          SELECT insert_webhook_inbox_record(
            $1::uuid,
            $2::uuid,
            'communications',
            $3::jsonb,
            '{}'::jsonb,
            'in_progress',
            gen_random_uuid(),
            NULL
          )
          `,
          [webhookId1, webhookSourceId, payload1]
        );

        const { rows: replyRunRows1 } = await client.query(
          `
          SELECT start_workflow_run(
            (SELECT id FROM workflow_templates WHERE name='dialog360_reply_handler_v1' LIMIT 1),
            jsonb_build_object(
              'webhook_id', $1::uuid,
              'organization_id', $2::uuid
            )
          ) AS workflow_run_id
          `,
          [webhookId1, organizationId]
        );
        const replyWorkflowRunId1 = replyRunRows1[0]?.workflow_run_id;
        expect(replyWorkflowRunId1).toBeTruthy();
        const sessionState = await progressWorkflowUntil(
          client,
          replyWorkflowRunId1,
          async () => {
            const { rows } = await client.query(
              `
              SELECT id, requested_intent, state
              FROM comms_reply_sessions
              WHERE client_id = $1::uuid
                AND recipient_id = $2::uuid
                AND resolved_at IS NULL
              ORDER BY created_at DESC
              LIMIT 1
              `,
              [clientId, recipientId],
            );
            return rows[0] || null;
          },
          (state) => Boolean(state?.id),
        );
        const sessionId = sessionState?.id;
        expect(sessionId).toBeTruthy();
        expect(sessionState?.requested_intent).toBe('status');
        expect(Array.isArray(sessionState?.state?.shipments)).toBe(true);

        // 2) Second inbound: reply with tracking number -> expect session resolved and shipment response queued.
        const webhookId2 = randomUUID();
        const payload2 = buildReplyPayload({
          recipient: recipientPhone,
          messageId: `wamid.${randomUUID()}`,
          text: tracking1,
        });
        await client.query(
          `
          SELECT insert_webhook_inbox_record(
            $1::uuid,
            $2::uuid,
            'communications',
            $3::jsonb,
            '{}'::jsonb,
            'in_progress',
            gen_random_uuid(),
            NULL
          )
          `,
          [webhookId2, webhookSourceId, payload2]
        );

        const { rows: replyRunRows2 } = await client.query(
          `
          SELECT start_workflow_run(
            (SELECT id FROM workflow_templates WHERE name='dialog360_reply_handler_v1' LIMIT 1),
            jsonb_build_object(
              'webhook_id', $1::uuid,
              'organization_id', $2::uuid
            )
          ) AS workflow_run_id
          `,
          [webhookId2, organizationId]
        );
        const replyWorkflowRunId2 = replyRunRows2[0]?.workflow_run_id;
        expect(replyWorkflowRunId2).toBeTruthy();
        const resolvedState = await progressWorkflowUntil(
          client,
          replyWorkflowRunId2,
          async () => {
            const { rows } = await client.query(
              `
              SELECT resolved_at
              FROM comms_reply_sessions
              WHERE id = $1::uuid
              `,
              [sessionId],
            );
            return rows[0] || null;
          },
          (state) => Boolean(state?.resolved_at),
        );
        expect(resolvedState?.resolved_at).toBeTruthy();

        const { rows: decisionRows } = await client.query(
          `
          SELECT decision_inputs
          FROM decision_log
          WHERE decision_category = 'communication_reply'
            AND resource_id = $1::uuid
          ORDER BY timestamp DESC
          LIMIT 1
          `,
          [webhookId2]
        );
        const decisionInputs = decisionRows[0]?.decision_inputs;
        expect(decisionInputs).toBeTruthy();
        expect(decisionInputs.intent).toBe('status');
        expect(decisionInputs.shipment_id).toBeTruthy();
        assertQueuedDecision(decisionInputs, 'disambiguation-resolve');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    },
    120000
  );

  test(
    'rate-limits repeated replies per recipient/source',
    async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const sourceRow = await resolveDialog360ReplyWebhookSource(client);
        const webhookSourceId = sourceRow?.id;
        const senderId = sourceRow?.sender_id;
        const organizationId = sourceRow?.organization_id;
        const clientId = sourceRow?.client_id;
        expect(webhookSourceId).toBeTruthy();
        expect(senderId).toBeTruthy();
        expect(organizationId).toBeTruthy();
        expect(clientId).toBeTruthy();
        const mappingConfigId = await ensureDialog360ReplyMappingConfig(client, webhookSourceId);
        expect(mappingConfigId).toBeTruthy();

        const providerId = await ensureDialog360Provider(client, organizationId);
        expect(providerId).toBeTruthy();

        const authConfigId = await createDialog360AuthConfig(client, providerId, {
          description: 'integration comms reply disambiguation api_key',
        });
        expect(authConfigId).toBeTruthy();

        const recipientPhone = `9665${Math.floor(Math.random() * 90000000 + 10000000)}`;
        const { rows: recipientRows } = await client.query(
          `
          INSERT INTO recipients (organization_id, client_id, name, phone_number, preferred_language)
          VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'en')
          ON CONFLICT (client_id, phone_number_normalized) WHERE phone_number_normalized IS NOT NULL
          DO UPDATE SET updated_at = now()
          RETURNING id
          `,
          [organizationId, clientId, 'E2E User', recipientPhone]
        );
        const recipientId = recipientRows[0]?.id;
        expect(recipientId).toBeTruthy();
        await ensureDialog360ProviderDefaults(client, providerId, {
          defaultRecipient: recipientPhone,
        });

        // A single shipment so requires_shipment intents can answer directly.
        const tracking = `QA-${randomUUID().slice(0, 8)}`;
        await client.query(
          `
          INSERT INTO shipments (
            organization_id,
            client_id,
            sender_id,
            recipient_id,
            service_type,
            tracking_number,
            box_count,
            status,
            promised_delivery_date,
            created_at,
            updated_at
          )
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'delivery', $5::text, 1, 'in_transit', (now() + interval '3 days')::date, now(), now())
          `,
          [organizationId, clientId, senderId, recipientId, tracking]
        );

        await client.query(
          `
          WITH expired AS (
            UPDATE settings_versions
               SET effective_until = now()
             WHERE category = 'comms_reply_policy'
               AND scope_type = 'source'
               AND scope_id = $1::uuid
               AND effective_until IS NULL
               AND approved_at IS NOT NULL
            RETURNING 1
          ),
          barrier AS (
            SELECT 1 AS ok FROM expired
            UNION ALL SELECT 1 AS ok
            LIMIT 1
          ),
          next_version AS (
            SELECT COALESCE(MAX(version), 0) + 1 AS v
            FROM settings_versions
            WHERE category = 'comms_reply_policy'
              AND scope_type = 'source'
              AND scope_id = $1::uuid
          ),
          inserted AS (
            INSERT INTO settings_versions (
              category,
              scope_type,
              scope_id,
              version,
              value,
              schema_version,
              change_reason,
              approved_at,
              effective_from
            )
            SELECT
              'comms_reply_policy',
              'source',
              $1::uuid,
              next_version.v,
              $2::jsonb,
              1,
              'integration test seed: dialog360 reply policy (rate limit)',
              now(),
              now()
            FROM next_version, barrier
            RETURNING id, value
          )
          INSERT INTO settings (
            category,
            scope_type,
            scope_id,
            settings_version_id,
            cached_value,
            last_updated
          )
          SELECT
            'comms_reply_policy',
            'source',
            $1::uuid,
            inserted.id,
            inserted.value,
            now()
          FROM inserted
          ON CONFLICT (category, scope_type, scope_hash)
          DO UPDATE SET
            settings_version_id = EXCLUDED.settings_version_id,
            cached_value = EXCLUDED.cached_value,
            last_updated = EXCLUDED.last_updated
          `,
          [
            webhookSourceId,
            JSON.stringify({
              auth_config_id: authConfigId,
              dry_run: false,
              dispatch: {
                mode: 'queue',
                timeout_seconds: 10,
                poll_max_seconds: 0,
                poll_interval_ms: 200,
                lease_seconds: 30,
                pending_reschedule_seconds: 30,
              },
              reply_rate_limit: { enabled: true, window_seconds: 60, max_replies: 1 },
              intents: {
                status: {
                  keywords: ['status'],
                  template: 'Shipment {tracking_number}: status {status}.',
                  not_found_template: 'No shipment found.',
                  requires_shipment: true,
                },
                fallback: {
                  template: 'Thanks.',
                },
              },
            }),
          ]
        );

        const makeReply = async () => {
          const webhookId = randomUUID();
          const payload = buildReplyPayload({
            recipient: recipientPhone,
            messageId: `wamid.${randomUUID()}`,
            text: 'status',
          });
          await client.query(
            `
            SELECT insert_webhook_inbox_record(
              $1::uuid,
              $2::uuid,
              'communications',
              $3::jsonb,
              '{}'::jsonb,
              'in_progress',
              gen_random_uuid(),
              NULL
            )
            `,
            [webhookId, webhookSourceId, payload]
          );
          const { rows } = await client.query(
            `
            SELECT start_workflow_run(
              (SELECT id FROM workflow_templates WHERE name='dialog360_reply_handler_v1' LIMIT 1),
              jsonb_build_object('webhook_id', $1::uuid, 'organization_id', $2::uuid)
            ) AS workflow_run_id
            `,
            [webhookId, organizationId]
          );
          const runId = rows[0]?.workflow_run_id;
          expect(runId).toBeTruthy();
          return progressWorkflowUntil(
            client,
            runId,
            async () => {
              const { rows: decisionRows } = await client.query(
                `
                SELECT decision_inputs
                FROM decision_log
                WHERE decision_category = 'communication_reply'
                  AND resource_id = $1::uuid
                ORDER BY timestamp DESC
                LIMIT 1
                `,
                [webhookId],
              );
              return decisionRows[0]?.decision_inputs || null;
            },
            (inputs) => typeof inputs?.queued === 'boolean' || typeof inputs?.error === 'string',
          );
        };

        const first = await makeReply();
        assertQueuedDecision(first, 'rate-limit-first');
        expect(first?.error).toBeFalsy();

        const second = await makeReply();
        expect(second?.queued).toBeFalsy();
        expect(second?.error).toBe('rate_limited');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    },
    60000
  );
});
