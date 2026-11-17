#!/usr/bin/env node
/* eslint-disable no-console */
const { runCli } = require('./lib/integration-fixtures');

if (require.main === module) {
  runCli().catch((error) => {
    console.error(`[seed-pgtap-fixtures] ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  });
}
