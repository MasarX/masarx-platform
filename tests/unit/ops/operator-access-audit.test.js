jest.mock('pg', () => ({ Client: jest.fn() }));
jest.mock('../../../scripts/utils/resolve-db-url', () => ({ resolveDatabaseUrlWithFallback: jest.fn() }));

const fs = require('fs');
const { Client } = require('pg');
const { resolveDatabaseUrlWithFallback } = require('../../../scripts/utils/resolve-db-url');
const { runAudit } = require('../../../scripts/ops/audit/operator-access-audit');
const {
  evaluateOperatorAccounts,
  resolveRequiredOperatorAccounts,
} = require('../../../scripts/ops/audit/operator-access-core');

describe('operator-access audit core', () => {
  test('resolveRequiredOperatorAccounts returns env-specific enabled accounts', () => {
    const baseline = {
      required_operator_accounts: {
        prod: [
          { key: 'a', email: 'A@example.com', user_type: 'super_admin', access_scope_type: 'platform' },
          { key: 'b', email: 'b@example.com', user_type: 'ops_admin', access_scope_type: 'tenant', enabled: false },
        ],
      },
    };
    const required = resolveRequiredOperatorAccounts(baseline, 'prod');
    expect(required).toEqual([
      {
        key: 'a',
        email: 'a@example.com',
        user_type: 'super_admin',
        access_scope_type: 'platform',
        status: 'active',
        delivery_mode: 'invite',
        enabled: true,
        require_wildcard_capability: false,
        require_password_credential: false,
      },
    ]);
  });

  test('evaluateOperatorAccounts reports missing and mismatched rows', async () => {
    const requiredAccounts = [
      {
        key: 'platform_super_admin',
        email: 'xgjowtnlghqukqnxtmmnvwyz@example.invalid',
        user_type: 'super_admin',
        access_scope_type: 'platform',
        status: 'active',
        require_wildcard_capability: true,
      },
      {
        key: 'tenant_ops_admin',
        email: 'uhpvvhxlqkjrnkqnswpggrux@example.invalid',
        user_type: 'ops_admin',
        access_scope_type: 'tenant',
        status: 'active',
      },
    ];

    const client = {
      query: jest.fn(async (sql, params = []) => {
        if (sql.includes('resolve_access_control_policy_v1')) {
          return { rows: [{ policy: { version: 1 } }] };
        }
        if (sql.includes('FROM public.users AS u') || sql.includes('FROM auth.users AS au')) {
          return { rows: [] };
        }
        if (sql.includes('FROM public.users u')) {
          const email = String(params[0] || '');
          if (email === 'xgjowtnlghqukqnxtmmnvwyz@example.invalid') {
            return {
              rows: [
                {
                  id: 'u1',
                  email,
                  user_type: 'super_admin',
                  access_scope_type: 'tenant',
                  access_scope_id: null,
                  status: 'active',
                },
              ],
            };
          }
          return { rows: [] };
        }
        if (sql.includes('FROM public.access_eval_capability_v1')) {
          return { rows: [{ allowed: false, reason: 'missing_capability', capability_keys: ['organizations.read'] }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    const result = await evaluateOperatorAccounts(client, { requiredAccounts });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes('access_scope_type "tenant"'))).toBe(true);
    expect(result.issues.some((issue) => issue.includes('organizations.write not allowed'))).toBe(true);
    expect(result.issues.some((issue) => issue.includes('missing operator account "tenant_ops_admin"'))).toBe(true);
  });

  test('evaluateOperatorAccounts passes when rows and wildcard capability match', async () => {
    const requiredAccounts = [
      {
        key: 'platform_super_admin',
        email: 'xgjowtnlghqukqnxtmmnvwyz@example.invalid',
        user_type: 'super_admin',
        access_scope_type: 'platform',
        status: 'active',
        require_wildcard_capability: true,
      },
    ];

    const client = {
      query: jest.fn(async (sql, params = []) => {
        if (sql.includes('resolve_access_control_policy_v1')) {
          return { rows: [{ policy: { version: 1 } }] };
        }
        if (sql.includes('FROM public.users AS u')) {
          return { rows: [{ email: 'xgjowtnlghqukqnxtmmnvwyz@example.invalid' }] };
        }
        if (sql.includes('FROM auth.users AS au')) {
          return { rows: [{ id: 'u1', has_password_credential: true }] };
        }
        if (sql.includes('FROM public.users u')) {
          return {
            rows: [
              {
                id: 'u1',
                email: String(params[0] || ''),
                user_type: 'super_admin',
                access_scope_type: 'platform',
                access_scope_id: null,
                status: 'active',
              },
            ],
          };
        }
        if (sql.includes('FROM public.access_eval_capability_v1')) {
          return { rows: [{ allowed: true, reason: 'allowed', capability_keys: ['*'] }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    const result = await evaluateOperatorAccounts(client, { requiredAccounts });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.findings).toHaveLength(1);
  });

  const requiredAdmin = {
    key: 'bootstrap_admin',
    email: 'bootstrap@example.invalid',
    user_type: 'super_admin',
    access_scope_type: 'platform',
    status: 'active',
    delivery_mode: 'breakglass',
    require_wildcard_capability: true,
  };

  function mockAuditClient(options = {}) {
    const user = {
      id: 'user-1',
      email: requiredAdmin.email,
      user_type: 'super_admin',
      access_scope_type: 'platform',
      access_scope_id: null,
      status: 'active',
      ...options.user,
    };
    return {
      query: jest.fn(async (sql, params = []) => {
        if (sql.includes('resolve_access_control_policy_v1')) {
          return { rows: [{ policy: options.missingPolicy ? null : { version: 1 } }] };
        }
        if (sql.includes('FROM public.users AS u')) {
          expect(sql).toContain("lower(u.user_type) = 'super_admin'");
          expect(sql).toContain("lower(u.access_scope_type) = 'platform'");
          expect(sql).toContain("lower(u.status) = 'active'");
          return { rows: options.activeAdmins || [{ email: requiredAdmin.email }] };
        }
        if (sql.includes('FROM public.users u')) {
          expect(params).toEqual([requiredAdmin.email]);
          return { rows: [user] };
        }
        if (sql.includes('FROM auth.users AS au')) {
          expect(params).toEqual([requiredAdmin.email]);
          expect(sql).toContain('AS has_password_credential');
          expect(sql).not.toMatch(/SELECT\s+(?:au\.)?encrypted_password\b/i);
          return { rows: options.authUsers || [{ id: user.id, has_password_credential: true }] };
        }
        if (sql.includes('FROM public.access_eval_capability_v1')) {
          expect(params.slice(2)).toEqual([user.access_scope_type, user.access_scope_id, user.id, user.user_type]);
          return { rows: [{ allowed: true, capability_keys: ['*'] }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
  }

  test('breakglass normalization retains password admission even with an explicit false flag', () => {
    const accounts = resolveRequiredOperatorAccounts({
      required_operator_accounts: {
        dev: [{ ...requiredAdmin, delivery_mode: ' BREAKGLASS ', require_password_credential: false }],
      },
    }, 'dev');
    expect(accounts[0]).toMatchObject({ delivery_mode: 'breakglass', require_password_credential: true });
  });

  test.each([
    ['no active admin', [], 'exactly one active platform super_admin user (found 0)'],
    ['duplicate active admins', [{ email: requiredAdmin.email }, { email: 'unexpected@example.invalid' }], 'exactly one active platform super_admin user (found 2)'],
    ['different active identity', [{ email: 'unexpected@example.invalid' }], 'does not match the required bootstrap account'],
  ])('rejects %s without exposing unexpected runtime identities', async (_label, activeAdmins, issue) => {
    const result = await evaluateOperatorAccounts(mockAuditClient({ activeAdmins }), { requiredAccounts: [requiredAdmin] });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain(issue);
    expect(JSON.stringify(result)).not.toContain('unexpected@example.invalid');
  });

  test('requires exactly one configured platform admin even if runtime has only one', async () => {
    const result = await evaluateOperatorAccounts(mockAuditClient(), { requiredAccounts: [requiredAdmin, requiredAdmin] });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(['operator bootstrap config must require exactly one platform super_admin (found 2)']);
  });

  test.each([
    ['missing auth identity', [], 'exactly one matching auth user (found 0)'],
    ['duplicate auth identities', [{ id: 'user-1' }, { id: 'user-2' }], 'exactly one matching auth user (found 2)'],
    ['mismatched auth ID', [{ id: 'other-id', has_password_credential: true }], 'auth user identity does not match public.users'],
    ['missing password credential', [{ id: 'user-1', has_password_credential: false }], 'missing the required password credential'],
  ])('rejects %s independently of wildcard capability', async (_label, authUsers, issue) => {
    const result = await evaluateOperatorAccounts(mockAuditClient({ authUsers }), { requiredAccounts: [requiredAdmin] });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain(issue);
    expect(result.findings[0]).toMatchObject({ auth_user_count: authUsers.length });
    expect(JSON.stringify(result)).not.toContain('other-id');
  });

  test('matching auth identity and breakglass credential pass without returning credential material', async () => {
    const result = await evaluateOperatorAccounts(mockAuditClient({
      authUsers: [{ id: 'user-1', has_password_credential: true, encrypted_password: 'synthetic-must-not-escape' }],
    }), { requiredAccounts: [requiredAdmin] });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.platform_super_admin_invariant).toEqual({ required_count: 1, active_count: 1 });
    expect(result.findings[0]).toMatchObject({
      auth_user_present: true,
      auth_identity_matches: true,
      password_credential_present: true,
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-must-not-escape');
    expect(JSON.stringify(result)).not.toContain('encrypted_password');
  });

  test('invite identities do not require passwords but must still match auth.users', async () => {
    const result = await evaluateOperatorAccounts(mockAuditClient({
      authUsers: [{ id: 'user-1', has_password_credential: false }],
    }), { requiredAccounts: [{ ...requiredAdmin, delivery_mode: 'invite' }] });
    expect(result.ok).toBe(true);
  });

  test.each([
    [{ user: { status: 'inactive' } }, 'has status "inactive"'],
    [{ user: { user_type: 'ops_admin' } }, 'has user_type "ops_admin"'],
    [{ user: { access_scope_id: 'unexpected-scope' } }, 'must have NULL access_scope_id'],
    [{ missingPolicy: true }, 'access control policy missing'],
  ])('retains existing account and policy guards: %s', async (options, issue) => {
    const result = await evaluateOperatorAccounts(mockAuditClient(options), { requiredAccounts: [requiredAdmin] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((entry) => entry.includes(issue))).toBe(true);
  });

  test('empty optional audit remains a no-op', async () => {
    const client = { query: jest.fn() };
    expect(await evaluateOperatorAccounts(client)).toEqual({ required: 0, findings: [], issues: [], ok: true });
    expect(client.query).not.toHaveBeenCalled();
  });

  test('database errors propagate rather than certifying a clean audit', async () => {
    const client = mockAuditClient();
    client.query.mockRejectedValueOnce(new Error('synthetic database failure'));
    await expect(evaluateOperatorAccounts(client, { requiredAccounts: [requiredAdmin] })).rejects.toThrow('synthetic database failure');
  });

  test.each([false, true])('active audit caller preserves breakglass policy and closes the client (query error: %s)', async (queryError) => {
    const client = {
      ...mockAuditClient({ authUsers: [{ id: 'user-1', has_password_credential: false }] }),
      connect: jest.fn(),
      end: jest.fn(),
    };
    if (queryError) client.query.mockRejectedValueOnce(new Error('synthetic query failure'));
    Client.mockImplementation(() => client);
    resolveDatabaseUrlWithFallback.mockResolvedValue({ dsn: 'synthetic-dsn', candidateName: 'mock', attempts: 1 });
    const configRead = jest.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify({
      accounts: [{ ...requiredAdmin, status: 'inactive', require_password_credential: false }, { enabled: false }],
    }));
    try {
      const audit = runAudit({ environment: 'dev', configPath: 'synthetic-operator-config.json' });
      if (queryError) {
        await expect(audit).rejects.toThrow('synthetic query failure');
      } else {
        const result = await audit;
        expect(result.ok).toBe(false);
        expect(result.required).toBe(1);
        expect(result.issues).toEqual([
          'platform super_admin "bootstrap_admin" is missing the required password credential in auth.users',
        ]);
      }
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(client.end).toHaveBeenCalledTimes(1);
    } finally {
      configRead.mockRestore();
    }
  });
});

