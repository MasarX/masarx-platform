#!/usr/bin/env node
// Runner to merge label PDFs by label_job_ids and upload to labels bucket.
// Usage:
//   ENV_FILE=config/env/.env.cloud node scripts/workers/run-bundle-merge.js --job-ids <id1,id2,...> --output <org>/bundles/<name>.pdf
//   ENV_FILE=config/env/.env.cloud node scripts/workers/run-bundle-merge.js --job-file job_ids.txt --output <org>/bundles/<name>.pdf
//
// This is a thin wrapper around the merge logic from label-bundle-worker.js.
// It can optionally record a decision_log entry via log_decision() when --record is supplied.

const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { Client } = require('pg');
const { PDFDocument } = require('pdf-lib');
const { createClient } = require('@supabase/supabase-js');
const { loadEnv } = require('../utils/load-env');
const { resolveExecutionContext, buildTraceHeaders, emitTraceWithContext } = require('../utils/trace-context');

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

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return null;
  return args[idx + 1];
};

const parseIntArg = (name, fallback) => {
  const raw = getArg(name);
  const n = Number(raw);
  if (!raw) return fallback;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const jobFile = getArg('--job-file');
let jobIdsRaw = getArg('--job-ids');
const downloadConcurrency = parseIntArg('--download-concurrency', 8);
const downloadRetries = parseIntArg('--download-retries', 3);
const uploadRetries = parseIntArg('--upload-retries', 2);

if (jobFile && !jobIdsRaw) {
  try {
    jobIdsRaw = fs.readFileSync(jobFile, 'utf8').trim();
  } catch (err) {
    console.error('Failed to read job file', jobFile, err.message);
    process.exit(1);
  }
}

const outputPath = getArg('--output');
const recordDecision = args.includes('--record');
const correlationIdArg = getArg('--correlation-id');
if ((!jobIdsRaw && !jobFile) || !outputPath) {
  console.error('Usage: node scripts/workers/run-bundle-merge.js --job-ids <id1,id2,...> | --job-file <path> --output <path>.pdf [--record] [--download-concurrency N] [--download-retries N]');
  process.exit(1);
}
const jobIds = jobIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
if (!jobIds.length) {
  console.error('No job IDs provided.');
  process.exit(1);
}

const ctx = resolveExecutionContext({ operation: 'worker.bundle_merge_cli', correlationId: correlationIdArg });
const supabase = createClient(SUPABASE_URL, STORAGE_ADMIN_KEY, {
  auth: { persistSession: false },
  global: { headers: buildTraceHeaders(ctx) },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retry = async (fn, opts = {}) => {
  const attempts = Number.isFinite(Number(opts.attempts)) ? Math.max(1, Math.floor(Number(opts.attempts))) : 1;
  const baseDelayMs = Number.isFinite(Number(opts.baseDelayMs)) ? Math.max(0, Math.floor(Number(opts.baseDelayMs))) : 0;
  const label = typeof opts.label === 'string' ? opts.label : 'operation';
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      emitTraceWithContext(ctx, 'warn', {
        event: 'bundle_merge_retry',
        label,
        attempt,
        attempts,
        delay_ms: delay,
        error_message: err?.message || String(err),
      });
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastErr;
};

const downloadPdf = async (key) => (
  retry(async () => {
    const { data, error } = await supabase.storage.from(LABEL_BUCKET).download(key);
    if (error) throw new Error(`Download failed for ${key}: ${error.message}`);
    if (!data) throw new Error(`Download failed for ${key}: empty body`);
    return new Uint8Array(await data.arrayBuffer());
  }, { attempts: downloadRetries + 1, baseDelayMs: 250, label: `download:${key}` })
);

const uploadPdf = async (key, bytes) => {
  await retry(async () => {
    const { error } = await supabase.storage.from(LABEL_BUCKET).upload(key, Buffer.from(bytes), {
      upsert: true,
      contentType: 'application/pdf',
    });
    if (error) throw new Error(`Upload failed for ${key}: ${error.message}`);
  }, { attempts: uploadRetries + 1, baseDelayMs: 250, label: `upload:${key}` });
};

const mapWithConcurrency = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }).map(async () => {
    while (true) {
      const idx = next;
      next += 1;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
};

const main = async () => {
  const t0 = Date.now();
  emitTraceWithContext(ctx, 'info', {
    event: 'worker.start',
    worker: 'run-bundle-merge',
    output: outputPath,
    jobs_count: jobIds.length,
    record_decision: recordDecision,
    options: {
      download_concurrency: downloadConcurrency,
      download_retries: downloadRetries,
      upload_retries: uploadRetries,
    },
  });
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`SELECT set_config('request.correlation_id', $1, false)`, [ctx.correlationId]);
    const { rows } = await client.query(
      `
        SELECT id, output_file_url, organization_id
        FROM label_jobs
        WHERE id = ANY($1::uuid[])
          AND status = 'succeeded'
          AND output_file_url IS NOT NULL
        ORDER BY array_position($1::uuid[], id)
      `,
      [jobIds],
    );
    if (rows.length !== jobIds.length) {
      throw new Error(`Missing output_file_url for some jobs. Found ${rows.length}/${jobIds.length}`);
    }

    const downloadStart = Date.now();
    const pdfs = await mapWithConcurrency(rows, downloadConcurrency, async (row) => (
      downloadPdf(row.output_file_url)
    ));
    const downloadMs = Date.now() - downloadStart;

    const mergeStart = Date.now();
    const merged = await PDFDocument.create();
    for (const bytes of pdfs) {
      const doc = await PDFDocument.load(bytes);
      const copied = await merged.copyPages(doc, doc.getPageIndices());
      copied.forEach((p) => merged.addPage(p));
    }
    const mergedBytes = await merged.save();
    const mergeMs = Date.now() - mergeStart;

    const uploadStart = Date.now();
    await uploadPdf(outputPath, mergedBytes);
    const uploadMs = Date.now() - uploadStart;
    const totalMs = Date.now() - t0;

    const result = {
      status: 'ok',
      output: outputPath,
      merged_pages: merged.getPageCount(),
      jobs: jobIds,
      timings: {
        download_ms: downloadMs,
        merge_ms: mergeMs,
        upload_ms: uploadMs,
        total_ms: totalMs,
      },
      options: {
        download_concurrency: downloadConcurrency,
        download_retries: downloadRetries,
        upload_retries: uploadRetries,
      },
    };

    if (recordDecision) {
      const orgId = rows[0].organization_id;
      const bundleId = randomUUID();
      await client.query(
        `SELECT log_decision(
          $1::uuid,
          'label_bundle',
          'label_bundle',
          $2::uuid,
          'bundle_merge_cli',
          'succeeded',
          'bundle_merge_cli',
          NULL,
          $3::jsonb,
          $4
        )`,
        [
          orgId,
          bundleId,
          JSON.stringify({
            jobs: jobIds,
            output: outputPath,
            merged_pages: merged.getPageCount(),
            timings: result.timings,
          }),
          `Merged ${jobIds.length} label PDFs into ${outputPath}`,
        ],
      );
      result.bundle_id = bundleId;
      result.decision_log = 'recorded';
    }

    emitTraceWithContext(ctx, 'info', {
      event: 'worker.completed',
      status: 'ok',
      output: result.output,
      merged_pages: result.merged_pages,
      jobs_count: jobIds.length,
      timings: result.timings,
      decision_log: result.decision_log || 'skipped',
      bundle_id: result.bundle_id || null,
    });
    // Preserve CLI-friendly output shape for operators, but include trace context for debugging.
    console.log(JSON.stringify({ ...result, correlation_id: ctx.correlationId, traceparent: ctx.traceparent }, null, 2));
  } finally {
    await client.end();
  }
};

main().catch((err) => {
  emitTraceWithContext(ctx, 'error', { event: 'worker.failed', error_message: err?.message || String(err) });
  process.exit(1);
});
