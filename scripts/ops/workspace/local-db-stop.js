#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const { computeWorkspaceId } = require('./id');

function getWorkspaceId() {
  return process.env.WORKSPACE_NAME || computeWorkspaceId();
}

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'inherit' });
}

(function main() {
  const wk = getWorkspaceId();
  const containerName = `masarx_db_${wk}`.replace(/[^a-zA-Z0-9_.-]/g, '_');

  let res = run('docker', ['stop', containerName]);
  if (res.status !== 0) {
    console.warn(`[workspace/local-db-stop] docker stop exited with ${res.status}`);
  }
  res = run('docker', ['rm', containerName]);
  if (res.status !== 0) {
    console.warn(`[workspace/local-db-stop] docker rm exited with ${res.status}`);
  }
})();
