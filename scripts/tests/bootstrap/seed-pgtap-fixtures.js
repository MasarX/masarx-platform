#!/usr/bin/env node
/* eslint-disable no-console */
const { runCli, buildFixtureProfile } = require('./lib/integration-fixtures');
const { loadEnv } = require('../../utils/load-env');

async function runPgtapFixtureProfiles(env = process.env) {
  // Preserve the configured profile; the existing SQL suite additionally requires
  // these two default profiles. There is no runner GUC/prefix override bridge.
  const prefixes = [...new Set([buildFixtureProfile(env).prefix, 'test', 'test-foreign'])];
  for (const prefix of prefixes) {
    await runCli({ env: { ...env, INTEGRATION_FIXTURE_PREFIX: prefix } });
  }
}

if (require.main === module) {
  loadEnv();
  runPgtapFixtureProfiles({ ...process.env }).catch((error) => {
    console.error(`[seed-pgtap-fixtures] ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = { runPgtapFixtureProfiles };
