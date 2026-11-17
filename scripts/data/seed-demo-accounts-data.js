#!/usr/bin/env node
/**
 * Seed minimal, deterministic demo data for the provisioned demo accounts.
 *
 * Goals:
 * - No hardcoded IDs: read org/clients/senders from the demo accounts manifest.
 * - Idempotent: safe to run repeatedly (upserts via stable keys).
 * - Create enough rows for E2E + UX validation: shipments + shipment_boxes + labels + label_jobs.
 *
 * Usage:
 *   node scripts/data/seed-demo-accounts-data.js [--manifest <path>] [--shipments-per-sender <n>]
 *
 * Defaults:
 * - manifest: tmp/demo-accounts.json
 * - shipments-per-sender: 6
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { loadEnv } = require("../utils/load-env");
const { assertMutationAllowed } = require("../utils/production-mutation-guard");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [keyRaw, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      out[keyRaw] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[keyRaw] = true;
      continue;
    }
    out[keyRaw] = next;
    i += 1;
  }
  return out;
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`[seed-demo-data] Missing ${name}`);
  }
  return value;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function sanitizeTrackingBase(value) {
  const normalized = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 20);
  return normalized || "DEMO";
}

function buildTrackingNumber({ prefix, clientSlug, senderName, index }) {
  const base = sanitizeTrackingBase(`${prefix}${clientSlug}${senderName}`);
  const suffix = String(index + 1).padStart(3, "0");
  return `${base}${suffix}`;
}

async function upsertShipment(db, row) {
  await db.query(
    `
      INSERT INTO public.shipments (
        organization_id,
        client_id,
        sender_id,
        service_type,
        tracking_number,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tracking_number, client_id)
      DO UPDATE SET
        sender_id = EXCLUDED.sender_id,
        service_type = EXCLUDED.service_type,
        status = EXCLUDED.status,
        status_updated_at = now(),
        updated_at = now()
    `,
    [
      row.organization_id,
      row.client_id,
      row.sender_id,
      row.service_type,
      row.tracking_number,
      row.status,
    ]
  );

  const { rows } = await db.query(
    `
      SELECT id
      FROM public.shipments
      WHERE tracking_number = $1
        AND client_id = $2
      LIMIT 1
    `,
    [row.tracking_number, row.client_id]
  );

  if (!rows[0]?.id) {
    throw new Error(`[seed-demo-data] Failed to resolve shipment id for ${row.tracking_number}`);
  }
  return rows[0].id;
}

async function upsertShipmentBox(db, row) {
  await db.query(
    `
      INSERT INTO public.shipment_boxes (
        organization_id,
        client_id,
        shipment_id,
        box_number,
        barcode,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (shipment_id, box_number)
      DO UPDATE SET
        barcode = EXCLUDED.barcode,
        status = EXCLUDED.status
    `,
    [
      row.organization_id,
      row.client_id,
      row.shipment_id,
      row.box_number,
      row.barcode,
      row.status,
    ]
  );

  const { rows } = await db.query(
    `
      SELECT id
      FROM public.shipment_boxes
      WHERE shipment_id = $1
        AND box_number = $2
      LIMIT 1
    `,
    [row.shipment_id, row.box_number]
  );

  if (!rows[0]?.id) {
    throw new Error(`[seed-demo-data] Failed to resolve shipment_box id for ${row.barcode}`);
  }
  return rows[0].id;
}

async function upsertLabel(db, row) {
  await db.query(
    `
      INSERT INTO public.labels (
        organization_id,
        client_id,
        shipment_id,
        label_type,
        barcode,
        barcode_format,
        file_url,
        file_size_bytes,
        generated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (barcode, shipment_id)
      DO UPDATE SET
        file_url = EXCLUDED.file_url,
        file_size_bytes = EXCLUDED.file_size_bytes,
        generated_by = EXCLUDED.generated_by,
        generated_at = now()
    `,
    [
      row.organization_id,
      row.client_id,
      row.shipment_id,
      row.label_type,
      row.barcode,
      row.barcode_format,
      row.file_url,
      row.file_size_bytes,
      row.generated_by,
    ]
  );
}

async function ensureLabelJob(db, row) {
  await db.query(
    `
      SELECT *
      FROM public.request_label_generation_batch(
        $1,
        $2,
        $3,
        $4,
        $5::uuid[],
        $6
      )
    `,
    [
      row.shipment_id,
      row.label_type,
      row.requested_by,
      row.requested_source,
      row.shipment_box_ids,
      row.job_purpose,
    ]
  );
}

async function main() {
  loadEnv();
  assertMutationAllowed({
    operation: "seed-demo-accounts-data",
    allowProductionEnvVar: "SEED_DEMO_DATA_ALLOW_PRODUCTION",
  });
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const manifestPath = path.resolve(
    repoRoot,
    args.manifest || "tmp/demo-accounts.json"
  );

  const shipmentsPerSenderRaw = Number.parseInt(
    String(args["shipments-per-sender"] ?? "6"),
    10
  );
  const shipmentsPerSender =
    Number.isFinite(shipmentsPerSenderRaw) && shipmentsPerSenderRaw > 0
      ? shipmentsPerSenderRaw
      : 6;

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[seed-demo-data] Demo manifest missing: ${manifestPath}`);
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  const manifest = readJson(manifestPath);
  const orgId = manifest?.organization?.id;
  if (!orgId) {
    throw new Error("[seed-demo-data] Demo manifest missing organization.id");
  }

  const clients = Array.isArray(manifest.clients) ? manifest.clients : [];
  const senders = Array.isArray(manifest.senders) ? manifest.senders : [];
  const users = Array.isArray(manifest.users) ? manifest.users : [];
  const opsUser = users.find((u) => u && u.user_type === "ops_admin");
  const generatedBy = opsUser?.auth_user_id ?? null;

  const senderByClientSlug = new Map();
  for (const sender of senders) {
    if (!sender?.client_slug || !sender?.id) continue;
    const arr = senderByClientSlug.get(sender.client_slug) || [];
    arr.push(sender);
    senderByClientSlug.set(sender.client_slug, arr);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = await pool.connect();

  const prefix = sanitizeTrackingBase("DEMO");
  const created = {
    shipments: 0,
    boxes: 0,
    labels: 0,
    labelJobs: 0,
  };

  try {
    await db.query("BEGIN");

    for (const client of clients) {
      if (!client?.slug || !client?.id) continue;
      const clientSlug = String(client.slug);
      const clientId = client.id;

      const clientSenders = senderByClientSlug.get(clientSlug) || [];
      if (!clientSenders.length) {
        clientSenders.push({ id: null, sender_name: "" });
      }

      for (const sender of clientSenders) {
        const senderId = sender?.id ?? null;
        const senderName = sender?.sender_name ?? "";

        for (let i = 0; i < shipmentsPerSender; i += 1) {
          const trackingNumber = buildTrackingNumber({
            prefix,
            clientSlug,
            senderName,
            index: i,
          });

          const shipmentId = await upsertShipment(db, {
            organization_id: orgId,
            client_id: clientId,
            sender_id: senderId,
            service_type: "delivery",
            tracking_number: trackingNumber,
            status: "created",
          });
          created.shipments += 1;

          const barcode = `${trackingNumber}:1`;
          const shipmentBoxId = await upsertShipmentBox(db, {
            organization_id: orgId,
            client_id: clientId,
            shipment_id: shipmentId,
            box_number: 1,
            barcode,
            status: "pending",
          });
          created.boxes += 1;

          await upsertLabel(db, {
            organization_id: orgId,
            client_id: clientId,
            shipment_id: shipmentId,
            label_type: "shipping",
            barcode,
            barcode_format: "CODE128",
            file_url: `https://example.invalid/labels/${barcode}.pdf`,
            file_size_bytes: 1024,
            generated_by: generatedBy,
          });
          created.labels += 1;

          await ensureLabelJob(db, {
            shipment_id: shipmentId,
            label_type: "shipping",
            requested_by: generatedBy,
            requested_source: "demo_seed",
            shipment_box_ids: [shipmentBoxId],
            job_purpose: "primary",
          });
          created.labelJobs += 1;
        }
      }
    }

    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
    await pool.end();
  }

  console.log(
    JSON.stringify(
      {
        event: "demo_seed_complete",
        manifest: path.relative(repoRoot, manifestPath),
        shipments_per_sender: shipmentsPerSender,
        created,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
