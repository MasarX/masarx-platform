#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * trim-future-partitions.js
 *
 * Purpose:
 *   Repair/maintenance utility to remove runaway future RANGE partitions that are
 *   outside the configured partitions_ahead window (partitioning_config + partition_defaults).
 *
 * Why:
 *   Some environments can accumulate excessive future partitions (e.g., from legacy
 *   non-idempotent create_next_partitions() behaviour), which can exhaust lock memory
 *   and break integration/pgTAP workloads.
 *
 * Guarantees:
 * - Dynamic: computes cutoffs from DB config (partitioning_config + resolve_settings()).
 * - Safe: only drops partitions whose start_at is >= window_end (outside the active window).
 * - Idempotent: re-running when no future partitions exist is a no-op.
 *
 * Usage:
 *   node scripts/ops/trim-future-partitions.js [--dry-run] [--limit N] [--table <name>]
 */

const { Client } = require('pg');
const { loadEnv } = require('../utils/load-env');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.replace(/^--/, '');
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    out[k] = v;
  }
  return out;
}

function toInt(value, fallback) {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function quoteIdent(value) {
  const v = String(value || '');
  return `"${v.replace(/"/g, '""')}"`;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === '1' || args['dry-run'] === 'true';
  const limit = Math.max(0, toInt(args.limit || args.max || '0', 0));
  const tableFilter = String(args.table || '').trim();

  const dbUrl = (process.env.DATABASE_URL || '').trim();
  if (!dbUrl) {
    throw new Error('DATABASE_URL is not set (expected ENV_FILE=config/env/.env.cloud or exported env vars).');
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    // Hold the same lock-key family used by create_next_partitions() so that
    // partition creation and trimming never race.
    await client.query(`select pg_advisory_lock(hashtext('public'), hashtext('create_next_partitions'))`);

    const params = [];
    let whereTail = '';
    if (tableFilter) {
      params.push(tableFilter);
      whereTail = `and pi.table_name = $${params.length}`;
    }

    const { rows } = await client.query(
      `
        with conf as (
          select
            pc.table_name,
            pc.partition_interval,
            coalesce(
              pc.partitions_ahead,
              coalesce((resolve_settings('partition_defaults','global', null)->>'partitions_ahead')::int, 4)
            ) as partitions_ahead
          from public.partitioning_config pc
          where pc.partition_strategy in ('RANGE','HASH+RANGE')
        ),
        cutoff as (
          select
            table_name,
            date_trunc(case when partition_interval = 'weekly' then 'week' else 'month' end, now()) as window_start,
            case when partition_interval = 'weekly' then interval '1 week' else interval '1 month' end as step,
            partitions_ahead
          from conf
        ),
        thresholds as (
          select
            table_name,
            window_start + (partitions_ahead * step) as window_end
          from cutoff
        )
        select
          pi.table_name,
          pi.partition_name,
          pi.start_at,
          pi.end_at,
          pi.row_estimate,
          format('drop table if exists public.%I', pi.partition_name) as drop_sql
        from public.partition_inventory pi
        join thresholds t on t.table_name = pi.table_name
        where pi.start_at is not null
          and pi.start_at >= t.window_end
          ${whereTail}
        order by pi.table_name, pi.start_at desc
      `,
      params,
    );

    const counts = rows.reduce((acc, r) => {
      const k = r.table_name || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    const total = rows.length;
    if (!total) {
      console.log('[trim-future-partitions] No future partitions to trim (already within window).');
      return;
    }

    console.log('[trim-future-partitions] Future partitions detected:', total);
    for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  - ${k}: ${v}`);
    }

    if (dryRun) {
      console.log('[trim-future-partitions] Dry-run enabled; no DDL executed.');
      return;
    }

    let dropped = 0;
    const nonEmpty = [];
    for (const r of rows) {
      if (limit && dropped >= limit) break;
      const sql = String(r.drop_sql || '').trim();
      const label = `${r.table_name}.${r.partition_name}`;
      const partitionIdent = quoteIdent(r.partition_name);
      const hasRowRes = await client.query(
        `select exists(select 1 from public.${partitionIdent} limit 1) as has_row`,
      );
      const hasRow = Boolean(hasRowRes.rows && hasRowRes.rows[0] && hasRowRes.rows[0].has_row);
      if (hasRow) {
        nonEmpty.push({
          label,
          start_at: r.start_at,
          end_at: r.end_at,
          row_estimate: Number(r.row_estimate || 0),
        });
        console.log(`[trim-future-partitions] skip non-empty ${label} (${r.start_at} -> ${r.end_at})`);
        continue;
      }
      console.log(`[trim-future-partitions] dropping ${label} (${r.start_at} -> ${r.end_at})`);
      await client.query(sql);
      dropped++;
    }

    console.log(`[trim-future-partitions] Completed. Dropped=${dropped}${limit ? ` (limit=${limit})` : ''}`);
    if (nonEmpty.length) {
      console.error(`[trim-future-partitions] Refusing to drop ${nonEmpty.length} non-empty future partitions.`);
      nonEmpty.slice(0, 25).forEach((p) => {
        console.error(`  - ${p.label} (${p.start_at} -> ${p.end_at}) row_estimate=${p.row_estimate}`);
      });
      if (nonEmpty.length > 25) {
        console.error(`  - ...and ${nonEmpty.length - 25} more`);
      }
      process.exit(1);
    }
  } finally {
    try {
      await client.query(`select pg_advisory_unlock(hashtext('public'), hashtext('create_next_partitions'))`);
    } catch (_) {
      // best-effort unlock
    }
    await client.end();
  }
}

main().catch((err) => {
  console.error('[trim-future-partitions] Failed:', err && err.message ? err.message : String(err));
  process.exit(1);
});
