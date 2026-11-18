const {
  ensureProject,
  deleteProjectWithRetries,
  getBranchConfig,
  waitForBranchDatabaseConfig,
} = require('../../../scripts/ops/workspace/supabase-api');

function branchConfig(overrides = {}) {
  return {
    branch_id: 'branch-id',
    project_ref: 'abcdefghijklmnopqrst',
    status: 'ACTIVE_HEALTHY',
    db_host: 'db.abcdefghijklmnopqrst.supabase.co',
    db_port: '5432',
    db_user: 'postgres.abcdefghijklmnopqrst',
    db_pass: 'branch-password',
    ...overrides,
  };
}

describe('supabase-api getBranchConfig', () => {
  test('reads the encoded branch endpoint and normalizes branch-owned DB credentials without logging', async () => {
    const originalFetch = global.fetch;
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      jest.spyOn(console, method).mockImplementation(() => {}),
    );
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'branch/id with spaces',
        project_ref: ' abcdefghijklmnopqrst ',
        parent_project_ref: ' parent-af38b526-f5c1-468d-88fb-86677fbe872a ',
        status: ' ACTIVE_HEALTHY ',
        db_host: ' db.abcdefghijklmnopqrst.supabase.co ',
        db_port: 6543,
        db_user: ' postgres.abcdefghijklmnopqrst ',
        db_pass: 'branch-owned-secret',
        jwt_secret: ' branch-jwt-secret ',
        region: ' eu-west-1 ',
      }),
    }));

    try {
      await expect(getBranchConfig({
        token: 'management-token',
        branchIdOrRef: 'branch/id with spaces',
        timeoutMs: 12_345,
      })).resolves.toEqual(expect.objectContaining({
        branch_id: 'branch/id with spaces',
        project_ref: 'abcdefghijklmnopqrst',
        status: 'ACTIVE_HEALTHY',
        db_host: 'db.abcdefghijklmnopqrst.supabase.co',
        db_port: '6543',
        db_user: 'postgres.abcdefghijklmnopqrst',
        db_pass: 'branch-owned-secret',
        jwt_secret: 'branch-jwt-secret',
        region: 'eu-west-1',
      }));

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.supabase.com/v1/branches/branch%2Fid%20with%20spaces',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            authorization: 'Bearer management-token',
          }),
          signal: expect.any(AbortSignal),
        }),
      );
      expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(false);
      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      global.fetch = originalFetch;
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  test('validates token and branch identifier before issuing a request', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn();

    try {
      await expect(getBranchConfig({
        token: '',
        branchIdOrRef: '5fd7e30a-80df-483b-955c-7a633c6ba9d6',
      })).rejects.toThrow(/SUPABASE_ACCESS_TOKEN.*required.*branch config/i);
      await expect(getBranchConfig({
        token: 'management-token',
        branchIdOrRef: '   ',
      })).rejects.toThrow(/branchIdOrRef.*required/i);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('does not retain a redacted branch jwt secret', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        project_ref: 'abcdefghijklmnopqrst',
        status: 'ACTIVE_HEALTHY',
        db_host: 'db.abcdefghijklmnopqrst.supabase.co',
        db_port: 5432,
        db_user: 'postgres.abcdefghijklmnopqrst',
        db_pass: 'branch-owned-secret',
        jwt_secret: '********',
      }),
    }));
    try {
      await expect(getBranchConfig({
        token: 'management-token',
        branchIdOrRef: 'abcdefghijklmnopqrst',
      })).resolves.toEqual(expect.objectContaining({ jwt_secret: '' }));
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('supabase-api waitForBranchDatabaseConfig', () => {
  test('retries transitional status and a transient fetch failure before returning validated credentials', async () => {
    let nowMs = 0;
    const getBranchConfigFn = jest.fn()
      .mockResolvedValueOnce(branchConfig({ status: 'COMING_UP' }))
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(branchConfig());
    const sleepFn = jest.fn(async (delayMs) => {
      nowMs += delayMs;
    });

    await expect(waitForBranchDatabaseConfig({
      token: 'management-token',
      branchIdOrRef: 'abcdefghijklmnopqrst',
      expectedProjectRef: 'abcdefghijklmnopqrst',
      maxWaitMs: 10_000,
      retryDelayMs: 250,
      getBranchConfigFn,
      nowFn: () => nowMs,
      sleepFn,
    })).resolves.toEqual(expect.objectContaining({
      project_ref: 'abcdefghijklmnopqrst',
      status: 'ACTIVE_HEALTHY',
      db_pass: 'branch-password',
    }));

    expect(getBranchConfigFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 250);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 250);
  });
});

describe('supabase-api ensureProject', () => {
  test('reuses existing project when create hits name conflict', async () => {
    const originalFetch = global.fetch;
    const responses = [
      {
        ok: false,
        status: 400,
        body: { message: 'Project with name "planning_enhancements" already exists in your organization.' },
      },
      {
        ok: true,
        status: 200,
        body: [{ name: 'planning_enhancements', ref: 'ref123', region: 'us-east-1', organization_id: 'org' }],
      },
    ];

    global.fetch = jest.fn(async () => {
      const next = responses.shift();
      return {
        ok: next.ok,
        status: next.status,
        text: async () => JSON.stringify(next.body),
      };
    });

    try {
      const res = await ensureProject({
        token: 'tok',
        organizationId: 'org',
        name: 'planning_enhancements',
        region: 'us-east-1',
        plan: 'free',
        dbPass: 'pass',
        reuseExisting: true,
      });

      expect(res).toEqual(
        expect.objectContaining({
          project_ref: 'ref123',
          db_pass: 'pass',
          reused: true,
        }),
      );
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('throws a clear error when reusing but dbPass is missing', async () => {
    const originalFetch = global.fetch;
    const responses = [
      {
        ok: false,
        status: 400,
        body: { message: 'Project with name "planning_enhancements" already exists in your organization.' },
      },
      {
        ok: true,
        status: 200,
        body: [{ name: 'planning_enhancements', ref: 'ref123', region: 'us-east-1', organization_id: 'org' }],
      },
    ];

    global.fetch = jest.fn(async () => {
      const next = responses.shift();
      return {
        ok: next.ok,
        status: next.status,
        text: async () => JSON.stringify(next.body),
      };
    });

    try {
      await expect(
        ensureProject({
          token: 'tok',
          organizationId: 'org',
          name: 'planning_enhancements',
          region: 'us-east-1',
          plan: 'free',
          dbPass: '',
          reuseExisting: true,
        }),
      ).rejects.toThrow(/dbPass|SUPABASE_DB_PASSWORD/i);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('surfaces actionable diagnostics when project creation is forbidden', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: 'Forbidden resource' }),
    }));

    try {
      await expect(
        ensureProject({
          token: 'tok',
          organizationId: 'org-1',
          name: 'go-live-preview',
          region: 'eu-north-1',
          plan: 'free',
          dbPass: 'pass',
          reuseExisting: true,
        }),
      ).rejects.toThrow(/project creation denied.*Owner\/Admin.*quota/i);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('reuses existing project on 403 when same project name is visible', async () => {
    const originalFetch = global.fetch;
    const responses = [
      {
        ok: false,
        status: 403,
        body: { message: 'Forbidden resource' },
      },
      {
        ok: true,
        status: 200,
        body: [{ name: 'go-live-preview', ref: 'ref-existing', region: 'us-east-1', organization_id: 'org-1' }],
      },
    ];

    global.fetch = jest.fn(async () => {
      const next = responses.shift();
      return {
        ok: next.ok,
        status: next.status,
        text: async () => JSON.stringify(next.body),
      };
    });

    try {
      const res = await ensureProject({
        token: 'tok',
        organizationId: 'org-1',
        name: 'go-live-preview',
        region: 'us-east-1',
        plan: 'free',
        dbPass: 'pass',
        reuseExisting: true,
      });
      expect(res).toEqual(
        expect.objectContaining({
          project_ref: 'ref-existing',
          reused: true,
          reused_without_create_permission: true,
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('reuses existing project on 403 with case-insensitive name match', async () => {
    const originalFetch = global.fetch;
    const responses = [
      {
        ok: false,
        status: 403,
        body: { message: 'Forbidden resource' },
      },
      {
        ok: true,
        status: 200,
        body: [{ name: 'MasarX-DEV', ref: 'ref-dev', region: 'us-east-1', organization_id: 'org-1' }],
      },
    ];

    global.fetch = jest.fn(async () => {
      const next = responses.shift();
      return {
        ok: next.ok,
        status: next.status,
        text: async () => JSON.stringify(next.body),
      };
    });

    try {
      const res = await ensureProject({
        token: 'tok',
        organizationId: 'org-1',
        name: 'masarx-dev',
        region: 'us-east-1',
        plan: 'pro',
        dbPass: 'pass',
        reuseExisting: true,
      });
      expect(res).toEqual(
        expect.objectContaining({
          project_ref: 'ref-dev',
          reused: true,
          reused_without_create_permission: true,
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('supabase-api deleteProjectWithRetries', () => {
  test('retries transient fetch failures until delete succeeds', async () => {
    const originalFetch = global.fetch;
    let callCount = 0;
    global.fetch = jest.fn(async () => {
      callCount += 1;
      if (callCount < 3) {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }
      if (callCount === 4) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: async () => JSON.stringify({ message: 'not found' }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
      };
    });

    try {
      await expect(
        deleteProjectWithRetries('abcdefghijklmnopqrst', 'tok', {
          organizationId: 'exact-org-id',
          timeoutMs: 1000,
          intervalMs: 1,
        }),
      ).resolves.toBeUndefined();
      expect(global.fetch).toHaveBeenCalledTimes(4);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
