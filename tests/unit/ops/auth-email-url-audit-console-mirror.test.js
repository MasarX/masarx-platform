const path = require('path');
const {
  buildAuthEmailPolicyMirrorEntry,
  mergeAuthEmailUrlPolicySetting,
  normalizeRepoRelativePath,
  resolveAuditStatus,
} = require('../../../scripts/ops/audit/auth-email-url-audit');

describe('auth-email-url-audit Console V2 mirror helpers', () => {
  const summary = {
    generated_at: '2026-05-04T08:30:00.000Z',
    environment: 'stg',
    project_ref: 'project-stg',
    policy_path: path.join(process.cwd(), 'config', 'ops', 'auth-email-url-policy.stg.json'),
    read_attempts: 2,
    read_retried: true,
    read_retry_window_ms: 120000,
    ok: true,
    issues: [],
    warnings: [],
    actual: {
      site_url: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
      additional_redirect_urls: [
        'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
        'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
      ],
      source: 'supabase-management-api',
    },
    policy: {
      site_url: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
      additional_redirect_urls: [
        'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
        'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
      ],
      banned_redirect_hosts: ['localhost', '127.0.0.1', '0.0.0.0', '.local', '.localhost'],
    },
  };

  test('normalizes repo-relative policy source paths for Console rows', () => {
    expect(normalizeRepoRelativePath(summary.policy_path)).toBe(
      'config/ops/auth-email-url-policy.stg.json',
    );
  });

  test('resolves traffic-light status from audit result', () => {
    expect(resolveAuditStatus({ ok: true, issues: [], warnings: [] })).toBe('green');
    expect(resolveAuditStatus({ ok: true, issues: [], warnings: ['extra redirect'] })).toBe('yellow');
    expect(resolveAuditStatus({ ok: false, issues: ['mismatch'], warnings: [] })).toBe('red');
  });

  test('builds the Console V2 mirror row from the audit summary', () => {
    expect(buildAuthEmailPolicyMirrorEntry(summary)).toEqual({
      env: 'stg',
      callback_urls: ['https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback'],
      redirect_urls: [
        'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
        'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
      ],
      source_file: 'config/ops/auth-email-url-policy.stg.json',
      last_audit_at: '2026-05-04T08:30:00.000Z',
      audit_status: 'green',
      policy: {
        environment: 'stg',
        site_url: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
        additional_redirect_urls: [
          'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
          'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
        ],
        banned_redirect_hosts: ['localhost', '127.0.0.1', '0.0.0.0', '.local', '.localhost'],
      },
      metadata: {
        source: 'config/ops/auth-email-url-policy.stg.json',
        project_ref: 'project-stg',
        actual: summary.actual,
        ok: true,
        issues: [],
        warnings: [],
        read_attempts: 2,
        read_retried: true,
        read_retry_window_ms: 120000,
      },
    });
  });

  test('merges one environment without changing existing per-env entries', () => {
    const devEntry = {
      env: 'dev',
      callback_urls: ['https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback'],
      redirect_urls: ['https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback'],
      source_file: 'config/ops/auth-email-url-policy.dev.json',
      last_audit_at: null,
      audit_status: 'yellow',
      policy: { environment: 'dev' },
      metadata: { source: 'config/ops/auth-email-url-policy.dev.json' },
    };
    const staleStgEntry = {
      env: 'stg',
      callback_urls: ['old'],
      redirect_urls: ['old'],
      source_file: 'config/ops/auth-email-url-policy.stg.json',
      last_audit_at: null,
      audit_status: 'yellow',
      policy: { environment: 'stg' },
      metadata: { source: 'old' },
    };
    const prodEntry = {
      env: 'prod',
      callback_urls: ['https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback'],
      redirect_urls: ['https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback'],
      source_file: 'config/ops/auth-email-url-policy.prod.json',
      last_audit_at: null,
      audit_status: 'yellow',
      policy: { environment: 'prod' },
      metadata: { source: 'config/ops/auth-email-url-policy.prod.json' },
    };
    const current = {
      version: 1,
      owner: 'console-v2',
      policies: [devEntry, staleStgEntry, prodEntry],
    };

    const nextEntry = buildAuthEmailPolicyMirrorEntry(summary);
    const merged = mergeAuthEmailUrlPolicySetting(current, nextEntry);

    expect(merged).toEqual({
      version: 1,
      owner: 'console-v2',
      policies: [devEntry, nextEntry, prodEntry],
    });
    expect(current.policies[1]).toBe(staleStgEntry);
  });

  test('appends the audited environment when no existing row is present', () => {
    const nextEntry = buildAuthEmailPolicyMirrorEntry(summary);

    expect(mergeAuthEmailUrlPolicySetting({ version: 1, policies: [] }, nextEntry)).toEqual({
      version: 1,
      policies: [nextEntry],
    });
  });
});
