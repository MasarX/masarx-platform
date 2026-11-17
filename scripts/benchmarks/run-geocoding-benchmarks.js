#!/usr/bin/env node
/**
 * Benchmark runner for geocoding plugins.
 * - Ensures corpus size via benchmark_generate_corpus (optional).
 * - Executes benchmark samples per policy variant (local-only, local+long+provider, reverse-only, provider-only).
 * - Stores results in benchmark_results via workflow-driven handlers.
 * - Prints per-plugin metrics from v_benchmark_plugin_metrics and top failures.
 *
 * Usage:
 *   node scripts/benchmarks/run-geocoding-benchmarks.js --limit-per-category=50 --ensure-corpus --policies=all
 *   env: ENV_FILE=config/env/.env.cloud (or DATABASE_URL directly)
 */

const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../utils/load-env');

loadEnv();

// Load benchmark helpers after env is available (they read env at import time).
const {
  BENCHMARK_POLICY_LABELS,
  buildBenchmarkPolicies,
  runBenchmarkSample,
} = require('../../tests/integration/helpers/benchmarkIngest');
const { applyGeocodingPolicy } = require('../../tests/integration/helpers/geocodingPolicy');
const { providerOnlyBenchmarkPolicy } = require('../../tests/integration/helpers/benchmarkPolicy');

function parseArgs(argv) {
  const parsed = {
    limitPerCategory: 25,
    ensureCorpus: false,
    policies: 'all',
    scope: 'client',
    statementTimeoutMs: 0,
    categories: 'all',
    targetPerCategory: 1200,
  };
  argv.forEach((arg) => {
    if (arg === '--ensure-corpus') parsed.ensureCorpus = true;
    else if (arg.startsWith('--limit-per-category=')) parsed.limitPerCategory = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--policies=')) parsed.policies = arg.split('=')[1];
    else if (arg.startsWith('--scope=')) parsed.scope = arg.split('=')[1];
    else if (arg.startsWith('--statement-timeout-ms=')) parsed.statementTimeoutMs = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--categories=')) parsed.categories = arg.split('=')[1];
    else if (arg.startsWith('--target-per-category=')) parsed.targetPerCategory = parseInt(arg.split('=')[1], 10);
  });
  return parsed;
}

const parsed = parseArgs(process.argv.slice(2));
const limitPerCategory = parsed.limitPerCategory || 25;
const ensureCorpus = parsed.ensureCorpus;
const policiesArg = parsed.policies.split(',').map((s) => s.trim()).filter(Boolean);
const scopeType = parsed.scope;
const statementTimeoutMs = Number.isFinite(parsed.statementTimeoutMs) ? parsed.statementTimeoutMs : 0;
const targetPerCategory = Number.isFinite(parsed.targetPerCategory) ? parsed.targetPerCategory : 1200;

const defaultCategories = ['perfect', 'typo', 'long_line', 'partial', 'short_code', 'reverse_only', 'border'];
const categories =
  parsed.categories === 'all'
    ? defaultCategories
    : parsed.categories
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
const policies = buildBenchmarkPolicies();

async function pickScope(client) {
  const { rows } = await client.query(
    `
      SELECT o.id AS organization_id, c.id AS client_id, s.id AS sender_id
      FROM organizations o
      JOIN clients c ON c.organization_id = o.id
      JOIN senders s ON s.client_id = c.id
      ORDER BY o.created_at
      LIMIT 1
    `,
  );
  if (!rows.length) {
    throw new Error('No organization/client/sender found; seed data missing');
  }
  return rows[0];
}

async function ensureCorpusSize(client) {
  const target = {
    perfect: targetPerCategory,
    typo: targetPerCategory,
    long_line: targetPerCategory,
    partial: targetPerCategory,
    short_code: targetPerCategory,
    reverse_local: targetPerCategory,
    border: targetPerCategory,
  };
  const { rows } = await client.query(`SELECT benchmark_generate_corpus($1::jsonb, FALSE, 42) AS summary`, [
    target,
  ]);
  return rows[0].summary;
}

async function loadSamples(client) {
  const samplesByCategory = {};
  for (const cat of categories) {
    const { rows } = await client.query(
      `
        SELECT *
        FROM benchmark_geocoding_samples
        WHERE category = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [cat, limitPerCategory],
    );
    samplesByCategory[cat] = rows;
  }
  return samplesByCategory;
}

async function runBenchmarks(client, scope, samplesByCategory) {
  const results = [];
  const selectedPolicies =
    policiesArg.includes('all') || !policiesArg.length
      ? Object.keys(policies)
      : policiesArg;
  const reverseCategories = new Set(['reverse_local', 'reverse_only', 'border']);
  const runId = randomUUID();
  const policyScopeId = scopeType === 'client' ? scope.client_id : scope.organization_id;

  await client.query(
    `INSERT INTO benchmark_runs (id, benchmark_key, metadata) VALUES ($1::uuid, 'geocoding', $2::jsonb)`,
    [
      runId,
      JSON.stringify({
        policies: selectedPolicies,
        limitPerCategory,
        ensureCorpus,
        scopeType,
        scopeId: scopeType === 'client' ? scope.client_id : scope.organization_id,
      }),
    ],
  );

  for (const policyLabel of selectedPolicies) {
    const policy = policies[policyLabel];
    if (!policy) continue;

    const effectivePolicy =
      policyLabel === BENCHMARK_POLICY_LABELS.PROVIDER_ONLY
        ? { ...providerOnlyBenchmarkPolicy(), ...policy }
        : policy;
    await applyGeocodingPolicy(client, scopeType, policyScopeId, effectivePolicy, null, policyLabel);
    await client.query(`DELETE FROM settings_cache`);

    for (const cat of Object.keys(samplesByCategory)) {
      // Skip reverse-only policy for non-reverse categories
      if (policyLabel === BENCHMARK_POLICY_LABELS.REVERSE_LOCAL_ONLY && !reverseCategories.has(cat)) {
        continue;
      }
      for (const sample of samplesByCategory[cat]) {
        const scopedSample = {
          ...sample,
          organization_id: scope.organization_id,
          client_id: scope.client_id,
          sender_id: scope.sender_id,
        };
        const res = await runBenchmarkSample(
          client,
          scopedSample,
          policyLabel,
          policy,
          scopeType,
          policyScopeId,
          runId,
          { skipPolicyApply: true },
        );
        results.push({ policyLabel, category: cat, matched: res.matched, plugin: res.matchPlugin });
      }
    }
  }
  return { results, runId };
}

async function fetchMetrics(client) {
  const { rows: metrics } = await client.query(
    `SELECT match_plugin, category, n, correct, ROUND(accuracy::numeric, 4) AS accuracy, ci_low, ci_high, p95_latency_ms FROM v_benchmark_plugin_metrics_latest_run ORDER BY match_plugin, category`,
  );
  const { rows: failures } = await client.query(
    `SELECT match_plugin, category, failure_reason, failures FROM v_benchmark_failures_latest_run ORDER BY failures DESC LIMIT 20`,
  );
  return { metrics, failures };
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    if (statementTimeoutMs === 0) {
      await client.query(`SET statement_timeout TO 0`);
    } else if (statementTimeoutMs > 0) {
      await client.query(`SET statement_timeout TO ${Math.floor(statementTimeoutMs)}`);
    }
    console.log(`Benchmark runner starting (limit per category=${limitPerCategory}, policies=${policiesArg.join(',')})`);
    if (ensureCorpus) {
      const summary = await ensureCorpusSize(client);
      console.log('Corpus ensured:', JSON.stringify(summary, null, 2));
    }

    const scope = await pickScope(client);
    const samples = await loadSamples(client);
    const { results, runId } = await runBenchmarks(client, scope, samples);
    console.log(`Benchmark run_id=${runId}`);
    console.log(`Executed ${results.length} benchmark samples`);

    const { metrics, failures } = await fetchMetrics(client);
    console.log('\nPer-plugin metrics (v_benchmark_plugin_metrics_latest_run):');
    console.table(metrics);
    console.log('\nTop failure reasons (v_benchmark_failures_latest_run):');
    console.table(failures);
  } finally {
    await client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
