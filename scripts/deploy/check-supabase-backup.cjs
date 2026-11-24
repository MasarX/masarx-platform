'use strict';

const { readFileSync } = require('node:fs');

function latestBackup(inventory, now, maxAgeHours) {
  if (!Array.isArray(inventory?.backups)) throw new Error('invalid backup inventory');

  let newest = null;
  for (const backup of inventory.backups) {
    if (backup?.status !== 'COMPLETED') continue;
    const recordedAt = backup.inserted_at;
    const timestamp = Date.parse(recordedAt);
    if (!Number.isSafeInteger(backup.id) || backup.id <= 0 || typeof recordedAt !== 'string' ||
        typeof backup.is_physical_backup !== 'boolean' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|\+00:00)$/.test(recordedAt) ||
        !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== recordedAt.slice(0, 19) ||
        timestamp > now) {
      throw new Error('invalid completed backup record');
    }
    if (newest === null || timestamp > newest) newest = timestamp;
  }
  if (newest === null || now - newest > maxAgeHours * 3_600_000) {
    throw new Error('no fresh completed backup');
  }
  return new Date(newest).toISOString();
}

async function checkBackup({ projectRef, token, maxAgeHours, now = Date.now(), request = fetch }) {
  if (!/^[a-z]{20}$/.test(projectRef) || typeof token !== 'string' || !/^\S+$/.test(token) ||
      !Number.isSafeInteger(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error('invalid backup check configuration');
  }
  let response;
  try {
    response = await request(`https://api.supabase.com/v1/projects/${projectRef}/database/backups`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('backup inventory request failed');
  }
  if (!response.ok) throw new Error(`backup inventory HTTP ${response.status}`);
  const inventory = await response.json().catch(() => { throw new Error('invalid backup inventory'); });
  return latestBackup(inventory, now, maxAgeHours);
}

if (require.main === module) {
  Promise.resolve().then(() => checkBackup({
    projectRef: process.env.SUPABASE_PROJECT_REF,
    token: readFileSync(0, 'utf8').trim(),
    maxAgeHours: Number(process.env.BACKUP_MAX_AGE_HOURS),
  })).then(timestamp => {
    console.log(`backup_check=pass backup_at=${timestamp}`);
  }).catch(error => {
    console.error(`backup_check=fail reason=${error.code ? 'cannot read backup credentials' : error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { checkBackup, latestBackup };
