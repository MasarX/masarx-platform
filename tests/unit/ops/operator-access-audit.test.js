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
        enabled: true,
        require_wildcard_capability: false,
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
});

