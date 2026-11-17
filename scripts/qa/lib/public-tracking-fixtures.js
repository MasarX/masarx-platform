const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function deterministicUuid(input) {
  const hex = crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function readDemoManifest() {
  const manifestPath = path.resolve(process.cwd(), 'tmp', 'demo-accounts.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`demo account manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const organizationId = String(manifest?.organization?.id || '').trim();
  const clientId = String(manifest?.clients?.[0]?.id || '').trim();
  const senderId = String(manifest?.senders?.[0]?.id || '').trim();
  if (!organizationId || !clientId || !senderId) {
    throw new Error('demo account manifest is missing organization/client/sender ids');
  }
  return { organizationId, clientId, senderId, manifestPath };
}

async function ensureBasePublicTrackingFixtures(client, demo) {
  const addressId = deterministicUuid(`qa-public-tracking-address:${demo.clientId}`);
  const cityId = deterministicUuid(`qa-public-tracking-city:${demo.organizationId}`);
  const districtId = deterministicUuid(`qa-public-tracking-district:${demo.organizationId}`);
  const zoneId = deterministicUuid(`qa-public-tracking-zone:${demo.organizationId}`);
  const branchId = deterministicUuid(`qa-public-tracking-branch:${demo.organizationId}`);
  const recipientOneId = deterministicUuid(`qa-public-tracking-recipient:1:${demo.clientId}`);
  const recipientTwoId = deterministicUuid(`qa-public-tracking-recipient:2:${demo.clientId}`);
  const shipmentOneId = deterministicUuid(`qa-public-tracking-shipment:1:${demo.clientId}`);
  const shipmentTwoId = deterministicUuid(`qa-public-tracking-shipment:2:${demo.clientId}`);

  await client.query(
    `
      insert into public.canonical_cities (
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
      values (
        $1::uuid,
        $2::uuid,
        'Riyadh',
        'الرياض',
        array['Riyadh', 'Riyadh City']::text[],
        'Riyadh',
        'SA',
        'manual_seed',
        jsonb_build_object('seed', true, 'source', 'qa_public_tracking_fixtures'),
        st_setsrid(st_makepoint(46.6818, 24.7061), 4326)::geography,
        true
      )
      on conflict (organization_id, name_canonical) where source_city_id is null do update
      set
        name_arabic = excluded.name_arabic,
        alternate_names = excluded.alternate_names,
        province = excluded.province,
        country_code = excluded.country_code,
        source = excluded.source,
        metadata = coalesce(public.canonical_cities.metadata, '{}'::jsonb) || excluded.metadata,
        centroid = coalesce(excluded.centroid, public.canonical_cities.centroid),
        is_active = excluded.is_active,
        updated_at = workflow_now()
    `,
    [cityId, demo.organizationId]
  );

  await client.query(
    `
      insert into public.canonical_districts (
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
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'Al Olaya',
        'العليا',
        array['Al Olaya', 'Olaya']::text[],
        'manual_seed',
        jsonb_build_object('seed', true, 'source', 'qa_public_tracking_fixtures'),
        st_setsrid(st_makepoint(46.6818, 24.7061), 4326)::geography,
        true
      )
      on conflict (organization_id, city_id, name_canonical) where source_district_id is null do update
      set
        name_arabic = excluded.name_arabic,
        alternate_names = excluded.alternate_names,
        source = excluded.source,
        metadata = coalesce(public.canonical_districts.metadata, '{}'::jsonb) || excluded.metadata,
        centroid = coalesce(excluded.centroid, public.canonical_districts.centroid),
        is_active = excluded.is_active,
        updated_at = workflow_now()
    `,
    [districtId, demo.organizationId, cityId]
  );

  await client.query(
    `
      insert into public.zones (
        id,
        organization_id,
        name,
        slug,
        is_active,
        created_at,
        updated_at
      )
      values (
        $1::uuid,
        $2::uuid,
        'QA Public Tracking Zone',
        'qa-public-tracking-zone',
        true,
        workflow_now(),
        workflow_now()
      )
      on conflict (id) do update
      set
        name = excluded.name,
        slug = excluded.slug,
        is_active = excluded.is_active,
        updated_at = workflow_now()
    `,
    [zoneId, demo.organizationId]
  );

  await client.query(
    `
      insert into public.branches (
        id,
        organization_id,
        code,
        name,
        timezone,
        is_active
      )
      values (
        $1::uuid,
        $2::uuid,
        'qa-public-tracking',
        'QA Public Tracking Branch',
        'Asia/Riyadh',
        true
      )
      on conflict (id) do update
      set
        code = excluded.code,
        name = excluded.name,
        timezone = excluded.timezone,
        is_active = excluded.is_active,
        updated_at = workflow_now()
    `,
    [branchId, demo.organizationId]
  );

  await client.query(
    `
      insert into public.zone_districts (zone_id, canonical_district_id)
      values ($1::uuid, $2::uuid)
      on conflict do nothing
    `,
    [zoneId, districtId]
  );

  await client.query(
    `
      insert into public.branch_zones (branch_id, zone_id, priority)
      values ($1::uuid, $2::uuid, 0)
      on conflict (zone_id) do update
      set
        branch_id = excluded.branch_id,
        priority = excluded.priority
    `,
    [branchId, zoneId]
  );

  await client.query(
    `
      insert into public.recipients (id, organization_id, client_id, name, phone_number, email)
      values
        ($1::uuid, $2::uuid, $3::uuid, 'Ahmad QA', '+966500001123', 'ahmad.qa@example.com'),
        ($4::uuid, $2::uuid, $3::uuid, 'Sara Ops', '+966500004456', 'sara.ops@example.com')
      on conflict do nothing
    `,
    [recipientOneId, demo.organizationId, demo.clientId, recipientTwoId]
  );
  await client.query(
    `
      update public.recipients
      set
        organization_id = $2::uuid,
        client_id = $3::uuid,
        name = case when id = $1::uuid then 'Ahmad QA' else 'Sara Ops' end,
        phone_number = case when id = $1::uuid then '+966500001123' else '+966500004456' end,
        email = case when id = $1::uuid then 'ahmad.qa@example.com' else 'sara.ops@example.com' end
      where id in ($1::uuid, $4::uuid)
    `,
    [recipientOneId, demo.organizationId, demo.clientId, recipientTwoId]
  );

  await client.query(
    `
      insert into public.addresses (
        id,
        organization_id,
        client_id,
        raw_input,
        district,
        city,
        province,
        postal_code,
        country,
        building_number,
        validation_status,
        sa_short_code
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'Olaya towers delivery point',
        'Al Olaya',
        'Riyadh',
        'Riyadh',
        '12345',
        'SA',
        '44',
        'valid',
        'RAHA1234'
      )
      on conflict do nothing
    `,
    [addressId, demo.organizationId, demo.clientId]
  );
  await client.query(
    `
      update public.addresses
      set
        organization_id = $2::uuid,
        client_id = $3::uuid,
        raw_input = 'Olaya towers delivery point',
        district = 'Al Olaya',
        city = 'Riyadh',
        province = 'Riyadh',
        postal_code = '12345',
        country = 'SA',
        building_number = '44',
        validation_status = 'valid',
        sa_short_code = 'RAHA1234'
      where id = $1::uuid
    `,
    [addressId, demo.organizationId, demo.clientId]
  );

  await client.query(
    `
      insert into public.shipments (
        id,
        organization_id,
        client_id,
        sender_id,
        service_type,
        zone_id,
        tracking_number,
        carrier_reference_number,
        client_reference_number,
        box_count,
        status,
        recipient_id,
        destination_address_id,
        promised_delivery_date,
        created_at,
        updated_at
      )
      values
        (
          $1::uuid,
          $4::uuid,
          $5::uuid,
          $6::uuid,
          'delivery',
          $3::uuid,
          'PT-TRACK-001',
          'PT-CARRIER-101',
          'PT-ORDER-001',
          1,
          'in_transit',
          $7::uuid,
          $9::uuid,
          (workflow_now() + interval '1 day')::date,
          workflow_now(),
          workflow_now()
        ),
        (
          $2::uuid,
          $4::uuid,
          $5::uuid,
          $6::uuid,
          'delivery',
          $3::uuid,
          'PT-TRACK-002',
          'PT-CARRIER-202',
          'PT-ORDER-002',
          1,
          'pending',
          $8::uuid,
          $9::uuid,
          (workflow_now() + interval '2 day')::date,
          workflow_now(),
          workflow_now()
        )
      on conflict do nothing
    `,
    [
      shipmentOneId,
      shipmentTwoId,
      zoneId,
      demo.organizationId,
      demo.clientId,
      demo.senderId,
      recipientOneId,
      recipientTwoId,
      addressId,
    ]
  );
  await client.query(
    `
      update public.shipments
      set
        organization_id = $4::uuid,
        client_id = $5::uuid,
        sender_id = $6::uuid,
        service_type = 'delivery',
        zone_id = $3::uuid,
        branch_id = $10::uuid,
        tracking_number = case when id = $1::uuid then 'PT-TRACK-001' else 'PT-TRACK-002' end,
        carrier_reference_number = case when id = $1::uuid then 'PT-CARRIER-101' else 'PT-CARRIER-202' end,
        client_reference_number = case when id = $1::uuid then 'PT-ORDER-001' else 'PT-ORDER-002' end,
        box_count = 1,
        status = case when id = $1::uuid then 'in_transit' else 'pending' end,
        recipient_id = case when id = $1::uuid then $7::uuid else $8::uuid end,
        destination_address_id = $9::uuid,
        promised_delivery_date = case when id = $1::uuid then (workflow_now() + interval '1 day')::date else (workflow_now() + interval '2 day')::date end,
        updated_at = workflow_now()
      where id in ($1::uuid, $2::uuid)
    `,
    [
      shipmentOneId,
      shipmentTwoId,
      zoneId,
      demo.organizationId,
      demo.clientId,
      demo.senderId,
      recipientOneId,
      recipientTwoId,
      addressId,
      branchId,
    ]
  );

  await client.query(
    `
      insert into public.shipment_reference_numbers (
        organization_id,
        client_id,
        shipment_id,
        reference_type,
        reference_value,
        source_type
      )
      values
        ($1::uuid, $2::uuid, $3::uuid, 'client_reference_number', 'PT-ORDER-001', 'system'),
        ($1::uuid, $2::uuid, $3::uuid, 'carrier_reference_number', 'PT-CARRIER-101', 'system'),
        ($1::uuid, $2::uuid, $4::uuid, 'client_reference_number', 'PT-ORDER-002', 'system'),
        ($1::uuid, $2::uuid, $4::uuid, 'carrier_reference_number', 'PT-CARRIER-202', 'system'),
        ($1::uuid, $2::uuid, $3::uuid, 'carrier_reference_number', 'PT-CARRIER-AMB-1', 'system'),
        ($1::uuid, $2::uuid, $4::uuid, 'carrier_reference_number', 'PT-CARRIER-AMB-1', 'system')
      on conflict do nothing
    `,
    [demo.organizationId, demo.clientId, shipmentOneId, shipmentTwoId]
  );

  await client.query(
    `
      insert into public.shipment_actions (
        id,
        shipment_id,
        organization_id,
        client_id,
        action_type,
        action_category,
        canonical_status,
        timestamp,
        created_at,
        performed_by_system
      )
      values
        (gen_random_uuid(), $1::uuid, $3::uuid, $4::uuid, 'status_change', 'operational', 'in_transit', workflow_now() - interval '2 hour', workflow_now() - interval '2 hour', 'qa_public_tracking_seed'),
        (gen_random_uuid(), $1::uuid, $3::uuid, $4::uuid, 'status_change', 'operational', 'out_for_delivery', workflow_now() - interval '1 hour', workflow_now() - interval '1 hour', 'qa_public_tracking_seed'),
        (gen_random_uuid(), $2::uuid, $3::uuid, $4::uuid, 'status_change', 'operational', 'pending', workflow_now() - interval '3 hour', workflow_now() - interval '3 hour', 'qa_public_tracking_seed')
      on conflict do nothing
    `,
    [shipmentOneId, shipmentTwoId, demo.organizationId, demo.clientId]
  );

  return {
    cityId,
    districtId,
    zoneId,
    branchId,
    shipmentOneId,
    shipmentTwoId,
    addressId,
    recipientOneId,
    recipientTwoId,
  };
}

module.exports = {
  deterministicUuid,
  readDemoManifest,
  ensureBasePublicTrackingFixtures,
};
