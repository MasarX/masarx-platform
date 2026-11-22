const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  applySetting,
  createOrganization,
  createUser,
  setAuthContext,
  setFixtureAdminContext,
  withFixtureAdminContext,
} = require('../helpers/tenant-utils');

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be defined for zones+baskets workflow test');
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function createZonesBasketsTemplate(client, organizationId) {
  const templateName = `pgtemp_zones_baskets_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const {
    rows: [{ id: templateId }],
  } = await client.query(
    `
      INSERT INTO workflow_templates (
        name,
        description,
        status,
        version,
        scope_type,
        scope_id,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        'Temporary template for zones+baskets handler integration test',
        'active',
        1,
        'tenant',
        $2::uuid,
        now(),
        now()
      )
      RETURNING id
    `,
    [templateName, organizationId]
  );

  await client.query(
    `
      INSERT INTO workflow_template_steps (
        workflow_template_id,
        sequence_order,
        operation_name,
        operation_settings_category,
        transition_condition,
        handler_key,
        handler_version,
        metadata,
        enabled,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        1,
        'zone_assign',
        'routing',
        'always',
        'zone_assign',
        'v1',
        jsonb_build_object('decision_log_event', 'test.zone_assign'),
        TRUE,
        now(),
        now()
      ),
      (
        $1::uuid,
        2,
        'basket_assign',
        'routing',
        'always',
        'basket_assign',
        'v1',
        jsonb_build_object('decision_log_event', 'test.basket_assign'),
        TRUE,
        now(),
        now()
      )
    `,
    [templateId]
  );

  return templateId;
}

async function progressWorkflowToHandlers(client, runId, handlerKeys, maxAttempts = 6) {
  const completed = new Set();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const {
      rows: [{ result: stepResult }],
    } = await client.query('SELECT progress_workflow_run($1::uuid) AS result', [runId]);
    if (stepResult?.handler_key && stepResult.status === 'completed') {
      completed.add(stepResult.handler_key);
    }

    const { rows: stepRows } = await client.query(
      `SELECT handler_key, step_status, operation_result
         FROM workflow_run_steps
        WHERE workflow_run_id = $1`,
      [runId]
    );

    for (const row of stepRows) {
      if (row.step_status === 'completed') {
        completed.add(row.handler_key);
      }
    }

    if (handlerKeys.every((handlerKey) => completed.has(handlerKey))) {
      return { completed, stepRows };
    }
  }

  const { rows: stepRows } = await client.query(
    `SELECT handler_key, step_status, operation_result
       FROM workflow_run_steps
      WHERE workflow_run_id = $1`,
    [runId]
  );

  return { completed, stepRows };
}

describe('zones + baskets workflow handlers', () => {
  let client;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    if (client) {
      client.release();
    }
    await pool.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  test('assigns shipment zone and basket from geocoding context', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const shipmentId = randomUUID();
    const canonicalCityId = randomUUID();
    const canonicalDistrictId = randomUUID();
    const zoneId = randomUUID();
    const seededBasketId = randomUUID();

    const tracking = `ZB${shipmentId.slice(0, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Zones+Baskets Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `zones-baskets-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Zones+Baskets Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `zones-baskets-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO senders (id, client_id, name, status)
       VALUES ($1::uuid, $2::uuid, 'Zones+Baskets Sender', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [senderId, clientId]
    );

    await client.query(
      `INSERT INTO canonical_cities (
          id,
          organization_id,
          name_canonical,
          name_arabic,
          alternate_names,
          source,
          metadata,
          is_active,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          'Test City',
          NULL,
          ARRAY['Test City']::text[],
          'manual_seed',
          '{}'::jsonb,
          TRUE,
          now(),
          now()
       )
       ON CONFLICT (id) DO NOTHING`,
      [canonicalCityId, organizationId]
    );

    await client.query(
      `INSERT INTO canonical_districts (
          id,
          organization_id,
          city_id,
          name_canonical,
          name_arabic,
          alternate_names,
          source,
          metadata,
          is_active,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'Test District',
          NULL,
          ARRAY['Test District']::text[],
          'manual_seed',
          '{}'::jsonb,
          TRUE,
          now(),
          now()
       )
       ON CONFLICT (id) DO NOTHING`,
      [canonicalDistrictId, organizationId, canonicalCityId]
    );

    await client.query(
      `INSERT INTO zones (id, organization_id, name, slug, is_active, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Zone A', $3, TRUE, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [zoneId, organizationId, `zone-a-${zoneId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO zone_districts (zone_id, canonical_district_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT DO NOTHING`,
      [zoneId, canonicalDistrictId]
    );

    await client.query(
      `INSERT INTO baskets (
          id,
          organization_id,
          zone_id,
          basket_type,
          state,
          current_count,
          capacity_count,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'zone_based',
          'forming',
          0,
          NULL,
          now(),
          now()
       )
       ON CONFLICT (id) DO NOTHING`,
      [seededBasketId, organizationId, zoneId]
    );

    await client.query(
      `INSERT INTO shipments (
          id,
          organization_id,
          client_id,
          sender_id,
          service_type,
          tracking_number,
          status,
          box_count,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          'delivery',
          $5,
          'pending',
          1,
          now(),
          now()
       )
       ON CONFLICT (id, client_id) DO NOTHING`,
      [shipmentId, organizationId, clientId, senderId, tracking]
    );

    await applySetting(client, {
      category: 'basket_policy',
      scopeType: 'sender',
      scopeId: senderId,
      value: {
        version: 1,
        enabled: true,
        basket_type: 'zone_based',
        open_states: ['forming'],
        create_if_missing: true,
        require_zone: true,
      },
      version: 1,
      schemaVersion: 1,
      approvedAt: new Date().toISOString(),
    });

    const templateName = `pgtemp_zones_baskets_${Date.now()}`;
    const {
      rows: [{ id: templateId }],
    } = await client.query(
      `
        INSERT INTO workflow_templates (
          name,
          description,
          status,
          version,
          scope_type,
          scope_id,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          'Temporary template for zones+baskets handler integration test',
          'active',
          1,
          'tenant',
          $2::uuid,
          now(),
          now()
        )
        RETURNING id
      `,
      [templateName, organizationId]
    );

    await client.query(
      `
        INSERT INTO workflow_template_steps (
          workflow_template_id,
          sequence_order,
          operation_name,
          operation_settings_category,
          transition_condition,
          handler_key,
          handler_version,
          metadata,
          enabled,
          created_at,
          updated_at
        )
        VALUES (
          $1::uuid,
          1,
          'zone_assign',
          'routing',
          'always',
          'zone_assign',
          'v1',
          jsonb_build_object('decision_log_event', 'test.zone_assign'),
          TRUE,
          now(),
          now()
        ),
        (
          $1::uuid,
          2,
          'basket_assign',
          'routing',
          'always',
          'basket_assign',
          'v1',
          jsonb_build_object('decision_log_event', 'test.basket_assign'),
          TRUE,
          now(),
          now()
        )
      `,
      [templateId]
    );

    const {
      rows: [{ run_id: runId }],
    } = await client.query('SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id', [
      templateId,
      {
        organization_id: organizationId,
        client_id: clientId,
        sender_id: senderId,
        shipment_id: shipmentId,
        geocoding: {
          successful: true,
          local_reverse_match: {
            canonical_district_id: canonicalDistrictId,
          },
        },
      },
    ]);

    const completed = new Set();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const {
        rows: [{ result: stepResult }],
      } = await client.query('SELECT progress_workflow_run($1::uuid) AS result', [runId]);
      if (stepResult?.handler_key && stepResult.status === 'completed') {
        completed.add(stepResult.handler_key);
      }

      const { rows: stepRows } = await client.query(
        'SELECT handler_key, step_status FROM workflow_run_steps WHERE workflow_run_id = $1',
        [runId],
      );
      for (const row of stepRows) {
        if (row.step_status === 'completed') {
          completed.add(row.handler_key);
        }
      }

      if (completed.has('zone_assign') && completed.has('basket_assign')) {
        break;
      }
    }
    expect(completed.has('zone_assign')).toBe(true);
    expect(completed.has('basket_assign')).toBe(true);

    const {
      rows: [shipmentRow],
    } = await client.query(
      `SELECT zone_id
       FROM shipments
       WHERE id = $1::uuid
         AND client_id = $2::uuid`,
      [shipmentId, clientId]
    );
    expect(shipmentRow.zone_id).toBe(zoneId);

    const { rows: basketRows } = await client.query(
      `
        SELECT bi.basket_id,
               b.organization_id,
               b.zone_id,
               b.current_count
        FROM basket_items bi
        JOIN baskets b ON b.id = bi.basket_id
        WHERE bi.shipment_id = $1::uuid
          AND bi.shipment_client_id = $2::uuid
          AND bi.removed_at IS NULL
        LIMIT 1
      `,
      [shipmentId, clientId]
    );
    expect(basketRows.length).toBe(1);
    expect(basketRows[0].basket_id).toBe(seededBasketId);
    expect(basketRows[0].organization_id).toBe(organizationId);
    expect(basketRows[0].zone_id).toBe(zoneId);
    expect(Number(basketRows[0].current_count)).toBe(1);
  });

  test('assigns shipment to a branch, route, service, and priority-specific basket', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const shipmentId = randomUUID();
    const canonicalCityId = randomUUID();
    const canonicalDistrictId = randomUUID();
    const zoneId = randomUUID();
    const branchId = randomUUID();
    const serviceLevelId = randomUUID();
    const matchingBasketId = randomUUID();
    const distractorBasketId = randomUUID();

    const tracking = `ZBSP${shipmentId.slice(0, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Zones+Baskets Sort Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `zones-baskets-sort-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Zones+Baskets Sort Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `zones-baskets-sort-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO senders (id, client_id, name, status)
       VALUES ($1::uuid, $2::uuid, 'Zones+Baskets Sort Sender', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [senderId, clientId]
    );

    await client.query(
      `INSERT INTO canonical_cities (
          id,
          organization_id,
          name_canonical,
          name_arabic,
          alternate_names,
          source,
          metadata,
          is_active,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          'Sort City',
          NULL,
          ARRAY['Sort City']::text[],
          'manual_seed',
          '{}'::jsonb,
          TRUE,
          now(),
          now()
       )
       ON CONFLICT (id) DO NOTHING`,
      [canonicalCityId, organizationId]
    );

    await client.query(
      `INSERT INTO canonical_districts (
          id,
          organization_id,
          city_id,
          name_canonical,
          name_arabic,
          alternate_names,
          source,
          metadata,
          is_active,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'Sort District',
          NULL,
          ARRAY['Sort District']::text[],
          'manual_seed',
          '{}'::jsonb,
          TRUE,
          now(),
          now()
       )
       ON CONFLICT (id) DO NOTHING`,
      [canonicalDistrictId, organizationId, canonicalCityId]
    );

    await client.query(
      `INSERT INTO zones (id, organization_id, name, slug, is_active, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Sort Zone', $3, TRUE, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [zoneId, organizationId, `sort-zone-${zoneId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO zone_districts (zone_id, canonical_district_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT DO NOTHING`,
      [zoneId, canonicalDistrictId]
    );

    await client.query(
      `INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
       VALUES ($1::uuid, $2::uuid, 'b04sort', 'B04 Sort Branch', 'Asia/Riyadh', TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [branchId, organizationId]
    );

    await client.query(
      `INSERT INTO branch_zones (branch_id, zone_id, priority)
       VALUES ($1::uuid, $2::uuid, 0)
       ON CONFLICT (zone_id) DO NOTHING`,
      [branchId, zoneId]
    );

    const {
      rows: [{ id: activeServiceLevelId }],
    } = await client.query(
      `INSERT INTO service_levels (id, organization_id, key, name, is_active)
       VALUES ($1::uuid, $2::uuid, 'express', 'Express', TRUE)
       ON CONFLICT (organization_id, key) DO UPDATE
       SET name = EXCLUDED.name,
           is_active = TRUE,
           updated_at = now()
       RETURNING id`,
      [serviceLevelId, organizationId]
    );

    await client.query(
      `INSERT INTO service_offerings (
          service_level_id,
          branch_id,
          zone_id,
          effective_from,
          effective_to,
          priority,
          is_active
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          now() - interval '1 day',
          NULL,
          0,
          TRUE
       )`,
      [activeServiceLevelId, branchId, zoneId]
    );

    await client.query(
      `INSERT INTO baskets (
          id,
          organization_id,
          zone_id,
          basket_type,
          state,
          current_count,
          sort_branch_id,
          sort_service_key,
          sort_route_key,
          sort_priority_key,
          created_at,
          updated_at
       )
       VALUES
       (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'zone_based',
          'forming',
          0,
          $4::uuid,
          'express',
          'route-a',
          'urgent',
          now(),
          now()
       ),
       (
          $5::uuid,
          $2::uuid,
          $3::uuid,
          'zone_based',
          'forming',
          0,
          $4::uuid,
          'express',
          'route-b',
          'urgent',
          now(),
          now()
       )
       ON CONFLICT (id) DO NOTHING`,
      [matchingBasketId, organizationId, zoneId, branchId, distractorBasketId]
    );

    await client.query(
      `INSERT INTO shipments (
          id,
          organization_id,
          client_id,
          sender_id,
          service_type,
          service_level,
          priority_score,
          tracking_number,
          status,
          box_count,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          'delivery',
          'express',
          95,
          $5,
          'pending',
          1,
          now(),
          now()
       )
       ON CONFLICT (id, client_id) DO NOTHING`,
      [shipmentId, organizationId, clientId, senderId, tracking]
    );

    await applySetting(client, {
      category: 'basket_policy',
      scopeType: 'sender',
      scopeId: senderId,
      value: {
        version: 1,
        enabled: true,
        basket_type: 'zone_based',
        open_states: ['forming'],
        create_if_missing: true,
        require_zone: true,
        group_by_branch: true,
        group_by_service: true,
        service_match_field: 'service_level',
        group_by_route: true,
        route_key_paths: 'routing.route_key|dispatch.route_key',
        group_by_priority: true,
        priority_bands: [
          { key: 'urgent', min_score: 80 },
          { key: 'standard', max_score: 79.999 },
        ],
      },
      version: 1,
      schemaVersion: 1,
      approvedAt: new Date().toISOString(),
    });

    const templateId = await createZonesBasketsTemplate(client, organizationId);
    const {
      rows: [{ run_id: runId }],
    } = await client.query('SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id', [
      templateId,
      {
        organization_id: organizationId,
        client_id: clientId,
        sender_id: senderId,
        shipment_id: shipmentId,
        routing: {
          route_key: 'route-a',
        },
        geocoding: {
          successful: true,
          local_reverse_match: {
            canonical_district_id: canonicalDistrictId,
          },
        },
      },
    ]);

    const { completed, stepRows } = await progressWorkflowToHandlers(client, runId, [
      'zone_assign',
      'basket_assign',
    ]);

    expect(completed.has('zone_assign')).toBe(true);
    expect(completed.has('basket_assign')).toBe(true);

    const basketAssignStep = stepRows.find((row) => row.handler_key === 'basket_assign');
    expect(basketAssignStep?.step_status).toBe('completed');
    expect(basketAssignStep?.operation_result?.assigned).toBe(true);
    expect(basketAssignStep?.operation_result?.basket_id).toBe(matchingBasketId);
    expect(basketAssignStep?.operation_result?.sort_branch_id).toBe(branchId);
    expect(basketAssignStep?.operation_result?.sort_service_key).toBe('express');
    expect(basketAssignStep?.operation_result?.sort_route_key).toBe('route-a');
    expect(basketAssignStep?.operation_result?.sort_priority_key).toBe('urgent');

    const { rows: basketRows } = await client.query(
      `
        SELECT bi.basket_id,
               b.zone_id,
               b.sort_branch_id,
               b.sort_service_key,
               b.sort_route_key,
               b.sort_priority_key,
               b.current_count
        FROM basket_items bi
        JOIN baskets b ON b.id = bi.basket_id
        WHERE bi.shipment_id = $1::uuid
          AND bi.shipment_client_id = $2::uuid
          AND bi.removed_at IS NULL
        LIMIT 1
      `,
      [shipmentId, clientId]
    );

    expect(basketRows.length).toBe(1);
    expect(basketRows[0].basket_id).toBe(matchingBasketId);
    expect(basketRows[0].zone_id).toBe(zoneId);
    expect(basketRows[0].sort_branch_id).toBe(branchId);
    expect(basketRows[0].sort_service_key).toBe('express');
    expect(basketRows[0].sort_route_key).toBe('route-a');
    expect(basketRows[0].sort_priority_key).toBe('urgent');
    expect(Number(basketRows[0].current_count)).toBe(1);
  });

  test('fails closed when route grouping is enabled without a route key', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const shipmentId = randomUUID();
    const canonicalCityId = randomUUID();
    const canonicalDistrictId = randomUUID();
    const zoneId = randomUUID();
    const branchId = randomUUID();
    const serviceLevelId = randomUUID();

    const tracking = `ZBRT${shipmentId.slice(0, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Zones+Baskets Route Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `zones-baskets-route-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Zones+Baskets Route Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `zones-baskets-route-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO senders (id, client_id, name, status)
       VALUES ($1::uuid, $2::uuid, 'Zones+Baskets Route Sender', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [senderId, clientId]
    );

    await client.query(
      `INSERT INTO canonical_cities (
          id,
          organization_id,
          name_canonical,
          name_arabic,
          alternate_names,
          source,
          metadata,
          is_active,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          'Route City',
          NULL,
          ARRAY['Route City']::text[],
          'manual_seed',
          '{}'::jsonb,
          TRUE,
          now(),
          now()
       )
       ON CONFLICT (id) DO NOTHING`,
      [canonicalCityId, organizationId]
    );

    await client.query(
      `INSERT INTO canonical_districts (
          id,
          organization_id,
          city_id,
          name_canonical,
          name_arabic,
          alternate_names,
          source,
          metadata,
          is_active,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'Route District',
          NULL,
          ARRAY['Route District']::text[],
          'manual_seed',
          '{}'::jsonb,
          TRUE,
          now(),
          now()
       )
       ON CONFLICT (id) DO NOTHING`,
      [canonicalDistrictId, organizationId, canonicalCityId]
    );

    await client.query(
      `INSERT INTO zones (id, organization_id, name, slug, is_active, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Route Zone', $3, TRUE, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [zoneId, organizationId, `route-zone-${zoneId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO zone_districts (zone_id, canonical_district_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT DO NOTHING`,
      [zoneId, canonicalDistrictId]
    );

    await client.query(
      `INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
       VALUES ($1::uuid, $2::uuid, 'b04route', 'B04 Route Branch', 'Asia/Riyadh', TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [branchId, organizationId]
    );

    await client.query(
      `INSERT INTO branch_zones (branch_id, zone_id, priority)
       VALUES ($1::uuid, $2::uuid, 0)
       ON CONFLICT (zone_id) DO NOTHING`,
      [branchId, zoneId]
    );

    const {
      rows: [{ id: activeServiceLevelId }],
    } = await client.query(
      `INSERT INTO service_levels (id, organization_id, key, name, is_active)
       VALUES ($1::uuid, $2::uuid, 'express', 'Express', TRUE)
       ON CONFLICT (organization_id, key) DO UPDATE
       SET name = EXCLUDED.name,
           is_active = TRUE,
           updated_at = now()
       RETURNING id`,
      [serviceLevelId, organizationId]
    );

    await client.query(
      `INSERT INTO service_offerings (
          service_level_id,
          branch_id,
          zone_id,
          effective_from,
          effective_to,
          priority,
          is_active
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          now() - interval '1 day',
          NULL,
          0,
          TRUE
       )`,
      [activeServiceLevelId, branchId, zoneId]
    );

    await client.query(
      `INSERT INTO shipments (
          id,
          organization_id,
          client_id,
          sender_id,
          service_type,
          service_level,
          priority_score,
          tracking_number,
          status,
          box_count,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          'delivery',
          'express',
          95,
          $5,
          'pending',
          1,
          now(),
          now()
       )
       ON CONFLICT (id, client_id) DO NOTHING`,
      [shipmentId, organizationId, clientId, senderId, tracking]
    );

    await applySetting(client, {
      category: 'basket_policy',
      scopeType: 'sender',
      scopeId: senderId,
      value: {
        version: 1,
        enabled: true,
        basket_type: 'zone_based',
        open_states: ['forming'],
        create_if_missing: true,
        require_zone: true,
        group_by_branch: true,
        group_by_service: true,
        service_match_field: 'service_level',
        group_by_route: true,
        route_key_paths: 'routing.route_key|dispatch.route_key',
        group_by_priority: true,
        priority_bands: [
          { key: 'urgent', min_score: 80 },
          { key: 'standard', max_score: 79.999 },
        ],
      },
      version: 1,
      schemaVersion: 1,
      approvedAt: new Date().toISOString(),
    });

    const templateId = await createZonesBasketsTemplate(client, organizationId);
    const {
      rows: [{ run_id: runId }],
    } = await client.query('SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id', [
      templateId,
      {
        organization_id: organizationId,
        client_id: clientId,
        sender_id: senderId,
        shipment_id: shipmentId,
        geocoding: {
          successful: true,
          local_reverse_match: {
            canonical_district_id: canonicalDistrictId,
          },
        },
      },
    ]);

    const { completed, stepRows } = await progressWorkflowToHandlers(client, runId, [
      'zone_assign',
      'basket_assign',
    ]);

    expect(completed.has('zone_assign')).toBe(true);
    expect(completed.has('basket_assign')).toBe(true);

    const basketAssignStep = stepRows.find((row) => row.handler_key === 'basket_assign');
    expect(basketAssignStep?.step_status).toBe('completed');
    expect(basketAssignStep?.operation_result?.assigned).toBe(false);
    expect(basketAssignStep?.operation_result?.reason).toBe('route_missing');
    expect(basketAssignStep?.operation_result?.sort_branch_id).toBe(branchId);
    expect(basketAssignStep?.operation_result?.sort_service_key).toBe('express');
    expect(basketAssignStep?.operation_result?.sort_route_key ?? null).toBeNull();

    const {
      rows: [{ activeBasketItems }],
    } = await client.query(
      `SELECT COUNT(*)::int AS "activeBasketItems"
         FROM basket_items
        WHERE shipment_id = $1::uuid
          AND shipment_client_id = $2::uuid
          AND removed_at IS NULL`,
      [shipmentId, clientId]
    );
    expect(activeBasketItems).toBe(0);

    const {
      rows: [{ basketCount }],
    } = await client.query(
      `SELECT COUNT(*)::int AS "basketCount"
         FROM baskets
        WHERE organization_id = $1::uuid`,
      [organizationId]
    );
    expect(basketCount).toBe(0);
  });

  test('re-sorts a shipment through the dedicated UI workflow after a route change', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const userId = randomUUID();
    const shipmentId = randomUUID();
    const oldBasketId = randomUUID();
    const newBasketId = randomUUID();
    const tracking = `ZBRS${shipmentId.slice(0, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Zones+Baskets Resort Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `zones-baskets-resort-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Zones+Baskets Resort Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `zones-baskets-resort-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO senders (id, client_id, name, status)
       VALUES ($1::uuid, $2::uuid, 'Zones+Baskets Resort Sender', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [senderId, clientId]
    );

    await createUser(client, organizationId, `resort-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      fullName: 'Resort Operator',
      userType: 'ops_admin',
      accessScopeType: 'tenant',
    });
    await client.query(
      `INSERT INTO baskets (
          id,
          organization_id,
          basket_type,
          state,
          sort_route_key,
          current_count,
          created_at,
          updated_at
       )
       VALUES
       ($1::uuid, $3::uuid, 'zone_based', 'forming', 'route-a', 0, now(), now()),
       ($2::uuid, $3::uuid, 'zone_based', 'forming', 'route-b', 0, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [oldBasketId, newBasketId, organizationId]
    );

    await client.query(
      `INSERT INTO shipments (
          id,
          organization_id,
          client_id,
          sender_id,
          service_type,
          tracking_number,
          status,
          metadata,
          box_count,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          'delivery',
          $5,
          'pending',
          jsonb_build_object('routing', jsonb_build_object('route_key', 'route-b')),
          1,
          now(),
          now()
       )
       ON CONFLICT (id, client_id) DO NOTHING`,
      [shipmentId, organizationId, clientId, senderId, tracking]
    );

    await client.query(
      `INSERT INTO basket_items (basket_id, shipment_id, shipment_client_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [oldBasketId, shipmentId, clientId]
    );

    await applySetting(client, {
      category: 'basket_policy',
      scopeType: 'sender',
      scopeId: senderId,
      value: {
        version: 1,
        enabled: true,
        basket_type: 'zone_based',
        open_states: ['forming'],
        create_if_missing: true,
        require_zone: false,
        group_by_route: true,
        route_key_paths: 'routing.route_key|dispatch.route_key',
      },
      version: 1,
      schemaVersion: 1,
      approvedAt: new Date().toISOString(),
    });

    await setAuthContext(client, userId);

    const {
      rows: [{ result: resortResult }],
    } = await client.query(
      `SELECT api.ui_execute_shipment_resort_v1(
          'shipments.resort',
          'shipments',
          ARRAY[$1::text],
          $1::text,
          1,
          '{}'::jsonb
       ) AS result`,
      [shipmentId]
    );

    expect(resortResult.status).toBe('resorted');
    expect(resortResult.items?.[0]?.previous_basket_id).toBe(oldBasketId);
    expect(resortResult.items?.[0]?.basket_id).toBe(newBasketId);
    expect(resortResult.workflow_run_id).toBeTruthy();

    await setFixtureAdminContext(client);

    const {
      rows: [activeBasketRow],
    } = await client.query(
      `SELECT basket_id
         FROM basket_items
        WHERE shipment_id = $1::uuid
          AND shipment_client_id = $2::uuid
          AND removed_at IS NULL
        ORDER BY added_at DESC, id DESC
        LIMIT 1`,
      [shipmentId, clientId]
    );
    expect(activeBasketRow?.basket_id).toBe(newBasketId);

    const {
      rows: [{ exceptionCount }],
    } = await client.query(
      `SELECT COUNT(*)::int AS "exceptionCount"
         FROM mis_sort_exceptions
        WHERE shipment_id = $1::uuid
          AND shipment_client_id = $2::uuid`,
      [shipmentId, clientId]
    );
    expect(exceptionCount).toBe(0);

    const {
      rows: [workflowRow],
    } = await client.query(
      `SELECT wt.name, wr.workflow_status
         FROM workflow_runs wr
         JOIN workflow_templates wt ON wt.id = wr.workflow_template_id
        WHERE wr.id = $1::uuid`,
      [resortResult.workflow_run_id]
    );
    expect(workflowRow).toEqual({
      name: 'shipment_resort_v1',
      workflow_status: 'completed',
    });

    const {
      rows: [decisionRow],
    } = await client.query(
      `SELECT decision_outcome
         FROM decision_log
        WHERE resource_type = 'shipment'
          AND resource_id = $1::uuid
          AND decision_point = 'shipment_resort'
        ORDER BY timestamp DESC, id DESC
        LIMIT 1`,
      [shipmentId]
    );
    expect(decisionRow?.decision_outcome).toBe('resorted');

    await setAuthContext(client, userId);

    const {
      rows: [{ secondResult }],
    } = await client.query(
      `SELECT api.ui_execute_shipment_resort_v1(
          'shipments.resort',
          'shipments',
          ARRAY[$1::text],
          $1::text,
          1,
          '{}'::jsonb
       ) AS "secondResult"`,
      [shipmentId]
    );
    expect(secondResult.status).toBe('already_sorted');
  });

  test('creates a mis-sort exception for the wrong basket and resolves it into the correct basket', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const shipmentId = randomUUID();
    const zoneAId = randomUUID();
    const zoneBId = randomUUID();
    const wrongBasketId = randomUUID();
    const correctBasketId = randomUUID();

    const tracking = `ZBMS${shipmentId.slice(0, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Zones+Baskets Mis-sort Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `zones-baskets-mis-sort-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Zones+Baskets Mis-sort Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `zones-baskets-mis-sort-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO senders (id, client_id, name, status)
       VALUES ($1::uuid, $2::uuid, 'Zones+Baskets Mis-sort Sender', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [senderId, clientId]
    );

    await client.query(
      `INSERT INTO zones (id, organization_id, name, slug, is_active, created_at, updated_at)
       VALUES
       ($1::uuid, $3::uuid, 'Zone A', $4, TRUE, now(), now()),
       ($2::uuid, $3::uuid, 'Zone B', $5, TRUE, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [
        zoneAId,
        zoneBId,
        organizationId,
        `mis-sort-zone-a-${zoneAId.slice(0, 8)}`,
        `mis-sort-zone-b-${zoneBId.slice(0, 8)}`,
      ]
    );

    await client.query(
      `INSERT INTO baskets (
          id,
          organization_id,
          zone_id,
          basket_type,
          state,
          current_count,
          created_at,
          updated_at
       )
       VALUES
       ($1::uuid, $3::uuid, $4::uuid, 'zone_based', 'forming', 0, now(), now()),
       ($2::uuid, $3::uuid, $5::uuid, 'zone_based', 'forming', 0, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [wrongBasketId, correctBasketId, organizationId, zoneBId, zoneAId]
    );

    await client.query(
      `INSERT INTO shipments (
          id,
          organization_id,
          client_id,
          sender_id,
          zone_id,
          service_type,
          tracking_number,
          status,
          box_count,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          $5::uuid,
          'delivery',
          $6,
          'pending',
          1,
          now(),
          now()
       )
       ON CONFLICT (id, client_id) DO NOTHING`,
      [shipmentId, organizationId, clientId, senderId, zoneAId, tracking]
    );

    await applySetting(client, {
      category: 'basket_policy',
      scopeType: 'sender',
      scopeId: senderId,
      value: {
        version: 1,
        enabled: true,
        basket_type: 'zone_based',
        open_states: ['forming'],
        create_if_missing: true,
        require_zone: true,
      },
      version: 1,
      schemaVersion: 1,
      approvedAt: new Date().toISOString(),
    });

    const {
      rows: [{ basket_item_id: wrongBasketItemId }],
    } = await client.query(
      `INSERT INTO basket_items (basket_id, shipment_id, shipment_client_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)
       RETURNING id AS basket_item_id`,
      [wrongBasketId, shipmentId, clientId]
    );

    const {
      rows: [exceptionRow],
    } = await client.query(
      `SELECT id, basket_id, exception_reason, actual_zone_id, expected_zone_id
         FROM mis_sort_exceptions
        WHERE basket_item_id = $1::uuid`,
      [wrongBasketItemId]
    );

    expect(exceptionRow.basket_id).toBe(wrongBasketId);
    expect(exceptionRow.exception_reason).toBe("wrong_zone");
    expect(exceptionRow.actual_zone_id).toBe(zoneBId);
    expect(exceptionRow.expected_zone_id).toBe(zoneAId);

    const {
      rows: [resolveRow],
    } = await client.query(
      `SELECT *
         FROM resolve_mis_sort_exception_v1($1::uuid, '{}'::jsonb)`,
      [exceptionRow.id]
    );

    expect(resolveRow.status).toBe('reassigned');
    expect(resolveRow.previous_basket_id).toBe(wrongBasketId);
    expect(resolveRow.basket_id).toBe(correctBasketId);

    const { rows: activeBasketRows } = await client.query(
      `SELECT basket_id
         FROM basket_items
        WHERE shipment_id = $1::uuid
          AND shipment_client_id = $2::uuid
          AND removed_at IS NULL`,
      [shipmentId, clientId]
    );

    expect(activeBasketRows).toEqual([{ basket_id: correctBasketId }]);

    const {
      rows: [removedWrongItemRow],
    } = await client.query(
      `SELECT removed_at
         FROM basket_items
        WHERE id = $1::uuid`,
      [wrongBasketItemId]
    );

    expect(removedWrongItemRow.removed_at).not.toBeNull();

    const {
      rows: [{ exceptionCount }],
    } = await client.query(
      `SELECT COUNT(*)::int AS "exceptionCount"
         FROM mis_sort_exceptions
        WHERE shipment_id = $1::uuid
          AND shipment_client_id = $2::uuid`,
      [shipmentId, clientId]
    );

    expect(exceptionCount).toBe(0);
  });

  test('requests a manual zone override with approval and applies it through the workflow engine', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const shipmentId = randomUUID();
    const zoneAId = randomUUID();
    const zoneBId = randomUUID();
    const zoneCId = randomUUID();
    const requesterUserId = randomUUID();
    const approverUserId = randomUUID();
    const zoneABasketId = randomUUID();
    const zoneBBasketId = randomUUID();
    const zoneCBasketId = randomUUID();
    const tracking = `ZO${shipmentId.slice(0, 8).toUpperCase()}`;
    let overrideState = null;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Zone Override Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `zone-override-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Zone Override Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `zone-override-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO senders (id, client_id, name, status)
       VALUES ($1::uuid, $2::uuid, 'Zone Override Sender', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [senderId, clientId]
    );

    await createUser(client, organizationId, `requester-${requesterUserId.slice(0, 8)}@example.com`, {
      id: requesterUserId,
      fullName: 'Zone Override Requester',
    });
    await createUser(client, organizationId, `approver-${approverUserId.slice(0, 8)}@example.com`, {
      id: approverUserId,
      fullName: 'Zone Override Approver',
    });

    await client.query(
      `INSERT INTO zones (id, organization_id, name, slug, is_active, created_at, updated_at)
       VALUES
         ($1::uuid, $4::uuid, 'Zone A', $5, TRUE, now(), now()),
         ($2::uuid, $4::uuid, 'Zone B', $6, TRUE, now(), now()),
         ($3::uuid, $4::uuid, 'Zone C', $7, TRUE, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [
        zoneAId,
        zoneBId,
        zoneCId,
        organizationId,
        `zone-a-${zoneAId.slice(0, 8)}`,
        `zone-b-${zoneBId.slice(0, 8)}`,
        `zone-c-${zoneCId.slice(0, 8)}`,
      ]
    );

    await client.query(
      `INSERT INTO baskets (
          id,
          organization_id,
          zone_id,
          basket_type,
          state,
          current_count,
          created_at,
          updated_at
       )
       VALUES
         ($1::uuid, $4::uuid, $5::uuid, 'zone_based', 'forming', 0, now(), now()),
         ($2::uuid, $4::uuid, $6::uuid, 'zone_based', 'forming', 0, now(), now()),
         ($3::uuid, $4::uuid, $7::uuid, 'zone_based', 'forming', 0, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [zoneABasketId, zoneBBasketId, zoneCBasketId, organizationId, zoneAId, zoneBId, zoneCId]
    );

    await client.query(
      `INSERT INTO shipments (
          id,
          organization_id,
          client_id,
          sender_id,
          zone_id,
          service_type,
          tracking_number,
          status,
          box_count,
          created_at,
          updated_at
       )
       VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          $5::uuid,
          'delivery',
          $6,
          'pending',
          1,
          now(),
          now()
       )
       ON CONFLICT (id, client_id) DO NOTHING`,
      [shipmentId, organizationId, clientId, senderId, zoneAId, tracking]
    );

    await applySetting(client, {
      category: 'basket_policy',
      scopeType: 'sender',
      scopeId: senderId,
      value: {
        version: 1,
        enabled: true,
        basket_type: 'zone_based',
        open_states: ['forming'],
        create_if_missing: true,
        require_zone: true,
      },
      version: 1,
      schemaVersion: 1,
      approvedAt: new Date().toISOString(),
    });

    const {
      rows: [{ basket_item_id: wrongBasketItemId }],
    } = await client.query(
      `INSERT INTO basket_items (basket_id, shipment_id, shipment_client_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)
       RETURNING id AS basket_item_id`,
      [zoneBBasketId, shipmentId, clientId]
    );

    const {
      rows: [exceptionRow],
    } = await client.query(
      `SELECT id, basket_id, exception_reason, actual_zone_id, expected_zone_id
         FROM mis_sort_exceptions
        WHERE basket_item_id = $1::uuid`,
      [wrongBasketItemId]
    );

    expect(exceptionRow.exception_reason).toBe('wrong_zone');
    expect(exceptionRow.actual_zone_id).toBe(zoneBId);
    expect(exceptionRow.expected_zone_id).toBe(zoneAId);

    const requestOverride = () => client.query(
      `SELECT *
         FROM public.request_zone_override_v1($1::uuid, $2::jsonb)`,
      [
        exceptionRow.id,
        JSON.stringify({
          override_reason: 'Supervisor approved zone correction to Zone C',
          requested_zone_id: zoneCId,
        }),
      ]
    );

    const { id: foreignOrgId } = await createOrganization(client, 'Synthetic Foreign Zone Tenant');
    const foreignUserId = await createUser(client, foreignOrgId, `zone-${randomUUID()}@example.invalid`, {
      fullName: 'Synthetic Foreign Zone Operator',
    });

    await client.query('SAVEPOINT foreign_zone_override');
    try {
      await setAuthContext(client, foreignUserId);
      await expect(requestOverride()).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('is outside current tenant scope'),
      });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT foreign_zone_override');
      await client.query('RELEASE SAVEPOINT foreign_zone_override');
    }

    await setAuthContext(client, requesterUserId);
    const { rows: [requestRow] } = await requestOverride();

    expect(requestRow.request_id).toBeTruthy();
    expect(requestRow.workflow_run_id).toBeTruthy();
    expect(requestRow.manual_review_task_id).toBeTruthy();
    expect(requestRow.status).toBe('pending');

    const {
      rows: [pendingRequestRow],
    } = await client.query(
      `SELECT requested_zone_id, request_reason, status, manual_review_task_id
         FROM zone_override_requests
        WHERE id = $1::uuid`,
      [requestRow.request_id]
    );

    expect(pendingRequestRow.requested_zone_id).toBe(zoneCId);
    expect(pendingRequestRow.request_reason).toBe('Supervisor approved zone correction to Zone C');
    expect(pendingRequestRow.status).toBe('pending');
    expect(pendingRequestRow.manual_review_task_id).toBe(requestRow.manual_review_task_id);

    const {
      rows: [manualReviewTask],
    } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT status, reason, metadata
         FROM manual_review_tasks
        WHERE id = $1::uuid`,
      [requestRow.manual_review_task_id]
    ));

    expect(manualReviewTask.status).toBe('pending');
    expect(manualReviewTask.reason).toBe('Supervisor approved zone correction to Zone C');
    expect(manualReviewTask.metadata.zone_override_request_id).toBe(requestRow.request_id);

    await setAuthContext(client, approverUserId);
    await client.query(
      `SELECT public.resolve_manual_review_task_v1($1::uuid, $2::text, $3::text)`,
      [requestRow.manual_review_task_id, 'approved', 'Approved by shift supervisor']
    );

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const {
        rows: [currentState],
      } = await client.query(
        `SELECT status, resolution_outcome, reviewed_by, applied_at
           FROM zone_override_requests
          WHERE id = $1::uuid`,
        [requestRow.request_id]
      );

      overrideState = currentState;
      if (overrideState?.status === 'applied') {
        break;
      }

      await client.query(
        `SELECT progress_workflow_run($1::uuid, $2::jsonb) AS result`,
        [
          requestRow.workflow_run_id,
          JSON.stringify({
            manual_review_task_id: requestRow.manual_review_task_id,
            resolution_outcome: 'approved',
            zone_override_request_id: requestRow.request_id,
          }),
        ]
      );
    }

    expect(overrideState?.status).toBe('applied');
    expect(overrideState?.resolution_outcome).toBe('approved');
    expect(overrideState?.reviewed_by).toBe(approverUserId);
    expect(overrideState?.applied_at).not.toBeNull();

    await setFixtureAdminContext(client);

    const {
      rows: [shipmentRow],
    } = await client.query(
      `SELECT zone_id
         FROM shipments
        WHERE id = $1::uuid
          AND client_id = $2::uuid`,
      [shipmentId, clientId]
    );

    expect(shipmentRow.zone_id).toBe(zoneCId);

    const { rows: activeBasketRows } = await client.query(
      `SELECT basket_id
         FROM basket_items
        WHERE shipment_id = $1::uuid
          AND shipment_client_id = $2::uuid
          AND removed_at IS NULL`,
      [shipmentId, clientId]
    );

    expect(activeBasketRows).toEqual([{ basket_id: zoneCBasketId }]);

    const {
      rows: [removedWrongItemRow],
    } = await client.query(
      `SELECT removed_at
         FROM basket_items
        WHERE id = $1::uuid`,
      [wrongBasketItemId]
    );

    expect(removedWrongItemRow.removed_at).not.toBeNull();

    const {
      rows: [{ exceptionCount }],
    } = await client.query(
      `SELECT COUNT(*)::int AS "exceptionCount"
         FROM mis_sort_exceptions
        WHERE shipment_id = $1::uuid
          AND shipment_client_id = $2::uuid`,
      [shipmentId, clientId]
    );

    expect(exceptionCount).toBe(0);
  });
});
