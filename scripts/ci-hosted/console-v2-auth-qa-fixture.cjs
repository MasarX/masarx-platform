'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const expiryUnboundExitCode = 2;

function loopbackUrl(value, protocols) {
  const address = new URL(value);
  assert(protocols.includes(address.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
  assert(address.port && !address.search && !address.hash);
  return address;
}

function loopbackOrigin(value) {
  const address = loopbackUrl(value, ['http:']);
  assert.equal(address.pathname, '/');
  assert(!address.username && !address.password);
  return address.origin;
}

function qualificationInputs(env) {
  assert.equal(env.CI, 'true');
  const candidate = JSON.parse(env.QA_CANDIDATE);
  for (const name of ['workflowSha', 'sourceSha', 'sourceTree']) {
    assert.match(candidate[name], /^[0-9a-f]{40}$/);
  }
  assert.match(candidate.lockfileDigest, /^[0-9a-f]{64}$/);
  assert(Number.isSafeInteger(candidate.runId) && candidate.runId > 0);
  assert.equal(candidate.attempt, 1);
  const root = fs.realpathSync(env.QA_CANDIDATE_DIR);
  assert.equal(root, fs.realpathSync(process.cwd()));
  const temp = fs.realpathSync(env.QA_TEMP_DIR);
  assert.match(path.basename(temp), /^console-auth-[A-Za-z0-9]+$/);
  for (const name of ['QA_LIVE', 'QA_DEMO']) {
    const { origin, buildDigest } = JSON.parse(env[name]);
    assert.equal(origin, loopbackOrigin(origin));
    assert.match(buildDigest, /^[0-9a-f]{64}$/);
  }
  return { temp, requireCandidate: createRequire(path.join(root, 'package.json')) };
}

async function provisionFixture(env) {
  const { requireCandidate } = qualificationInputs(env);
  const apiOrigin = loopbackOrigin(env.SUPABASE_URL);
  const database = loopbackUrl(env.DATABASE_URL, ['postgres:', 'postgresql:']);
  assert.equal(database.pathname, '/postgres');
  const anonKey = env.SUPABASE_ANON_KEY;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  assert(anonKey && serviceKey && anonKey !== serviceKey);
  assert.match(env.QA_JWT_EXPIRY_SECONDS, /^[1-9]\d*$/);
  const jwtExpirySeconds = Number(env.QA_JWT_EXPIRY_SECONDS);
  assert(Number.isSafeInteger(jwtExpirySeconds));

  const { createClient } = requireCandidate('@supabase/supabase-js');
  const { Client } = requireCandidate('pg');
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: 'api' },
    global: {
      fetch: (input, init) => {
        assert.equal(new URL(input.url ?? input).origin, apiOrigin);
        return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      },
    },
  };
  const suffix = randomUUID();
  const email = 'console-qa-' + suffix + '@example.invalid';
  const password = randomBytes(24).toString('base64url') + 'A1!';
  const service = createClient(apiOrigin, serviceKey, options);
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert(!created.error && created.data?.user?.id);
  const userId = created.data.user.id;

  const db = new Client({
    connectionString: database.href, connectionTimeoutMillis: 10_000, query_timeout: 10_000,
  });
  try {
    await db.connect();
    // The candidate's tenant-signup reviewer fixture uses the same platform operator binding.
    const membership = await db.query(
      "WITH organization AS (" +
      " INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status)" +
      " VALUES ($1::uuid, $2, $3, 'UTC', 'en', 'active') RETURNING id" +
      ")" +
      " INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)" +
      " SELECT $4::uuid, id, $5, $2, 'ops_admin', 'active', 'platform' FROM organization",
      [randomUUID(), 'Console QA fixture', 'console-qa-' + suffix, userId, email],
    );
    assert.equal(membership.rowCount, 1);
  } finally {
    await db.end();
  }

  const client = createClient(apiOrigin, anonKey, options);
  const signed = await client.auth.signInWithPassword({ email, password });
  assert(!signed.error && signed.data?.session?.user?.id === userId);
  const expiryBound = signed.data.session.expires_in === jwtExpirySeconds;
  const identity = await client.rpc('ui_me_v1');
  assert(!identity.error && identity.data?.user?.id === userId);
  assert.equal(identity.data.access_scope?.scope_type, 'platform');
  assert(Array.isArray(identity.data.capabilities) && identity.data.capabilities.length > 0);
  const logout = await client.auth.signOut();
  assert(!logout.error);
  return expiryBound ? { email, password } : null;
}

if (require.main === module) {
  provisionFixture(process.env).then(account => {
    if (account === null) {
      process.exitCode = expiryUnboundExitCode;
      return;
    }
    // The workflow captures this JSON in memory without printing or retaining it.
    process.stdout.write(JSON.stringify(account) + '\n');
  }).catch(() => {
    process.stderr.write('Console fixture qualification failed.\n');
    process.exitCode = 1;
  });
}

module.exports = { expiryUnboundExitCode, loopbackOrigin, qualificationInputs };
