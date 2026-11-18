#!/usr/bin/env node
/* eslint-disable no-console */

function parseEnabledFlag(value, fallback = false) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(raw)) return false;
  return fallback;
}

function normalizeEnvironmentName(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'dev' || raw.endsWith('-dev')) return 'dev';
  if (raw === 'stg' || raw.endsWith('-stg') || raw === 'staging' || raw.endsWith('-staging')) return 'stg';
  if (raw === 'prod' || raw.endsWith('-prod') || raw === 'production') return 'prod';
  return '';
}

function resolveEnvironmentName(options = {}) {
  const explicit = normalizeEnvironmentName(options.explicitEnvironment);
  if (explicit) return explicit;

  const env = options.env || process.env;
  const candidates = [
    env.OPERATOR_ACCOUNTS_ENV,
    env.DEPLOY_ENV,
    env.DEPLOY_ENV_NAME,
    env.GITHUB_ENVIRONMENT_NAME,
    env.GITHUB_ENVIRONMENT,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeEnvironmentName(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function normalizeRequiredAccount(entry = {}) {
  const deliveryMode = String(entry.delivery_mode || '').trim().toLowerCase() === 'breakglass'
    ? 'breakglass'
    : 'invite';
  return {
    key: String(entry.key || '').trim(),
    email: String(entry.email || '').trim().toLowerCase(),
    user_type: String(entry.user_type || '').trim().toLowerCase(),
    access_scope_type: String(entry.access_scope_type || '').trim().toLowerCase(),
    status: String(entry.status || 'active').trim().toLowerCase(),
    delivery_mode: deliveryMode,
    enabled: entry.enabled !== false,
    require_wildcard_capability: parseEnabledFlag(entry.require_wildcard_capability, false),
    require_password_credential: deliveryMode === 'breakglass'
      || parseEnabledFlag(entry.require_password_credential, false),
  };
}

function resolveRequiredOperatorAccounts(baseline = {}, environment = '') {
  const envName = normalizeEnvironmentName(environment);
  const registry = baseline.required_operator_accounts || {};
  const source = Array.isArray(registry[envName]) ? registry[envName] : [];
  return source.map(normalizeRequiredAccount).filter((entry) => entry.enabled);
}

async function fetchAccessPolicy(client) {
  const { rows } = await client.query(
    'SELECT policy FROM public.resolve_access_control_policy_v1($1, $2, $3) LIMIT 1;',
    ['global', null, false],
  );
  return rows && rows[0] ? rows[0].policy : null;
}

function firstRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

async function evaluateWildcardCapability(client, policy, userRow) {
  const { rows } = await client.query(
    `
      SELECT allowed, reason, capability_keys
      FROM public.access_eval_capability_v1($1::jsonb, $2::text, $3::text, $4::uuid, $5::uuid, $6::text)
    `,
    [
      policy,
      'organizations.write',
      userRow.access_scope_type,
      userRow.access_scope_id,
      userRow.id,
      userRow.user_type,
    ],
  );
  return firstRow(rows);
}

function isPlatformSuperAdminAccount(account) {
  return account.user_type === 'super_admin' && account.access_scope_type === 'platform';
}

async function evaluatePlatformSuperAdminInvariant(client, requiredAccounts, issues) {
  const requiredAdmins = requiredAccounts.filter(isPlatformSuperAdminAccount);
  const { rows } = await client.query(`
    SELECT lower(u.email) AS email
    FROM public.users AS u
    WHERE lower(u.user_type) = 'super_admin'
      AND lower(u.access_scope_type) = 'platform'
      AND lower(u.status) = 'active'
  `);
  if (requiredAdmins.length !== 1) {
    issues.push(`operator bootstrap config must require exactly one platform super_admin (found ${requiredAdmins.length})`);
  }
  if (rows.length !== 1) {
    issues.push(`runtime must contain exactly one active platform super_admin user (found ${rows.length})`);
  } else if (requiredAdmins.length === 1 && rows[0].email !== requiredAdmins[0].email) {
    issues.push('runtime active platform super_admin does not match the required bootstrap account');
  }
  return { required_count: requiredAdmins.length, active_count: rows.length };
}

async function evaluateAuthIdentity(client, required, userRow, issues) {
  const { rows } = await client.query(`
    SELECT au.id::text AS id,
      (au.encrypted_password IS NOT NULL AND length(au.encrypted_password) > 0) AS has_password_credential
    FROM auth.users AS au
    WHERE lower(au.email) = $1
    LIMIT 2
  `, [required.email]);
  const authUser = rows.length === 1 ? rows[0] : null;
  if (!authUser) {
    issues.push(`platform super_admin "${required.key}" must have exactly one matching auth user (found ${rows.length})`);
  } else {
    if (authUser.id !== userRow.id) {
      issues.push(`platform super_admin "${required.key}" auth user identity does not match public.users`);
    }
    if ((required.delivery_mode === 'breakglass' || parseEnabledFlag(required.require_password_credential))
      && !authUser.has_password_credential) {
      issues.push(`platform super_admin "${required.key}" is missing the required password credential in auth.users`);
    }
  }
  return {
    auth_user_count: rows.length,
    auth_user_present: Boolean(authUser),
    auth_identity_matches: Boolean(authUser && authUser.id === userRow.id),
    password_credential_present: Boolean(authUser && authUser.has_password_credential),
  };
}

async function evaluateOperatorAccounts(client, options = {}) {
  const requiredAccounts = Array.isArray(options.requiredAccounts) ? options.requiredAccounts : [];
  const issues = [];
  const findings = [];
  if (!requiredAccounts.length) {
    return {
      required: 0,
      findings,
      issues,
      ok: true,
    };
  }
  const policy = await fetchAccessPolicy(client);
  const platformSuperAdminInvariant = await evaluatePlatformSuperAdminInvariant(client, requiredAccounts, issues);

  for (const required of requiredAccounts) {
    const { rows } = await client.query(
      `
        SELECT
          u.id::text AS id,
          lower(u.email) AS email,
          lower(u.user_type) AS user_type,
          lower(u.access_scope_type) AS access_scope_type,
          u.access_scope_id::text AS access_scope_id,
          lower(u.status) AS status
        FROM public.users u
        WHERE lower(u.email) = $1
        ORDER BY u.created_at ASC
        LIMIT 1
      `,
      [required.email],
    );
    const row = firstRow(rows);
    if (!row) {
      issues.push(`missing operator account "${required.key}" (${required.email})`);
      continue;
    }

    const finding = {
      key: required.key,
      email: required.email,
      id: row.id,
      status: row.status,
      user_type: row.user_type,
      access_scope_type: row.access_scope_type,
      access_scope_id: row.access_scope_id || null,
    };
    if (isPlatformSuperAdminAccount(required)) {
      Object.assign(finding, await evaluateAuthIdentity(client, required, row, issues));
    }
    findings.push(finding);

    if (required.status && row.status !== required.status) {
      issues.push(
        `operator account "${required.key}" has status "${row.status}" (expected "${required.status}")`,
      );
    }
    if (required.user_type && row.user_type !== required.user_type) {
      issues.push(
        `operator account "${required.key}" has user_type "${row.user_type}" (expected "${required.user_type}")`,
      );
    }
    if (required.access_scope_type && row.access_scope_type !== required.access_scope_type) {
      issues.push(
        `operator account "${required.key}" has access_scope_type "${row.access_scope_type}" (expected "${required.access_scope_type}")`,
      );
    }

    if ((row.access_scope_type === 'platform' || row.access_scope_type === 'tenant') && row.access_scope_id) {
      issues.push(
        `operator account "${required.key}" must have NULL access_scope_id for scope "${row.access_scope_type}"`,
      );
    }

    if (required.require_wildcard_capability) {
      if (!policy) {
        issues.push(`access control policy missing while validating wildcard capability for "${required.key}"`);
      } else {
        const evalRow = await evaluateWildcardCapability(client, policy, row);
        const allowed = Boolean(evalRow && evalRow.allowed);
        const capabilities = Array.isArray(evalRow && evalRow.capability_keys)
          ? evalRow.capability_keys.map((value) => String(value || ''))
          : [];
        if (!allowed) {
          issues.push(
            `operator account "${required.key}" failed capability eval (organizations.write not allowed)`,
          );
        }
        if (!capabilities.includes('*')) {
          issues.push(
            `operator account "${required.key}" does not resolve wildcard capability "*"`,
          );
        }
      }
    }
  }

  return {
    required: requiredAccounts.length,
    findings,
    issues,
    platform_super_admin_invariant: platformSuperAdminInvariant,
    ok: issues.length === 0,
  };
}

module.exports = {
  evaluateOperatorAccounts,
  normalizeEnvironmentName,
  normalizeRequiredAccount,
  parseEnabledFlag,
  resolveEnvironmentName,
  resolveRequiredOperatorAccounts,
};
