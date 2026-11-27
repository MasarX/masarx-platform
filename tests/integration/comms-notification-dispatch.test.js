const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');

loadEnv();

const { requireEnv } = require('../utils/test-env');

jest.setTimeout(120000);

const missing = requireEnv(['DATABASE_URL'], 'comms-notification-dispatch');
const describeIfDb = missing ? describe.skip : describe;
const {
  applySetting,
  createClient,
  createMappingConfig,
  createOrganization,
  createSender,
  createShipment,
  createUser,
  createWebhookSource,
} = missing
  ? {}
  : require('./helpers/tenant-utils');
const {
  createDialog360AuthConfig,
  ensureDialog360Provider,
  ensureDialog360ProviderDefaults,
} = missing
  ? {}
  : require('./helpers/dialog360ReplyFixtures');

describeIfDb('communications notification dispatch contracts (integration)', () => {
  let pool;
  let client;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
      client = null;
    }
  });

  async function setServiceContext(organizationId, userId) {
    await client.query('SET LOCAL ROLE service_role');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({
        role: 'service_role',
        sub: String(userId),
        organization_id: String(organizationId),
      }),
    ]);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [String(userId)]);
    await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`);
  }

  async function lookupValue(category, expectedValue) {
    const { rows } = await client.query(
      `SELECT lv.value
         FROM public.lookup_definitions ld
         JOIN public.lookup_values lv
           ON lv.lookup_definition_id = ld.id
        WHERE ld.category = $1
          AND lv.value = $2
          AND lv.status = 'active'
        LIMIT 1`,
      [category, expectedValue],
    );

    if (!rows[0]?.value) {
      throw new Error(`missing active lookup value ${category}.${expectedValue}`);
    }

    return rows[0].value;
  }

  async function normalizePhone(phoneNumber) {
    const { rows } = await client.query(`SELECT public.normalize_phone_number($1::text) AS normalized`, [
      phoneNumber,
    ]);

    return rows[0]?.normalized || null;
  }

  async function createRecipient(organizationId, clientId, phoneNumber, email) {
    const recipientId = randomUUID();

    await client.query(
      `INSERT INTO public.recipients (
          id,
          organization_id,
          client_id,
          name,
          phone_number,
          email,
          preferred_language
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'Notification Recipient',
          $4::text,
          $5::text,
          'en'
        )`,
      [recipientId, organizationId, clientId, phoneNumber, email],
    );

    return recipientId;
  }

  async function createShipmentWithRecipient({ organizationId, clientId, senderId, recipientId }) {
    const shipment = await createShipment(client, {
      organizationId,
      clientId,
      trackingNumber: `COMMS-${randomUUID().slice(0, 8).toUpperCase()}`,
      status: 'in_transit',
    });

    await client.query(
      `UPDATE public.shipments
          SET sender_id = $2::uuid,
              recipient_id = $3::uuid
        WHERE id = $1::uuid`,
      [shipment.id, senderId, recipientId],
    );

    return shipment;
  }

  async function ensureCommsOperationTemplate(providerId, mappingConfigId) {
    const { rows } = await client.query(
      `INSERT INTO public.operation_templates (
          provider_id,
          handler_key,
          operation_name,
          method,
          url_template,
          headers_template,
          body_template,
          request_mappings,
          mapping_config_id,
          call_type,
          timeout_seconds,
          metadata
        )
        VALUES (
          $1::uuid,
          'outbound_http',
          $2::text,
          'POST',
          'https://example.test/send',
          jsonb_build_object('content-type', 'application/json'),
          '{}'::jsonb,
          NULL,
          $3::uuid,
          'comms_whatsapp',
          30,
          '{}'::jsonb
        )
        RETURNING id`,
      [providerId, `comms_whatsapp_dispatch_${randomUUID().slice(0, 8)}`, mappingConfigId],
    );

    return rows[0]?.id || null;
  }

  async function seedFixture() {
    const organization = await createOrganization(client, 'Comms Notification Dispatch Org');
    const tenantClient = await createClient(client, organization.id, 'Comms Notification Dispatch Client');
    const senderId = await createSender(client, tenantClient.id, 'Comms Notification Dispatch Sender');
    const operatorUserId = await createUser(
      client,
      organization.id,
      `comms-operator-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'ops_admin' },
    );

    const recipientPhone = '+12025550123';
    const recipientEmail = `recipient-${randomUUID().slice(0, 8)}@example.com`;
    const recipientId = await createRecipient(
      organization.id,
      tenantClient.id,
      recipientPhone,
      recipientEmail,
    );
    const shipment = await createShipmentWithRecipient({
      organizationId: organization.id,
      clientId: tenantClient.id,
      senderId,
      recipientId,
    });

    const providerId = await ensureDialog360Provider(client, organization.id);
    await ensureDialog360ProviderDefaults(client, providerId, {
      defaultRecipient: recipientPhone,
    });

    const authConfigId = await createDialog360AuthConfig(client, providerId, {
      apiKey: 'integration-EXAMPLE_PASSWORD',
      description: 'integration comms notification dispatch api_key',
    });

    const mappingConfigId = await createMappingConfig(
      client,
      'provider_response',
      `comms-dispatch-response-${randomUUID()}`,
      {
        success_path: '$.messages[0].id',
        field_mappings: {
          message_id: '$.messages[0].id',
          status: '$.messages[0].status',
          timestamp: '$.messages[0].timestamp',
        },
      },
      { notes: 'Comms notification dispatch test response mapping' },
    );

    const operationTemplateId = await ensureCommsOperationTemplate(providerId, mappingConfigId);

    const webhookMappingId = await createMappingConfig(
      client,
      'webhook_inbound',
      `comms-dispatch-webhook-${randomUUID()}`,
      {},
      { notes: 'Comms notification dispatch webhook mapping' },
    );
    const webhookSource = await createWebhookSource(client, {
      organizationId: organization.id,
      mappingConfigId: webhookMappingId,
      sourceIdentifier: `comms-dispatch-${randomUUID().slice(0, 8)}`,
      name: 'Comms Dispatch Source',
      providerType: 'communications',
    });

    const { rows: supportCaseRows } = await client.query(
      `INSERT INTO public.support_cases (
          organization_id,
          client_id,
          sender_id,
          resource_type,
          resource_id,
          opened_at,
          idempotency_key,
          metadata,
          created_at,
          updated_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'shipment',
          $4::uuid,
          now(),
          $5::text,
          $6::jsonb,
          now(),
          now()
        )
        RETURNING id`,
      [
        organization.id,
        tenantClient.id,
        senderId,
        shipment.id,
        `support-case-${randomUUID()}`,
        JSON.stringify({
          source: 'public_tracking',
          request_type: 'location_change',
          tracking_number: shipment.trackingNumber,
        }),
      ],
    );

    return {
      authConfigId,
      clientId: tenantClient.id,
      operationTemplateId,
      operatorUserId,
      organizationId: organization.id,
      providerId,
      recipientEmail,
      recipientId,
      recipientPhone,
      senderId,
      shipmentId: shipment.id,
      supportCaseId: supportCaseRows[0]?.id || null,
      webhookSourceId: webhookSource.id,
    };
  }

  test('resolves communication policy, queues WhatsApp, records delivery receipts, and enforces reply rate limits', async () => {
    const sentStatus = await lookupValue('message_status', 'sent');
    const deliveredStatus = await lookupValue('message_status', 'delivered');

    const fixture = await seedFixture();

    const { rows: globalPolicyRows } = await client.query(
      `SELECT cached_value
         FROM public.settings
        WHERE category = 'communication_policy'
          AND scope_type = 'global'
          AND scope_id IS NULL
        LIMIT 1`,
    );
    expect(globalPolicyRows[0]?.cached_value).toBeTruthy();

    await applySetting(client, {
      category: 'communication_policy',
      scopeType: 'client',
      scopeId: fixture.clientId,
      value: globalPolicyRows[0].cached_value,
      changeReason: 'integration test seed: communication_policy client scope',
    });

    await setServiceContext(fixture.organizationId, fixture.operatorUserId);

    const { rows: resolvedPolicyRows } = await client.query(
      `SELECT *
         FROM public.resolve_communication_policy($1::jsonb)`,
      [
        JSON.stringify({
          organization_id: fixture.organizationId,
          client_id: fixture.clientId,
          webhook_source_id: fixture.webhookSourceId,
        }),
      ],
    );

    expect(resolvedPolicyRows[0]?.scope_type).toBe('client');
    expect(resolvedPolicyRows[0]?.scope_id).toBe(fixture.clientId);
    expect(resolvedPolicyRows[0]?.value).toEqual(globalPolicyRows[0].cached_value);

    await client.query(
      `SELECT public.touch_recipient_channel_session($1::uuid, 'whatsapp', now())`,
      [fixture.recipientId],
    );

    const correlationId = randomUUID();
    const messageText = 'Shipment update from integration test.';
    const { rows: enqueueRows } = await client.query(
      `SELECT public.enqueue_comms_whatsapp(
          $1::uuid,
          $2::text,
          $3::text,
          $4::uuid,
          $5::uuid,
          $6::jsonb
        ) AS outbound_call_id`,
      [
        fixture.authConfigId,
        fixture.recipientPhone,
        messageText,
        correlationId,
        fixture.shipmentId,
        JSON.stringify({
          organization_id: fixture.organizationId,
          client_id: fixture.clientId,
          recipient_id: fixture.recipientId,
          webhook_source_id: fixture.webhookSourceId,
          source: 'integration_test',
        }),
      ],
    );

    const outboundCallId = enqueueRows[0]?.outbound_call_id || null;
    expect(outboundCallId).toBeTruthy();

    const { rows: outboundRows } = await client.query(
      `SELECT call_type, target_type, target_id, url, headers, body, correlation_id, context
         FROM public.outbound_calls
        WHERE id = $1::uuid
        LIMIT 1`,
      [outboundCallId],
    );

    expect(outboundRows[0]?.call_type).toBe('comms_whatsapp');
    expect(outboundRows[0]?.target_type).toBe('provider');
    expect(outboundRows[0]?.target_id).toBe(fixture.providerId);
    expect(outboundRows[0]?.url).toBeTruthy();
    expect(outboundRows[0]?.correlation_id).toBe(correlationId);
    expect(outboundRows[0]?.body?.text?.body).toBe(messageText);
    expect(outboundRows[0]?.headers || {}).not.toHaveProperty('D360-API-KEY');
    expect(outboundRows[0]?.context?.operation_template_id).toBe(fixture.operationTemplateId);

    const { rows: [{ handoff }] } = await client.query(
      `SELECT public.dispatch_outbound_call_inline($1::uuid) AS handoff`,
      [outboundCallId],
    );
    expect(handoff).toMatchObject({ job_id: outboundCallId, http_status: 202, completed: false });

    const { rows: [claim] } = await client.query(
      `SELECT * FROM public.claim_edge_job_by_id_v1($1::uuid)`,
      [outboundCallId],
    );
    expect(claim).toEqual({ job_id: outboundCallId, lease_token: expect.any(String) });

    const { rows: callSpecRows } = await client.query(
      `SELECT public.get_claimed_edge_job_call_spec_v1($1::uuid, $2::uuid) AS spec`,
      [outboundCallId, claim.lease_token],
    );

    expect(callSpecRows[0]?.spec?.headers?.['D360-API-KEY']).toBe('integration-EXAMPLE_PASSWORD');

    const providerMessageId = `msg-${randomUUID().slice(0, 12)}`;
    await client.query(
      `SELECT public.mark_claimed_edge_job_success_v1(
          $1::uuid,
          $2::uuid,
          200,
          '{}'::jsonb,
          $3::jsonb,
          12
        )`,
      [
        outboundCallId,
        claim.lease_token,
        JSON.stringify({
          messages: [
            {
              id: providerMessageId,
              status: 'accepted',
              timestamp: '1700000000',
            },
          ],
        }),
      ],
    );

    const { rows: attemptRows } = await client.query(
      `SELECT status, provider_message_id
         FROM public.comms_attempts
        WHERE outbound_call_id = $1::uuid
          AND attempt_number = 1
        LIMIT 1`,
      [outboundCallId],
    );

    expect(attemptRows[0]?.status).toBe(sentStatus);
    expect(attemptRows[0]?.provider_message_id).toBe(providerMessageId);

    const webhookInboxId = randomUUID();
    const { rows: receiptRows } = await client.query(
      `SELECT public.process_comms_delivery_receipt(
          $1::uuid,
          $2::uuid,
          $3::jsonb,
          $4::uuid
        ) AS result`,
      [
        webhookInboxId,
        fixture.webhookSourceId,
        JSON.stringify({
          message_id: providerMessageId,
          status: deliveredStatus,
        }),
        fixture.organizationId,
      ],
    );

    expect(receiptRows[0]?.result?.handled).toBe(true);
    expect(receiptRows[0]?.result?.updated_count).toBe(1);

    const { rows: deliveredAttemptRows } = await client.query(
      `SELECT status
         FROM public.comms_attempts
        WHERE outbound_call_id = $1::uuid
          AND attempt_number = 1
        LIMIT 1`,
      [outboundCallId],
    );

    expect(deliveredAttemptRows[0]?.status).toBe(deliveredStatus);

    const { rows: providerCallbackDecisionRows } = await client.query(
      `SELECT id
         FROM public.decision_log
        WHERE decision_category = 'provider_callback'
          AND resource_type = 'webhook_inbox'
          AND resource_id = $1::uuid
          AND decision_point = 'comms_delivery_receipt'
        ORDER BY timestamp DESC
        LIMIT 1`,
      [webhookInboxId],
    );

    expect(providerCallbackDecisionRows[0]?.id).toBeTruthy();

    const normalizedPhone = await normalizePhone(fixture.recipientPhone);
    const { rows: rateLimitRows1 } = await client.query(
      `SELECT public.check_and_increment_comms_reply_rate_limit(
          $1::uuid,
          $2::uuid,
          $3::text,
          60,
          1
        ) AS result`,
      [fixture.organizationId, fixture.webhookSourceId, normalizedPhone],
    );
    const { rows: rateLimitRows2 } = await client.query(
      `SELECT public.check_and_increment_comms_reply_rate_limit(
          $1::uuid,
          $2::uuid,
          $3::text,
          60,
          1
        ) AS result`,
      [fixture.organizationId, fixture.webhookSourceId, normalizedPhone],
    );

    expect(rateLimitRows1[0]?.result?.allowed).toBe(true);
    expect(rateLimitRows1[0]?.result?.count).toBe(1);
    expect(rateLimitRows2[0]?.result?.allowed).toBe(false);
    expect(rateLimitRows2[0]?.result?.reason).toBe('rate_limited');
  });

  test('uses canonical public-tracking helpers to write support messages and queue recipient notifications', async () => {
    const internalDirection = await lookupValue('support_message_direction', 'internal');
    const internalChannel = await lookupValue('support_message_channel', 'internal');

    const fixture = await seedFixture();

    await setServiceContext(fixture.organizationId, fixture.operatorUserId);

    const { rows: supportMessageRows } = await client.query(
      `SELECT public.public_tracking_emit_support_message_v1(
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::text,
          'public_tracking.integration',
          $5::text,
          $6::jsonb
        ) AS support_message_id`,
      [
        fixture.supportCaseId,
        fixture.organizationId,
        internalDirection,
        internalChannel,
        'Support note from integration test',
        JSON.stringify({ source: 'integration_test' }),
      ],
    );

    const supportMessageId = supportMessageRows[0]?.support_message_id || null;
    expect(supportMessageId).toBeTruthy();

    const { rows: supportMessageLedgerRows } = await client.query(
      `SELECT direction, channel, actor_system, body, metadata
         FROM public.support_messages
        WHERE id = $1::uuid
        LIMIT 1`,
      [supportMessageId],
    );

    expect(supportMessageLedgerRows[0]?.direction).toBe(internalDirection);
    expect(supportMessageLedgerRows[0]?.channel).toBe(internalChannel);
    expect(supportMessageLedgerRows[0]?.actor_system).toBe('public_tracking.integration');
    expect(supportMessageLedgerRows[0]?.body).toBe('Support note from integration test');
    expect(supportMessageLedgerRows[0]?.metadata?.source).toBe('integration_test');

    const { rows: notificationRows } = await client.query(
      `SELECT public.public_tracking_enqueue_recipient_notification_v1(
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'received',
          $4::text,
          $5::jsonb
        ) AS result`,
      [
        fixture.supportCaseId,
        fixture.organizationId,
        fixture.recipientId,
        'We received your request.',
        JSON.stringify({ notification_type: 'request_received' }),
      ],
    );

    const notificationResult = notificationRows[0]?.result || null;
    expect(notificationResult?.queued).toBe(true);
    expect(notificationResult?.channel).toBe('email');
    expect(notificationResult?.outbound_call_id).toBeTruthy();

    const { rows: notificationOutboundRows } = await client.query(
      `SELECT call_type, target_type, target_id, body, context
         FROM public.outbound_calls
        WHERE id = $1::uuid
        LIMIT 1`,
      [notificationResult.outbound_call_id],
    );

    expect(notificationOutboundRows[0]?.call_type).toBe('comms_email');
    expect(notificationOutboundRows[0]?.target_type).toBe('recipient');
    expect(notificationOutboundRows[0]?.target_id).toBe(fixture.recipientId);
    expect(notificationOutboundRows[0]?.body?.stage).toBe('received');
    expect(notificationOutboundRows[0]?.body?.message).toBe('We received your request.');
    expect(notificationOutboundRows[0]?.context?.source).toBe('public_tracking');

    const { rows: schedulingDecisionRows } = await client.query(
      `SELECT id
         FROM public.decision_log
        WHERE decision_category = 'comms_scheduling'
          AND resource_type = 'support_case'
          AND resource_id = $1::uuid
          AND decision_point = 'public_tracking_enqueue_recipient_notification_v1'
        ORDER BY timestamp DESC
        LIMIT 1`,
      [fixture.supportCaseId],
    );

    expect(schedulingDecisionRows[0]?.id).toBeTruthy();
  });
});
