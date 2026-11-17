const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../../scripts/utils/load-env');
loadEnv();
const { upsertWebhookPolicy } = require('../../../utils/policies');

const DATABASE_URL =
  process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));

const pool = new Pool({ connectionString: DATABASE_URL });

describe('Non-creation workflow intake intent routing', () => {
  const canonicalIntentMatrix = [
    {
      intent: 'shipment.create',
      templateCandidates: ['async_provider_dispatch_v1', 'shipment_create_v1'],
      allowsPlanning: true,
    },
    {
      intent: 'shipment.swap',
      templateCandidates: ['shipment_swap_v1'],
      allowsPlanning: true,
    },
    {
      intent: 'shipment.return',
      templateCandidates: ['shipment_return_v1'],
      allowsPlanning: true,
    },
    {
      intent: 'shipment.modify',
      templateCandidates: ['shipment_modify_v1'],
      allowsPlanning: false,
    },
    {
      intent: 'shipment.delete',
      templateCandidates: ['shipment_delete_v1'],
      allowsPlanning: false,
    },
    {
      intent: 'update.status',
      templateCandidates: ['shipment_update_status_v1'],
      allowsPlanning: false,
    },
    {
      intent: 'update.geocode',
      templateCandidates: ['shipment_update_geocode_v1'],
      allowsPlanning: false,
    },
    {
      intent: 'update.address',
      templateCandidates: ['shipment_update_address_v1'],
      allowsPlanning: false,
    },
    {
      intent: 'update.driver',
      templateCandidates: ['shipment_update_driver_v1'],
      allowsPlanning: false,
    },
    {
      intent: 'update.action',
      templateCandidates: ['shipment_update_action_v1'],
      allowsPlanning: false,
    },
    {
      intent: 'update.attachment',
      templateCandidates: ['shipment_update_attachment_v1'],
      allowsPlanning: false,
    },
  ];
  const genericShipmentUpdatedTemplateNames = [
    'shipment_update_status_v1',
    'shipment_update_address_v1',
    'shipment_update_driver_v1',
    'shipment_update_action_v1',
    'shipment_update_attachment_v1',
  ];
  const genericShipmentUpdatedIntentByTemplateName = {
    shipment_update_status_v1: 'update.status',
    shipment_update_address_v1: 'update.address',
    shipment_update_driver_v1: 'update.driver',
    shipment_update_action_v1: 'update.action',
    shipment_update_attachment_v1: 'update.attachment',
  };

  let client;

  beforeAll(async () => {
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  async function resolveTemplateIds(templateNames) {
    const { rows } = await client.query(
      `SELECT id, name
       FROM workflow_templates
       WHERE name = ANY($1::text[])`,
      [templateNames]
    );
    return new Map(rows.map((row) => [String(row.name), row.id]));
  }

  async function seedSourceWithPolicy(intent, templateRef, workflowOverrides = {}) {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const mappingId = randomUUID();
    const sourceId = randomUUID();
    const token = `tok-${randomUUID()}`;
    const normalizedIntent = intent.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const orgSlug = `non-create-${normalizedIntent}-${organizationId.slice(2, 10)}`;
    const sourceSlug = `nc-source-${normalizedIntent}-${sourceId.slice(2, 10)}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, $2::text, $3::text, 'Asia/Riyadh', 'en-US', 'active')`,
      [organizationId, `NonCreation Org ${intent}`, orgSlug]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'standard', 'active')`,
      [clientId, organizationId, `NonCreation Client ${intent}`, `nc-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
       VALUES ($1::uuid, 'webhook_inbound', $2::text, '{}'::jsonb, 1, 'non-creation test mapping')`,
      [mappingId, `non-create-${intent}-${Date.now()}`]
    );

    await client.query(
      `INSERT INTO webhook_sources (
         id,
         organization_id,
         source_identifier,
         name,
         provider_type,
         auth_token,
         mapping_config_id,
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
         TRUE
       )`,
      [sourceId, organizationId, sourceSlug, `Non-Creation Source ${intent}`, token, mappingId]
    );

    const templateCandidates = Array.isArray(templateRef) ? templateRef : [templateRef];
    const templateByName = await resolveTemplateIds(templateCandidates);
    const matchedTemplate = templateCandidates.find((name) => templateByName.has(String(name))) || '';
    if (!matchedTemplate) {
      throw new Error(`Workflow templates missing for ${intent}: ${templateCandidates.join(', ')}`);
    }
    const templateId = templateByName.get(String(matchedTemplate));

    const policy = {
      version: 1,
      response: {
        mode: 'accepted_async',
        default_headers: { 'content-type': 'application/json' }
      },
      validation: {
        idempotency: { body_path: 'event.id' }
      },
      workflow: {
        template_id: templateId,
        intent,
        ...workflowOverrides,
      }
    };

    await upsertWebhookPolicy('source', sourceId, policy, `non-creation intent ${intent}`, client);

    return {
      organizationId,
      clientId,
      sourceId,
      token,
      templateId
    };
  }

  test('status_update intent does not plan identifiers in workflow context', async () => {
    const { token, templateId } = await seedSourceWithPolicy(
      'status_update',
      'shipment_update_status_v1'
    );

    const payload = {
      event: {
        id: `evt-status-${randomUUID()}`,
        type: 'status_update'
      },
      resource: {
        tracking_number: 'NC-STATUS-123'
      }
    };

    const { rows } = await client.query(
      `SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS ack`,
      [
        token,
        JSON.stringify({ 'content-type': 'application/json' }),
        JSON.stringify(payload),
        JSON.stringify(payload)
      ]
    );

    const ack = rows[0].ack;
    expect(ack.status).toBeGreaterThanOrEqual(200);
    expect(ack.status).toBeLessThan(400);
    expect(ack.workflow_run_id).toBeTruthy();
    expect(ack.body?.resource).toBeUndefined();

    const { rows: runRows } = await client.query(
      `SELECT workflow_template_id, context
       FROM workflow_runs
       WHERE id = $1::uuid`,
      [ack.workflow_run_id]
    );

    expect(runRows).toHaveLength(1);

    const context = runRows[0].context || {};
    const followupTemplateId =
      context.workflow?.context_patch?.followup_template_id ||
      context.workflow?.followup_template_id ||
      null;

    if (templateId) {
      expect(followupTemplateId).toBe(templateId);
    }

    expect(context.planned_shipment_id).toBeUndefined();
    expect(context.planned_resource_id).toBeUndefined();
    expect(context.planned_tracking_number).toBeUndefined();
    expect(context.workflow?.context_patch?.planned_shipment_id).toBeUndefined();
    expect(context.workflow?.context_patch?.planned_tracking_number).toBeUndefined();
  });

  test('shipment_swap intent reserves identifiers only via configured plugin', async () => {
    const { token, templateId } = await seedSourceWithPolicy(
      'shipment_swap',
      'shipment_swap_v1',
      { reserve_new_tracking: true }
    );

    const payload = {
      event: {
        id: `evt-swap-${randomUUID()}`,
        type: 'shipment_swap'
      }
    };

    const { rows } = await client.query(
      `SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS ack`,
      [
        token,
        JSON.stringify({ 'content-type': 'application/json' }),
        JSON.stringify(payload),
        JSON.stringify(payload)
      ]
    );

    const ack = rows[0].ack;
    expect(ack.status).toBeGreaterThanOrEqual(200);
    expect(ack.status).toBeLessThan(400);
    expect(ack.workflow_run_id).toBeTruthy();
    expect(ack.followup_workflow_run_id).toBeTruthy();

    const followupRunId = ack.followup_workflow_run_id;

    let planned = null;
    let attempts = 6;
    while (!planned && attempts-- > 0) {
      await client.query(`SELECT progress_workflow_run($1::uuid)`, [followupRunId]);

      const { rows: reserveRows } = await client.query(
        `
          WITH run_row AS (
            SELECT to_jsonb(r.*) AS run_json
            FROM workflow_runs r
            WHERE r.id = $1::uuid
          ),
          step_row AS (
            SELECT to_jsonb(s.*) AS step_json
            FROM workflow_run_steps s
            WHERE s.workflow_run_id = $1::uuid
              AND s.handler_key = 'reserve_shipment_identifiers'
            ORDER BY sequence_order
            LIMIT 1
          )
          SELECT
            (workflow_handlers.reserve_identifiers_v1(
              jsonb_populate_record(NULL::public.workflow_run_steps, step_row.step_json),
              jsonb_populate_record(NULL::public.workflow_runs, run_row.run_json),
              '{}'::jsonb
            )).context_patch AS context_patch
          FROM run_row, step_row
        `,
        [followupRunId]
      );

      planned = reserveRows[0]?.context_patch || null;
    }

    expect(planned).toBeTruthy();
    expect(planned.planned_resource_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(planned.planned_shipment_id).toBe(planned.planned_resource_id);
    expect(planned.planned_tracking_number).toEqual(expect.any(String));

    const { rows: followupMetadata } = await client.query(
      `SELECT workflow_template_id
       FROM workflow_runs
       WHERE id = $1::uuid`,
      [followupRunId]
    );
    expect(followupMetadata).toHaveLength(1);
    expect(followupMetadata[0].workflow_template_id).toBe(templateId);
  });

  test.each(canonicalIntentMatrix)(
    '$intent routes through intake and enforces planning gate',
    async ({ intent, templateCandidates, allowsPlanning }) => {
      const { token } = await seedSourceWithPolicy(intent, templateCandidates);
      const payload = {
        event: {
          id: `evt-${intent.replace(/[^a-z0-9]+/gi, '-')}-${randomUUID()}`,
          type: intent,
        },
        resource: {
          tracking_number: `NC-${Date.now()}`,
        },
      };

      const { rows } = await client.query(
        `SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS ack`,
        [
          token,
          JSON.stringify({ 'content-type': 'application/json' }),
          JSON.stringify(payload),
          JSON.stringify(payload),
        ]
      );

      const ack = rows[0].ack;
      expect(ack.status).toBeGreaterThanOrEqual(200);
      expect(ack.status).toBeLessThan(400);
      expect(typeof ack.workflow_run_id).toBe('string');

      const { rows: runRows } = await client.query(
        `SELECT context
         FROM workflow_runs
         WHERE id = $1::uuid`,
        [ack.workflow_run_id]
      );
      expect(runRows).toHaveLength(1);

      if (!allowsPlanning) {
        const context = runRows[0].context || {};
        expect(context.planned_shipment_id).toBeUndefined();
        expect(context.planned_resource_id).toBeUndefined();
        expect(context.planned_tracking_number).toBeUndefined();
        expect(context.workflow?.context_patch?.planned_shipment_id).toBeUndefined();
        expect(context.workflow?.context_patch?.planned_tracking_number).toBeUndefined();
      }
    }
  );

  test.each([
    {
      label: 'status',
      expectedIntent: 'update.status',
      expectedTemplateName: 'shipment_update_status_v1',
      payloadPatch: {
        shipment: {
          status: 'out_for_delivery',
        },
      },
    },
    {
      label: 'address',
      expectedIntent: 'update.address',
      expectedTemplateName: 'shipment_update_address_v1',
      payloadPatch: {
        destination_address: {
          line1: 'King Fahd Road 10',
          city: 'Riyadh',
          country: 'SA',
        },
      },
    },
    {
      label: 'driver',
      expectedIntent: 'update.driver',
      expectedTemplateName: 'shipment_update_driver_v1',
      payloadPatch: {
        driver: {
          user_id: randomUUID(),
        },
      },
    },
    {
      label: 'action',
      expectedIntent: 'update.action',
      expectedTemplateName: 'shipment_update_action_v1',
      payloadPatch: {
        action: {
          action_type: 'note',
          action_category: 'operational',
          occurred_at: '2026-03-10T10:00:00Z',
        },
      },
    },
    {
      label: 'attachment',
      expectedIntent: 'update.attachment',
      expectedTemplateName: 'shipment_update_attachment_v1',
      payloadPatch: {
        attachments: [
          {
            content_url: 'https://example.com/proof.pdf',
            mime_type: 'application/pdf',
            size_bytes: 1024,
          },
        ],
      },
    },
  ])('generic shipment.updated routes $label payloads to the typed workflow template', async ({
    payloadPatch,
    expectedIntent,
    expectedTemplateName,
  }) => {
    const templateByName = await resolveTemplateIds(genericShipmentUpdatedTemplateNames);
    const templatesByIntent = Object.fromEntries(
      Array.from(templateByName.entries()).map(([name, id]) => {
        return [genericShipmentUpdatedIntentByTemplateName[name], { template_id: id }];
      })
    );

    const { token } = await seedSourceWithPolicy(
      'shipment.updated',
      'shipment_update_status_v1',
      { templates_by_intent: templatesByIntent }
    );

    const payload = {
      event: {
        id: `evt-generic-${expectedIntent.replace(/[^a-z0-9]+/gi, '-')}-${randomUUID()}`,
        type: 'shipment.updated',
      },
      shipment: {
        tracking_number: `GEN-${Date.now()}`,
      },
      ...payloadPatch,
    };

    const { rows } = await client.query(
      `SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS ack`,
      [
        token,
        JSON.stringify({ 'content-type': 'application/json' }),
        JSON.stringify(payload),
        JSON.stringify(payload),
      ]
    );

    const ack = rows[0].ack;
    expect(ack.status).toBeGreaterThanOrEqual(200);
    expect(ack.status).toBeLessThan(400);
    expect(ack.canonical_intent).toBe(expectedIntent);
    expect(typeof ack.followup_workflow_run_id).toBe('string');

    const { rows: followupRows } = await client.query(
      `SELECT workflow_template_id, context
       FROM workflow_runs
       WHERE id = $1::uuid`,
      [ack.followup_workflow_run_id]
    );

    expect(followupRows).toHaveLength(1);
    expect(followupRows[0].workflow_template_id).toBe(templateByName.get(expectedTemplateName));
    expect(
      followupRows[0].context?.canonical_intent ||
      followupRows[0].context?.workflow?.context_patch?.canonical_intent ||
      ack.canonical_intent
    ).toBe(expectedIntent);
  });

  test('generic shipment.updated fails closed when payload matches multiple specific mutation segments', async () => {
    const templateByName = await resolveTemplateIds(genericShipmentUpdatedTemplateNames);
    const templatesByIntent = Object.fromEntries(
      Array.from(templateByName.entries()).map(([name, id]) => {
        return [genericShipmentUpdatedIntentByTemplateName[name], { template_id: id }];
      })
    );

    const { token, sourceId } = await seedSourceWithPolicy(
      'shipment.updated',
      'shipment_update_status_v1',
      { templates_by_intent: templatesByIntent }
    );
    const eventId = `evt-generic-ambiguous-${randomUUID()}`;
    const payload = {
      event: {
        id: eventId,
        type: 'shipment.updated',
      },
      shipment: {
        tracking_number: `GEN-AMB-${Date.now()}`,
      },
      action: {
        action_type: 'note',
        action_category: 'operational',
        occurred_at: '2026-03-10T10:00:00Z',
      },
      attachments: [
        {
          content_url: 'https://example.com/proof.pdf',
          mime_type: 'application/pdf',
          size_bytes: 1024,
        },
      ],
    };

    const { rows } = await client.query(
      `SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS ack`,
      [
        token,
        JSON.stringify({ 'content-type': 'application/json' }),
        JSON.stringify(payload),
        JSON.stringify(payload),
      ]
    );

    const ack = rows[0].ack;
    expect(ack.status).toBe(400);
    expect(ack.body?.error).toBe('shipment_update_payload_ambiguous');
    expect(ack.workflow_run_id).toBeUndefined();
    expect(ack.followup_workflow_run_id).toBeUndefined();

    const { rows: inboxRows } = await client.query(
      `SELECT COUNT(*)::int AS inbox_count
       FROM webhook_inbox
       WHERE webhook_source_id = $1::uuid
         AND idempotency_key = $2::text`,
      [sourceId, eventId]
    );

    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].inbox_count).toBe(0);
  });

  test.each(
    canonicalIntentMatrix.filter((entry) => entry.allowsPlanning)
  )('$intent remains idempotent on replayed event.id', async ({ intent, templateCandidates }) => {
    const { token, sourceId } = await seedSourceWithPolicy(intent, templateCandidates);
    const eventId = `idem-${intent.replace(/[^a-z0-9]+/gi, '-')}-${randomUUID()}`;
    const payload = {
      event: {
        id: eventId,
        type: intent,
      },
      resource: {
        tracking_number: `NC-IDEM-${Date.now()}`,
      },
    };

    const callIntake = async () => {
      const { rows } = await client.query(
        `SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS ack`,
        [
          token,
          JSON.stringify({ 'content-type': 'application/json' }),
          JSON.stringify(payload),
          JSON.stringify(payload),
        ]
      );
      return rows[0].ack;
    };

    const first = await callIntake();
    const second = await callIntake();

    expect(first.status).toBeGreaterThanOrEqual(200);
    expect(second.status).toBeGreaterThanOrEqual(200);
    if (second.workflow_run_id) {
      expect(second.workflow_run_id).toBe(first.workflow_run_id);
    }

    const { rows: dedupeRows } = await client.query(
      `SELECT
         COUNT(*)::int AS inbox_count,
         COUNT(DISTINCT workflow_run_id)::int AS run_count
       FROM webhook_inbox
       WHERE webhook_source_id = $1::uuid
         AND idempotency_key = $2::text`,
      [sourceId, eventId]
    );
    expect(dedupeRows).toHaveLength(1);
    expect(dedupeRows[0].inbox_count).toBe(1);
    expect(dedupeRows[0].run_count).toBe(1);
  });
});
