#!/usr/bin/env node
/* eslint-disable no-console */

const { runBenchmarkCli } = require('./labels-print-workflow-benchmark');

runBenchmarkCli({
  defaultScenario: 'download-latency',
  logPrefix: 'labels-print-download-latency-benchmark',
}).catch((err) => {
  console.error('[labels-print-download-latency-benchmark] Failed:', err?.message || err);
  process.exit(1);
});
