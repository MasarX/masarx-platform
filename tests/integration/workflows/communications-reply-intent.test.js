const { dialog360 } = require('../../../scripts/clients');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const {
  createDialog360AuthConfig,
  ensureDialog360ReplyMappingConfig,
  ensureDialog360Provider,
  resolveDialog360ReplyWebhookSource,
} = require('../helpers/dialog360ReplyFixtures');
const { ensureIntegrationFixturesPresent } = require('../helpers/integration-fixtures');

const liveEnabled = process.env.RUN_LIVE_COMMS_TESTS === 'true';
const describeOrSkipLive = liveEnabled ? describe : describe.skip;

describe('Communications reply intent workflow (Dialog360)', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const getDefaultRecipient = async (client, organizationId) => {
    const providerId = await ensureDialog360Provider(client, organizationId);
    if (!providerId) return null;

    const { rows } = await client.query(
      `
        SELECT (cached_value->>'default_recipient') AS default_recipient
        FROM settings
        WHERE category = 'provider_defaults'
          AND scope_type = 'resource'
          AND scope_id = $1::uuid
        ORDER BY last_updated DESC NULLS LAST
        LIMIT 1
      `,
      [providerId],
    );
    return rows[0]?.default_recipient || null;
  };

  const buildReplyPayload = ({ recipient, messageId, text = 'test reply' }) => ({
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
                  context: { id: `corr-${messageId}` },
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
        // Allow async queue workers to persist workflow context updates between ticks.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return lastState;
  };

  afterAll(async () => {
    await pool.end();
  });

  beforeAll(async () => {
    await ensureIntegrationFixturesPresent();
  });

  describeOrSkipLive('Live send smoke (Dialog360)', () => {
    beforeAll(async () => {
      await dialog360.getConfig();
    });

    afterAll(async () => {
      if (typeof dialog360.shutdown === 'function') {
        await dialog360.shutdown();
      }
    });

    test(
      'sends a WhatsApp text and marks reply_received when inbound reply arrives (simulated)',
      async () => {
        const outbound = await dialog360.sendTextMessage({
          body: `Comms intent test @ ${new Date().toISOString()}`,
        });
        expect(outbound).toHaveProperty('messages');
        const messageId = outbound.messages[0]?.id;
        expect(messageId).toBeTruthy();

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const sourceRow = await resolveDialog360ReplyWebhookSource(client);
          const organizationId = sourceRow?.organization_id;
          expect(organizationId).toBeTruthy();
          const mappingConfigId = await ensureDialog360ReplyMappingConfig(client, sourceRow?.id);
          expect(mappingConfigId).toBeTruthy();

          const defaultRecipient = await getDefaultRecipient(client, organizationId);
          expect(defaultRecipient).toBeTruthy();

          const workflowTemplateId = randomUUID();
          await client.query(
            `
            INSERT INTO workflow_templates (id, name, description, version, status, scope_type)
            VALUES ($1::uuid, 'reply_intent_test', 'Comms reply intent integration test', 1, 'active', 'global')
            `,
            [workflowTemplateId],
          );

          const workflowRunId = randomUUID();
          await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [workflowRunId]);
          await client.query(
            `
            INSERT INTO workflow_runs (
              id,
              workflow_template_id,
              workflow_template_version,
              entry_point,
              workflow_status,
              context
            )
            VALUES (
              $1::uuid,
              $2::uuid,
              1,
              'webhook',
              'in_progress',
              jsonb_build_object(
                'communication',
                jsonb_build_object(
                  'recipient', $3::text,
                  'message_id', $4::text
                )
              )
            )
            `,
            [workflowRunId, workflowTemplateId, defaultRecipient, messageId],
          );

          const res = await client.query(
            `
            SELECT worker_action_mark_communication_reply(
              gen_random_uuid(),
              jsonb_build_object('stop_reason','reply_intent_test'),
              jsonb_build_object(
                'transformed_payload',
                jsonb_build_object(
                  'communication',
                  jsonb_build_object(
                    'recipient', $2::text,
                    'message_id', $1::text
                  )
                )
              )
            ) AS result
            `,
            [messageId, defaultRecipient],
          );
          const result = res.rows[0]?.result;
          expect(result).toBeTruthy();
          expect(result.status).toBe('completed');
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      },
      30000,
    );
  });

  test(
    'reply workflow handler maps Dialog360 webhook payload and marks reply_received (no stop unless opt-out)',
    async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const sourceRow = await resolveDialog360ReplyWebhookSource(client);
        const webhookSourceId = sourceRow?.id;
        const organizationId = sourceRow?.organization_id;
        const clientId = sourceRow?.client_id;
        expect(webhookSourceId).toBeTruthy();
        expect(organizationId).toBeTruthy();
        expect(clientId).toBeTruthy();

        const mappingConfigId = await ensureDialog360ReplyMappingConfig(client, webhookSourceId);
        expect(mappingConfigId).toBeTruthy();

        const defaultRecipient = await getDefaultRecipient(client, organizationId);
        expect(defaultRecipient).toBeTruthy();

        const { rows: authRows } = await client.query(
          `
          SELECT pac.id
          FROM provider_auth_configs pac
          JOIN providers p ON p.id = pac.provider_id
          WHERE p.organization_id = $1::uuid
            AND p.name = 'dialog360_whatsapp'
          ORDER BY pac.created_at DESC
          LIMIT 1
          `,
          [organizationId],
        );
        let authConfigId = authRows[0]?.id;
        if (!authConfigId) {
          const { rows: providerRows } = await client.query(
            `SELECT id
             FROM providers
             WHERE organization_id = $1::uuid
               AND name = 'dialog360_whatsapp'
               AND provider_type = 'comms'
             ORDER BY created_at DESC
             LIMIT 1`,
            [organizationId],
          );
          let providerId = providerRows[0]?.id || null;
          if (!providerId) {
            const { rows: createdProviderRows } = await client.query(
              `INSERT INTO providers (organization_id, name, provider_type, enabled, metadata)
               VALUES ($1::uuid, 'dialog360_whatsapp', 'comms', TRUE, '{}'::jsonb)
               ON CONFLICT (organization_id, name, provider_type) DO UPDATE
               SET enabled = EXCLUDED.enabled,
                   updated_at = now()
               RETURNING id`,
              [organizationId],
            );
            providerId = createdProviderRows[0]?.id || null;
          }
          expect(providerId).toBeTruthy();

          authConfigId = await createDialog360AuthConfig(client, providerId, {
            description: 'integration comms reply intent api_key',
          });
        }
        expect(authConfigId).toBeTruthy();

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
              'integration test seed: dialog360 reply policy',
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
              intents: {
                status: {
                  keywords: ['status', 'where', 'delivery', 'arrive'],
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
                eta: {
                  keywords: ['eta', 'when', 'arrive'],
                  template: 'ETA for {tracking_number}: {eta}.',
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
                opt_out: {
                  keywords: ['stop', 'unsubscribe', 'optout'],
                  template: 'You have been opted out.',
                  stop_workflow: true,
                  opt_out: true,
                  allow_opted_out_send: true,
                },
                fallback: {
                  template: 'Thanks for your message. We will get back to you shortly.',
                },
              },
            }),
          ]
        );

        const workflowTemplateId = randomUUID();
        await client.query(
          `
          INSERT INTO workflow_templates (id, name, description, version, status, scope_type)
          VALUES ($1::uuid, 'reply_intent_test_auto', 'Comms reply intent auto handler test', 1, 'active', 'global')
        `,
          [workflowTemplateId]
        );

        const messageId = `wamid.${randomUUID()}`;
        const correlationId = `corr-${messageId}`;

        // Ensure the recipient exists (needed for client-scoped matching + opt-out/session enforcement).
        const { rows: recipientRows } = await client.query(
          `
          INSERT INTO recipients (organization_id, client_id, name, phone_number, preferred_language)
          VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'en')
          ON CONFLICT (client_id, phone_number_normalized) WHERE phone_number_normalized IS NOT NULL
          DO UPDATE SET updated_at = now()
          RETURNING id
          `,
          [organizationId, clientId, 'E2E User', defaultRecipient]
        );
        expect(recipientRows[0]?.id).toBeTruthy();

        const workflowRunId = randomUUID();
        await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [workflowRunId]);
        await client.query(
          `
          INSERT INTO workflow_runs (
            id,
            workflow_template_id,
            workflow_template_version,
            entry_point,
            workflow_status,
            context
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            1,
            'webhook',
            'in_progress',
            jsonb_build_object(
              'organization_id', $5::uuid,
              'client_id', $6::uuid,
              'correlation_id', $7::text,
              'communication',
              jsonb_build_object(
                'recipient', $3::text,
                'message_id', $4::text,
                'correlation_id', $7::text
              )
            )
          )
        `,
          [workflowRunId, workflowTemplateId, defaultRecipient, messageId, organizationId, clientId, correlationId]
        );

        const payload = buildReplyPayload({
          recipient: defaultRecipient,
          messageId,
          text: 'Auto handler test',
        });
        const webhookId = randomUUID();
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

        // Execute the reply handler workflow against the staged webhook row.
        const { rows: replyRunRows } = await client.query(
          `
          SELECT start_workflow_run(
            (SELECT id FROM workflow_templates WHERE name='dialog360_reply_handler_v1' LIMIT 1),
            jsonb_build_object(
              'webhook_id', $1::uuid,
              'organization_id', $2::uuid
            )
          ) AS workflow_run_id
          `,
          [webhookId, organizationId]
        );
        const replyWorkflowRunId = replyRunRows[0]?.workflow_run_id;
        expect(replyWorkflowRunId).toBeTruthy();

        const runState = await progressWorkflowUntil(
          client,
          replyWorkflowRunId,
          async () => {
            const { rows } = await client.query(
              `
              SELECT
                workflow_status,
                context->'communication'->>'reply_received' AS reply_received,
                metadata->'last_reply' AS last_reply
              FROM workflow_runs
              WHERE id = $1::uuid
            `,
              [workflowRunId],
            );
            return rows[0] || null;
          },
          (state) => state?.reply_received === 'true' && state?.last_reply?.webhook_id === webhookId,
        );

        expect(runState?.workflow_status).toBe('in_progress');
        expect(runState?.reply_received).toBe('true');
        expect(runState?.last_reply).toBeTruthy();
        expect(runState?.last_reply?.webhook_id).toBe(webhookId);

        // Opt-out should stop the run (policy-driven).
        const stopMessageId = `wamid.${randomUUID()}`;
        const stopWebhookId = randomUUID();
        const stopPayload = buildReplyPayload({
          recipient: defaultRecipient,
          messageId: stopMessageId,
          text: 'stop',
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
          [stopWebhookId, webhookSourceId, stopPayload]
        );

        const { rows: stopReplyRunRows } = await client.query(
          `
          SELECT start_workflow_run(
            (SELECT id FROM workflow_templates WHERE name='dialog360_reply_handler_v1' LIMIT 1),
            jsonb_build_object(
              'webhook_id', $1::uuid,
              'organization_id', $2::uuid
            )
          ) AS workflow_run_id
          `,
          [stopWebhookId, organizationId]
        );
        const stopReplyWorkflowRunId = stopReplyRunRows[0]?.workflow_run_id;
        expect(stopReplyWorkflowRunId).toBeTruthy();
        const stoppedState = await progressWorkflowUntil(
          client,
          stopReplyWorkflowRunId,
          async () => {
            const { rows } = await client.query(
              `SELECT workflow_status FROM workflow_runs WHERE id = $1::uuid`,
              [workflowRunId],
            );
            return rows[0] || null;
          },
          (state) => state?.workflow_status === 'stopped',
        );
        expect(stoppedState?.workflow_status).toBe('stopped');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    },
    90000
  );
});
