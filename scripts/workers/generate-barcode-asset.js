#!/usr/bin/env node
// Generate a Code128 barcode PNG for a value and upload to the label render assets bucket.
// Usage: ENV_FILE=config/env/.env.cloud node scripts/workers/generate-barcode-asset.js --value TRACKING --key barcodes/TRACKING.png

const { createClient } = require('@supabase/supabase-js');
const bwipjs = require('bwip-js');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../utils/load-env');
const { resolveExecutionContext, buildTraceHeaders, emitTraceWithContext } = require('../utils/trace-context');

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const STORAGE_ADMIN_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;
const ASSET_BUCKET =
  process.env.LABEL_ASSET_BUCKET ||
  process.env.LABEL_RENDER_ASSETS_BUCKET ||
  'label-render-assets';

if (!SUPABASE_URL || !STORAGE_ADMIN_KEY) {
  console.error('Missing SUPABASE_URL or storage admin key (SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx === -1 ? null : args[idx + 1];
};

const value = getArg('--value');
const key = getArg('--key');
const dpi = Number(getArg('--dpi') || 300);
const scale = Math.max(1, Math.round(dpi / 100));
const correlationIdArg = getArg('--correlation-id');

if (!value || !key) {
  console.error('Usage: node generate-barcode-asset.js --value TRACKING --key barcodes/TRACKING.png [--dpi 300]');
  process.exit(1);
}

const ctx = resolveExecutionContext({ operation: 'worker.generate_barcode_asset', correlationId: correlationIdArg });
const supabase = createClient(SUPABASE_URL, STORAGE_ADMIN_KEY, {
  auth: { persistSession: false },
  global: { headers: buildTraceHeaders(ctx) },
});

async function main() {
  emitTraceWithContext(ctx, 'info', {
    event: 'worker.start',
    worker: 'generate-barcode-asset',
    key,
    dpi,
  });
  // Generate PNG buffer via bwip-js (Code128 auto)
  const png = await bwipjs.toBuffer({
    bcid: 'code128',
    text: value,
    scale,
    height: 20 * scale,
    includetext: false,
    paddingwidth: 6,
    paddingheight: 2,
  });

  // Upload to Storage
  const { error } = await supabase.storage.from(ASSET_BUCKET).upload(key, png, {
    contentType: 'image/png',
    upsert: true,
  });
  if (error) {
    throw new Error(`upload failed: ${error.message}`);
  }

  // Optional local save if desired
  if (args.includes('--save-local')) {
    const outPath = path.resolve(process.cwd(), path.basename(key));
    fs.writeFileSync(outPath, png);
    emitTraceWithContext(ctx, 'info', { event: 'worker.saved_local', path: outPath });
  }

  emitTraceWithContext(ctx, 'info', {
    event: 'worker.completed',
    status: 'ok',
    asset: `${ASSET_BUCKET}/${key}`,
  });
}

main().catch((err) => {
  emitTraceWithContext(ctx, 'error', { event: 'worker.failed', error_message: err?.message || String(err) });
  process.exit(1);
});
