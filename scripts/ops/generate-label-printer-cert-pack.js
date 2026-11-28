#!/usr/bin/env node
/**
 * Generate a "printer certification" label pack for a client warehouse.
 *
 * Goal: print + scan in the warehouse to confirm the selected print profile (dpi)
 * can reliably scan the worst-case client references on the current label design.
 *
 * SSOT:
 *  - Template snapshot: resolve_label_template(...)
 *  - Printer profile: resolve_settings_row('label_print_profile', ...)
 *  - Barcode actions: resolve_settings_row('label_render_policy', ...).barcode (warn/enforce)
 */
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { Client } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { evaluateBarcodeQualityPolicy } = require('../render/barcode-quality-policy');
const { renderComposedLabelPdf } = require('../qa/label-render-sim');

loadEnv();

const ROOT = process.cwd();

function die(msg) {
  console.error(`[printer-cert] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const k = t.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[k] = true;
    else {
      out[k] = next;
      i += 1;
    }
  }
  return out;
}

function nowTs() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}-${hh}${mm}${ss}`;
}

function hashText(s) {
  return createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function pickScope({ orgId, clientId, senderId }) {
  if (senderId) return { scopeType: 'sender', scopeId: senderId };
  if (clientId) return { scopeType: 'client', scopeId: clientId };
  return { scopeType: 'tenant', scopeId: orgId };
}

async function resolveSettingsValue(db, category, scopeType, scopeId) {
  const { rows } = await db.query(
    'SELECT value, scope_type, scope_id, settings_version_id, version FROM public.resolve_settings_row($1, $2, $3)',
    [category, scopeType, scopeId]
  );
  if (!rows.length || !rows[0]?.value) return null;
  return rows[0];
}

async function resolveTemplateSnapshot(db, { orgId, clientId, senderId, labelType }) {
  const { rows } = await db.query(
    `
      SELECT template_id, template_version, template_snapshot
        FROM public.resolve_label_template($1::uuid, $2::uuid, $3::uuid, $4::text)
       LIMIT 1
    `,
    [orgId, clientId, senderId, labelType]
  );
  if (!rows.length || !rows[0]?.template_snapshot) return null;
  return rows[0];
}

async function fetchWorstCaseShipments(db, { orgId, clientId, senderId, limit }) {
  const { rows } = await db.query(
    `
      SELECT id AS shipment_id,
             tracking_number,
             COALESCE(client_reference_number, carrier_reference_number, tracking_number) AS reference_number,
             length(COALESCE(client_reference_number, carrier_reference_number, tracking_number)) AS reference_len
        FROM public.shipments
       WHERE organization_id = $1::uuid
         AND client_id = $2::uuid
         AND ($3::uuid IS NULL OR sender_id = $3::uuid)
       ORDER BY reference_len DESC NULLS LAST, created_at DESC
       LIMIT $4::int
    `,
    [orgId, clientId, senderId, limit]
  );
  return rows;
}

async function fetchPayloadRow(db, shipmentId) {
  const { rows } = await db.query(
    `
      SELECT *
        FROM public.shipment_label_payload_v
       WHERE shipment_id = $1::uuid
       ORDER BY box_number ASC NULLS LAST
       LIMIT 1
    `,
    [shipmentId]
  );
  return rows[0] || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const orgId = typeof args['org-id'] === 'string' ? args['org-id'] : null;
  const clientId = typeof args['client-id'] === 'string' ? args['client-id'] : null;
  const senderId = typeof args['sender-id'] === 'string' ? args['sender-id'] : null;
  const labelType = typeof args['label-type'] === 'string' ? String(args['label-type']).toLowerCase() : 'shipping';
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.floor(Number(args.limit))) : 12;

  if (!process.env.DATABASE_URL) die('Missing DATABASE_URL (set ENV_FILE=path/to/cloud-config)');
  if (!orgId) die('Missing --org-id');
  if (!clientId) die('Missing --client-id');

  const outDir = path.resolve(
    ROOT,
    String(args['out-dir'] || path.join('tmp', 'printer-cert-packs', orgId, clientId, nowTs()))
  );

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    const { scopeType, scopeId } = pickScope({ orgId, clientId, senderId });

    const printProfileRow = await resolveSettingsValue(db, 'label_print_profile', scopeType, scopeId);
    if (!printProfileRow) die(`label_print_profile missing for scope ${scopeType}:${scopeId || 'null'}`);
    const printProfile = printProfileRow.value;

    const policyRow = await resolveSettingsValue(db, 'label_render_policy', scopeType, scopeId);
    if (!policyRow) die(`label_render_policy missing for scope ${scopeType}:${scopeId || 'null'}`);
    const labelPolicy = policyRow.value || {};
    const barcodePolicy = labelPolicy?.barcode && typeof labelPolicy.barcode === 'object' ? labelPolicy.barcode : {};

    const template = await resolveTemplateSnapshot(db, { orgId, clientId, senderId, labelType });
    if (!template) die(`Unable to resolve label template snapshot for label_type=${labelType}`);

    const shipments = await fetchWorstCaseShipments(db, { orgId, clientId, senderId, limit });
    if (!shipments.length) {
      die('No shipments found for this client (need real references to generate a certification pack).');
    }

    const dpi = Number.isFinite(Number(printProfile?.dpi)) ? Number(printProfile.dpi) : 203;
    const ppBarcode = printProfile?.barcode && typeof printProfile.barcode === 'object' ? printProfile.barcode : {};
    const quietZoneModules = Number.isFinite(Number(ppBarcode.quiet_zone_modules)) ? Math.floor(Number(ppBarcode.quiet_zone_modules)) : 10;
    const minQuietZoneModules = Number.isFinite(Number(ppBarcode.min_quiet_zone_modules)) ? Math.floor(Number(ppBarcode.min_quiet_zone_modules)) : 4;
    const targetDots = Number.isFinite(Number(ppBarcode.target_module_width_dots)) ? Math.floor(Number(ppBarcode.target_module_width_dots)) : 2;
    const hardMinDots = Number.isFinite(Number(ppBarcode.hard_min_module_width_dots)) ? Math.floor(Number(ppBarcode.hard_min_module_width_dots)) : 1;

    fs.mkdirSync(outDir, { recursive: true });

    const packDoc = await PDFDocument.create();

    const index = {
      generated_at: new Date().toISOString(),
      org_id: orgId,
      client_id: clientId,
      sender_id: senderId,
      label_type: labelType,
      scope: { scope_type: scopeType, scope_id: scopeId || null },
      template: {
        template_id: template.template_id,
        template_version: template.template_version,
      },
      label_print_profile: {
        profile_key: printProfile?.profile_key || null,
        dpi,
        barcode: {
          quiet_zone_modules: quietZoneModules,
          min_quiet_zone_modules: minQuietZoneModules,
          target_module_width_dots: targetDots,
          hard_min_module_width_dots: hardMinDots,
        },
      },
      label_render_policy_barcode: {
        gate_mode: barcodePolicy?.gate_mode || 'warn_only',
        on_unscannable: barcodePolicy?.on_unscannable || null,
        on_at_risk: barcodePolicy?.on_at_risk || null,
        on_non_vector: barcodePolicy?.on_non_vector || null,
      },
      cases: [],
    };

    let i = 0;
    for (const row of shipments) {
      i += 1;
      const shipmentId = row.shipment_id;
      const payloadRow = await fetchPayloadRow(db, shipmentId);
      if (!payloadRow) continue;

      const composed = {
        payload: payloadRow,
        job: { template_snapshot: template.template_snapshot },
      };

      const fileName = `${String(i).padStart(2, '0')}_refLen-${payloadRow?.reference_number ? String(payloadRow.reference_number).length : 0}.pdf`;
      const outFile = path.join(outDir, fileName);

      const rendered = await renderComposedLabelPdf(composed, outFile, {
        labelType,
        dpi,
        quietZoneModules,
        minQuietZoneModules,
        targetDots,
        hardMinDots,
      });

      const policyEval = evaluateBarcodeQualityPolicy(barcodePolicy, rendered.barcodeMeta);

      const doc = await PDFDocument.load(rendered.bytes);
      const [page] = await packDoc.copyPages(doc, [0]);
      packDoc.addPage(page);

      index.cases.push({
        shipment_id: shipmentId,
        tracking_number: payloadRow.tracking_number || row.tracking_number || null,
        reference_length: payloadRow.reference_number ? String(payloadRow.reference_number).length : null,
        reference_sha256: payloadRow.reference_number ? hashText(payloadRow.reference_number) : null,
        file: path.relative(ROOT, outFile).replace(/\\/g, '/'),
        barcode: {
          policy: {
            gate_mode: barcodePolicy?.gate_mode || 'warn_only',
            would_fail: policyEval.should_fail,
            should_warn: policyEval.should_warn,
            violations: policyEval.violations,
          },
          blocks: rendered.barcodeMeta,
        },
      });
      console.log(`[printer-cert] wrote ${path.relative(ROOT, outFile)}`);
    }

    if (!index.cases.length) die('No label pages were produced (shipment_label_payload_v returned no rows).');

    const packBytes = await packDoc.save();
    const packPath = path.join(outDir, 'printer-cert-pack.pdf');
    fs.writeFileSync(packPath, Buffer.from(packBytes));
    console.log(`[printer-cert] wrote ${path.relative(ROOT, packPath)}`);

    const indexPath = path.join(outDir, 'index.json');
    fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    console.log(`[printer-cert] wrote ${path.relative(ROOT, indexPath)}`);
  } finally {
    await db.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
