import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import supabase from '../ops/workspace/supabase-api.js';
import preview from '../ops/workspace/preview-project.js';
import { ensureTenantRole } from './dev-sweep-role.cjs';

const config = new URL('../../config/dev/', import.meta.url);
const recipient = fileURLToPath(new URL('sweep-recipient.crt', config));
const roles = JSON.parse(readFileSync(new URL('sweep-roles.json', config), 'utf8'));
const marker = 'dev_design_sweep';
const failure = Symbol('sweep failure');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function requireSweep(condition, reason) {
  if (!condition) throw { [failure]: reason };
}

function mask(value) {
  requireSweep(typeof value === 'string' && /^[\x21-\x7e]+$/.test(value), 'invalid_secret');
  console.log(`::add-mask::${value.replaceAll('%', '%25')}`);
}

async function reportQueryError(response, reason) {
  // The status alone separates a token or scope refusal from a database error.
  console.error(`${reason}_http_status=${response.status}`);
  const error = await response.json();
  // Supabase can wrap the PostgreSQL error in a message with additional row details.
  const message = typeof error?.message === 'string' ? error.message : '';
  const header = /^(?:Failed to run sql query: )?ERROR: +([0-9A-Z]{5}): +([^\r\n]*)/.exec(message);
  const sqlstate = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : header?.[1];
  if (!sqlstate) return;

  const primary = header?.[2] ?? message.split(/[\r\n]/, 1)[0];
  const constraint = error?.constraint ??
    /^(?:duplicate key value|new row for relation "[^"]+"|insert or update on table "[^"]+") violates (?:unique|check|foreign key) constraint "([a-z_][a-z0-9_]*)"$/.exec(primary)?.[1];
  const column = error?.column ??
    /^(?:null value in column|column) "([a-z_][a-z0-9_]*)"(?: of relation "[^"]+")? (?:violates not-null constraint|does not exist)$/.exec(primary)?.[1];
  const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
  let detail = '';
  if (typeof constraint === 'string' && identifier.test(constraint)) detail = ` constraint=${constraint}`;
  else if (typeof column === 'string' && identifier.test(column)) detail = ` column=${column}`;
  console.error(`${reason}_sqlstate=${sqlstate}${detail}`);
}

async function request(url, headers, reason, method = 'GET', body) {
  try {
    const response = await fetch(url, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(25_000),
    });
    if (response.ok) return method === 'DELETE' ? null : await response.json();
    if (reason === 'auth_config') console.error(`auth_config_http_status=${response.status}`);
    else if (url.endsWith('/database/query')) await reportQueryError(response, reason);
  } catch {
    // Provider errors can contain configuration, identities or request data.
  }
  requireSweep(false, reason);
}

function ensureFixture(query, suffix, organizationId, senderId) {
  // The regular organization insert trigger bootstraps tenant settings.
  return query(`
    WITH inserted_org AS (
      INSERT INTO public.organizations (slug, name, id)
      VALUES ($1, $2, $3::uuid) ON CONFLICT (slug) DO NOTHING RETURNING id
    ), org AS (
      SELECT id FROM inserted_org
      UNION ALL SELECT id FROM public.organizations WHERE slug = $1 AND name = $2 AND id = $3::uuid
    ), inserted_client AS (
      INSERT INTO public.clients (organization_id, slug, name)
      SELECT id, $1, $2 FROM org
      ON CONFLICT (organization_id, slug) DO NOTHING RETURNING id
    ), client AS (
      SELECT id FROM inserted_client
      UNION ALL SELECT c.id FROM public.clients c JOIN org o ON c.organization_id = o.id
        WHERE c.slug = $1 AND c.name = $2
    ), inserted_sender AS (
      INSERT INTO public.senders (id, client_id, name)
      SELECT $4::uuid, id, $2 FROM client
      ON CONFLICT (id) DO NOTHING RETURNING id
    ), sender AS (
      SELECT id FROM inserted_sender
      UNION ALL SELECT s.id FROM public.senders s JOIN client c ON s.client_id = c.id
        WHERE s.id = $4::uuid AND s.name = $2
    )
    SELECT org.id AS organization_id, sender.id AS sender_id FROM org CROSS JOIN sender`,
  [`design-sweep-${suffix}`, `Design sweep ${suffix}`, organizationId, senderId], 'fixture_write');
}

async function checkRolePolicy(query, { id, organizationId, key, scope, scopeId, required, optional }) {
  // Not read_only: the resolvers grant EXECUTE only to authenticated and service_role, so the read-only
  // principal gets 42501 (#790). p_log = false keeps the policy resolver free of writes.
  const [policy] = await query(`
    SELECT roles, public.resolve_capabilities_v1(policy, roles) AS capabilities
      FROM public.resolve_access_control_policy_v1($1, $2::uuid, false)
      CROSS JOIN LATERAL public.resolve_role_keys_v1(policy, $3::uuid, $4) AS resolved(roles)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.rbac_user_role_assignments WHERE user_id = $3::uuid AND revoked_at IS NULL
      )`, [scope, scopeId ?? organizationId, id, key], 'role_read');
  requireSweep(policy?.roles?.length === 1 && policy.roles[0] === key &&
    Array.isArray(policy.capabilities) && required.every(cap => policy.capabilities.includes(cap)) &&
    policy.capabilities.every(cap => required.includes(cap) || optional.includes(cap)), 'role_policy');
}

async function ensureMembership(query, { id, email, organizationId, key, scope, scopeId }) {
  // ui_me_v1 resolves this scoped user_type through access_control_policy.
  const rows = await query(`
    WITH inserted AS (
      INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'active', $6, $7::uuid)
      ON CONFLICT DO NOTHING RETURNING id
    )
    SELECT id FROM inserted
    UNION ALL SELECT id FROM public.users
      WHERE id = $1::uuid AND organization_id = $2::uuid AND email = $3 AND full_name = $4
        AND user_type = $5 AND status = 'active' AND access_scope_type = $6
        AND access_scope_id IS NOT DISTINCT FROM $7::uuid`,
  [id, organizationId, email, `Design sweep ${key}`, key, scope, scopeId], 'membership_write');
  requireSweep(rows.length === 1 && rows[0].id === id, 'membership_conflict');
}

export async function provisionSweep(env) {
  requireSweep(env.GITHUB_ACTIONS === 'true' && env.DEPLOY_ENV === 'dev' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_REPOSITORY === 'MasarX/masarx-platform', 'dispatch_guard');

  const projectRef = env.SUPABASE_PROJECT_REF;
  const projectUrl = preview.buildSupabaseProjectUrl(projectRef);
  requireSweep(supabase.isCanonicalSupabaseProjectRef(projectRef) &&
    [projectUrl, `${projectUrl}/`].includes(env.NEXT_PUBLIC_SUPABASE_URL) &&
    env.RUNNER_TEMP && !env.SUPABASE_MGMT_URL, 'dev_configuration');

  const certificate = new X509Certificate(readFileSync(recipient));
  requireSweep(certificate.fingerprint256 === env.SWEEP_RECIPIENT_SHA256, 'recipient_fingerprint');
  const roleKeys = Object.keys(roles);
  requireSweep(roleKeys.length > 0 && Object.entries(roles).every(([key, role]) =>
    /^[a-z_]+$/.test(key) && !/admin|owner|service|platform/.test(key) &&
    ['tenant', 'sender'].includes(role.scope) &&
    (!role.provisionTenantRole || role.scope === 'tenant') &&
    [...role.required, ...role.optional].every(cap => /^(?:[a-z_]+\.read|labels\.download)$/.test(cap))), 'role_configuration');

  const token = env.SUPABASE_ACCESS_TOKEN;
  mask(token);
  mask(projectRef);
  const management = `${supabase.getSupabaseMgmtUrl()}/v1/projects/${projectRef}`;
  const managementHeaders = { authorization: `Bearer ${token}` };
  const authConfig = await request(`${management}/config/auth`, managementHeaders, 'auth_config');
  const emailEnabled = authConfig?.external_email_enabled;
  console.log(`password_sign_in=${emailEnabled === true ? 'enabled' : emailEnabled === false ? 'disabled' : 'unknown'}`);
  requireSweep(emailEnabled === true, 'password_sign_in');

  const keys = await request(`${management}/api-keys?reveal=true`, managementHeaders, 'service_key_read');
  const serviceKeys = keys.filter(row => row.name === 'service_role');
  requireSweep(serviceKeys.length === 1, 'service_key_read');
  const serviceKey = serviceKeys[0].api_key;
  mask(serviceKey);
  const claims = JSON.parse(Buffer.from(serviceKey.split('.')[1], 'base64url'));
  requireSweep(claims.role === 'service_role' && claims.ref === projectRef, 'service_key_binding');

  const authHeaders = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
  const authUsers = `${projectUrl}/auth/v1/admin/users`;
  const query = (sql, parameters, reason, readOnly = false) => request(
    `${management}/database/query`, managementHeaders, reason, 'POST',
    { query: sql, parameters, read_only: readOnly },
  );
  const digest = createHash('sha256').update(`dev-design-sweep:${projectRef}`).digest('hex');
  const suffix = digest.slice(0, 16);
  const fixture = await ensureFixture(query, suffix, digest.slice(0, 32), digest.slice(32));
  requireSweep(fixture.length === 1 && uuid.test(fixture[0].organization_id) &&
    uuid.test(fixture[0].sender_id), 'fixture_conflict');
  const { organization_id: organizationId, sender_id: senderId } = fixture[0];

  const credentials = {};
  for (const [key, role] of Object.entries(roles)) {
    if (role.provisionTenantRole) await ensureTenantRole(query, organizationId, key, role.required);
    const email = `${key}-${suffix}@${['sweep', 'invalid'].join('.')}`;
    const password = `${randomBytes(32).toString('base64url')}aA0!`;
    mask(email);
    mask(password);

    const existing = await query(`
      SELECT id, role, raw_app_meta_data ->> $2 AS sweep
        FROM auth.users WHERE lower(email) = $1`, [email, marker], 'identity_read', true);
    requireSweep(existing.length === 0 || (existing.length === 1 && uuid.test(existing[0].id) &&
      existing[0].role === 'authenticated' && existing[0].sweep === key), 'identity_conflict');
    const prior = existing[0];
    const response = prior ?? await request(authUsers, authHeaders, 'identity_create', 'POST', {
      email, password, email_confirm: true, app_metadata: { [marker]: key },
    });
    const user = response?.user ?? response;
    requireSweep(uuid.test(user?.id) && user.role === 'authenticated' &&
      (prior || (user.email === email && user.app_metadata?.[marker] === key)), 'identity_response');

    const identity = {
      ...role, id: user.id, email, organizationId, key, scopeId: role.scope === 'sender' ? senderId : null,
    };
    try {
      await checkRolePolicy(query, identity);
    } catch (error) {
      if (!prior) await request(`${authUsers}/${user.id}`, authHeaders, 'identity_cleanup', 'DELETE');
      throw error;
    }
    await ensureMembership(query, identity);
    if (prior) {
      const updated = await request(`${authUsers}/${user.id}`, authHeaders, 'password_rotate', 'PUT', { password });
      const rotated = updated?.user ?? updated;
      requireSweep(rotated?.id === user.id && rotated.email === email && rotated.role === 'authenticated' &&
        rotated.app_metadata?.[marker] === key, 'identity_response');
    }
    credentials[key] = { email, password };
  }

  const encrypted = spawnSync('openssl', ['cms', '-encrypt', '-aes256', '-binary', '-outform', 'DER', '-recip', recipient], {
    input: JSON.stringify(credentials), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: 15_000,
  });
  requireSweep(encrypted.status === 0 && encrypted.stdout?.length > 0, 'encryption');
  writeFileSync(join(env.RUNNER_TEMP, 'dev-sweep-credentials.cms'), encrypted.stdout, { flag: 'wx', mode: 0o600 });
  console.log(`users_ready=${roleKeys.length}`);
  console.log(`roles=${roleKeys.join(',')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  provisionSweep(process.env).catch(error => {
    console.error(`sweep_error=${error?.[failure] ?? 'unexpected'}`);
    process.exitCode = 1;
  });
}
