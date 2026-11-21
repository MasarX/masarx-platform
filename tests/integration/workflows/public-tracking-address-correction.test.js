const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  createClient,
  createOrganization,
  createSender,
  createShipment,
} = require('../helpers/tenant-utils');
const { companyId: VENDOR_COMPANY_ID } = require('../../fixtures/carrier/vendor-account.synthetic.json');

loadEnv();

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be defined for public tracking address-correction tests');
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

async function withTransaction(run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await run(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failures when the test already aborted the transaction
    }
    client.release();
  }
}

async function seedCoverageFixture(client) {
  const organization = await createOrganization(client, 'Public Tracking Address Correction Org');
  const tenantClient = await createClient(
    client,
    organization.id,
    'Public Tracking Address Correction Client'
  );
  const senderId = await createSender(
    client,
    tenantClient.id,
    'Public Tracking Address Correction Sender'
  );

  const cityId = randomUUID();
  const districtId = randomUUID();
  const zoneId = randomUUID();
  const branchId = randomUUID();
  const routeBranchId = randomUUID();

  const {
    rows: [{ id: activeCityId }],
  } = await client.query(
    `
      INSERT INTO public.canonical_cities (
        id,
        organization_id,
        name_canonical,
        name_arabic,
        alternate_names,
        province,
        country_code,
        source,
        metadata,
        centroid,
        is_active
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        'Riyadh',
        'Riyadh',
        ARRAY['Riyadh', 'Riyadh City']::text[],
        'Riyadh',
        'SA',
        'integration_test',
        jsonb_build_object('seed', true, 'source', 'public_tracking_address_correction_test'),
        st_setsrid(st_makepoint(46.6753, 24.7136), 4326)::geography,
        true
      )
      ON CONFLICT (organization_id, name_canonical) WHERE source_city_id IS NULL
      DO UPDATE SET
        name_arabic = COALESCE(EXCLUDED.name_arabic, public.canonical_cities.name_arabic),
        alternate_names = COALESCE(EXCLUDED.alternate_names, public.canonical_cities.alternate_names),
        province = COALESCE(EXCLUDED.province, public.canonical_cities.province),
        country_code = COALESCE(EXCLUDED.country_code, public.canonical_cities.country_code),
        source = COALESCE(EXCLUDED.source, public.canonical_cities.source),
        metadata = COALESCE(public.canonical_cities.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        centroid = COALESCE(EXCLUDED.centroid, public.canonical_cities.centroid),
        is_active = TRUE,
        updated_at = now()
      RETURNING id
    `,
    [cityId, organization.id]
  );

  await client.query(
    `
      INSERT INTO public.canonical_districts (
        id,
        organization_id,
        city_id,
        name_canonical,
        name_arabic,
        alternate_names,
        source,
        metadata,
        centroid,
        is_active
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'Al Olaya',
        'Al Olaya',
        ARRAY['Al Olaya', 'Olaya']::text[],
        'integration_test',
        jsonb_build_object('seed', true, 'source', 'public_tracking_address_correction_test'),
        st_setsrid(st_makepoint(46.6753, 24.7136), 4326)::geography,
        true
      )
    `,
    [districtId, organization.id, activeCityId]
  );

  await client.query(
    `
      INSERT INTO public.zones (
        id,
        organization_id,
        name,
        slug,
        is_active,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        'Public Tracking Coverage Zone',
        'public-tracking-coverage-zone',
        true,
        workflow_now(),
        workflow_now()
      )
    `,
    [zoneId, organization.id]
  );

  await client.query(
    `
      INSERT INTO public.branches (
        id,
        organization_id,
        code,
        name,
        timezone,
        is_active
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        'pt-addr-cov',
        'Public Tracking Coverage Branch',
        'Asia/Riyadh',
        true
      )
    `,
    [branchId, organization.id]
  );

  await client.query(
    `
      INSERT INTO public.branches (
        id,
        organization_id,
        code,
        name,
        timezone,
        is_active
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        'pt-addr-rte',
        'Public Tracking Route Branch',
        'Asia/Riyadh',
        true
      )
    `,
    [routeBranchId, organization.id]
  );

  await client.query(
    `
      INSERT INTO public.zone_districts (zone_id, canonical_district_id)
      VALUES ($1::uuid, $2::uuid)
    `,
    [zoneId, districtId]
  );

  await client.query(
    `
      INSERT INTO public.branch_zones (branch_id, zone_id, priority)
      VALUES ($1::uuid, $2::uuid, 0)
    `,
    [branchId, zoneId]
  );

  const shipment = await createShipment(client, {
    organizationId: organization.id,
    clientId: tenantClient.id,
    serviceType: 'delivery',
    status: 'in_transit',
    trackingNumber: `PT-ADDR-${randomUUID().slice(0, 8).toUpperCase()}`,
  });

  await client.query(
    `
      UPDATE public.shipments
         SET sender_id = $2::uuid,
             zone_id = $3::uuid,
             branch_id = $4::uuid
       WHERE id = $1::uuid
    `,
    [shipment.id, senderId, zoneId, routeBranchId]
  );

  const routeRunId = randomUUID();
  const routeStopId = randomUUID();

  await client.query(
    `
      INSERT INTO public.route_runs (
        id,
        organization_id,
        branch_id,
        status,
        planned_date,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'in_progress',
        workflow_now()::date,
        jsonb_build_object('seed', true, 'source', 'public_tracking_address_correction_test'),
        workflow_now(),
        workflow_now()
      )
    `,
    [routeRunId, organization.id, routeBranchId]
  );

  await client.query(
    `
      INSERT INTO public.route_stops (
        id,
        organization_id,
        route_run_id,
        client_id,
        shipment_id,
        stop_kind,
        sequence_order,
        metadata,
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
        1,
        '{}'::jsonb,
        workflow_now(),
        workflow_now()
      )
    `,
    [routeStopId, organization.id, routeRunId, tenantClient.id, shipment.id]
  );

  return {
    organizationId: organization.id,
    clientId: tenantClient.id,
    senderId,
    shipmentId: shipment.id,
    routeRunId,
    routeStopId,
    coverageZoneId: zoneId,
    coverageBranchId: branchId,
    routeBranchId,
  };
}

async function resolveCanonicalUpdateRoute(client) {
  const { rows } = await client.query(
    `
      SELECT r.id, r.provider_id, r.route_name
      FROM public.api_routes r
      JOIN public.api_route_packs p ON p.id = r.pack_id
      WHERE p.name = 'logestechs_v2_mirror'
        AND upper(r.method) = 'PUT'
        AND r.path_template = '/api/guests/{companyId}/packages/{shipmentId}'
        AND r.scope_type = 'global'
        AND r.enabled = TRUE
      ORDER BY r.updated_at DESC
      LIMIT 1
    `
  );

  if (!rows.length) {
    throw new Error('Canonical Logestechs provider update route is missing');
  }

  return rows[0];
}

async function seedProviderGatewayLinkage(client, fixture, route) {
  const sourceId = randomUUID();
  const sourceToken = `pt-address-provider-${randomUUID()}`;
  const mappingConfigId = randomUUID();
  const providerAuthConfigId = randomUUID();
  const providerShipmentId = `PT-PROV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    .toUpperCase();

  await client.query(
    `
      INSERT INTO public.mapping_configs (
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
        '{}'::jsonb,
        1,
        'public tracking provider update fixture'
      )
    `,
    [mappingConfigId, `pt-address-provider-${randomUUID()}`]
  );

  await client.query(
    `
      INSERT INTO public.webhook_sources (
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
        'Public Tracking Provider Update Source',
        'api_gateway',
        $4::text,
        $5::uuid,
        $6::uuid,
        1000,
        TRUE
      )
    `,
    [sourceId, fixture.organizationId, `pt-address-provider-${randomUUID()}`, sourceToken, mappingConfigId, fixture.senderId]
  );

  const { rows: secretRows } = await client.query(
    `
      SELECT vault.create_secret($1::text, $2::text, $3::text, NULL) AS id
    `,
    [
      JSON.stringify({
        username: 'public-tracking@example.test',
        password: 'public-tracking-pass',
      }),
      `provider_auth_configs/${providerAuthConfigId}`,
      'public tracking provider update auth',
    ]
  );

  await client.query(
    `
      INSERT INTO public.provider_auth_configs (
        id,
        provider_id,
        auth_type,
        credentials_vault_id,
        credentials,
        expires_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        'basic_auth',
        $3::uuid,
        NULL,
        NULL
      )
    `,
    [providerAuthConfigId, route.provider_id, secretRows[0].id]
  );

  const settingsVersionId = randomUUID();
  const accountValue = {
    auth_config_id: providerAuthConfigId,
    company_id: VENDOR_COMPANY_ID,
    enabled: true,
  };

  await client.query(
    `
      INSERT INTO public.settings_versions_p0 (
        id,
        category,
        scope_type,
        scope_id,
        scope_hash,
        version,
        value,
        schema_version,
        change_reason,
        approved_at,
        effective_from
      )
      VALUES (
        $1::uuid,
        'logestechs_v2_account',
        'source',
        $2::uuid,
        $2::uuid,
        1,
        $3::jsonb,
        1,
        'public tracking provider update fixture',
        now(),
        now()
      )
    `,
    [settingsVersionId, sourceId, JSON.stringify(accountValue)]
  );

  await client.query(
    `
      INSERT INTO public.settings (
        category,
        scope_type,
        scope_id,
        scope_hash,
        settings_version_id,
        cached_value,
        last_updated
      )
      VALUES (
        'logestechs_v2_account',
        'source',
        $1::uuid,
        $1::uuid,
        $2::uuid,
        $3::jsonb,
        now()
      )
    `,
    [sourceId, settingsVersionId, JSON.stringify(accountValue)]
  );

  const sourceRequestId = randomUUID();
  await client.query(
    `
      INSERT INTO public.api_gateway_requests (
        id,
        organization_id,
        client_id,
        sender_id,
        source_id,
        correlation_id,
        route_id,
        settings_resolution_id,
        method,
        path,
        query_string,
        request_headers,
        request_body,
        received_at,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        NULL,
        'PUT',
        $8::text,
        NULL,
        '{"content-type":"application/json"}'::jsonb,
        '{}'::jsonb,
        now(),
        now(),
        now()
      )
    `,
    [
      sourceRequestId,
      fixture.organizationId,
      fixture.clientId,
      fixture.senderId,
      sourceId,
      randomUUID(),
      route.id,
      `/api/guests/${VENDOR_COMPANY_ID}/packages/${providerShipmentId}`,
    ]
  );

  await client.query(
    `
      UPDATE public.shipments
      SET metadata = public.deep_merge_jsonb(
            COALESCE(metadata, '{}'::jsonb),
            jsonb_build_object(
              'source',
              jsonb_build_object(
                'type', 'api_gateway',
                'api_gateway_request_id', $2::uuid,
                'route_id', $3::uuid
              ),
              'provider',
              jsonb_build_object(
                'id', $4::uuid,
                'shipment_id', $5::text
              )
            )
          ),
          updated_at = now()
      WHERE id = $1::uuid
    `,
    [fixture.shipmentId, sourceRequestId, route.id, route.provider_id, providerShipmentId]
  );

  await client.query(
    `
      SELECT public.upsert_shipment_reference_number_v1(
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'logistics_reference_number',
        $4::text,
        'provider',
        $5::uuid,
        $6::jsonb
      )
    `,
    [
      fixture.organizationId,
      fixture.clientId,
      fixture.shipmentId,
      providerShipmentId,
      route.provider_id,
      JSON.stringify({
        source: 'public_tracking_address_correction_test',
        source_id: sourceId,
      }),
    ]
  );

  return {
    sourceId,
    sourceRequestId,
    providerShipmentId,
  };
}

describe('public tracking address correction active-route propagation', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('updates the shipment address and syncs active route-stop correction metadata', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedCoverageFixture(client);

      const response = await client.query(
        `
          SELECT public.shipment_apply_destination_address_change_v1($1::jsonb) AS result
        `,
        [
          JSON.stringify({
            shipment_id: fixture.shipmentId,
            client_id: fixture.clientId,
            performed_by_system: 'public_tracking_test',
            request_type_key: 'location_change',
            address_text: 'Tower 4, gate B, service road',
            short_national_address: 'RAHA1234',
            landmark: 'Near the red tower',
            drop_point: 'Reception, gate, loading bay',
            notes: 'Use service entrance',
            map_pin: {
              lat: 24.7136,
              lng: 46.6753,
            },
          }),
        ]
      );

      const result = response.rows[0]?.result || {};
      expect(result.ok).toBe(true);
      expect(result.geocode_workflow_run_id).toBeTruthy();
      expect(result.validation?.branch_id).toBe(fixture.coverageBranchId);
      expect(result.route_propagation?.mode).toBe('active_route');
      expect(result.route_propagation?.synced).toBe(true);
      expect(result.route_propagation?.branch_mismatch).toBe(true);
      expect(result.route_propagation?.route_stop_count).toBe(1);
      expect(result.provider_propagation?.mode).toBe('none');

      const shipmentRows = await client.query(
        `
          SELECT
            s.destination_address_id,
            s.zone_id,
            s.branch_id,
            a.raw_input,
            a.line1,
            a.line2,
            a.additional_directions
          FROM public.shipments s
          JOIN public.addresses a
            ON a.id = s.destination_address_id
         WHERE s.id = $1::uuid
        `,
        [fixture.shipmentId]
      );
      const shipment = shipmentRows.rows[0];
      expect(shipment.destination_address_id).toBeTruthy();
      expect(shipment.zone_id).toBe(fixture.coverageZoneId);
      expect(shipment.branch_id).toBe(fixture.coverageBranchId);
      expect(shipment.raw_input).toBe('Tower 4, gate B, service road');
      expect(shipment.line1).toBe('Tower 4, gate B, service road');
      expect(shipment.line2).toBe('Reception, gate, loading bay');
      expect(String(shipment.additional_directions || '')).toContain('Near the red tower');

      const stopRows = await client.query(
        `
          SELECT metadata
          FROM public.route_stops
          WHERE id = $1::uuid
        `,
        [fixture.routeStopId]
      );
      const correction = stopRows.rows[0]?.metadata?.address_correction || {};
      expect(correction.address_text).toBe('Tower 4, gate B, service road');
      expect(correction.short_national_address).toBe('RAHA1234');
      expect(correction.landmark).toBe('Near the red tower');
      expect(correction.drop_point).toBe('Reception, gate, loading bay');
      expect(correction.zone_id).toBe(fixture.coverageZoneId);
      expect(correction.branch_id).toBe(fixture.coverageBranchId);
      expect(correction.map_pin?.lat).toBeCloseTo(24.7136, 4);
      expect(correction.map_pin?.lng).toBeCloseTo(46.6753, 4);

      const routeRows = await client.query(
        `
          SELECT branch_id
          FROM public.route_runs
          WHERE id = $1::uuid
        `,
        [fixture.routeRunId]
      );
      expect(routeRows.rows[0]?.branch_id).toBe(fixture.routeBranchId);
    });
  });

  test('queues canonical provider update propagation when the shipment keeps provider-source linkage', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedCoverageFixture(client);
      const route = await resolveCanonicalUpdateRoute(client);
      const providerLinkage = await seedProviderGatewayLinkage(client, fixture, route);

      const response = await client.query(
        `
          SELECT public.shipment_apply_destination_address_change_v1($1::jsonb) AS result
        `,
        [
          JSON.stringify({
            shipment_id: fixture.shipmentId,
            client_id: fixture.clientId,
            support_case_id: randomUUID(),
            performed_by_system: 'public_tracking_test',
            request_type_key: 'location_change',
            address_text: 'Tower 8, new service road',
            short_national_address: 'NEWA7788',
            landmark: 'Opposite the glass tower',
            drop_point: 'Dock 3',
            notes: 'Call before arrival',
            map_pin: {
              lat: 24.7136,
              lng: 46.6753,
            },
          }),
        ]
      );

      const result = response.rows[0]?.result || {};
      expect(result.ok).toBe(true);
      expect(result.provider_propagation?.mode).toBe('provider_update');
      expect(result.provider_propagation?.queued).toBe(true);
      expect(result.provider_propagation?.route_id).toBe(route.id);
      expect(result.provider_propagation?.provider_id).toBe(route.provider_id);
      expect(result.provider_propagation?.provider_shipment_id).toBe(
        providerLinkage.providerShipmentId
      );

      const gatewayRows = await client.query(
        `
          SELECT
            agr.path,
            oc.target_id,
            oc.headers,
            oc.body,
            oc.context
          FROM public.api_gateway_requests agr
          JOIN public.outbound_calls oc
            ON oc.id = agr.outbound_call_id
          WHERE agr.id = $1::uuid
        `,
        [result.provider_propagation.api_gateway_request_id]
      );
      expect(gatewayRows.rows).toHaveLength(1);
      expect(gatewayRows.rows[0].path).toBe(
        `/api/guests/${VENDOR_COMPANY_ID}/packages/${providerLinkage.providerShipmentId}`
      );
      expect(gatewayRows.rows[0].target_id).toBe(route.provider_id);
      expect(gatewayRows.rows[0].headers['company-id']).toBe(VENDOR_COMPANY_ID);
      expect(gatewayRows.rows[0].body.destinationAddress).toMatchObject({
        addressLine1: 'Tower 8, new service road',
        addressLine2: 'Dock 3',
        city: 'Riyadh',
        region: 'Riyadh',
        district: 'Al Olaya',
        country: 'SA',
        nationalAddress: 'NEWA7788',
      });
      expect(gatewayRows.rows[0].context.api_gateway_path_params).toMatchObject({
        companyId: VENDOR_COMPANY_ID,
        shipmentId: providerLinkage.providerShipmentId,
      });
      expect(gatewayRows.rows[0].context.auth.auth_config_id).toBeTruthy();

      const actionRows = await client.query(
        `
          SELECT action_data
          FROM public.shipment_actions
          WHERE shipment_id = $1::uuid
            AND action_type = 'address_update'
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [fixture.shipmentId]
      );
      expect(actionRows.rows).toHaveLength(1);
      expect(actionRows.rows[0].action_data.provider_propagation).toMatchObject({
        mode: 'provider_update',
        queued: true,
        api_gateway_request_id: result.provider_propagation.api_gateway_request_id,
      });
    });
  });
});
