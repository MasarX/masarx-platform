#!/usr/bin/env node

const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { loadEnv } = require('../utils/load-env');
const { resolveExecutionContext, buildTraceHeaders, emitTraceWithContext } = require('../utils/trace-context');

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EDGE_SUPABASE_URL || process.env.API_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.EDGE_SUPABASE_ANON_KEY || '';
const SERVICE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.EDGE_SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const EDGE_RPC_SCHEMA = process.env.RESOURCE_IMPORT_RPC_SCHEMA || process.env.EDGE_RPC_SCHEMA || process.env.API_RPC_SCHEMA || 'api';
const IMPORT_BUCKET = 'tabular-imports';

if (!SUPABASE_URL || !SERVICE_KEY || !DATABASE_URL) {
  console.error('Missing SUPABASE_URL, service key, or DATABASE_URL for tabular import worker.');
  process.exit(1);
}

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const getArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) return fallback;
  return args[index + 1];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isJwtLike = (value) => String(value || '').trim().split('.').length === 3;

const once = hasFlag('--once');
const runId = getArg('--run-id')?.toLowerCase() ?? null;
if (hasFlag('--run-id') && (!once || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId ?? ''))) {
  throw new Error('The --run-id option requires --once and a valid run UUID.');
}
const workerId = getArg('--worker-id', process.env.TABULAR_IMPORT_WORKER_ID || `tabular-import-worker-${process.pid}`);
const pollMs = Number.parseInt(getArg('--poll-ms', process.env.TABULAR_IMPORT_WORKER_POLL_MS || '3000'), 10) || 3000;
const batchSize = Number.parseInt(getArg('--batch-size', process.env.TABULAR_IMPORT_WORKER_BATCH_SIZE || ''), 10) || null;

const ctx = resolveExecutionContext({ operation: 'worker.tabular_import', correlationId: process.env.CORRELATION_ID });
const apiKeyHeader = isJwtLike(SERVICE_KEY) ? (SUPABASE_ANON_KEY || SERVICE_KEY) : SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
  db: { schema: EDGE_RPC_SCHEMA },
  global: { headers: { apikey: apiKeyHeader, ...buildTraceHeaders(ctx) } },
});

const toRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
};

const firstRecord = (value) => {
  if (Array.isArray(value)) return toRecord(value[0]);
  return toRecord(value);
};

const csvEscape = (value) => {
  if (value == null) return '';
  let raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(raw)) raw = "'" + raw;
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
};

const sanitizeFileName = (value, fallback = 'import-errors.csv') => {
  const normalized = String(value || '')
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
};

const rpc = async (name, args = {}) => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    throw new Error(error.message || `RPC ${name} failed`);
  }
  return data;
};

const buildErrorCsv = (run, rows) => {
  const summary = toRecord(run.summary) || {};
  const summaryHeaders = Array.isArray(summary.headers)
    ? summary.headers.map((value) => String(value)).filter(Boolean)
    : [];
  const extras = new Set();
  rows.forEach((row) => {
    const originalRow = toRecord(row.original_row) || {};
    Object.keys(originalRow).forEach((key) => {
      if (!summaryHeaders.includes(key)) extras.add(key);
    });
  });

  const headers = [
    ...summaryHeaders,
    ...Array.from(extras),
    '__row_number',
    '__status',
    '__reason_codes',
    '__reason_messages',
    '__suggested_fix',
  ];

  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach((row) => {
    const originalRow = toRecord(row.original_row) || {};
    const reasonCodes = Array.isArray(row.reason_codes) ? row.reason_codes.map((entry) => String(entry)) : [];
    const reasonMessages = Array.isArray(row.reason_messages) ? row.reason_messages.map((entry) => String(entry)) : [];
    const suggestedFix = reasonMessages[0] || 'Review the blocked or skipped row details and correct the source file before retrying.';
    const record = [
      ...summaryHeaders.map((header) => originalRow[header]),
      ...Array.from(extras).map((header) => originalRow[header]),
      row.row_number,
      row.execution_status || row.action || '',
      reasonCodes.join('; '),
      reasonMessages.join('; '),
      suggestedFix,
    ];
    lines.push(record.map(csvEscape).join(','));
  });
  return `${lines.join('\n')}\n`;
};

const uploadErrorExport = async ({ run, rows, pgClient }) => {
  if (!rows.length) return null;

  const fileName = sanitizeFileName(`${run.resource_key || 'import'}-${run.id}-errors.csv`);
  const storageKey = `${run.organization_id}/imports/${run.resource_key || 'resource'}/${run.id}/${fileName}`;
  const csv = buildErrorCsv(run, rows);
  const bytes = Buffer.from(csv, 'utf8');

  const { error: uploadError } = await supabase.storage
    .from(IMPORT_BUCKET)
    .upload(storageKey, bytes, {
      upsert: true,
      contentType: 'text/csv',
    });
  if (uploadError) {
    throw new Error(uploadError.message || 'Failed to upload tabular import error export');
  }

  const artifactResult = firstRecord(await rpc('register_artifact_v1', {
    p_artifact: {
      organization_id: run.organization_id,
      storage_bucket: IMPORT_BUCKET,
      storage_key: storageKey,
      mime_type: 'text/csv',
      size_bytes: bytes.length,
      source_system: 'tabular_import_worker',
      metadata: {
        file_name: fileName,
        run_id: run.id,
        resource_key: run.resource_key,
        export_kind: 'error_export',
      },
    },
  }));

  const artifactId = artifactResult?.artifact_id || null;
  if (!artifactId) {
    throw new Error('register_artifact_v1 did not return artifact_id for error export');
  }

  await pgClient.query(
    `insert into public.artifact_links (
       organization_id,
       artifact_id,
       resource_type,
       resource_id,
       relation_type,
       metadata
     ) values ($1, $2, 'tabular_import_runs', $3, 'error_export', $4::jsonb)
     on conflict (organization_id, artifact_id, resource_type, resource_id, relation_type) do nothing`,
    [
      run.organization_id,
      artifactId,
      run.id,
      JSON.stringify({ file_name: fileName, storage_key: storageKey }),
    ],
  );

  return {
    artifactId,
    storageKey,
    fileName,
  };
};

const createOperationReport = async ({ run, errorExport, failedRows, pgClient }) => {

  const status = String(run.status || '').toLowerCase() === 'failed' ? 'failed' : 'succeeded';
  const nextStepsResult = await pgClient.query(
    `select public.tabular_import_execution_next_steps_v1($1::int, $2::int, $3::int, $4::int, $5::int) as next_steps`,
    [run.created_count, run.updated_count, run.skipped_count, run.failed_count, run.blocked_count],
  );
  const nextSteps = nextStepsResult.rows[0].next_steps;
  if (run.report_id) {
    if (nextSteps.length > 0) {
      await pgClient.query(
        `update public.mapping_operation_reports
            set next_steps = $2::jsonb,
                updated_at = now()
          where id = $1
            and organization_id = $3
            and next_steps = '[]'::jsonb`,
        [run.report_id, JSON.stringify(nextSteps), run.organization_id],
      );
    }
    return run.report_id;
  }

  const report = await rpc('ui_create_mapping_operation_report_v1', {
    p_report: {
      organization_id: run.organization_id,
      artifact_type: 'tabular_import',
      operation_kind: 'tabular_import_execution',
      save_mode: 'direct',
      status,
      primary_resource_type: 'tabular_import_runs',
      primary_resource_id: run.id,
      correlation_id: ctx.correlationId,
      request_summary: {
        resource_key: run.resource_key,
        write_mode: run.write_mode,
        source_format: run.source_format,
        source_file_name: run.source_file_name,
        total_rows: run.total_rows,
      },
      conversion_summary: {
        warning_count: run.warning_count,
      },
      diagnostics_summary: {
        blocked_count: run.blocked_count,
        skipped_count: run.skipped_count,
        failed_count: run.failed_count,
        error_rows: failedRows.length,
        error_artifact_id: errorExport?.artifactId || null,
      },
      result_payload: {
        run_id: run.id,
        status: run.status,
        created_count: run.created_count,
        updated_count: run.updated_count,
        skipped_count: run.skipped_count,
        failed_count: run.failed_count,
        blocked_count: run.blocked_count,
        error_export: errorExport || null,
      },
      decision_refs: {
        task_id: run.task_id,
      },
      next_steps: nextSteps,
    },
  });

  const record = firstRecord(report) || toRecord(report);
  return record?.id || null;
};

const finalizeRun = async ({ runId, pgClient }) => {
  await pgClient.query('BEGIN');
  try {
    const runResult = await pgClient.query(
      `select r.*
         from public.tabular_import_runs r
        where r.status in ('completed', 'completed_with_errors', 'failed')
          and (
            r.id = $1::uuid
            or ($1::uuid is null and r.error_artifact_id is null and exists (
              select 1 from public.tabular_import_run_rows rr
               where rr.run_id = r.id
                 and (rr.action in ('skip', 'block', 'failed')
                   or rr.execution_status in ('skipped', 'blocked', 'failed'))
            ))
          )
        order by r.completed_at asc nulls last, r.id
        limit 1
        for update of r skip locked`,
      [runId || null],
    );
    const run = runResult.rows[0];
    if (!run) {
      await pgClient.query('COMMIT');
      return null;
    }

    const failedRowsResult = await pgClient.query(
      `select row_number, action, execution_status, original_row, reason_codes, reason_messages
         from public.tabular_import_run_rows
        where run_id = $1
          and (
            action in ('skip', 'block', 'failed')
            or execution_status in ('skipped', 'blocked', 'failed')
          )
        order by row_number asc`,
      [run.id],
    );
    const failedRows = failedRowsResult.rows;

    let errorExport = null;
    if (failedRows.length > 0 && !run.error_artifact_id) {
      errorExport = await uploadErrorExport({ run, rows: failedRows, pgClient });
    }

    const reportId = await createOperationReport({ run, errorExport, failedRows, pgClient });
    if (reportId || errorExport?.artifactId) {
      await pgClient.query(
        `update public.tabular_import_runs
            set report_id = coalesce($2::uuid, report_id),
                error_artifact_id = coalesce($3::uuid, error_artifact_id),
                updated_at = now()
          where id = $1`,
        [run.id, reportId, errorExport?.artifactId || null],
      );
    }

    await pgClient.query('COMMIT');
    return {
      reportId,
      errorArtifactId: errorExport?.artifactId || run.error_artifact_id || null,
    };
  } catch (error) {
    await pgClient.query('ROLLBACK');
    throw error;
  }
};

const processClaim = async (claim, pgClient) => {
  emitTraceWithContext(ctx, 'info', {
    event: 'tabular_import.claimed',
    worker_id: workerId,
    run_id: claim.run_id,
    task_id: claim.task_id,
  });

  let result = null;
  let processedCount = -1;
  do {
    result = toRecord(await rpc('process_tabular_import_run_v1', {
      p_run_id: claim.run_id,
      p_batch_size: batchSize,
    })) || {};
    if (result.status !== 'processing' && result.status !== 'queued') break;
    const nextProcessedCount = Number(result.created_count) + Number(result.updated_count) + Number(result.failed_count);
    if (!Number.isSafeInteger(nextProcessedCount) || nextProcessedCount <= processedCount) {
      throw new Error(`Tabular import ${claim.run_id} made no processing progress.`);
    }
    processedCount = nextProcessedCount;
  } while (true);

  if (String(result.status || '').toLowerCase() !== 'processing') {
    await finalizeRun({ runId: claim.run_id, pgClient });
  }

  emitTraceWithContext(ctx, 'info', {
    event: 'tabular_import.completed',
    worker_id: workerId,
    run_id: claim.run_id,
    result,
  });
};

const main = async () => {
  const pgClient = new Client({ connectionString: DATABASE_URL });
  await pgClient.connect();
  try {
    await pgClient.query(`select set_config('request.correlation_id', $1, false)`, [ctx.correlationId]);
    while (true) {
      const claim = toRecord(await rpc(runId ? 'claim_tabular_import_task_v1' : 'claim_next_tabular_import_task_v1', {
        p_worker_id: workerId,
        ...(runId ? { p_run_id: runId } : {}),
      }));

      if (runId && claim && claim.run_id !== runId) {
        throw new Error('The worker claim returned a different import run.');
      }
      if (!claim) {
        // Kickoff can finish a run before its worker claims the task.
        if (runId) {
          if (!await finalizeRun({ runId, pgClient })) {
            throw new Error('The requested import run is neither claimable nor ready to finalize.');
          }
          break;
        }
        let finalized = null;
        try {
          finalized = await finalizeRun({ pgClient });
        } catch (error) {
          emitTraceWithContext(ctx, 'error', {
            event: 'tabular_import.finalize_failed',
            worker_id: workerId,
            error_message: error instanceof Error ? error.message : String(error),
          });
        }
        if (finalized && !once) continue;
        if (once) break;
        await sleep(pollMs);
        continue;
      }

      try {
        await processClaim(claim, pgClient);
      } catch (error) {
        emitTraceWithContext(ctx, 'error', {
          event: 'tabular_import.failed',
          worker_id: workerId,
          run_id: claim.run_id,
          error_message: error instanceof Error ? error.message : String(error),
        });
        try {
          await finalizeRun({ runId: claim.run_id, pgClient });
        } catch (finalizeError) {
          emitTraceWithContext(ctx, 'error', {
            event: 'tabular_import.finalize_failed',
            worker_id: workerId,
            run_id: claim.run_id,
            error_message: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
          });
        }
        if (runId) throw error;
      }

      if (once) break;
    }
  } finally {
    await pgClient.end();
  }
};

main().catch((error) => {
  emitTraceWithContext(ctx, 'error', {
    event: 'tabular_import.worker_fatal',
    worker_id: workerId,
    error_message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
