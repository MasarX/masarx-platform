const { ensureProject, deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');

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
        body: [{ name: 'planning_enhancements', ref: 'ref123', region: 'us-east-1' }],
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
        body: [{ name: 'planning_enhancements', ref: 'ref123', region: 'us-east-1' }],
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
        body: [{ name: 'go-live-preview', ref: 'ref-existing', region: 'us-east-1' }],
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
        body: [{ name: 'MasarX-DEV', ref: 'ref-dev', region: 'us-east-1' }],
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
      return {
        ok: true,
        status: 200,
        text: async () => '',
      };
    });

    try {
      await expect(
        deleteProjectWithRetries('ref-delete', 'tok', {
          timeoutMs: 1000,
          intervalMs: 1,
        }),
      ).resolves.toBeUndefined();
      expect(global.fetch).toHaveBeenCalledTimes(3);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
