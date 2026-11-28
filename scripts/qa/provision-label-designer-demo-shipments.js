#!/usr/bin/env node
/*
  Provision "fully filled" shipments for label-designer preview (shipment_label_payload_v).

  Usage:
    ENV_FILE=path/to/cloud-config node scripts/qa/provision-label-designer-demo-shipments.js \
      --user-email uyjztrzhvqwxjmjxvyjwviwj@example.invalid \
      --count 3

  Notes:
    - Creates recipients, origin/destination addresses (incl. sa_short_code), shipments, and shipment_boxes.
    - Tags shipments via shipments.metadata.source="label_designer_demo" for easy cleanup.
    - Outputs shipment_id + shipment_box_id you can paste into the browser designer.
*/
const crypto = require('crypto');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

function getArg(name, def = '') {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  if (idx >= 0) return argv[idx + 1] || def;
  const pref = `${name}=`;
  const hit = argv.find((a) => a.startsWith(pref));
  if (hit) return hit.slice(pref.length) || def;
  return def;
}

function getIntArg(name, def) {
  const raw = String(getArg(name, '')).trim();
  if (!raw) return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) return def;
  return Math.max(1, Math.floor(v));
}

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function randomDigits(count) {
  const max = 10 ** count;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(count, '0');
}

function randomShortCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const prefix = Array.from({ length: 4 })
    .map(() => letters[crypto.randomInt(0, letters.length)])
    .join('');
  return `${prefix}${randomDigits(4)}`;
}

function makeTrackingNumber() {
  // Keep alphanumeric uppercase only so barcode constraint (^[A-Z0-9]+:[0-9]+$) is satisfied.
  return `QA${Date.now()}${randomDigits(3)}`;
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[provision-label-designer-demo-shipments] DATABASE_URL is required');
  process.exit(2);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function resolveOrganizationId(client) {
  const orgId = getArg('--org-id', '').trim();
  if (orgId) return orgId;

  const userEmail = normaliseEmail(getArg('--user-email', '').trim());
  if (userEmail) {
    const { rows } = await client.query(
      'SELECT organization_id FROM public.users WHERE email = $1 LIMIT 1',
      [userEmail]
    );
    if (rows[0]?.organization_id) return rows[0].organization_id;
    throw new Error(`No organization found for user email=${userEmail}`);
  }

  const fallback = await client.query('SELECT id FROM public.organizations ORDER BY created_at ASC LIMIT 1');
  if (!fallback.rows[0]?.id) throw new Error('No organizations found');
  return fallback.rows[0].id;
}

async function resolveClientId(client, organizationId) {
  const clientId = getArg('--client-id', '').trim();
  if (clientId) return clientId;

  const { rows } = await client.query(
    'SELECT id FROM public.clients WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1',
    [organizationId]
  );
  if (!rows[0]?.id) throw new Error('No clients found for resolved organization');
  return rows[0].id;
}

async function resolveSenderId(client, clientId) {
  const senderId = getArg('--sender-id', '').trim();
  if (senderId) return senderId;

  const { rows } = await client.query(
    'SELECT id FROM public.senders WHERE client_id = $1 ORDER BY created_at ASC LIMIT 1',
    [clientId]
  );
  return rows[0]?.id || null;
}

async function resolveZoneId(client, organizationId) {
  const zoneId = getArg('--zone-id', '').trim();
  if (zoneId) return zoneId;

  const { rows } = await client.query(
    'SELECT id FROM public.zones WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1',
    [organizationId]
  );
  if (rows[0]?.id) return rows[0].id;

  const slugBase = 'label-designer-demo-zone';
  const slug = `${slugBase}-${randomDigits(4)}`.toLowerCase();
  const inserted = await client.query(
    `INSERT INTO public.zones (organization_id, name, slug, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, TRUE, now(), now())
     RETURNING id`,
    [organizationId, 'Label Designer Demo Zone', slug]
  );
  return inserted.rows[0]?.id || null;
}

async function insertAddress(client, params) {
  const {
    organizationId,
    clientId,
    rawInput,
    line1,
    line2,
    district,
    city,
    province,
    postalCode,
    country,
    buildingNumber,
    additionalDirections,
    validationStatus,
    saShortCode,
  } = params;

  const { rows } = await client.query(
    `INSERT INTO public.addresses (
      organization_id,
      client_id,
      raw_input,
      normalized_line1,
      normalized_line2,
      district,
      city,
      province,
      postal_code,
      country,
      building_number,
      additional_directions,
      validation_status,
      sa_short_code,
      created_at,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())
    RETURNING id`,
    [
      organizationId,
      clientId,
      rawInput,
      line1 || null,
      line2 || null,
      district || null,
      city,
      province,
      postalCode || null,
      country || 'SA',
      buildingNumber || null,
      additionalDirections || null,
      validationStatus || 'valid',
      saShortCode || null,
    ]
  );
  if (!rows[0]?.id) throw new Error('Failed to insert address');
  return rows[0].id;
}

async function insertRecipient(client, params) {
  const { organizationId, clientId, name, phoneNumber, email, preferredLanguage } = params;
  const { rows } = await client.query(
    `INSERT INTO public.recipients (
      organization_id,
      client_id,
      name,
      phone_number,
      email,
      preferred_language,
      created_at,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,now(),now())
    RETURNING id`,
    [organizationId, clientId, name, phoneNumber, email || null, preferredLanguage || 'en']
  );
  if (!rows[0]?.id) throw new Error('Failed to insert recipient');
  return rows[0].id;
}

async function insertShipment(client, params) {
  const {
    organizationId,
    clientId,
    senderId,
    recipientId,
    destinationAddressId,
    originAddressId,
    zoneId,
    trackingNumber,
    status,
    serviceType,
    codAmount,
    codCurrency,
    declaredValue,
    specialInstructions,
    metadata,
  } = params;

  const { rows } = await client.query(
    `INSERT INTO public.shipments (
      organization_id,
      client_id,
      sender_id,
      recipient_id,
      destination_address_id,
      origin_address_id,
      zone_id,
      service_type,
      tracking_number,
      box_count,
      status,
      status_updated_at,
      special_instructions,
      cod_amount,
      cod_currency,
      declared_value,
      metadata,
      created_at,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,now(),$11,$12,$13,$14,$15::jsonb,now(),now())
    RETURNING id, tracking_number`,
    [
      organizationId,
      clientId,
      senderId,
      recipientId,
      destinationAddressId,
      originAddressId,
      zoneId,
      serviceType || 'delivery',
      trackingNumber,
      status || 'created',
      specialInstructions || null,
      codAmount ?? null,
      codCurrency || 'SAR',
      declaredValue ?? null,
      JSON.stringify(metadata || {}),
    ]
  );
  if (!rows[0]?.id) throw new Error('Failed to insert shipment');
  return rows[0];
}

async function insertShipmentBox(client, params) {
  const {
    shipmentId,
    organizationId,
    clientId,
    trackingNumber,
    weightKg,
    lengthCm,
    widthCm,
    heightCm,
    contentsDescription,
  } = params;
  const barcode = `${trackingNumber}:1`;
  const { rows } = await client.query(
    `INSERT INTO public.shipment_boxes (
      shipment_id,
      organization_id,
      client_id,
      box_number,
      barcode,
      weight_kg,
      length_cm,
      width_cm,
      height_cm,
      contents_description,
      status,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, now(), now())
    RETURNING id`,
    [
      shipmentId,
      organizationId,
      clientId,
      barcode,
      weightKg ?? null,
      lengthCm ?? null,
      widthCm ?? null,
      heightCm ?? null,
      contentsDescription || null,
      'pending',
    ]
  );
  if (!rows[0]?.id) throw new Error('Failed to insert shipment box');
  return rows[0].id;
}

(async () => {
  const count = getIntArg('--count', 3);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const organizationId = await resolveOrganizationId(client);
    const clientId = await resolveClientId(client, organizationId);
    const senderId = await resolveSenderId(client, clientId);
    const zoneId = await resolveZoneId(client, organizationId);

    const originAddressId = await insertAddress(client, {
      organizationId,
      clientId,
      rawInput: 'QA Warehouse Address (Label Designer)',
      line1: 'Warehouse - Dock 1',
      line2: 'Industrial Area',
      district: 'QA District',
      city: 'Riyadh',
      province: 'Riyadh',
      postalCode: '11564',
      country: 'SA',
      buildingNumber: '12',
      additionalDirections: 'Use gate A',
      validationStatus: 'valid',
      saShortCode: randomShortCode(),
    });

    const fixedShortCodes = ['ABDC1234', 'EFGH5678', 'IJKL9012'];
    const created = [];
    for (let i = 0; i < count; i++) {
      const idx = i + 1;
      const preferredLanguage = i % 2 === 0 ? 'ar' : 'en';
      const isCod = i % 2 === 0;
      const trackingNumber = makeTrackingNumber();

      const recipientId = await insertRecipient(client, {
        organizationId,
        clientId,
        name: preferredLanguage === 'ar' ? `QA مستلم ${idx}` : `QA Recipient ${idx}`,
        phoneNumber: `9665${randomDigits(8)}`,
        email: `qa+label-designer-${Date.now()}-${randomDigits(4)}-${idx}@example.com`,
        preferredLanguage,
      });

      const destinationAddressId = await insertAddress(client, {
        organizationId,
        clientId,
        rawInput: `QA Destination Address ${idx} (Label Designer)`,
        line1: `Destination line 1 - #${idx}`,
        line2: preferredLanguage === 'ar' ? 'عنوان تجريبي' : 'Test address',
        district: `QA District ${idx}`,
        city: 'Riyadh',
        province: 'Riyadh',
        postalCode: `11${randomDigits(3)}`,
        country: 'SA',
        buildingNumber: String(100 + idx),
        additionalDirections: 'Call upon arrival',
        validationStatus: 'valid',
        saShortCode: fixedShortCodes[i] || randomShortCode(),
      });

      const shipment = await insertShipment(client, {
        organizationId,
        clientId,
        senderId,
        recipientId,
        destinationAddressId,
        originAddressId,
        zoneId,
        trackingNumber,
        status: isCod ? 'in_transit' : 'created',
        serviceType: 'delivery',
        codAmount: isCod ? 125.5 + idx : null,
        codCurrency: 'SAR',
        declaredValue: 500 + idx,
        specialInstructions: 'QA: handle with care',
        metadata: {
          qa: true,
          source: 'label_designer_demo',
          scenario: isCod ? 'cod' : 'prepaid',
        },
      });

      const shipmentBoxId = await insertShipmentBox(client, {
        shipmentId: shipment.id,
        organizationId,
        clientId,
        trackingNumber: shipment.tracking_number,
        weightKg: 1.25 + idx / 10,
        lengthCm: 20 + idx,
        widthCm: 10 + idx,
        heightCm: 5 + idx,
        contentsDescription: 'QA contents',
      });

      created.push({
        shipment_id: shipment.id,
        shipment_box_id: shipmentBoxId,
        tracking_number: shipment.tracking_number,
      });
    }

    await client.query('COMMIT');

    console.log(
      JSON.stringify(
        {
          ok: true,
          organization_id: organizationId,
          client_id: clientId,
          zone_id: zoneId,
          created,
        },
        null,
        2
      )
    );
    process.exit(0);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    console.error(
      '[provision-label-designer-demo-shipments] error',
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
