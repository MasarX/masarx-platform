#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { buildDbConnectionCandidates } = require('../utils/pg-candidates');

loadEnv();

const {
  DATABASE_URL,
  DATABASE_URL_DIRECT,
  BENCHMARK_DATABASE_URL,
  BENCHMARK_DATABASE_URL_DIRECT,
  PREVIEW_SUPABASE_DB_PASSWORD,
  SUPABASE_URL,
  SUPABASE_PROJECT_ID,
} = process.env;

const parseIntSafe = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const inferProjectRefFromSupabaseUrl = () => {
  const explicit = String(SUPABASE_PROJECT_ID || '').trim();
  if (explicit) return explicit;
  const raw = String(SUPABASE_URL || '').trim();
  if (!raw) return '';
  try {
    const host = new URL(raw).hostname;
    const match = host.match(/^([a-z0-9]{20})\.supabase\.co$/i);
    return match && match[1] ? String(match[1]).toLowerCase() : '';
  } catch {
    return '';
  }
};

const buildPreviewDirectDsn = ({ projectRef, password }) => {
  const ref = String(projectRef || '').trim();
  const pass = String(password || '').trim();
  if (!ref || !pass) return '';
  const dsn = new URL('postgresql:');
  dsn.username = 'postgres';
  dsn.password = pass;
  dsn.hostname = `db.${ref}.supabase.co`;
  dsn.port = '5432';
  dsn.pathname = '/postgres';
  dsn.searchParams.set('sslmode', 'require');
  return dsn.toString();
};

async function selectPool() {
  const projectRef = inferProjectRefFromSupabaseUrl();
  const previewDirectDsn = buildPreviewDirectDsn({
    projectRef,
    password: PREVIEW_SUPABASE_DB_PASSWORD,
  });

  const rawDbCandidates = [];
  if (String(DATABASE_URL || '').trim()) {
    rawDbCandidates.push({ name: 'DATABASE_URL', dsn: String(DATABASE_URL).trim() });
  }
  if (String(DATABASE_URL_DIRECT || '').trim()) {
    rawDbCandidates.push({ name: 'DATABASE_URL_DIRECT', dsn: String(DATABASE_URL_DIRECT).trim() });
  }
  if (String(BENCHMARK_DATABASE_URL || '').trim()) {
    rawDbCandidates.push({ name: 'BENCHMARK_DATABASE_URL', dsn: String(BENCHMARK_DATABASE_URL).trim() });
  }
  if (String(BENCHMARK_DATABASE_URL_DIRECT || '').trim()) {
    rawDbCandidates.push({ name: 'BENCHMARK_DATABASE_URL_DIRECT', dsn: String(BENCHMARK_DATABASE_URL_DIRECT).trim() });
  }
  if (previewDirectDsn) {
    rawDbCandidates.push({ name: 'PREVIEW_SUPABASE_DB_PASSWORD+SUPABASE_URL', dsn: previewDirectDsn });
  }
  if (rawDbCandidates.length === 0) {
    throw new Error('Missing database connection candidates. Provide DATABASE_URL or preview credentials.');
  }

  const dbCandidates = await buildDbConnectionCandidates(rawDbCandidates, { projectRef });
  const errors = [];
  for (const candidate of dbCandidates) {
    const dsn = String(candidate?.dsn || '').trim();
    if (!dsn) continue;
    const pool = new Pool({ connectionString: dsn });
    try {
      const client = await pool.connect();
      client.release();
      return { pool, dbCandidate: String(candidate?.name || 'unknown') };
    } catch (err) {
      errors.push(`${String(candidate?.name || 'unknown')}: ${err?.message || err}`);
      await pool.end().catch(() => {});
    }
  }
  throw new Error(`Unable to connect to database via candidate ladder: ${errors.join(' | ')}`);
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      days: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      app: { type: 'string' },
      out: { type: 'string' },
    },
    strict: false,
  });

  const days = Math.max(1, Math.min(90, parseIntSafe(values.days, 7)));
  const now = new Date();
  const from = values.from ? new Date(String(values.from)) : new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const to = values.to ? new Date(String(values.to)) : now;
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new Error('Invalid date window. Use --from/--to ISO timestamps or a positive --days window.');
  }
  const app = String(values.app || '').trim() || null;

  const { pool, dbCandidate } = await selectPool();
  const client = await pool.connect();
  try {
    const summarySql = `
      WITH base AS (
        SELECT
          app,
          created_at,
          CASE
            WHEN COALESCE(meta->>'click_to_download_start_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'click_to_download_start_ms')::numeric
            ELSE NULL
          END AS click_ms,
          CASE
            WHEN COALESCE(meta->>'target_download_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'target_download_ms')::numeric
            ELSE NULL
          END AS target_ms,
          CASE
            WHEN COALESCE(meta->>'stage_command_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'stage_command_ms')::numeric
            ELSE NULL
          END AS stage_command_ms,
          CASE
            WHEN COALESCE(meta->>'stage_first_status_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'stage_first_status_ms')::numeric
            ELSE NULL
          END AS stage_first_status_ms,
          CASE
            WHEN COALESCE(meta->>'stage_output_ready_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'stage_output_ready_ms')::numeric
            ELSE NULL
          END AS stage_output_ready_ms,
          CASE
            WHEN COALESCE(meta->>'stage_transport_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'stage_transport_ms')::numeric
            ELSE NULL
          END AS stage_transport_ms,
          CASE
            WHEN COALESCE(meta->>'function_total_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'function_total_ms')::numeric
            ELSE NULL
          END AS function_total_ms,
          CASE
            WHEN COALESCE(meta->>'edge_overhead_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'edge_overhead_ms')::numeric
            ELSE NULL
          END AS edge_overhead_ms,
          NULLIF(meta->>'output_source', '') AS output_source,
          LOWER(NULLIF(meta->>'classification', '')) AS classification,
          NULLIF(meta->>'workflow_run_id', '') AS workflow_run_id
        FROM public.ui_event_log
        WHERE event_type = 'ui.bulk_action.print.download.kpi'
          AND created_at >= $1::timestamptz
          AND created_at < $2::timestamptz
          AND ($3::text IS NULL OR app = $3::text)
      ),
      scored AS (
        SELECT
          app,
          created_at,
          workflow_run_id,
          click_ms,
          target_ms,
          stage_command_ms,
          stage_first_status_ms,
          stage_output_ready_ms,
          stage_transport_ms,
          function_total_ms,
          edge_overhead_ms,
          output_source,
          COALESCE(
            classification,
            CASE
              WHEN click_ms IS NOT NULL AND target_ms IS NOT NULL AND click_ms <= target_ms THEN 'hit'
              WHEN click_ms IS NOT NULL THEN 'miss'
              ELSE NULL
            END
          ) AS resolved_classification
        FROM base
        WHERE click_ms IS NOT NULL
      ),
      source_counts AS (
        SELECT
          app,
          jsonb_object_agg(output_source, source_count) AS output_source_counts
        FROM (
          SELECT
            app,
            output_source,
            COUNT(*)::int AS source_count
          FROM scored
          WHERE output_source IS NOT NULL
          GROUP BY app, output_source
        ) grouped_sources
        GROUP BY app
      )
      SELECT
        scored.app,
        COUNT(*)::int AS sample_count,
        ROUND(AVG(click_ms)::numeric, 2) AS mean_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY click_ms)::numeric, 2) AS p50_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY click_ms)::numeric, 2) AS p95_ms,
        SUM(CASE WHEN resolved_classification = 'hit' THEN 1 ELSE 0 END)::int AS hit_count,
        SUM(CASE WHEN resolved_classification = 'miss' THEN 1 ELSE 0 END)::int AS miss_count,
        ROUND(
          (SUM(CASE WHEN resolved_classification = 'hit' THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0))
          , 4
        ) AS hit_rate,
        ROUND(MAX(target_ms)::numeric, 2) AS target_download_ms,
        COUNT(DISTINCT workflow_run_id)::int AS distinct_workflow_runs,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stage_command_ms)::numeric, 2) AS stage_command_p50_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY stage_command_ms)::numeric, 2) AS stage_command_p95_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stage_first_status_ms)::numeric, 2) AS stage_first_status_p50_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY stage_first_status_ms)::numeric, 2) AS stage_first_status_p95_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stage_output_ready_ms)::numeric, 2) AS stage_output_ready_p50_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY stage_output_ready_ms)::numeric, 2) AS stage_output_ready_p95_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stage_transport_ms)::numeric, 2) AS stage_transport_p50_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY stage_transport_ms)::numeric, 2) AS stage_transport_p95_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY function_total_ms)::numeric, 2) AS function_total_p50_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY function_total_ms)::numeric, 2) AS function_total_p95_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY edge_overhead_ms)::numeric, 2) AS edge_overhead_p50_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY edge_overhead_ms)::numeric, 2) AS edge_overhead_p95_ms,
        source_counts.output_source_counts
      FROM scored
      LEFT JOIN source_counts ON source_counts.app = scored.app
      GROUP BY scored.app, source_counts.output_source_counts
      ORDER BY scored.app;
    `;

    const trendSql = `
      WITH scored AS (
        SELECT
          app,
          date_trunc('hour', created_at) AS bucket_hour,
          CASE
            WHEN COALESCE(meta->>'click_to_download_start_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'click_to_download_start_ms')::numeric
            ELSE NULL
          END AS click_ms,
          CASE
            WHEN COALESCE(meta->>'target_download_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'target_download_ms')::numeric
            ELSE NULL
          END AS target_ms,
          CASE
            WHEN COALESCE(meta->>'stage_command_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'stage_command_ms')::numeric
            ELSE NULL
          END AS stage_command_ms,
          CASE
            WHEN COALESCE(meta->>'stage_first_status_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'stage_first_status_ms')::numeric
            ELSE NULL
          END AS stage_first_status_ms,
          CASE
            WHEN COALESCE(meta->>'stage_output_ready_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'stage_output_ready_ms')::numeric
            ELSE NULL
          END AS stage_output_ready_ms,
          CASE
            WHEN COALESCE(meta->>'stage_transport_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'stage_transport_ms')::numeric
            ELSE NULL
          END AS stage_transport_ms,
          CASE
            WHEN COALESCE(meta->>'function_total_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'function_total_ms')::numeric
            ELSE NULL
          END AS function_total_ms,
          CASE
            WHEN COALESCE(meta->>'edge_overhead_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (meta->>'edge_overhead_ms')::numeric
            ELSE NULL
          END AS edge_overhead_ms,
          LOWER(NULLIF(meta->>'classification', '')) AS classification
        FROM public.ui_event_log
        WHERE event_type = 'ui.bulk_action.print.download.kpi'
          AND created_at >= $1::timestamptz
          AND created_at < $2::timestamptz
          AND ($3::text IS NULL OR app = $3::text)
      ),
      normalized AS (
        SELECT
          app,
          bucket_hour,
          click_ms,
          target_ms,
          stage_command_ms,
          stage_first_status_ms,
          stage_output_ready_ms,
          stage_transport_ms,
          function_total_ms,
          edge_overhead_ms,
          COALESCE(
            classification,
            CASE
              WHEN click_ms IS NOT NULL AND target_ms IS NOT NULL AND click_ms <= target_ms THEN 'hit'
              WHEN click_ms IS NOT NULL THEN 'miss'
              ELSE NULL
            END
          ) AS resolved_classification
        FROM scored
        WHERE click_ms IS NOT NULL
      )
      SELECT
        app,
        bucket_hour,
        COUNT(*)::int AS sample_count,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY click_ms)::numeric, 2) AS p50_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY click_ms)::numeric, 2) AS p95_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stage_command_ms)::numeric, 2) AS stage_command_p50_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stage_first_status_ms)::numeric, 2) AS stage_first_status_p50_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stage_output_ready_ms)::numeric, 2) AS stage_output_ready_p50_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stage_transport_ms)::numeric, 2) AS stage_transport_p50_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY function_total_ms)::numeric, 2) AS function_total_p50_ms,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY edge_overhead_ms)::numeric, 2) AS edge_overhead_p50_ms,
        SUM(CASE WHEN resolved_classification = 'hit' THEN 1 ELSE 0 END)::int AS hit_count,
        ROUND(
          (SUM(CASE WHEN resolved_classification = 'hit' THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0))
          , 4
        ) AS hit_rate
      FROM normalized
      GROUP BY app, bucket_hour
      ORDER BY app, bucket_hour;
    `;

    const [summaryResult, trendResult] = await Promise.all([
      client.query(summarySql, [from.toISOString(), to.toISOString(), app]),
      client.query(trendSql, [from.toISOString(), to.toISOString(), app]),
    ]);

    const output = {
      generated_at: new Date().toISOString(),
      window: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
      filters: {
        app,
      },
      environment: {
        db_candidate: dbCandidate,
      },
      summary: summaryResult.rows,
      hourly_trend: trendResult.rows,
    };

    const rendered = `${JSON.stringify(output, null, 2)}\n`;
    process.stdout.write(rendered);

    const outPathRaw = String(values.out || '').trim();
    if (outPathRaw) {
      const outPath = path.resolve(process.cwd(), outPathRaw);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, rendered, 'utf8');
      console.error(`[shipments-print-kpi-report] Wrote ${outPath}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[shipments-print-kpi-report] Failed:', err?.message || err);
  process.exit(1);
});
