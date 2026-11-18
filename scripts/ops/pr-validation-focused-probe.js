#!/usr/bin/env node
/* eslint-disable no-console */
const { canonicalJson, compareAscii, sha256 } = require('./pr-validation-focused-common');

function normalizeRows(rows) {
  return [...(rows || [])].map((row) => {
    const out = {};
    for (const key of Object.keys(row || {}).sort(compareAscii)) {
      const value = row[key];
      out[key] = value instanceof Date ? value.toISOString() : (typeof value === 'bigint' ? String(value) : value);
    }
    return out;
  }).sort((left, right) => compareAscii(canonicalJson(left), canonicalJson(right)));
}

function buildContaminationSnapshot(value = {}) {
  const snapshot = {
    schema: 'pr-validation-session.focused-contamination-snapshot.v1',
    capturedAt: String(value.capturedAt || new Date().toISOString()),
    connection: {
      database: String(value.connection?.database || ''),
      host: String(value.connection?.host || ''),
      port: Number(value.connection?.port || 0),
      username: String(value.connection?.username || ''),
    },
    sequences: normalizeRows(value.sequences),
    locks: normalizeRows(value.locks),
    backgroundActivity: normalizeRows(value.backgroundActivity),
  };
  snapshot.stateDigest = sha256(canonicalJson({
    connection: snapshot.connection,
    sequences: snapshot.sequences,
    locks: snapshot.locks,
    backgroundActivity: snapshot.backgroundActivity,
  }));
  snapshot.counts = {
    sequences: snapshot.sequences.length,
    locks: snapshot.locks.length,
    backgroundActivity: snapshot.backgroundActivity.length,
  };
  return snapshot;
}

function countChangedRows(beforeRows, afterRows) {
  const before = new Set(normalizeRows(beforeRows).map(canonicalJson));
  const after = new Set(normalizeRows(afterRows).map(canonicalJson));
  let count = 0;
  for (const row of before) if (!after.has(row)) count += 1;
  for (const row of after) if (!before.has(row)) count += 1;
  return count;
}

function diffRowsByIdentity(beforeRows, afterRows, identityKeys, label) {
  function indexRows(rows) {
    const indexed = new Map();
    for (const row of normalizeRows(rows)) {
      const identity = {};
      for (const key of identityKeys) identity[key] = row[key] ?? null;
      const key = canonicalJson(identity);
      if (indexed.has(key)) throw new Error(`Focused contamination ${label} rows contain a duplicate identity.`);
      indexed.set(key, { identity, row });
    }
    return indexed;
  }

  const before = indexRows(beforeRows);
  const after = indexRows(afterRows);
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort(compareAscii)
    .flatMap((key) => {
      const beforeRow = before.get(key)?.row || null;
      const afterRow = after.get(key)?.row || null;
      if (canonicalJson(beforeRow) === canonicalJson(afterRow)) return [];
      return [{
        identity: before.get(key)?.identity || after.get(key).identity,
        before: beforeRow,
        after: afterRow,
      }];
    });
}

function compareContaminationSnapshots(before, after, options = {}) {
  if (before?.schema !== 'pr-validation-session.focused-contamination-snapshot.v1'
    || after?.schema !== 'pr-validation-session.focused-contamination-snapshot.v1') {
    throw new Error('Focused contamination snapshots use an unsupported schema.');
  }
  if (canonicalJson(before.connection) !== canonicalJson(after.connection)) {
    throw new Error('Focused contamination snapshots are not bound to the same database connection.');
  }
  const sequenceDeltas = diffRowsByIdentity(
    before.sequences,
    after.sequences,
    ['schemaname', 'sequencename'],
    'sequence',
  );
  const lockDeltas = diffRowsByIdentity(
    before.locks,
    after.locks,
    ['locktype', 'database', 'relation', 'mode', 'granted', 'fastpath'],
    'lock',
  );
  const backgroundActivityDeltas = diffRowsByIdentity(
    before.backgroundActivity,
    after.backgroundActivity,
    ['backend_type', 'username', 'application_name', 'client_addr'],
    'background activity',
  );
  const sequenceDeltaCount = sequenceDeltas.length;
  const lockResidueCount = lockDeltas.length;
  const backgroundActivityDeltaCount = backgroundActivityDeltas.length;
  const sharedRowDeltaCount = Number(options.sharedRowDeltaCount || 0);
  const stable = before.stateDigest === after.stateDigest
    && sequenceDeltaCount === 0
    && sharedRowDeltaCount === 0
    && lockResidueCount === 0
    && backgroundActivityDeltaCount === 0;
  return {
    checkedAt: String(options.checkedAt || after.capturedAt),
    beforeDigest: before.stateDigest,
    afterDigest: after.stateDigest,
    stable,
    sequenceDeltaCount,
    sequenceDeltas,
    sharedRowDeltaCount,
    lockResidueCount,
    lockDeltas,
    backgroundActivityDeltaCount,
    backgroundActivityDeltas,
  };
}

const DEFAULT_BACKGROUND_QUIESCENCE_TIMEOUT_MS = 12000;
const DEFAULT_BACKGROUND_QUIESCENCE_INTERVAL_MS = 1000;
const DEFAULT_PROBE_CAPTURE_TIMEOUT_MS = 10000;
const CONTAMINATION_DEADLINE_CODE = 'FOCUSED_CONTAMINATION_DEADLINE_EXCEEDED';
const CANONICAL_LOOPBACK_ADDRESSES = new Set([
  '127.0.0.1',
  '127.0.0.1/32',
  '::1',
  '::1/128',
]);

function resolveBoundedPositiveInteger(value, fallback, label, maximum) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error(`Focused contamination ${label} must be a bounded positive integer.`);
  }
  return resolved;
}

function contaminationDeadlineError(label) {
  const error = new Error(`Focused contamination ${label} exceeded its absolute deadline.`);
  error.code = CONTAMINATION_DEADLINE_CODE;
  return error;
}

function remainingDeadlineMs(deadlineAt, now) {
  return Math.max(0, Math.floor(deadlineAt - now()));
}

async function runWithinDeadline(task, options = {}) {
  const now = options.now || Date.now;
  const remainingMs = remainingDeadlineMs(options.deadlineAt, now);
  if (remainingMs <= 0) throw contaminationDeadlineError(options.label || 'operation');
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(contaminationDeadlineError(options.label || 'operation')), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hasMeasuredPersistentContamination(comparison) {
  // Rollback-verified shared-row writes are statically serial-quarantined before this post-run probe; no dynamic shared-row measurement is claimed here.
  return Number(comparison?.sequenceDeltaCount || 0) > 0
    || Number(comparison?.lockResidueCount || 0) > 0;
}

function isPgCronActivity(row) {
  return String(row?.application_name || '') === 'pg_cron';
}

function hasPgCronBackgroundDelta(comparison) {
  return (comparison?.backgroundActivityDeltas || []).some((delta) => (
    isPgCronActivity(delta.before) || isPgCronActivity(delta.after)
  ));
}

function isCanonicalLoopbackPgCronActivity(row, snapshot) {
  return isPgCronActivity(row)
    && String(row.backend_type || '') === 'client backend'
    && String(row.username || '') === String(snapshot?.connection?.username || '')
    && CANONICAL_LOOPBACK_ADDRESSES.has(String(row.client_addr || ''))
    && Number.isSafeInteger(Number(row.connection_count))
    && Number(row.connection_count) > 0;
}

function snapshotWithoutPgCron(snapshot) {
  return buildContaminationSnapshot({
    capturedAt: snapshot.capturedAt,
    connection: snapshot.connection,
    sequences: snapshot.sequences,
    locks: snapshot.locks,
    backgroundActivity: snapshot.backgroundActivity.filter((row) => !isPgCronActivity(row)),
  });
}

function pgCronBaselineFailure(snapshot, reason) {
  return {
    accepted: false,
    reason,
    snapshot: null,
    comparison: compareContaminationSnapshots(snapshotWithoutPgCron(snapshot), snapshot),
  };
}

function isCanonicalPgCronDelta(delta, before, after) {
  const rows = [delta?.before, delta?.after].filter(Boolean);
  return rows.length > 0 && rows.every((row) => (
    isCanonicalLoopbackPgCronActivity(row, row === delta.before ? before : after)
  ));
}

async function establishContaminationBaseline(options = {}) {
  const captureSnapshot = options.captureSnapshot;
  if (typeof captureSnapshot !== 'function') {
    throw new Error('Focused contamination baseline requires a snapshot capture function.');
  }
  const timeoutMs = resolveBoundedPositiveInteger(
    options.timeoutMs,
    DEFAULT_BACKGROUND_QUIESCENCE_TIMEOUT_MS,
    'baseline timeout',
    60000,
  );
  const intervalMs = resolveBoundedPositiveInteger(
    options.intervalMs,
    DEFAULT_BACKGROUND_QUIESCENCE_INTERVAL_MS,
    'baseline interval',
    timeoutMs,
  );
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now || Date.now;
  if (typeof sleep !== 'function' || typeof now !== 'function') {
    throw new Error('Focused contamination baseline requires clock and sleep functions.');
  }
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new Error('Focused contamination baseline clock is invalid.');
  const deadlineAt = startedAt + timeoutMs;
  const maximumSamples = Math.ceil(timeoutMs / intervalMs) + 1;

  async function captureBeforeDeadline() {
    return runWithinDeadline(() => captureSnapshot({
      deadlineAt,
      remainingMs: remainingDeadlineMs(deadlineAt, now),
      now,
    }), { deadlineAt, now, label: 'baseline snapshot capture' });
  }

  let previous;
  try {
    previous = await captureBeforeDeadline();
    compareContaminationSnapshots(previous, previous);
  } catch (error) {
    throw error;
  }
  let captureCount = 1;
  let safeCaptureStreak = 0;
  let lastUnsafe = null;

  const initialPgCron = previous.backgroundActivity.filter(isPgCronActivity);
  if (initialPgCron.some((row) => !isCanonicalLoopbackPgCronActivity(row, previous))) {
    return { ...pgCronBaselineFailure(previous, 'noncanonical_pg_cron_activity'), captureCount };
  }
  if (initialPgCron.length > 0) {
    lastUnsafe = pgCronBaselineFailure(previous, 'canonical_pg_cron_activity_present');
  } else {
    safeCaptureStreak = 1;
  }

  for (let sample = 1; sample < maximumSamples; sample += 1) {
    const remainingMs = remainingDeadlineMs(deadlineAt, now);
    if (remainingMs <= 0) break;
    try {
      await runWithinDeadline(() => sleep(Math.min(intervalMs, remainingMs)), {
        deadlineAt,
        now,
        label: 'baseline interval',
      });
    } catch (error) {
      if (error?.code === CONTAMINATION_DEADLINE_CODE && lastUnsafe) {
        return { ...lastUnsafe, captureCount };
      }
      throw error;
    }
    if (remainingDeadlineMs(deadlineAt, now) <= 0) break;

    let current;
    try {
      current = await captureBeforeDeadline();
      captureCount += 1;
    } catch (error) {
      if (error?.code === CONTAMINATION_DEADLINE_CODE && lastUnsafe) {
        return { ...lastUnsafe, captureCount };
      }
      throw error;
    }
    const comparison = compareContaminationSnapshots(previous, current);
    if (hasMeasuredPersistentContamination(comparison)) {
      return {
        accepted: false,
        reason: 'sequence_or_lock_baseline_drift',
        snapshot: null,
        comparison,
        captureCount,
      };
    }
    const currentPgCron = current.backgroundActivity.filter(isPgCronActivity);
    if (currentPgCron.some((row) => !isCanonicalLoopbackPgCronActivity(row, current))) {
      return { ...pgCronBaselineFailure(current, 'noncanonical_pg_cron_activity'), captureCount };
    }
    if (comparison.backgroundActivityDeltaCount > 0
      && !comparison.backgroundActivityDeltas.every((delta) => isCanonicalPgCronDelta(delta, previous, current))) {
      return {
        accepted: false,
        reason: 'noncanonical_background_baseline_drift',
        snapshot: null,
        comparison,
        captureCount,
      };
    }
    if (currentPgCron.length > 0) {
      lastUnsafe = pgCronBaselineFailure(current, 'canonical_pg_cron_activity_present');
      safeCaptureStreak = 0;
    } else if (comparison.stable === true && safeCaptureStreak > 0) {
      safeCaptureStreak += 1;
    } else {
      safeCaptureStreak = 1;
    }
    if (safeCaptureStreak >= 2) {
      return {
        accepted: true,
        reason: 'consecutive_stable_baseline_captures',
        snapshot: current,
        comparison: compareContaminationSnapshots(current, current),
        captureCount,
      };
    }
    previous = current;
  }

  if (lastUnsafe) return { ...lastUnsafe, captureCount };
  throw contaminationDeadlineError('baseline stabilization');
}

async function confirmBackgroundOnlyContaminationQuiescence(options = {}) {
  const before = options.before;
  const captureSnapshot = options.captureSnapshot;
  if (typeof captureSnapshot !== 'function') {
    throw new Error('Focused contamination quiescence confirmation requires a snapshot capture function.');
  }
  const timeoutMs = resolveBoundedPositiveInteger(
    options.timeoutMs,
    DEFAULT_BACKGROUND_QUIESCENCE_TIMEOUT_MS,
    'quiescence timeout',
    60000,
  );
  const intervalMs = resolveBoundedPositiveInteger(
    options.intervalMs,
    DEFAULT_BACKGROUND_QUIESCENCE_INTERVAL_MS,
    'quiescence interval',
    timeoutMs,
  );
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now || Date.now;
  if (typeof sleep !== 'function' || typeof now !== 'function') {
    throw new Error('Focused contamination quiescence confirmation requires clock and sleep functions.');
  }
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new Error('Focused contamination quiescence clock is invalid.');
  const deadlineAt = startedAt + timeoutMs;
  const maximumRetrySamples = Math.ceil(timeoutMs / intervalMs);

  async function captureBeforeDeadline() {
    return runWithinDeadline(() => captureSnapshot({
      deadlineAt,
      remainingMs: remainingDeadlineMs(deadlineAt, now),
      now,
    }), { deadlineAt, now, label: 'snapshot capture' });
  }

  let lastUnstableComparison = null;
  let comparison;
  try {
    comparison = compareContaminationSnapshots(before, await captureBeforeDeadline());
  } catch (error) {
    if (error?.code === CONTAMINATION_DEADLINE_CODE && lastUnstableComparison) return lastUnstableComparison;
    throw error;
  }
  if (comparison.stable === true || hasMeasuredPersistentContamination(comparison)
    || hasPgCronBackgroundDelta(comparison)) return comparison;
  if (Number(comparison.backgroundActivityDeltaCount || 0) === 0) return comparison;

  lastUnstableComparison = comparison;
  let stableStreak = 0;
  for (let sample = 0; sample < maximumRetrySamples; sample += 1) {
    const remainingMs = remainingDeadlineMs(deadlineAt, now);
    if (remainingMs <= 0) return lastUnstableComparison;
    try {
      await runWithinDeadline(() => sleep(Math.min(intervalMs, remainingMs)), {
        deadlineAt, now, label: 'quiescence interval',
      });
    } catch (error) {
      if (error?.code === CONTAMINATION_DEADLINE_CODE) return lastUnstableComparison;
      throw error;
    }
    if (remainingDeadlineMs(deadlineAt, now) <= 0) return lastUnstableComparison;
    try {
      comparison = compareContaminationSnapshots(before, await captureBeforeDeadline());
    } catch (error) {
      if (error?.code === CONTAMINATION_DEADLINE_CODE) return lastUnstableComparison;
      throw error;
    }
    if (comparison.stable === true) {
      stableStreak += 1;
      if (stableStreak >= 2) return comparison;
      continue;
    }
    stableStreak = 0;
    if (hasMeasuredPersistentContamination(comparison) || hasPgCronBackgroundDelta(comparison)) return comparison;
    if (Number(comparison.backgroundActivityDeltaCount || 0) === 0) return comparison;
    lastUnstableComparison = comparison;
  }
  return lastUnstableComparison;
}
const PROBE_SQL = Object.freeze({
  identity: 'select current_database() as database, inet_server_addr()::text as host, inet_server_port() as port, current_user as username',
  sequences: `select pgs.schemaname, pgs.sequencename, coalesce(pgs.last_value::text, '') as last_value
    from pg_sequences pgs
    join pg_namespace n on n.nspname = pgs.schemaname
    join pg_class c on c.relnamespace = n.oid and c.relname = pgs.sequencename and c.relkind = 'S'
    where not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_class'::regclass and d.objid = c.oid
        and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e'
    )
    order by pgs.schemaname, pgs.sequencename`,
  locks: `select locktype, database::text, relation::text, mode, granted, fastpath,
      count(*)::integer as lock_count
    from pg_locks
    where pid <> pg_backend_pid() and granted = false
    group by locktype, database, relation, mode, granted, fastpath
    order by locktype, database, relation, mode, granted, fastpath`,
  activity: `select backend_type, coalesce(usename, '') as username,
      coalesce(application_name, '') as application_name,
      coalesce(client_addr::text, '') as client_addr,
      count(*)::integer as connection_count
    from pg_stat_activity
    where pid <> pg_backend_pid() and datname = current_database()
    group by backend_type, usename, application_name, client_addr
    order by backend_type, username, application_name, client_addr`,
});

async function captureContaminationSnapshot(options = {}) {
  const connection = options.connection;
  if (!connection?.connectionString) {
    throw new Error('Focused contamination probe requires an in-memory connection string.');
  }
  const expectedPort = Number(options.expectedPort || 0);
  const parsed = new URL(connection.connectionString);
  if (Number(parsed.port || 5432) !== expectedPort) {
    throw new Error('Focused contamination probe database port does not match the owner-bound lease.');
  }
  const now = options.now || Date.now;
  const initialBudgetMs = resolveBoundedPositiveInteger(
    options.remainingMs,
    DEFAULT_PROBE_CAPTURE_TIMEOUT_MS,
    'snapshot capture timeout',
    60000,
  );
  const deadlineAt = Number(options.deadlineAt == null ? now() + initialBudgetMs : options.deadlineAt);
  if (!Number.isFinite(deadlineAt) || remainingDeadlineMs(deadlineAt, now) <= 0) {
    throw contaminationDeadlineError('snapshot capture');
  }
  const Client = options.Client || require('pg').Client;
  const client = new Client({
    connectionString: connection.connectionString,
    connectionTimeoutMillis: remainingDeadlineMs(deadlineAt, now),
    query_timeout: remainingDeadlineMs(deadlineAt, now),
    statement_timeout: remainingDeadlineMs(deadlineAt, now),
  });
  const runProbeStep = (label, task) => runWithinDeadline(task, { deadlineAt, now, label });
  const query = (label, text) => runProbeStep(label, () => client.query({
    text,
    query_timeout: remainingDeadlineMs(deadlineAt, now),
  }));
  try {
    await runProbeStep('database connect', () => client.connect());
    const identity = await query('identity query', PROBE_SQL.identity);
    const sequences = await query('sequence query', PROBE_SQL.sequences);
    const locks = await query('lock query', PROBE_SQL.locks);
    const activity = await query('background activity query', PROBE_SQL.activity);
    return buildContaminationSnapshot({
      capturedAt: new Date(now()).toISOString(),
      connection: identity.rows[0],
      sequences: sequences.rows,
      locks: locks.rows,
      backgroundActivity: activity.rows,
    });
  } finally {
    try {
      const cleanupDeadlineAt = Math.max(deadlineAt, now() + 250);
      await runWithinDeadline(() => client.end(), {
        deadlineAt: cleanupDeadlineAt,
        now,
        label: 'database cleanup',
      });
    } catch (_) {
      // The owner-bound lifecycle guard records close uncertainty.
    }
  }
}
module.exports = {
  PROBE_SQL,
  buildContaminationSnapshot,
  captureContaminationSnapshot,
  compareContaminationSnapshots,
  confirmBackgroundOnlyContaminationQuiescence,
  establishContaminationBaseline,
  countChangedRows,
  diffRowsByIdentity,
};
