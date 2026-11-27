const { randomBytes, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const supabase = require('../ops/workspace/supabase-api');
const { buildSupabaseProjectUrl } = require('../ops/workspace/preview-project');
const { decodeJwtPayload } = require('../utils/jwt');

const requestTimeoutMs = 30_000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

class FixtureError extends Error {
  constructor(code) {
    super('DEV synthetic fixture failed');
    this.code = code;
  }
}

function requireFixture(condition, code) {
  if (!condition) throw new FixtureError(code);
}

function mask(value, code) {
  requireFixture(typeof value === 'string' && /^[\x21-\x7e]+$/.test(value), code);
  console.log(`::add-mask::${value.replaceAll('%', '%25')}`);
}

function request(url, headers, method, body) {
  return fetch(url, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

async function jsonRequest(url, headers, code, method = 'GET', body) {
  try {
    const response = await request(url, headers, method, body);
    if (response.ok && method !== 'DELETE') return await response.json();
    await response.body?.cancel();
    if (response.ok) return;
  } catch {
    // Provider errors can contain credentials, hosts, or fixture values.
  }
  throw new FixtureError(code);
}

async function transaction(db, work) {
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL statement_timeout = '20s'");
    const result = await work();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function seedDatabase(db, fixture, userId, { seedUser, seedExtra }) {
  const { organizationId, clientId, shipmentId, tag, tracking } = fixture;
  await transaction(db, async () => {
    await db.query('INSERT INTO public.organizations (id, name, slug) VALUES ($1, $2, $2)', [organizationId, tag]);
    await db.query('INSERT INTO public.clients (id, organization_id, name, slug) VALUES ($1, $2, $3, $3)',
      [clientId, organizationId, tag]);
    await seedUser(db, fixture, userId);
    await db.query(`INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status)
      VALUES ($1, $2, $3, $4, 'delivery', 'pending')`, [shipmentId, organizationId, clientId, tracking]);
    await seedExtra?.(db, fixture, userId);
  });
}

async function cleanDatabase(db, fixture, extraRows) {
  const { organizationId, clientId, shipmentId, tag, email } = fixture;
  // Onboarding creates default senders, source configuration and settings under the new tenant.
  return transaction(db, async () => {
    const { rowCount } = await db.query('SELECT 1 FROM public.organizations WHERE id = $1 AND slug = $2 FOR UPDATE',
      [organizationId, tag]);
    const { rows } = await db.query(`SELECT id FROM public.senders WHERE client_id = $1
      UNION ALL SELECT id FROM public.webhook_sources WHERE organization_id = $2`, [clientId, organizationId]);
    const scopeIds = [organizationId, clientId, ...rows.map(({ id }) => id)];
    const owned = {
      ...extraRows?.(fixture),
      shipments: ['id = $1 AND organization_id = $2 AND client_id = $3', [shipmentId, organizationId, clientId]],
      users: ['organization_id = $1 AND email = $2', [organizationId, email]],
      settings_resolution_log: ['organization_id = $1', [organizationId]],
      decision_log: ['organization_id = $1', [organizationId]],
      settings_cache: ['settings_scope_id = ANY($1::uuid[])', [scopeIds]],
      settings: ['scope_id = ANY($1::uuid[])', [scopeIds]],
      settings_versions: ['scope_id = ANY($1::uuid[])', [scopeIds]],
      senders: ['client_id = $1', [clientId]],
      api_route_packs: ["scope_type = 'tenant' AND scope_id = $1", [organizationId]],
      webhook_sources: ['organization_id = $1', [organizationId]],
      providers: ['organization_id = $1', [organizationId]],
      mapping_configs: ['organization_id = $1', [organizationId]],
      clients: ['id = $1 AND organization_id = $2 AND slug = $3', [clientId, organizationId, tag]],
      organizations: ['id = $1 AND slug = $2', [organizationId, tag]],
    };
    if (rowCount === 1) {
      for (const [table, [where, params]] of Object.entries(owned)) {
        await db.query(`DELETE FROM public.${table} WHERE ${where}`, params);
      }
    }
    return owned;
  });
}

async function cleanup(db, fixture, authUsers, authHeaders, verifiedUserId, { marker, extraRows, exit }) {
  const errors = [];
  let owned;
  try {
    owned = await cleanDatabase(db, fixture, extraRows);
  } catch {
    errors.push(exit.cleanupDatabase);
  }
  try {
    let userId = verifiedUserId;
    if (!userId) {
      // A lost create response can still leave a committed Auth user.
      const { rows } = await db.query(`SELECT id FROM auth.users WHERE email = $1
        AND raw_app_meta_data->>$2::text = $3`, [fixture.email, marker, fixture.tag]);
      requireFixture(rows.length <= 1, exit.cleanupAuth);
      userId = rows[0]?.id;
    }
    if (userId) {
      requireFixture(uuid.test(userId), exit.cleanupAuth);
      await jsonRequest(`${authUsers}/${userId}`, authHeaders, exit.cleanupAuth, 'DELETE');
    }
  } catch {
    errors.push(exit.cleanupAuth);
  }
  try {
    requireFixture(owned, exit.cleanupVerify);
    const { rowCount } = await db.query('SELECT 1 FROM auth.users WHERE email = $1', [fixture.email]);
    requireFixture(rowCount === 0, exit.cleanupVerify);
    const tenantRows = ['organization_id = $1', [fixture.organizationId]];
    const verified = {
      ...owned,
      rbac_roles: tenantRows,
      rbac_role_permissions: tenantRows,
      rbac_user_role_assignments: tenantRows,
      canonical_cities: tenantRows,
      canonical_districts: tenantRows,
    };
    for (const [table, [where, params]] of Object.entries(verified)) {
      const remaining = await db.query(`SELECT 1 FROM public.${table} WHERE ${where} LIMIT 1`, params);
      requireFixture(remaining.rowCount === 0, exit.cleanupVerify);
    }
  } catch {
    errors.push(exit.cleanupVerify);
  }
  return errors;
}

async function withDevFixture(env, options, use) {
  const { prefix, marker, appMetadata, exit } = options;
  const projectRef = env.SUPABASE_PROJECT_REF;
  requireFixture(env.GITHUB_ACTIONS === 'true' && env.DEPLOY_ENV === 'dev' && env.GITHUB_REF === 'refs/heads/main'
    && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') && supabase.isCanonicalSupabaseProjectRef(projectRef)
    && env.GITHUB_STEP_SUMMARY && !env.SUPABASE_MGMT_URL, exit.configuration);
  mask(env.SUPABASE_ACCESS_TOKEN, exit.configuration);
  mask(env.SUPABASE_DB_PASSWORD, exit.configuration);
  mask(projectRef, exit.configuration);

  const projectUrl = buildSupabaseProjectUrl(projectRef);
  const management = `${supabase.getSupabaseMgmtUrl()}/v1/projects/${projectRef}`;
  const managementHeaders = { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` };
  const keys = await jsonRequest(`${management}/api-keys?reveal=true`, managementHeaders, exit.credentials);
  requireFixture(Array.isArray(keys), exit.credentials);
  const keyFor = (role) => {
    const matches = keys.filter((key) => key?.name === role);
    requireFixture(matches.length === 1, exit.credentials);
    const key = matches[0].api_key;
    mask(key, exit.credentials);
    const claims = decodeJwtPayload(key);
    requireFixture(claims?.role === role && claims.ref === projectRef, exit.credentials);
    return key;
  };
  const anonKey = keyFor('anon');
  const serviceKey = keyFor('service_role');
  const poolers = await jsonRequest(`${management}/config/database/pooler`, managementHeaders, exit.database);
  requireFixture(Array.isArray(poolers), exit.database);
  const primary = poolers.filter((pooler) => pooler?.database_type === 'PRIMARY');
  requireFixture(primary.length === 1 && supabase.isCanonicalSupabasePoolerHost(primary[0].db_host), exit.database);
  const db = new Client({
    host: primary[0].db_host, port: 5432, database: 'postgres', user: `postgres.${projectRef}`,
    password: env.SUPABASE_DB_PASSWORD, connectionTimeoutMillis: 8000, query_timeout: 25_000,
    ssl: { ca: readFileSync(join(__dirname, '../../config/certs/supabase-prod-ca-2021.crt')), rejectUnauthorized: true },
  });
  // A closed idle connection is also reported by the next query, where the stage can be logged safely.
  db.on('error', () => {});

  const tag = `${prefix}-${randomUUID()}`;
  const shipmentId = randomUUID();
  const fixture = {
    tag, email: `${tag}@example.invalid`, organizationId: randomUUID(), clientId: randomUUID(), shipmentId,
    tracking: shipmentId.replaceAll('-', '').toUpperCase(), boxId: randomUUID(), draftId: randomUUID(),
  };
  const { email } = fixture;
  const password = `${randomBytes(32).toString('base64url')}aA0!`;
  mask(email, exit.fixture);
  mask(password, exit.fixture);
  const authUsers = `${projectUrl}/auth/v1/admin/users`;
  const authHeaders = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
  const credentials = { email, password };
  let stage = exit.database;
  let createAttempted = false;
  let usingFixture = false;
  let userId;
  let result;
  let error;
  let cleanupErrors = [];
  try {
    await db.connect();
    stage = exit.authCreate;
    createAttempted = true;
    const created = await jsonRequest(authUsers, authHeaders, stage, 'POST', {
      ...credentials, email_confirm: true, app_metadata: { ...appMetadata, [marker]: tag },
    });
    const user = created?.user ?? created;
    requireFixture(uuid.test(user?.id) && user.email === email && user.role === 'authenticated'
      && user.app_metadata?.[marker] === tag, stage);
    userId = user.id;

    stage = exit.fixture;
    await seedDatabase(db, fixture, userId, options);
    usingFixture = true;
    const signIn = async (readSession = () => jsonRequest(
      `${projectUrl}/auth/v1/token?grant_type=password`, { apikey: anonKey }, exit.signIn, 'POST', credentials,
    )) => {
      try {
        const session = await readSession();
        const jwt = session?.access_token;
        mask(jwt, exit.signIn);
        mask(session?.refresh_token, exit.signIn);
        const claims = decodeJwtPayload(jwt);
        requireFixture(claims?.role === 'authenticated' && claims.sub === userId, exit.signIn);
        return session;
      } catch {
        throw new FixtureError(exit.signIn);
      }
    };
    result = await use({ ...fixture, credentials, projectUrl, anonKey, signIn });
  } catch (failure) {
    error = failure instanceof FixtureError || usingFixture ? failure : new FixtureError(stage);
  } finally {
    try {
      if (createAttempted) cleanupErrors = await cleanup(db, fixture, authUsers, authHeaders, userId, options);
    } finally {
      try {
        await db.end();
      } catch (failure) {
        if (!cleanupErrors.length) throw failure;
      }
    }
  }
  return { result, error, cleanupErrors, cleaned: createAttempted && cleanupErrors.length === 0 };
}

module.exports = { FixtureError, requireFixture, request, withDevFixture };
