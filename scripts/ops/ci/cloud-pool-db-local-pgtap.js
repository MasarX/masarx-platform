#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

// Full pgTAP for the local-db db_local lane: a dedicated, ephemeral JIT VM running one job and one plain
// `supabase start` stack. It reuses the repo runner's full-local qualification (no local skip list,
// capability probe, serialized per-file execution) with lane-specific proofs instead of the shared-host
// workspace lease: there is no lease-owned workspace config, lifecycle lock or ownership state on this VM.
const { spawnSync } = require('child_process');
const runner = require('../../tests/run-pgtap-cloud');

// objectives:allow LOCALHOST Justification: the lane accepts only the loopback config.toml db port.
const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

function plainCliDatabaseIdentity({ projectId, dbPort, spawn = spawnSync }) {
  if (!projectId || !dbPort) throw new Error('[db_local/pgtap] project id and db port are required');
  return (_workspaceId, dsn) => {
    const parsed = new URL(dsn);
    if (!LOOPBACK.has(parsed.hostname.toLowerCase()) || String(parsed.port) !== String(dbPort)) {
      throw new Error('[db_local/pgtap] DATABASE_URL must target the loopback config.toml db port');
    }
    const container = `supabase_db_${projectId}`;
    const port = spawn('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' });
    if (port.error || port.status !== 0
      || !String(port.stdout || '').split(/\r?\n/).some(line => line.trim().endsWith(`:${dbPort}`))) {
      throw new Error(`[db_local/pgtap] ${container} does not own port ${dbPort}`);
    }
    return { database: decodeURIComponent(parsed.pathname.replace(/^\//, '')), host: parsed.hostname.toLowerCase() };
  };
}

function laneQualificationOptions({ env = process.env, projectId, dbPort, spawn = spawnSync } = {}) {
  return {
    env,
    // One job per JIT VM: no other lane can hold this stack, so the shared-host lock/ownership checks do not apply.
    acquireLock: async () => ({ release: async () => {} }),
    identify: plainCliDatabaseIdentity({ projectId, dbPort, spawn }),
    inspect: () => ({ pending_intent: false }),
    assertMutation: () => {},
  };
}

async function runFullPgtap({
  env = process.env, projectId, dbPort, spawn = spawnSync,
  qualify = runner.withFullLocalQualification, runSuite = runner.runSuite,
  resolveCandidates = runner.resolveDatabaseUrlCandidates,
} = {}) {
  const candidates = await resolveCandidates(env);
  return qualify(candidates, () => runSuite(candidates, true, env), laneQualificationOptions({ env, projectId, dbPort, spawn }));
}

if (require.main === module) {
  runFullPgtap({ projectId: process.env.DB_LOCAL_PROJECT_ID, dbPort: process.env.DB_LOCAL_DB_PORT }).catch((error) => {
    console.error(error?.message || error);
    process.exit(Number.isInteger(error?.exitCode) && error.exitCode > 0 ? error.exitCode : 1);
  });
}

module.exports = { plainCliDatabaseIdentity, laneQualificationOptions, runFullPgtap };
