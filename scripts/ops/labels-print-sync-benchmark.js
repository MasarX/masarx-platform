#!/usr/bin/env node
/* eslint-disable no-console */

const { runBenchmarkCli } = require('./labels-print-workflow-benchmark');

runBenchmarkCli({
  defaultScenario: 'print-sync',
  logPrefix: 'labels-print-sync-benchmark',
}).catch((err) => {
  console.error('[labels-print-sync-benchmark] Failed:', err?.message || err);
  process.exit(1);
});
