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
  const rawDeliveryMode = String(entry.delivery_mode || 'invite').trim().toLowerCase();
  const deliveryMode = rawDeliveryMode === 'breakglass' ? 'breakglass' : 'invite';
  return {
    key: String(entry.key || '').trim(),
    email: String(entry.email || '').trim().toLowerCase(),
    user_type: String(entry.user_type || '').trim().toLowerCase(),
    access_scope_type: String(entry.access_scope_type || '').trim().toLowerCase(),
    status: String(entry.status || 'active').trim().toLowerCase(),
    delivery_mode: deliveryMode,
    enabled: entry.enabled !== false,
    require_wildcard_capability: parseEnabledFlag(entry.require_wildcard_capability, false),
    require_password_credential: parseEnabledFlag(
      entry.require_password_credential,
      deliveryMode === 'breakglass',
    ),
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

function isPlatformSuperAdminAccount(account = {}) {
  return Boolean(
    String(account.user_type || '').trim().toLowerCase() === 'super_admin' &&
    String(account.access_scope_type || '').trim().toLowerCase() === 'platform' &&
    String(account.email || '').trim()
  );
}

async function fetchActivePlatformSuperAdmins(client) {
  const { rows } = await client.query(
    `
      SELECT
        u.id::text AS id,
        lower(u.email) AS email,
        lower(u.status) AS status
      FROM public.users AS u
      WHERE lower(u.user_type) = 'super_admin'
        AND lower(u.access_scope_type) = 'platform'
        AND lower(u.status) = 'active'
      ORDER BY lower(u.email), u.created_at ASC
    `,
  );
  return Array.isArray(rows) ? rows : [];
}

async function fetchAuthUsersByEmail(client, email) {
  const { rows } = await client.query(
    `
      SELECT
        au.id::text AS id,
        lower(au.email) AS email,
        (au.encrypted_password IS NOT NULL AND length(au.encrypted_password) > 0) AS has_password_credential,
        (au.email_confirmed_at IS NOT NULL) AS email_confirmed
      FROM auth.users AS au
      WHERE lower(au.email) = $1
      ORDER BY au.created_at ASC
      LIMIT 2
    `,
    [String(email || '').trim().toLowerCase()],
  );
  return Array.isArray(rows) ? rows : [];
}

async function evaluatePlatformSuperAdminInvariant(client, requiredAccounts, issues) {
  const requiredPlatformSuperAdmins = requiredAccounts.filter(isPlatformSuperAdminAccount);
  const activePlatformSuperAdmins = await fetchActivePlatformSuperAdmins(client);
  const requiredEmails = requiredPlatformSuperAdmins.map((entry) => entry.email).sort();
  const activeEmails = activePlatformSuperAdmins.map((entry) => entry.email).sort();

  if (requiredPlatformSuperAdmins.length !== 1) {
    issues.push(
      `operator bootstrap config must require exactly one platform super_admin (found ${requiredPlatformSuperAdmins.length})`,
    );
  }
  if (activePlatformSuperAdmins.length !== 1) {
    issues.push(
      `runtime must contain exactly one active platform super_admin user (found ${activePlatformSuperAdmins.length}: ${activeEmails.join(', ') || 'none'})`,
    );
  }
  if (
    requiredPlatformSuperAdmins.length === 1 &&
    activePlatformSuperAdmins.length === 1 &&
    activePlatformSuperAdmins[0].email !== requiredPlatformSuperAdmins[0].email
  ) {
    issues.push(
      `runtime active platform super_admin "${activePlatformSuperAdmins[0].email}" does not match required bootstrap account "${requiredPlatformSuperAdmins[0].email}"`,
    );
  }

  return {
    required_count: requiredPlatformSuperAdmins.length,
    required_emails: requiredEmails,
    active_count: activePlatformSuperAdmins.length,
    active_emails: activeEmails,
  };
}

async function evaluateOperatorAccounts(client, options = {}) {
  const requiredAccounts = Array.isArray(options.requiredAccounts) ? options.requiredAccounts : [];
  const issues = [];
  const findings = [];
  let platformSuperAdminInvariant = {
    required_count: 0,
    required_emails: [],
    active_count: 0,
    active_emails: [],
  };
  if (!requiredAccounts.length) {
    return {
      required: 0,
      findings,
      issues,
      platform_super_admin_invariant: platformSuperAdminInvariant,
      ok: true,
    };
  }
  const policy = await fetchAccessPolicy(client);
  platformSuperAdminInvariant = await evaluatePlatformSuperAdminInvariant(client, requiredAccounts, issues);

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
      const authUsers = await fetchAuthUsersByEmail(client, required.email);
      finding.auth_user_count = authUsers.length;
      finding.auth_user_present = authUsers.length === 1;
      finding.password_credential_present = authUsers.length === 1
        ? Boolean(authUsers[0].has_password_credential)
        : false;
      if (authUsers.length !== 1) {
        issues.push(
          `platform super_admin "${required.key}" must have exactly one matching auth user (found ${authUsers.length})`,
        );
      } else if (required.require_password_credential && !authUsers[0].has_password_credential) {
        issues.push(
          `platform super_admin "${required.key}" is missing the required password credential in auth.users`,
        );
      }
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
  evaluatePlatformSuperAdminInvariant,
  fetchActivePlatformSuperAdmins,
  fetchAuthUsersByEmail,
  isPlatformSuperAdminAccount,
  normalizeEnvironmentName,
  normalizeRequiredAccount,
  parseEnabledFlag,
  resolveEnvironmentName,
  resolveRequiredOperatorAccounts,
};
