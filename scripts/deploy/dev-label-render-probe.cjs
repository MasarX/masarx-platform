const { randomBytes, randomUUID } = require('node:crypto');
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const supabase = require('../ops/workspace/supabase-api');
const { buildSupabaseProjectUrl } = require('../ops/workspace/preview-project');
const { decodeJwtPayload } = require('../utils/jwt');

const EXIT = Object.freeze({
  configuration: 10,
  credentials: 11,
  database: 12,
  authCreate: 13,
  fixture: 14,
  signIn: 15,
  renderNetwork: 16,
  renderStatus: 17,
  renderResponse: 18,
  renderPdf: 19,
  cleanupDatabase: 20,
  cleanupAuth: 21,
  cleanupVerify: 22,
  unexpected: 23,
});
const renderTimeoutMs = 30_000;
const pdfHeader = Buffer.from('%PDF-');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const labelType = 'shipping';
// Only fixed codes from the renderer's non-200 designer preview responses are safe to report.
const previewErrorCodes = new Set([
  'auth_required', 'draft_id_required', 'shipment_id_required', 'config_missing',
  'org_required', 'draft_not_found', 'template_missing', 'payload_missing',
]);

class ProbeError extends Error {
  constructor(code) {
    super('DEV label probe failed');
    this.code = code;
  }
}

function requireProbe(condition, code) {
  if (!condition) throw new ProbeError(code);
}

function mask(value, code) {
  requireProbe(typeof value === 'string' && /^[\x21-\x7e]+$/.test(value), code);
  console.log(`::add-mask::${value.replaceAll('%', '%25')}`);
}

function checkPreview(status, body) {
  if (status !== 200) return { code: EXIT.renderStatus };
  if (body?.ok !== true) return { code: EXIT.renderResponse };
  const encoded = body.pdf_base64;
  if (typeof encoded !== 'string') return { code: EXIT.renderPdf };
  const pdf = Buffer.from(encoded, 'base64');
  if (pdf.toString('base64') !== encoded || !pdf.subarray(0, pdfHeader.length).equals(pdfHeader)) {
    return { code: EXIT.renderPdf };
  }
  return { code: 0, pdfBytes: pdf.length };
}

function request(url, headers, method, body) {
  return fetch(url, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(renderTimeoutMs),
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
  throw new ProbeError(code);
}

async function renderPreview(send, wait = delay) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    let status;
    let text;
    try {
      response = await send();
      status = response.status;
      if (status === 200) text = await response.text();
    } catch {
      status = undefined;
    }
    if (status === 200 && text !== undefined) {
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        throw new ProbeError(EXIT.renderResponse);
      }
      return checkPreview(status, result);
    }
    if (status !== undefined) {
      if (status < 500 || status >= 600 || attempt === 2) {
        const body = await response.json().catch(() => null);
        const errorCode = body?.error?.code;
        const rendererCode = previewErrorCodes.has(errorCode) ? errorCode : 'unavailable';
        return {
          code: EXIT.renderStatus,
          diagnostic: `LABEL_PROBE_RENDER_ERROR status=${status} renderer_code=${rendererCode}`,
        };
      }
      await response.body?.cancel().catch(() => {});
    }
    if (attempt < 2) await wait(1000 * 2 ** attempt);
    else return { code: EXIT.renderNetwork };
  }
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

async function seed(db, { organizationId, clientId, shipmentId, boxId, draftId, tag, email }, userId) {
  const draft = {
    version: 'draft',
    templates: {
      [labelType]: {
        version: '1.0.0',
        template_key: labelType,
        label_type: labelType,
        page: { width_inch: 4, height_inch: 6, dpi: 203, orientation: 'portrait' },
        blocks: [{
          id: 'title', type: 'text', x: 24, y: 24, width: 240, height: 24, font_size: 12,
          text_expr: { op: 'literal', value: tag },
        }],
      },
    },
  };
  const tracking = shipmentId.replaceAll('-', '').toUpperCase();
  await transaction(db, async () => {
    await db.query('INSERT INTO public.organizations (id, name, slug) VALUES ($1, $2, $2)', [organizationId, tag]);
    await db.query('INSERT INTO public.clients (id, organization_id, name, slug) VALUES ($1, $2, $3, $3)',
      [clientId, organizationId, tag]);
    await db.query(`INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
      VALUES ($1, $2, $3, $4, 'ops_admin', 'active', 'tenant')`, [userId, organizationId, email, tag]);
    const { rowCount } = await db.query(`INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
      SELECT $1, $2, role_id FROM public.provision_rbac_roles_from_templates_v1($1, ARRAY['ops_admin'], $2)`,
    [organizationId, userId]);
    requireProbe(rowCount === 1, EXIT.fixture);
    await db.query(`INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status)
      VALUES ($1, $2, $3, $4, 'delivery', 'pending')`, [shipmentId, organizationId, clientId, tracking]);
    await db.query(`INSERT INTO public.shipment_boxes (id, shipment_id, organization_id, client_id, box_number, barcode)
      VALUES ($1, $2, $3, $4, 1, $5)`, [boxId, shipmentId, organizationId, clientId, `${tracking}:1`]);
    await db.query(`INSERT INTO public.label_design_drafts
      (id, organization_id, scope_type, scope_id, label_type, draft_name, draft_value, created_by)
      VALUES ($1, $2, 'tenant', $2, $3, $4, $5, $6)`,
    [draftId, organizationId, labelType, tag, draft, userId]);
  });
}

async function cleanDatabase(db, { organizationId, clientId, shipmentId, boxId, draftId, tag, email }) {
  // Onboarding creates default senders, source configuration and settings under the new tenant.
  return transaction(db, async () => {
    const { rowCount } = await db.query('SELECT 1 FROM public.organizations WHERE id = $1 AND slug = $2 FOR UPDATE',
      [organizationId, tag]);
    const { rows } = await db.query(`SELECT id FROM public.senders WHERE client_id = $1
      UNION ALL SELECT id FROM public.webhook_sources WHERE organization_id = $2`, [clientId, organizationId]);
    const scopeIds = [organizationId, clientId, ...rows.map(({ id }) => id)];
    const owned = {
      label_design_drafts: ['id = $1 AND organization_id = $2', [draftId, organizationId]],
      shipment_boxes: ['id = $1 AND shipment_id = $2 AND client_id = $3', [boxId, shipmentId, clientId]],
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

async function cleanup(db, fixture, authUsers, authHeaders, verifiedUserId) {
  const errors = [];
  let owned;
  try {
    owned = await cleanDatabase(db, fixture);
  } catch {
    errors.push(EXIT.cleanupDatabase);
  }
  try {
    let userId = verifiedUserId;
    if (!userId) {
      // A lost create response can still leave a committed Auth user.
      const { rows } = await db.query(`SELECT id FROM auth.users WHERE email = $1
        AND raw_app_meta_data->>'dev_label_probe' = $2`, [fixture.email, fixture.tag]);
      requireProbe(rows.length <= 1, EXIT.cleanupAuth);
      userId = rows[0]?.id;
    }
    if (userId) {
      requireProbe(uuid.test(userId), EXIT.cleanupAuth);
      await jsonRequest(`${authUsers}/${userId}`, authHeaders, EXIT.cleanupAuth, 'DELETE');
    }
  } catch {
    errors.push(EXIT.cleanupAuth);
  }
  try {
    requireProbe(owned, EXIT.cleanupVerify);
    const { rowCount } = await db.query('SELECT 1 FROM auth.users WHERE email = $1', [fixture.email]);
    requireProbe(rowCount === 0, EXIT.cleanupVerify);
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
      requireProbe(remaining.rowCount === 0, EXIT.cleanupVerify);
    }
  } catch {
    errors.push(EXIT.cleanupVerify);
  }
  return errors;
}

async function run(env) {
  const projectRef = env.SUPABASE_PROJECT_REF;
  requireProbe(env.GITHUB_ACTIONS === 'true' && env.DEPLOY_ENV === 'dev' && env.GITHUB_REF === 'refs/heads/main'
    && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') && supabase.isCanonicalSupabaseProjectRef(projectRef)
    && env.GITHUB_STEP_SUMMARY && !env.SUPABASE_MGMT_URL, EXIT.configuration);
  mask(env.SUPABASE_ACCESS_TOKEN, EXIT.configuration);
  mask(env.SUPABASE_DB_PASSWORD, EXIT.configuration);
  mask(projectRef, EXIT.configuration);

  const projectUrl = buildSupabaseProjectUrl(projectRef);
  const management = `${supabase.getSupabaseMgmtUrl()}/v1/projects/${projectRef}`;
  const managementHeaders = { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` };
  const keys = await jsonRequest(`${management}/api-keys?reveal=true`, managementHeaders, EXIT.credentials);
  requireProbe(Array.isArray(keys), EXIT.credentials);
  const keyFor = (role) => {
    const matches = keys.filter((key) => key?.name === role);
    requireProbe(matches.length === 1, EXIT.credentials);
    const key = matches[0].api_key;
    mask(key, EXIT.credentials);
    const claims = decodeJwtPayload(key);
    requireProbe(claims?.role === role && claims.ref === projectRef, EXIT.credentials);
    return key;
  };
  const anonKey = keyFor('anon');
  const serviceKey = keyFor('service_role');
  const poolers = await jsonRequest(`${management}/config/database/pooler`, managementHeaders, EXIT.database);
  requireProbe(Array.isArray(poolers), EXIT.database);
  const primary = poolers.filter((pooler) => pooler?.database_type === 'PRIMARY');
  requireProbe(primary.length === 1 && supabase.isCanonicalSupabasePoolerHost(primary[0].db_host), EXIT.database);
  const db = new Client({
    host: primary[0].db_host, port: 5432, database: 'postgres', user: `postgres.${projectRef}`,
    password: env.SUPABASE_DB_PASSWORD, connectionTimeoutMillis: 8000, query_timeout: 25_000,
    ssl: { ca: readFileSync(join(__dirname, '../../config/certs/supabase-prod-ca-2021.crt')), rejectUnauthorized: true },
  });
  // A closed idle connection is also reported by the next query, where the stage can be logged safely.
  db.on('error', () => {});

  const tag = `dev-label-probe-${randomUUID()}`;
  const fixture = {
    tag, email: `${tag}@example.invalid`, organizationId: randomUUID(),
    clientId: randomUUID(), shipmentId: randomUUID(), boxId: randomUUID(), draftId: randomUUID(),
  };
  const password = `${randomBytes(32).toString('base64url')}aA0!`;
  mask(fixture.email, EXIT.fixture);
  mask(password, EXIT.fixture);
  const authUsers = `${projectUrl}/auth/v1/admin/users`;
  const authHeaders = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
  const errors = [];
  let stage = EXIT.database;
  let createAttempted = false;
  let userId;
  let rendered;
  let cleaned = false;
  try {
    await db.connect();
    stage = EXIT.authCreate;
    createAttempted = true;
    const created = await jsonRequest(authUsers, authHeaders, stage, 'POST', {
      email: fixture.email, password, email_confirm: true, app_metadata: { dev_label_probe: tag },
    });
    const user = created?.user ?? created;
    requireProbe(uuid.test(user?.id) && user.email === fixture.email && user.role === 'authenticated'
      && user.app_metadata?.dev_label_probe === tag, stage);
    userId = user.id;
    stage = EXIT.fixture;
    await seed(db, fixture, user.id);
    stage = EXIT.signIn;
    const session = await jsonRequest(`${projectUrl}/auth/v1/token?grant_type=password`, { apikey: anonKey },
      stage, 'POST', { email: fixture.email, password });
    const jwt = session?.access_token;
    mask(jwt, stage);
    mask(session?.refresh_token, stage);
    const claims = decodeJwtPayload(jwt);
    requireProbe(claims?.role === 'authenticated' && claims.sub === user.id, stage);

    stage = EXIT.renderNetwork;
    rendered = await renderPreview(() => request(
      `${projectUrl}/functions/v1/label-renderer`, { apikey: anonKey, authorization: `Bearer ${jwt}` }, 'POST', {
        mode: 'designer_preview', user_jwt: jwt, label_type: labelType,
        draft_id: fixture.draftId, shipment_id: fixture.shipmentId, shipment_box_id: fixture.boxId,
      },
    ));
    requireProbe(rendered.code === 0, rendered.code);
  } catch (error) {
    errors.push(error instanceof ProbeError ? error.code : stage);
  } finally {
    if (createAttempted) {
      const cleanupErrors = await cleanup(db, fixture, authUsers, authHeaders, userId);
      errors.push(...cleanupErrors);
      cleaned = cleanupErrors.length === 0;
    }
    await db.end();
  }
  return { pdfBytes: rendered?.pdfBytes, renderDiagnostic: rendered?.diagnostic, cleaned, errors };
}

async function main() {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  const evidence = [];
  let errors = [];
  let renderDiagnostic;
  try {
    const result = await run(process.env);
    ({ errors, renderDiagnostic } = result);
    if (result.pdfBytes) evidence.push(`LABEL_PROBE status=200 pdf_bytes=${result.pdfBytes} sha=${process.env.GITHUB_SHA}`);
    if (result.cleaned) evidence.push('LABEL_PROBE_CLEANUP rows=0');
  } catch (error) {
    errors.push(error instanceof ProbeError ? error.code : EXIT.unexpected);
  }
  const failures = errors.map(code => `LABEL_PROBE_ERROR code=${code}`);
  if (renderDiagnostic) failures.push(renderDiagnostic);
  for (const line of evidence) console.log(line);
  for (const line of failures) console.error(line);
  if (summary) {
    try {
      appendFileSync(summary, `${[...evidence, ...failures].join('\n')}\n`);
    } catch {
      console.error(`LABEL_PROBE_ERROR code=${EXIT.unexpected}`);
      errors.push(EXIT.unexpected);
    }
  }
  process.exitCode = errors.at(-1) ?? 0;
}

if (require.main === module) void main();

module.exports = { checkPreview, renderPreview, EXIT };
