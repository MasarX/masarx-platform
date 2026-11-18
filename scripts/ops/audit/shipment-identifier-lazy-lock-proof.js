#!/usr/bin/env node
/* eslint-disable no-console */

const crypto = require('crypto');
const { Client } = require('pg');
const { loadEnv } = require('../../utils/load-env');

loadEnv();

const CORRELATION_RELATIONS = [
  'public.workflow_runs',
  'public.decision_log',
  'public.domain_events',
  'public.outbound_calls',
];
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

function timeoutMs(env = process.env) {
  const value = Number(env.SHIPMENT_IDENTIFIER_LAZY_LOCK_TIMEOUT_MS || 1500);
  if (!Number.isSafeInteger(value) || value < 250 || value > 10000) {
    throw new Error('SHIPMENT_IDENTIFIER_LAZY_LOCK_TIMEOUT_MS must be an integer from 250 through 10000');
  }
  return value;
}

function isObservedLockBlock(row, blockerPid) {
  return row?.wait_event_type === 'Lock'
    && Array.isArray(row.blocker_pids)
    && row.blocker_pids.map(Number).includes(Number(blockerPid));
}

function resolveLocalEphemeralConnectionString(env = process.env) {
  if (String(env.SHIPMENT_IDENTIFIER_LAZY_LOCK_ALLOW || '') !== '1'
    || String(env.SHIPMENT_IDENTIFIER_LAZY_LOCK_ENVIRONMENT || '') !== 'local_ephemeral') {
    throw new Error(
      'Lazy-lock proof requires SHIPMENT_IDENTIFIER_LAZY_LOCK_ALLOW=1 and SHIPMENT_IDENTIFIER_LAZY_LOCK_ENVIRONMENT=local_ephemeral',
    );
  }
  const connectionString = String(env.DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('DATABASE_URL is required');
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('Lazy-lock proof requires a valid PostgreSQL connection URL');
  }
  const hostname = parsed.hostname.toLowerCase();
  // objectives:allow LOCALHOST Justification: destructive lazy-lock proof is fail-closed to an explicitly local ephemeral database.
  if (!['localhost', '127.0.0.1'].includes(hostname)) {
    throw new Error('Lazy-lock proof is restricted to a loopback local/ephemeral database');
  }
  const expectedDatabase = String(env.SHIPMENT_IDENTIFIER_LAZY_LOCK_EXPECTED_DATABASE || '').trim();
  const expectedHost = String(env.SHIPMENT_IDENTIFIER_LAZY_LOCK_EXPECTED_HOST || '').trim().toLowerCase();
  const expectedPort = String(env.SHIPMENT_IDENTIFIER_LAZY_LOCK_EXPECTED_PORT || '').trim();
  const urlDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!expectedDatabase || !expectedHost || !expectedPort ||
      hostname !== expectedHost || String(parsed.port || '5432') !== expectedPort ||
      urlDatabase !== expectedDatabase) {
    throw new Error('Lazy-lock proof DATABASE_URL is not bound to the expected workspace database endpoint');
  }
  return connectionString;
}

async function setAuthenticated(client, userId, statementTimeoutMs) {
  await client.query('BEGIN');
  await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
  await client.query('SELECT set_config(\'request.jwt.claim.sub\', $1, true)', [userId]);
  await client.query('SELECT set_config(\'request.jwt.claims\', $1, true)', [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
  await client.query('SET LOCAL ROLE authenticated');
}

async function createRepresentativeFixture(client) {
  const shipment = await client.query(
    `SELECT s.organization_id, s.tracking_number AS ordinary_query
       FROM public.shipments s
      WHERE NULLIF(btrim(s.tracking_number), '') IS NOT NULL
        AND btrim(s.tracking_number) !~* $1
      ORDER BY s.created_at DESC NULLS LAST
      LIMIT 1`,
    [UUID_PATTERN],
  );
  if (!shipment.rows[0]) {
    throw new Error('No ordinary shipment identifier is available for a disposable Example Person fixture');
  }

  const userId = crypto.randomUUID();
  const organizationId = shipment.rows[0].organization_id;
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO public.users (
         id, organization_id, email, full_name, user_type, access_scope_type
       )
      VALUES ($1::uuid, $2::uuid, $3, 'Shipment identifier lock proof', 'ops_admin', 'tenant')`,
      [userId, organizationId, `shipment-identifier-lock-${userId}@example.invalid`],
    );
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  }

  return {
    user_id: userId,
    ordinary_query: shipment.rows[0].ordinary_query,
    cleanup_user_id: userId,
  };
}

async function cleanupRepresentativeFixture(client, representative) {
  if (!representative?.cleanup_user_id) return;
  await client.query('BEGIN');
  try {
    await client.query(
      'DELETE FROM public.users WHERE id = $1::uuid',
      [representative.cleanup_user_id],
    );
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  }
}

async function discoverRepresentative(client, statementTimeoutMs) {
  const candidates = await client.query(
    `SELECT u.id::text AS user_id, s.tracking_number AS ordinary_query
       FROM public.users u
       JOIN public.shipments s
         ON (u.access_scope_type = 'tenant' AND s.organization_id = u.organization_id)
         OR (u.access_scope_type = 'client' AND s.client_id = u.access_scope_id)
         OR (u.access_scope_type = 'sender' AND s.sender_id = u.access_scope_id)
       WHERE NULLIF(btrim(s.tracking_number), '') IS NOT NULL
         AND btrim(s.tracking_number) !~* $1
      ORDER BY u.created_at DESC NULLS LAST, s.created_at DESC NULLS LAST
      LIMIT 100`,
    [UUID_PATTERN],
  );

  for (const candidate of candidates.rows) {
    try {
      await setAuthenticated(client, candidate.user_id, statementTimeoutMs);
      const capability = await client.query(
        `WITH caller_scope AS (
           SELECT public.current_user_scope_type() AS scope_type,
                  CASE
                    WHEN public.current_user_scope_type() = 'tenant'
                      THEN COALESCE(public.current_user_scope_id(), public.current_user_org_id())
                    ELSE public.current_user_scope_id()
                  END AS scope_id
         )
         SELECT public.user_has_capability_v1(
                  'shipments.read', scope_type, scope_id
                ) AS can_shipments,
                (
                  public.user_has_capability_v1(
                    'audit_log.read', scope_type, scope_id
                  ) OR public.user_has_capability_v1(
                    'requests.read', scope_type, scope_id
                  )
                ) AS can_correlations
           FROM caller_scope`,
      );
      const result = await client.query(
        'SELECT public.ui_search_shipment_identifier_ids_v1(ARRAY[$1::text]) AS ids',
        [candidate.ordinary_query],
      );
      await client.query('ROLLBACK');
      if (capability.rows[0]?.can_shipments && capability.rows[0]?.can_correlations && result.rows[0]?.ids?.length > 0) {
        return candidate;
      }
    } catch {
      try { await client.query('ROLLBACK'); } catch {}
    }
  }

  const fixture = await createRepresentativeFixture(client);
  try {
    await setAuthenticated(client, fixture.user_id, statementTimeoutMs);
    const capability = await client.query(
      `WITH caller_scope AS (
         SELECT public.current_user_scope_type() AS scope_type,
                COALESCE(public.current_user_scope_id(), public.current_user_org_id()) AS scope_id
       )
       SELECT public.user_has_capability_v1(
                'shipments.read', scope_type, scope_id
              ) AS can_shipments,
              (
                public.user_has_capability_v1('audit_log.read', scope_type, scope_id)
                OR public.user_has_capability_v1('requests.read', scope_type, scope_id)
              ) AS can_correlations
         FROM caller_scope`,
    );
    const result = await client.query(
      'SELECT public.ui_search_shipment_identifier_ids_v1(ARRAY[$1::text]) AS ids',
      [fixture.ordinary_query],
    );
    await client.query('ROLLBACK');
    if (capability.rows[0]?.can_shipments
      && capability.rows[0]?.can_correlations
      && result.rows[0]?.ids?.length > 0) {
      return fixture;
    }
  } catch {
    try { await client.query('ROLLBACK'); } catch {}
  }
  await cleanupRepresentativeFixture(client, fixture);
  throw new Error('No representative authorized user + ordinary shipment identifier fixture was found');
}

async function runProof({ env = process.env, clientFactory = (config) => new Client(config) } = {}) {
  const connectionString = resolveLocalEphemeralConnectionString(env);
  const shortTimeout = timeoutMs(env);
  const blocker = clientFactory({ connectionString, application_name: 'shipment-identifier-lazy-lock:blocker' });
  const search = clientFactory({ connectionString, application_name: 'shipment-identifier-lazy-lock:search' });
  const observer = clientFactory({ connectionString, application_name: 'shipment-identifier-lazy-lock:observer' });
  let blockerConnected = false;
  let searchConnected = false;
  let representative = null;
  try {
    await blocker.connect();
    blockerConnected = true;
    await search.connect();
    searchConnected = true;
    await observer.connect();
    const expectedDatabase = String(env.SHIPMENT_IDENTIFIER_LAZY_LOCK_EXPECTED_DATABASE || '').trim();
    const identities = await Promise.all(
      [blocker, search, observer].map((client) => client.query('SELECT current_database() AS database_name')),
    );
    if (identities.some((result) => result.rows[0]?.database_name !== expectedDatabase)) {
      throw new Error('Lazy-lock proof connected to an unexpected workspace database');
    }
    representative = await discoverRepresentative(search, Math.max(shortTimeout * 4, 5000));
    await blocker.query('BEGIN');
    const blockerPid = Number((await blocker.query('SELECT pg_backend_pid()::int AS pid')).rows[0]?.pid || 0);
    await blocker.query(`SET LOCAL lock_timeout = '${Math.max(shortTimeout * 4, 5000)}ms'`);
    await blocker.query(`LOCK TABLE ${CORRELATION_RELATIONS.join(', ')} IN ACCESS EXCLUSIVE MODE`);

    await setAuthenticated(search, representative.user_id, shortTimeout);
    const ordinaryStarted = Date.now();
    const ordinary = await search.query(
      'SELECT public.ui_search_shipment_identifier_ids_v1(ARRAY[$1::text]) AS ids',
      [representative.ordinary_query],
    );
    const ordinaryElapsedMs = Date.now() - ordinaryStarted;
    await search.query('ROLLBACK');
    if (!Array.isArray(ordinary.rows[0]?.ids) || ordinary.rows[0].ids.length === 0) {
      throw new Error('Representative ordinary identifier did not resolve while correlation relations were locked');
    }

    const uuidSentinel = crypto.randomUUID();
    await setAuthenticated(search, representative.user_id, shortTimeout);
    const searchPid = Number((await search.query('SELECT pg_backend_pid()::int AS pid')).rows[0]?.pid || 0);
    const uuidStarted = Date.now();
    let uuidError = null;
    let uuidSettled = false;
    const uuidQuery = search
      .query('SELECT public.ui_search_shipment_identifier_ids_v1(ARRAY[$1::text])', [uuidSentinel])
      .catch((error) => { uuidError = error; })
      .finally(() => { uuidSettled = true; });
    let observedBlock = null;
    const observeDeadline = Date.now() + shortTimeout;
    while (!uuidSettled && Date.now() < observeDeadline) {
      const wait = await observer.query(
        `SELECT wait_event_type, wait_event, pg_blocking_pids($1::int) AS blocker_pids
           FROM pg_stat_activity
          WHERE pid = $1::int`,
        [searchPid],
      );
      const row = wait.rows[0];
      if (isObservedLockBlock(row, blockerPid)) {
        observedBlock = row;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await uuidQuery;
    const uuidElapsedMs = Date.now() - uuidStarted;
    await search.query('ROLLBACK');
    if (!uuidError || uuidError.code !== '57014') {
      throw new Error(
        `UUID sentinel did not block on correlation relations (expected SQLSTATE 57014, got ${uuidError?.code || 'success'})`,
      );
    }
    if (!observedBlock) {
      throw new Error('UUID timeout was not proven to wait on the blocker session relation locks');
    }

    return {
      ordinary_query: representative.ordinary_query,
      uuid_sentinel: uuidSentinel,
      ordinary_elapsed_ms: ordinaryElapsedMs,
      uuid_elapsed_ms: uuidElapsedMs,
      timeout_ms: shortTimeout,
      blocker_pid: blockerPid,
      search_pid: searchPid,
      observed_wait_event: observedBlock.wait_event,
      locked_relations: CORRELATION_RELATIONS,
    };
  } finally {
    if (blockerConnected) {
      try { await blocker.query('ROLLBACK'); } catch {}
    }
    if (searchConnected) {
      try { await search.query('ROLLBACK'); } catch {}
    }
    try {
      if (searchConnected) await cleanupRepresentativeFixture(search, representative);
    } finally {
      await Promise.allSettled([blocker.end(), search.end(), observer.end()]);
    }
  }
}

if (require.main === module) {
  runProof()
    .then((result) => console.log(`[shipment-identifier-lazy-lock] passed ${JSON.stringify(result)}`))
    .catch((error) => {
      console.error(`[shipment-identifier-lazy-lock] failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  CORRELATION_RELATIONS,
  cleanupRepresentativeFixture,
  createRepresentativeFixture,
  discoverRepresentative,
  isObservedLockBlock,
  resolveLocalEphemeralConnectionString,
  runProof,
  timeoutMs,
};
