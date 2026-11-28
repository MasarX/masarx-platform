#!/usr/bin/env node
/*
  Provision reproducible QA fixtures for the shipment amend/cancel workspace.
  Creates sender-scoped shipment_operation_policy coverage plus:
    - one pending shipment inside the soft-cancel window
    - one pending shipment outside the soft-cancel window

  Usage:
    ENV_FILE=path/to/local-config node scripts/qa/provision-shipment-amend-cancel-fixtures.js
*/
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const { loadEnv } = require("../utils/load-env");
const {
  deterministicUuid,
  readDemoManifest,
} = require("./lib/public-tracking-fixtures");

loadEnv();

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) {
  console.error("[provision-shipment-amend-cancel-fixtures] DATABASE_URL is required");
  process.exit(2);
}

const pool = new Pool({ connectionString: DATABASE_URL });

function buildShipmentOperationPolicy(
  deleteWindowHours = 24,
  addressDefaultCountryCode = "QA",
) {
  return {
    version: 1,
    modify: {
      allowed_statuses: ["pending"],
      allowed_fields: [
        "service_type",
        "service_level",
        "special_instructions",
        "cod_amount",
        "client_reference_number",
        "carrier_reference_number",
        "metadata",
        "references",
      ],
    },
    address: {
      allowed_statuses: ["pending"],
      default_country_code: addressDefaultCountryCode,
    },
    reschedule: {
      allowed_statuses: ["pending"],
    },
    delete: {
      allowed_statuses: ["pending"],
      mode: "soft_cancel",
      window_hours: deleteWindowHours,
    },
  };
}

function buildTrackingNumber(prefix, runToken) {
  return `${prefix}-${runToken}-${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, "0")}`;
}

async function rpcOne(client, sql, params) {
  const result = await client.query(sql, params);
  return result.rows[0] || null;
}

async function withFixtureProvisionLock(client, fn) {
  const lockKey = "qa:shipment-amend-cancel-fixtures";
  await client.query("select pg_advisory_lock(hashtextextended($1::text, 0))", [lockKey]);
  try {
    return await fn();
  } finally {
    await client.query("select pg_advisory_unlock(hashtextextended($1::text, 0))", [lockKey]);
  }
}

async function ensureFixtureSender(client, demo) {
  const senderId = deterministicUuid(`qa-shipment-amend-cancel-sender:${demo.clientId}`);
  await client.query(
    `
      insert into public.senders (
        id,
        client_id,
        name,
        brand_name,
        auto_provisioned,
        auto_recreate,
        status,
        settings_override
      )
      values (
        $1::uuid,
        $2::uuid,
        'QA Shipment Amend Cancel Sender',
        'QA Shipment Amend Cancel Sender',
        false,
        true,
        'active',
        '{}'::jsonb
      )
      on conflict (id) do nothing
    `,
    [senderId, demo.clientId],
  );

  await client.query(
    `
      update public.senders
      set
        client_id = $2::uuid,
        name = 'QA Shipment Amend Cancel Sender',
        brand_name = 'QA Shipment Amend Cancel Sender',
        auto_provisioned = false,
        auto_recreate = true,
        status = 'active',
        settings_override = '{}'::jsonb
      where id = $1::uuid
    `,
    [senderId, demo.clientId],
  );

  return senderId;
}

async function upsertPolicy(
  client,
  senderId,
  deleteWindowHours,
  addressDefaultCountryCode = "QA",
) {
  await client.query(
    `
      select public.upsert_settings_value_v1(
        'shipment_operation_policy',
        'sender',
        $1::uuid,
        $2::jsonb,
        1,
        'qa shipment amend/cancel playwright fixtures'
      )
    `,
    [
      senderId,
      JSON.stringify(
        buildShipmentOperationPolicy(
          deleteWindowHours,
          addressDefaultCountryCode,
        ),
      ),
    ],
  );
}

async function insertShipment(client, params) {
  const {
    organizationId,
    clientId,
    senderId,
    trackingNumber,
    createdAt,
    shipmentStatus = "pending",
    promisedDeliveryDate,
  } = params;

  const shipmentId = randomUUID();
  await client.query(
    `
      insert into public.shipments (
        id,
        organization_id,
        client_id,
        sender_id,
        service_type,
        service_level,
        tracking_number,
        carrier_reference_number,
        client_reference_number,
        status,
        promised_delivery_date,
        created_at,
        updated_at,
        special_instructions,
        metadata
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        'delivery',
        'standard',
        $5::text,
        $6::text,
        $7::text,
        $8::text,
        $9::date,
        $10::timestamptz,
        now(),
        'QA shipment amend/cancel fixture',
        $11::jsonb
      )
    `,
    [
      shipmentId,
      organizationId,
      clientId,
      senderId,
      trackingNumber,
      `${trackingNumber}-CARRIER`,
      `${trackingNumber}-CLIENT`,
      shipmentStatus,
      promisedDeliveryDate,
      createdAt.toISOString(),
      JSON.stringify({
        qa_fixture: "shipment_amend_cancel",
        tracking_number: trackingNumber,
      }),
    ],
  );

  return shipmentId;
}

async function fetchShipmentSummary(client, shipmentId) {
  const row = await rpcOne(
    client,
    `
      select
        id,
        tracking_number,
        status,
        created_at,
        promised_delivery_date
      from public.shipments
      where id = $1::uuid
      limit 1
    `,
    [shipmentId],
  );
  if (!row) {
    throw new Error(`shipment not found after provisioning: ${shipmentId}`);
  }
  return row;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query(
      "select pg_advisory_lock(hashtext('qa.provision_shipment_amend_cancel_fixtures_v1'))",
    );

    const demo = readDemoManifest();
    const deleteWindowHours = 24;
    const addressDefaultCountryCode = "QA";
    const summary = await withFixtureProvisionLock(client, async () => {
      const senderId = await ensureFixtureSender(client, demo);
      await upsertPolicy(
        client,
        senderId,
        deleteWindowHours,
        addressDefaultCountryCode,
      );

      const runToken = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      const now = new Date();
      const blockedCreatedAt = new Date(now.getTime() - 48 * 60 * 60 * 1000);
      const promisedDeliveryDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      const cancelAllowedId = await insertShipment(client, {
        organizationId: demo.organizationId,
        clientId: demo.clientId,
        senderId,
        trackingNumber: buildTrackingNumber("UC030-CANCEL-OK", runToken),
        createdAt: now,
        promisedDeliveryDate,
      });

      const cancelBlockedId = await insertShipment(client, {
        organizationId: demo.organizationId,
        clientId: demo.clientId,
        senderId,
        trackingNumber: buildTrackingNumber("UC030-CANCEL-BLOCKED", runToken),
        createdAt: blockedCreatedAt,
        promisedDeliveryDate,
      });

      return {
        generated_at: new Date().toISOString(),
        policy: {
          scope_type: "sender",
          scope_id: senderId,
          delete_window_hours: deleteWindowHours,
          address_default_country_code: addressDefaultCountryCode,
        },
        shipments: {
          cancel_allowed: await fetchShipmentSummary(client, cancelAllowedId),
          cancel_window_blocked: await fetchShipmentSummary(client, cancelBlockedId),
        },
      };
    });

    const outputPath = path.resolve(
      process.cwd(),
      "tmp",
      "shipment-amend-cancel-fixtures.json",
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    console.log(JSON.stringify(summary, null, 2));
    console.error(`[provision-shipment-amend-cancel-fixtures] wrote ${outputPath}`);
  } finally {
    try {
      await client.query(
        "select pg_advisory_unlock(hashtext('qa.provision_shipment_amend_cancel_fixtures_v1'))",
      );
    } catch {
      // Ignore unlock failures during local fixture teardown.
    }
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "[provision-shipment-amend-cancel-fixtures] error",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
