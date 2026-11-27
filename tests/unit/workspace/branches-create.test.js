const { supabasePoolerHost } = require('../../fixtures/builders/hosts');

const westRegion = 'eu-test-1';
const westPooler1 = supabasePoolerHost(1, westRegion);

const fs = require('fs');
const path = require('path');
const {
  buildBranchDatabaseUrl,
  getArg,
  hydrateBranchForProvision,
  hydrateSelectedBranch,
  resolveBranchConfigTimeoutMs,
  resolveCreateMode,
  selectBranchForProvision,
} = require('../../../scripts/ops/branches/create');

function branchConfig(overrides = {}) {
  return {
    project_ref: 'abcdefghijklmnopqrst',
    status: 'ACTIVE_HEALTHY',
    name: 'api-branch-name',
    region: westRegion,
    db_host: 'db.abcdefghijklmnopqrst.supabase.co',
    db_port: '6432',
    db_user: 'postgres.abcdefghijklmnopqrst',
    db_pass: 'branch-owned-password',
    jwt_secret: 'branch-jwt-secret',
    ...overrides,
  };
}

describe('scripts/ops/branches/create.js', () => {
  const sourcePath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'scripts',
    'ops',
    'branches',
    'create.js',
  );

  test('keeps project-mode behavior and delegates branch lifecycle contracts to shared APIs', () => {
    const body = fs.readFileSync(sourcePath, 'utf8');

    expect(body).toContain('setProjectDatabasePassword');
    expect(body).toContain('if (created.reused) {');
    expect(body).toContain('await setProjectDatabasePassword({');
    expect(body).toContain('const selectedBranch = await selectBranchForProvision({');
    expect(body).toContain('await waitForBranchDatabaseConfigFn({');
    expect(body).toContain('validateBranchDatabaseConfig(branchConfig');
    expect(body).not.toContain('fetch(');
    expect(body).not.toContain('function normalizeBranchDatabaseConfig');
    expect(body).not.toContain('function isCanonicalSupabaseDatabaseHost');
    expect(body).not.toContain('inheritedPass');
    expect(body).not.toContain('resolvePoolerHostFn: (branchProjectRef');
    expect(body).toContain('reused: created.reused === true');
    expect((body.match(/reuseExisting: !forceNew/g) || [])).toHaveLength(2);
  });

  test('builds a direct DSN from validated branch-owned fields', () => {
    expect(buildBranchDatabaseUrl(branchConfig(), 'abcdefghijklmnopqrst')).toBe(
      (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",branchConfig().db_pass,"@",branchConfig().db_host,":",'6432',"/",'postgres'].join("")),
    );
  });

  test('rejects an off-domain host before constructing a credential-bearing DSN', () => {
    expect(() => buildBranchDatabaseUrl(branchConfig({
      db_host: 'attacker.example.com',
      db_pass: 'must-not-leave-the-process',
    }), 'abcdefghijklmnopqrst')).toThrow('branch_db_credentials_invalid:db_host');
  });

  test('hydrates branch-owned credentials and returns the exact official direct host', async () => {
    const getBranchConfigFn = jest.fn().mockResolvedValue(branchConfig());
    const resolvePoolerHostFn = jest.fn().mockResolvedValue(
      westPooler1,
    );

    await expect(hydrateSelectedBranch({
      selectedBranch: {
        branch_id: 'deprecated-branch-uuid',
        project_ref: 'abcdefghijklmnopqrst',
        name: 'selected-name',
      },
      branchParentRef: 'uvwxyzabcdefghijklmn',
      requestedName: 'requested-name',
      token: 'management-token',
      region: 'us-east-1',
      getBranchConfigFn,
      nowFn: () => 0,
      resolvePoolerHostFn,
    })).resolves.toEqual({
      mode: 'branch',
      name: 'api-branch-name',
      reused: false,
      branch_id: 'deprecated-branch-uuid',
      branch_parent_ref: 'uvwxyzabcdefghijklmn',
      project_ref: 'abcdefghijklmnopqrst',
      region: westRegion,
      pooler_host: westPooler1,
      pooler_port: '5432',
      direct_db_host: 'db.abcdefghijklmnopqrst.supabase.co',
      db_pass: 'branch-owned-password',
      jwt_secret: 'branch-jwt-secret',
      supabase_url: 'https://abcdefghijklmnopqrst.supabase.co',
      database_url:
        (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",branchConfig().db_pass,"@",branchConfig().db_host,":",'6432',"/",'postgres'].join("")),
    });

    expect(getBranchConfigFn).toHaveBeenCalledWith({
      token: 'management-token',
      branchIdOrRef: 'abcdefghijklmnopqrst',
      timeoutMs: 120_000,
    });
  });

  test('rejects an off-domain pooler host before returning branch credentials', async () => {
    const error = await hydrateSelectedBranch({
      selectedBranch: { project_ref: 'abcdefghijklmnopqrst' },
      branchParentRef: 'uvwxyzabcdefghijklmn',
      token: 'management-token',
      getBranchConfigFn: jest.fn().mockResolvedValue(branchConfig({
        project_ref: 'abcdefghijklmnopqrst',
        db_host: 'db.abcdefghijklmnopqrst.supabase.co',
      })),
      resolvePoolerHostFn: jest.fn().mockResolvedValue('attacker.example.com'),
    }).catch((caught) => caught);

    expect(error.code).toBe('branch_db_credentials_invalid');
    expect(error.message).toBe(
      'Branch credential lookup failed after branch selection (code=branch_db_credentials_invalid)',
    );
  });

  test('rejects an injected pooler port before reading branch credentials', async () => {
    const getBranchConfigFn = jest.fn();
    await expect(hydrateSelectedBranch({
      selectedBranch: { project_ref: 'abcdefghijklmnopqrst' },
      branchParentRef: 'uvwxyzabcdefghijklmn',
      token: 'management-token',
      poolerPort: '5432@attacker.example',
      getBranchConfigFn,
    })).rejects.toThrow('branch_db_credentials_invalid:pooler_port');
    expect(getBranchConfigFn).not.toHaveBeenCalled();
  });

  test('polls a complete transitional config until ACTIVE_HEALTHY credentials arrive', async () => {
    let nowMs = 0;
    const getBranchConfigFn = jest.fn()
      .mockResolvedValueOnce(branchConfig({ status: 'COMING_UP' }))
      .mockResolvedValueOnce(branchConfig());
    const sleepFn = jest.fn(async (delayMs) => {
      nowMs += delayMs;
    });

    const result = await hydrateSelectedBranch({
      selectedBranch: { project_ref: 'abcdefghijklmnopqrst' },
      branchParentRef: 'uvwxyzabcdefghijklmn',
      token: 'management-token',
      branchConfigTimeoutMs: 10_000,
      branchConfigRetryDelayMs: 2_000,
      getBranchConfigFn,
      nowFn: () => nowMs,
      sleepFn,
      resolvePoolerHostFn: jest.fn().mockResolvedValue(
        westPooler1,
      ),
    });

    expect(result.db_pass).toBe('branch-owned-password');
    expect(getBranchConfigFn).toHaveBeenCalledTimes(2);
    expect(getBranchConfigFn).toHaveBeenNthCalledWith(1, {
      token: 'management-token',
      branchIdOrRef: 'abcdefghijklmnopqrst',
      timeoutMs: 10_000,
    });
    expect(getBranchConfigFn).toHaveBeenNthCalledWith(2, {
      token: 'management-token',
      branchIdOrRef: 'abcdefghijklmnopqrst',
      timeoutMs: 8_000,
    });
    expect(sleepFn).toHaveBeenCalledWith(2_000);
  });

  test('polls missing credentials and then accepts the complete config', async () => {
    let nowMs = 0;
    const getBranchConfigFn = jest.fn()
      .mockResolvedValueOnce(branchConfig({ db_user: '', db_pass: '' }))
      .mockResolvedValueOnce(branchConfig());
    const sleepFn = jest.fn(async (delayMs) => {
      nowMs += delayMs;
    });

    await expect(hydrateSelectedBranch({
      selectedBranch: { project_ref: 'abcdefghijklmnopqrst' },
      branchParentRef: 'uvwxyzabcdefghijklmn',
      token: 'management-token',
      branchConfigTimeoutMs: 10_000,
      branchConfigRetryDelayMs: 1_000,
      getBranchConfigFn,
      nowFn: () => nowMs,
      sleepFn,
      resolvePoolerHostFn: jest.fn().mockResolvedValue(
        westPooler1,
      ),
    })).resolves.toMatchObject({ db_pass: 'branch-owned-password' });

    expect(getBranchConfigFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(1_000);
  });

  test('bounds readiness exhaustion by one total deadline', async () => {
    let nowMs = 0;
    const getBranchConfigFn = jest.fn().mockResolvedValue(
      branchConfig({ status: 'COMING_UP' }),
    );
    const sleepFn = jest.fn(async (delayMs) => {
      nowMs += delayMs;
    });

    const error = await hydrateSelectedBranch({
      selectedBranch: { project_ref: 'abcdefghijklmnopqrst' },
      branchParentRef: 'uvwxyzabcdefghijklmn',
      token: 'management-token',
      branchConfigTimeoutMs: 10_000,
      branchConfigRetryDelayMs: 5_000,
      getBranchConfigFn,
      nowFn: () => nowMs,
      sleepFn,
    }).catch((caught) => caught);

    expect(error.code).toBe('branch_db_credentials_unavailable');
    expect(error.message).toBe(
      'Branch credential lookup failed after branch selection (code=branch_db_credentials_unavailable)',
    );
    expect(getBranchConfigFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(nowMs).toBe(10_000);
  });

  test('fails terminal status immediately even when credentials are missing', async () => {
    const getBranchConfigFn = jest.fn().mockResolvedValue(branchConfig({
      status: 'RESTORE_FAILED',
      db_user: '',
      db_pass: '',
    }));
    const sleepFn = jest.fn();

    const error = await hydrateSelectedBranch({
      selectedBranch: { project_ref: 'abcdefghijklmnopqrst' },
      branchParentRef: 'uvwxyzabcdefghijklmn',
      token: 'management-token',
      getBranchConfigFn,
      sleepFn,
    }).catch((caught) => caught);

    expect(error.code).toBe('branch_db_credentials_terminal_status');
    expect(error.message).toBe(
      'Branch credential lookup failed after branch selection (code=branch_db_credentials_terminal_status)',
    );
    expect(getBranchConfigFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  test('fails access denial immediately without leaking the underlying message', async () => {
    const secret = 'must-not-appear-in-cli-errors';
    const getBranchConfigFn = jest.fn().mockRejectedValue(
      Object.assign(new Error(secret), { status: 403 }),
    );

    const error = await hydrateSelectedBranch({
      selectedBranch: { project_ref: 'abcdefghijklmnopqrst' },
      branchParentRef: 'uvwxyzabcdefghijklmn',
      token: 'management-token',
      getBranchConfigFn,
    }).catch((caught) => caught);

    expect(error.code).toBe('branch_db_credentials_access_denied');
    expect(error.message).toBe(
      'Branch credential lookup failed after branch selection (code=branch_db_credentials_access_denied)',
    );
    expect(error.message).not.toContain(secret);
    expect(getBranchConfigFn).toHaveBeenCalledTimes(1);
    expect(String(error.cause?.message || '')).toContain(secret);
  });

  test('caps branch-config readiness at 120 seconds', () => {
    expect(resolveBranchConfigTimeoutMs(undefined)).toBe(120_000);
    expect(resolveBranchConfigTimeoutMs('2500')).toBe(2_500);
    expect(resolveBranchConfigTimeoutMs('999999')).toBe(120_000);
  });

  test('rejects unknown create modes instead of provisioning a project', () => {
    expect(resolveCreateMode('branch')).toBe('branch');
    expect(resolveCreateMode('project')).toBe('project');
    expect(() => resolveCreateMode('invalid')).toThrow(
      "Invalid branch create mode 'invalid'",
    );
    expect(getArg('--mode', undefined, ['node', 'create.js', '--mode=branch'])).toBe('branch');
    expect(getArg('--name', undefined, ['node', 'create.js', '--name=workspace'])).toBe('workspace');
    expect(() => resolveCreateMode(getArg(
      '--mode',
      undefined,
      ['node', 'create.js', '--mode='],
    ))).toThrow("Invalid branch create mode ''");
    expect(() => resolveCreateMode(getArg(
      '--mode',
      undefined,
      ['node', 'create.js', '--mode', '--name', 'workspace'],
    ))).toThrow("Invalid branch create mode ''");
  });

  test('explicit branch mode fails closed before selection and never falls back to project', async () => {
    await expect(selectBranchForProvision({
      token: 'management-token',
      parentRef: '',
      name: 'branch-name',
    })).rejects.toThrow('Branch mode requires canonical SUPABASE_BRANCH_PARENT_REF');
    await expect(selectBranchForProvision({
      token: '',
      parentRef: 'uvwxyzabcdefghijklmn',
      name: 'branch-name',
    })).rejects.toThrow('Branch mode requires SUPABASE_ACCESS_TOKEN');

    const selectionError = new Error('branch creation denied');
    const ensureBranchFn = jest.fn().mockRejectedValue(selectionError);
    await expect(selectBranchForProvision({
      token: 'management-token',
      parentRef: 'uvwxyzabcdefghijklmn',
      name: 'branch-name',
      ensureBranchFn,
    })).rejects.toBe(selectionError);

    const freshEnsureBranchFn = jest.fn().mockResolvedValue({
      branch_id: 'new-branch-id',
      project_ref: 'abcdefghijklmnopqrst',
      reused: false,
    });
    await selectBranchForProvision({
      token: 'management-token',
      parentRef: 'uvwxyzabcdefghijklmn',
      name: 'branch-name',
      reuseExisting: false,
      ensureBranchFn: freshEnsureBranchFn,
    });
    expect(freshEnsureBranchFn).toHaveBeenCalledWith(expect.objectContaining({
      reuseExisting: false,
    }));

    const body = fs.readFileSync(sourcePath, 'utf8');
    const hydrateSource = body.slice(
      body.indexOf('async function hydrateSelectedBranch'),
      body.indexOf('async function selectBranchForProvision'),
    );
    expect(body).not.toContain('falling back to mode=project');
    expect(hydrateSource).not.toContain('waitUntilReady');
  });

  test('cleans up only an exact newly created branch when hydration fails', async () => {
    const hydrationError = new Error('credential hydration failed');
    const hydrateSelectedBranchFn = jest.fn().mockRejectedValue(hydrationError);
    const deleteBranchWithRetriesFn = jest.fn().mockResolvedValue(undefined);
    const selectedBranch = {
      branch_id: 'new-branch-id',
      project_ref: 'bcdefghijklmnopqrstu',
      reused: false,
    };

    await expect(hydrateBranchForProvision({
      selectedBranch,
      token: 'management-token',
      hydrateSelectedBranchFn,
      deleteBranchWithRetriesFn,
    })).rejects.toBe(hydrationError);
    expect(deleteBranchWithRetriesFn).toHaveBeenCalledWith(
      'new-branch-id',
      'management-token',
      { timeoutMs: 120_000 },
    );
  });

  test.each([
    ['a reused branch', { branch_id: 'reused-branch-id', reused: true }],
    ['a branch without exact id', { branch_id: '', reused: false }],
  ])('never cleanup-deletes %s after hydration failure', async (_label, selectedBranch) => {
    const hydrationError = new Error('credential hydration failed');
    const deleteBranchWithRetriesFn = jest.fn();

    await expect(hydrateBranchForProvision({
      selectedBranch: { project_ref: 'abcdefghijklmnopqrst', ...selectedBranch },
      token: 'management-token',
      hydrateSelectedBranchFn: jest.fn().mockRejectedValue(hydrationError),
      deleteBranchWithRetriesFn,
    })).rejects.toBe(hydrationError);
    expect(deleteBranchWithRetriesFn).not.toHaveBeenCalled();
  });

  test.each([
    ['terminal status', 'branch_db_credentials_terminal_status', 'workspace-branch'],
    ['access denial', 'branch_db_credentials_access_denied', 'workspace-branch'],
    ['identity mismatch', 'branch_db_credentials_terminal_status', 'different-name'],
  ])('never repair-deletes a reused branch on %s', async (_label, code, selectedName) => {
    const failure = Object.assign(new Error('hydration failed'), { code });
    const deleteBranchWithRetriesFn = jest.fn();
    const ensureBranchFn = jest.fn();

    await expect(hydrateBranchForProvision({
      selectedBranch: {
        branch_id: 'reused-branch-id',
        project_ref: 'abcdefghijklmnopqrst',
        branch_parent_ref: 'uvwxyzabcdefghijklmn',
        name: selectedName,
        reused: true,
      },
      branchParentRef: 'uvwxyzabcdefghijklmn',
      requestedName: 'workspace-branch',
      token: 'management-token',
      hydrateSelectedBranchFn: jest.fn().mockRejectedValue(failure),
      deleteBranchWithRetriesFn,
      ensureBranchFn,
    })).rejects.toBe(failure);

    expect(deleteBranchWithRetriesFn).not.toHaveBeenCalled();
    expect(ensureBranchFn).not.toHaveBeenCalled();
  });

});
