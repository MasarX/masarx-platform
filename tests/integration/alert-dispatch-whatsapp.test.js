const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { applySetting } = require('./helpers/tenant-utils');
const {
  ensureIntegrationFixturesPresent,
  getIntegrationFixtureProfile,
} = require('./helpers/integration-fixtures');

loadEnv();

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('Alert dispatch worker (WhatsApp on-call)', () => {
  let client;
  const fixtureOrgSlug = getIntegrationFixtureProfile().organizations.alpha.slug;

  const resolveDialogProviderScope = async (db) => {
    const { rows: templatedRows } = await db.query(
      `
        SELECT p.organization_id, p.id AS provider_id
        FROM providers p
        JOIN organizations o ON o.id = p.organization_id
        WHERE p.name = 'dialog360_whatsapp'
          AND o.slug = $1::text
          AND EXISTS (
            SELECT 1
            FROM operation_templates ot
            WHERE ot.provider_id = p.id
              AND ot.operation_name = 'ops_oncall_whatsapp_alert_v1'
          )
        ORDER BY p.created_at ASC
        LIMIT 1
      `,
      [fixtureOrgSlug],
    );
    if (templatedRows.length) return templatedRows[0];

    const { rows } = await db.query(
      `
        SELECT p.organization_id, p.id AS provider_id
        FROM providers p
        JOIN organizations o ON o.id = p.organization_id
        WHERE p.name = 'dialog360_whatsapp'
          AND o.slug = $1::text
        ORDER BY p.created_at ASC
        LIMIT 1
      `,
      [fixtureOrgSlug],
    );
    if (rows.length) return rows[0];

    const { rows: globalRows } = await db.query(
      `
        SELECT p.organization_id, p.id AS provider_id
        FROM providers p
        WHERE p.name = 'dialog360_whatsapp'
        ORDER BY p.created_at ASC
        LIMIT 1
      `,
    );
    return globalRows[0] || null;
  };

  const ensureOpsOncallTemplateAuth = async (db, providerId, authConfigId) => {
    const { rows } = await db.query(
      `
        WITH target AS (
          SELECT id
          FROM operation_templates
          WHERE provider_id = $1::uuid
            AND operation_name = 'ops_oncall_whatsapp_alert_v1'
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1
        )
        UPDATE operation_templates ot
        SET
          headers_template = jsonb_strip_nulls(
            COALESCE(ot.headers_template, '{}'::jsonb)
            || jsonb_build_object('content-type', 'application/json')
          ),
          metadata = jsonb_strip_nulls(
            COALESCE(ot.metadata, '{}'::jsonb)
            || jsonb_build_object(
              'auth',
              jsonb_build_object(
                'mode', 'api_key_header',
                'auth_type', 'api_key',
                'auth_config_id', $2::uuid,
                'header', 'D360-API-KEY',
                'credential_key', 'api_key'
              )
            )
          ),
          updated_at = now()
        FROM target
        WHERE ot.id = target.id
        RETURNING ot.id
      `,
      [providerId, authConfigId],
    );

    return rows[0]?.id || null;
  };

  beforeAll(async () => {
    await ensureIntegrationFixturesPresent();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  test('enqueues comms_whatsapp outbound call and marks trigger notified', async () => {
    await client.query(
      `UPDATE cron_config SET last_run_at = NULL WHERE worker_name = 'alert_dispatch_worker'`
    );

    const providerScope = await resolveDialogProviderScope(client);
    expect(providerScope).toBeTruthy();
    const organizationId = providerScope.organization_id;
    const providerId = providerScope.provider_id;

    const authConfigId = randomUUID();
    const { rows: vaultRows } = await client.query(
      `SELECT vault.create_secret($1::text, $2::text, $3::text, NULL) AS id`,
      [
        JSON.stringify({ api_key: 'EXAMPLE_PASSWORD' }),
        `provider_auth_configs/${authConfigId}`,
        'integration alert dispatch whatsapp api_key',
      ],
    );

    await client.query(
      `INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
       VALUES ($1::uuid, $2::uuid, 'api_key', $3::uuid, NULL, NULL)`,
      [authConfigId, providerId, vaultRows[0].id],
    );

    await applySetting(client, {
      category: 'ops_oncall_alerting',
      scopeType: 'tenant',
      scopeId: organizationId,
      value: {
        enabled: true,
        min_severity: 'warning',
        channels: {
          whatsapp: {
            enabled: true,
            provider_id: providerId,
            operation_name: 'ops_oncall_whatsapp_alert_v1',
            to: '+12025550123',
            to_normalization: 'digits_only',
            message_prefix: '[TEST]',
          },
        },
      },
      changeReason: 'integration-test: ops_oncall_alerting'
    });

    const templateId = await ensureOpsOncallTemplateAuth(client, providerId, authConfigId);
    expect(templateId).toBeTruthy();

    const alertRuleId = randomUUID();
    const ruleName = `test::alert_dispatch::${Date.now()}::${Math.random().toString(16).slice(2)}`;
    await client.query(
      `
        INSERT INTO alert_rules (
          id,
          organization_id,
          rule_name,
          enabled,
          priority,
          trigger_source,
          trigger_conditions,
          throttle_window_minutes,
          alert_channels
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          TRUE,
          100,
          'decision_log',
          jsonb_build_object('decision_category','test'),
          5,
          jsonb_build_array('whatsapp')
        )
      `,
      [alertRuleId, organizationId, ruleName]
    );

    const alertTriggerId = randomUUID();
    const resourceId = randomUUID();
    const correlationId = randomUUID();
    await client.query(
      `
        INSERT INTO alert_triggers (
          id,
          alert_rule_id,
          organization_id,
          resource_type,
          resource_id,
          severity,
          message,
          context,
          notified_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'decision_log',
          $4::uuid,
          'critical',
          'integration test alert',
          jsonb_build_object('correlation_id', $5::text),
          NULL
        )
      `,
      [alertTriggerId, alertRuleId, organizationId, resourceId, correlationId]
    );

    const { rows: dispatchRows } = await client.query(
      `SELECT public.run_alert_dispatch_worker() AS result`
    );
    expect(dispatchRows.length).toBe(1);
    expect(dispatchRows[0].result).toBeTruthy();

    const { rows: triggerRows } = await client.query(
      `SELECT notified_at, context FROM alert_triggers WHERE id = $1::uuid`,
      [alertTriggerId]
    );
    expect(triggerRows.length).toBe(1);
    expect(triggerRows[0].notified_at).not.toBeNull();
    expect(triggerRows[0].context).toHaveProperty('dispatch');
    expect(triggerRows[0].context.dispatch).toHaveProperty('channels');
    expect(triggerRows[0].context.dispatch.channels).toHaveProperty('whatsapp');
    expect(triggerRows[0].context.dispatch.channels.whatsapp).toHaveProperty('outbound_call_id');

    const outboundCallId = triggerRows[0].context.dispatch.channels.whatsapp.outbound_call_id;
    expect(outboundCallId).toBeTruthy();

    const { rows: outboundRows } = await client.query(
      `SELECT call_type, target_type, target_id, url, headers, body, correlation_id, context
         FROM outbound_calls
        WHERE id = $1::uuid`,
      [outboundCallId]
    );
    expect(outboundRows.length).toBe(1);
    expect(outboundRows[0].call_type).toBe('comms_whatsapp');
    expect(outboundRows[0].target_type).toBe('provider');
    expect(outboundRows[0].target_id).toBe(providerId);
    expect(outboundRows[0].url).toBeTruthy();
    const outboundHeaders = outboundRows[0].headers || {};
    expect(outboundHeaders).not.toHaveProperty('D360-API-KEY');
    expect(outboundRows[0].body).toHaveProperty('to');
    expect(outboundRows[0].correlation_id).toBe(correlationId);
    expect(outboundRows[0].context).toHaveProperty('alert_trigger_id');
    expect(outboundRows[0].context.alert_trigger_id).toBe(alertTriggerId);
    expect(outboundRows[0].context).toHaveProperty('channel');
    expect(outboundRows[0].context.channel).toBe('whatsapp');

    const { rows: specRows } = await client.query(
      `SELECT public.get_job_call_spec($1::uuid) AS spec`,
      [outboundCallId]
    );
    expect(specRows.length).toBe(1);
    const specHeaders = specRows[0].spec?.headers || {};
    expect(specHeaders).toHaveProperty('D360-API-KEY');
    expect(specHeaders['D360-API-KEY']).toBe('EXAMPLE_PASSWORD');

    const { rows: decisionRows } = await client.query(
      `
        SELECT id
        FROM decision_log
        WHERE decision_category = 'alert_dispatch'
          AND resource_type = 'alert_trigger'
          AND resource_id = $1::uuid
        ORDER BY timestamp DESC
        LIMIT 1
      `,
      [alertTriggerId]
    );
    expect(decisionRows.length).toBe(1);
  });

  test('does not dispatch WhatsApp when rule channels do not include it', async () => {
    await client.query(
      `UPDATE cron_config SET last_run_at = NULL WHERE worker_name = 'alert_dispatch_worker'`
    );

    const providerScope = await resolveDialogProviderScope(client);
    expect(providerScope).toBeTruthy();
    const organizationId = providerScope.organization_id;
    const providerId = providerScope.provider_id;

    const authConfigId = randomUUID();
    const { rows: vaultRows } = await client.query(
      `SELECT vault.create_secret($1::text, $2::text, $3::text, NULL) AS id`,
      [
        JSON.stringify({ api_key: 'EXAMPLE_PASSWORD' }),
        `provider_auth_configs/${authConfigId}`,
        'integration alert dispatch whatsapp api_key',
      ],
    );

    await client.query(
      `INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
       VALUES ($1::uuid, $2::uuid, 'api_key', $3::uuid, NULL, NULL)`,
      [authConfigId, providerId, vaultRows[0].id],
    );

    await applySetting(client, {
      category: 'ops_oncall_alerting',
      scopeType: 'tenant',
      scopeId: organizationId,
      value: {
        enabled: true,
        min_severity: 'warning',
        channels: {
          whatsapp: {
            enabled: true,
            provider_id: providerId,
            operation_name: 'ops_oncall_whatsapp_alert_v1',
            to: '+12025550123',
            to_normalization: 'digits_only',
            message_prefix: '[TEST]',
          },
        },
      },
      changeReason: 'integration-test: ops_oncall_alerting',
    });

    const alertRuleId = randomUUID();
    const ruleName = `test::alert_dispatch::no_whatsapp::${Date.now()}::${Math.random().toString(16).slice(2)}`;
    await client.query(
      `
        INSERT INTO alert_rules (
          id,
          organization_id,
          rule_name,
          enabled,
          priority,
          trigger_source,
          trigger_conditions,
          throttle_window_minutes,
          alert_channels
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          TRUE,
          100,
          'decision_log',
          jsonb_build_object('decision_category','test'),
          5,
          jsonb_build_array('email')
        )
      `,
      [alertRuleId, organizationId, ruleName]
    );

    const alertTriggerId = randomUUID();
    const resourceId = randomUUID();
    await client.query(
      `
        INSERT INTO alert_triggers (
          id,
          alert_rule_id,
          organization_id,
          resource_type,
          resource_id,
          severity,
          message,
          context,
          notified_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'decision_log',
          $4::uuid,
          'critical',
          'integration test alert',
          '{}'::jsonb,
          NULL
        )
      `,
      [alertTriggerId, alertRuleId, organizationId, resourceId]
    );

    await client.query(`SELECT public.run_alert_dispatch_worker()`);

    const { rows: triggerRows } = await client.query(
      `SELECT notified_at, context FROM alert_triggers WHERE id = $1::uuid`,
      [alertTriggerId]
    );
    expect(triggerRows.length).toBe(1);
    expect(triggerRows[0].notified_at).not.toBeNull();
    expect(triggerRows[0].context).toHaveProperty('dispatch');
    expect(triggerRows[0].context.dispatch).toHaveProperty('status');
    expect(triggerRows[0].context.dispatch.status).toBe('skipped');
    expect(triggerRows[0].context.dispatch).toHaveProperty('skipped');
    expect(triggerRows[0].context.dispatch.skipped).toHaveProperty('email');

    const { rows: outboundRows } = await client.query(
      `
        SELECT id
        FROM outbound_calls
        WHERE context->>'alert_trigger_id' = $1
      `,
      [alertTriggerId]
    );
    expect(outboundRows.length).toBe(0);
  });
});
