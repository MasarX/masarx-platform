#!/usr/bin/env node
// Merge existing label PDFs (by label_job_ids) into a single PDF and upload to labels bucket.
// Usage:
//   ENV_FILE=config/env/.env.cloud node scripts/workers/label-bundle-worker.js --job-ids <id1,id2,...> --output-path <org>/bundles/<name>.pdf
//
// Notes:
// - Reads DB via DATABASE_URL to resolve output_file_url for each label_job.
// - Downloads PDFs from the labels bucket using a storage admin key.
// - Merges pages with pdf-lib, uploads merged PDF to the labels bucket at output-path.
// - Does NOT write a new DB row; caller can record the path in workflow context.

const path = require('path');
const { Client } = require('pg');
const { PDFDocument } = require('pdf-lib');
const { createClient } = require('@supabase/supabase-js');
const { loadEnv } = require('../utils/load-env');
const { resolveExecutionContext, buildTraceHeaders, emitTraceWithContext } = require('../utils/trace-context');

// Load env
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const STORAGE_ADMIN_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const LABEL_BUCKET = process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';

if (!SUPABASE_URL || !STORAGE_ADMIN_KEY || !DATABASE_URL) {
  console.error('Missing SUPABASE_URL or storage admin key (SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY) or DATABASE_URL.');
  process.exit(1);
}

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return null;
  return args[idx + 1];
};

const jobIdsRaw = getArg('--job-ids');
const outputPath = getArg('--output-path');
const correlationIdArg = getArg('--correlation-id');
if (!jobIdsRaw || !outputPath) {
  console.error('Usage: node scripts/workers/label-bundle-worker.js --job-ids <id1,id2,...> --output-path <path>.pdf');
  process.exit(1);
}
const jobIds = jobIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
if (!jobIds.length) {
  console.error('No job IDs provided.');
  process.exit(1);
}

const ctx = resolveExecutionContext({ operation: 'worker.label_bundle', correlationId: correlationIdArg });
const supabase = createClient(SUPABASE_URL, STORAGE_ADMIN_KEY, {
  auth: { persistSession: false },
  global: { headers: buildTraceHeaders(ctx) },
});

const downloadPdf = async (key) => {
  const { data, error } = await supabase.storage.from(LABEL_BUCKET).download(key);
  if (error) throw new Error(`Download failed for ${key}: ${error.message}`);
  return new Uint8Array(await data.arrayBuffer());
};

const uploadPdf = async (key, bytes) => {
  const { error } = await supabase.storage.from(LABEL_BUCKET).upload(key, Buffer.from(bytes), {
    upsert: true,
    contentType: 'application/pdf',
  });
  if (error) throw new Error(`Upload failed for ${key}: ${error.message}`);
};

const main = async () => {
  emitTraceWithContext(ctx, 'info', {
    event: 'worker.start',
    worker: 'label-bundle-worker',
    output_path: outputPath,
    jobs_count: jobIds.length,
  });
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`SELECT set_config('request.correlation_id', $1, false)`, [ctx.correlationId]);
    const { rows } = await client.query(
      `SELECT id, output_file_url FROM label_jobs WHERE id = ANY($1::uuid[]) AND status = 'succeeded' AND output_file_url IS NOT NULL`,
      [jobIds],
    );
    if (rows.length !== jobIds.length) {
      throw new Error(`Missing output_file_url for some jobs. Found ${rows.length}/${jobIds.length}`);
    }

    const pdfs = [];
    for (const row of rows) {
      pdfs.push(await downloadPdf(row.output_file_url));
    }

    const merged = await PDFDocument.create();
    for (const bytes of pdfs) {
      const doc = await PDFDocument.load(bytes);
      const copied = await merged.copyPages(doc, doc.getPageIndices());
      copied.forEach((p) => merged.addPage(p));
    }
    const mergedBytes = await merged.save();

    await uploadPdf(outputPath, mergedBytes);
    emitTraceWithContext(ctx, 'info', {
      event: 'worker.completed',
      status: 'ok',
      output: outputPath,
      merged_pages: merged.getPageCount(),
      jobs: jobIds,
    });
  } finally {
    await client.end();
  }
};

main().catch((err) => {
  emitTraceWithContext(ctx, 'error', { event: 'worker.failed', error_message: err?.message || String(err) });
  process.exit(1);
});
